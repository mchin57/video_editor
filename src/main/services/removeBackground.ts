/**
 * Background removal ("subject-aware crop"): run the RVM video-matting model over
 * ONE source window (the segment a video layer plays) frame-by-frame in the main
 * process and save the alpha result as a NEW library asset — a transparent VP9
 * (yuva420p) WebM carrying the same window's audio. The renderer then points the
 * layer at it (`rebaseVideoContent`, shared/layers.ts). Discovery mirrors whisper:
 * the ONNX model is found under the bundled models dir (installer) or
 * <data>/bin/models (user-provided).
 *
 * Pipeline: ffmpeg decodes the window to upright raw RGB frames → RVM
 * (onnxruntime; DirectML GPU on Windows, else CPU) emits a foreground + alpha per
 * frame (carrying recurrent state for temporal stability) → a second ffmpeg
 * encodes the straight-alpha RGBA frames + the window's audio to the WebM. The
 * pure frame/tensor + arg helpers live in removeBackgroundArgs.ts (unit-tested).
 *
 * The job is cancelable: `cancelJob` aborts its signal, which kills both ffmpeg
 * children (startFfmpeg), stops the frame loop, and deletes the partial output.
 */

import { once } from 'node:events'
import { existsSync, promises as fsp, readdirSync } from 'node:fs'
import { basename, join, parse } from 'node:path'
import type { MediaAsset } from '@shared/media'
import type { RemoveBackgroundRequest } from '@shared/ipc'
import { getSubdir, getBundledModelsDir } from '../config'
import { getBinaries } from './ffmpeg'
import { startFfmpeg } from './ffmpegRun'
import { importGenerated, ensureProxy, requireUsable } from './mediaStore'
import { requireSession } from './projectSession'
import { hdrToSdrChain } from './proxy'
import { createJob, failJob, finishJob, setLabel, setProgress } from './jobs'
import {
  buildMatteDecodeArgs,
  buildMatteEncodeArgs,
  compositeRgba,
  downsampleRatioFor,
  frameToSrcTensor,
  matteDims,
  matteFps,
  rawFrames,
  type MatteWindow
} from './removeBackgroundArgs'
import { createLogger, bestEffort } from '@shared/log'

const log = createLogger('matte')

type OrtModule = typeof import('onnxruntime-node')
type OrtTensor = import('onnxruntime-node').Tensor
type OrtSession = import('onnxruntime-node').InferenceSession
type OrtOutputs = Awaited<ReturnType<OrtSession['run']>>

/** Where inference runs. GPU = DirectML (any D3D12 GPU on Windows — it ships
 *  inside onnxruntime-node's win32 binaries, so it costs no installer size). */
export type MatteDevice = 'gpu' | 'cpu'

/** Model search roots, bundled (installer) first, then the user data dir. */
function modelDirs(): string[] {
  const dirs: string[] = []
  const bundled = getBundledModelsDir()
  if (bundled) dirs.push(bundled)
  dirs.push(join(getSubdir('bin'), 'models'))
  return dirs
}

/** Locate the RVM matting model (`rvm_*.onnx`, else the first `.onnx` found). */
export function discoverMatteModel(): string | null {
  for (const dir of modelDirs()) {
    if (!existsSync(dir)) continue
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.onnx'))
    } catch {
      continue
    }
    const pick = files.find((f) => f.toLowerCase().startsWith('rvm')) ?? files[0]
    if (pick) return join(dir, pick)
  }
  return null
}

/** Feature gate: the model must exist on disk AND onnxruntime-node must load
 *  (it's a native module — an Electron ABI mismatch fails at import time, and
 *  the UI should hide the button rather than fail at click time). */
export async function segmentAvailable(): Promise<boolean> {
  if (discoverMatteModel() === null) return false
  try {
    await loadOrt()
    return true
  } catch (error) {
    // Hidden, not failed at click time — but say why (an ABI mismatch, a missing DLL).
    log.warn('onnxruntime-node did not load; background removal is unavailable', error)
    return false
  }
}

// onnxruntime-node is loaded lazily (native module) so a load failure can't crash
// the whole main process at import; sessions are cached per model path + device.
let ortMod: OrtModule | null = null
const sessions = new Map<string, Promise<OrtSession>>()
/** Set once the GPU session was created but could not actually run the model;
 *  later jobs this app run go straight to the CPU instead of failing over again. */
let gpuUnusable = false

async function loadOrt(): Promise<OrtModule> {
  if (!ortMod) ortMod = await import('onnxruntime-node')
  return ortMod
}

function getSession(ort: OrtModule, modelPath: string, device: MatteDevice): Promise<OrtSession> {
  const key = `${device}:${modelPath}`
  let s = sessions.get(key)
  if (!s) {
    s =
      device === 'gpu'
        ? // DirectML supports neither memory patterns nor parallel execution;
          // onnxruntime's docs require both off for the DML provider.
          ort.InferenceSession.create(modelPath, {
            executionProviders: ['dml'],
            enableMemPattern: false,
            executionMode: 'sequential'
          })
        : ort.InferenceSession.create(modelPath)
    // Don't cache a failure — the next job should get to try again.
    s.catch(() => sessions.delete(key))
    sessions.set(key, s)
  }
  return s
}

/** The GPU session when this machine can create one, else the CPU session. */
async function bestSession(ort: OrtModule, modelPath: string): Promise<{ session: OrtSession; device: MatteDevice }> {
  if (process.platform === 'win32' && !gpuUnusable) {
    try {
      return { session: await getSession(ort, modelPath, 'gpu'), device: 'gpu' }
    } catch (err) {
      log.warn('DirectML unavailable, using the CPU', err)
    }
  }
  return { session: await getSession(ort, modelPath, 'cpu'), device: 'cpu' }
}

/** Fail early and clearly if a non-RVM ONNX was dropped in (inputs: src,
 *  r1i..r4i, downsample_ratio). */
function assertRvm(session: OrtSession, modelPath: string): void {
  if (!session.inputNames.includes('src') || !session.inputNames.includes('downsample_ratio')) {
    throw new Error(
      `"${basename(modelPath)}" is not a Robust Video Matting model (inputs: ${session.inputNames.join(', ')}).`
    )
  }
}

/** "0:12" — a source time for the matted clip's library name. */
function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The requested window, clamped to the source's known duration. */
function clampWindow(req: RemoveBackgroundRequest, sourceSec: number): MatteWindow {
  const startSec = Math.max(0, Math.min(req.startSec, sourceSec > 0 ? sourceSec : Infinity))
  const room = sourceSec > 0 ? sourceSec - startSec : Infinity
  const durationSec = Math.min(Math.max(0, req.durationSec), room)
  if (!(durationSec > 0)) throw new Error('That clip segment is empty.')
  return { startSec, durationSec }
}

/**
 * Matte one source window → a new transparent WebM library asset (with the
 * window's audio), and build its preview proxy before returning so the caller
 * can swap it in immediately. Reports progress on the jobs channel. Resolves
 * null when the job was canceled (nothing is left behind); throws if the model
 * is missing, the source has no video, or processing fails.
 */
export async function removeBackgroundToLibrary(req: RemoveBackgroundRequest): Promise<MediaAsset | null> {
  const modelPath = discoverMatteModel()
  if (!modelPath) throw new Error('Background-removal model is not installed (resources/models).')
  const project = requireSession() // the matte finishes in the project it started in
  const asset = await requireUsable(req.mediaId, project)
  const v = asset.probe.video
  if (!v) throw new Error('That clip has no video track.')
  const window = clampWindow(req, asset.probe.durationSec || 0)

  const baseLabel = `Remove background · ${asset.fileName}`
  const onDevice = (d: MatteDevice): string => `${baseLabel} (${d === 'gpu' ? 'GPU' : 'CPU'})`
  const job = createJob('matte', baseLabel, req.subjectId ?? req.mediaId, { cancelable: true, uses: [req.mediaId] })
  const signal = job.signal!
  try {
    const ort = await loadOrt()
    let { session, device } = await bestSession(ort, modelPath)
    // Checked BEFORE any ffmpeg is spawned so a bad model can't leak children.
    assertRvm(session, modelPath)
    setLabel(job.id, onDevice(device))

    const { w, h } = matteDims(v.displayWidth, v.displayHeight)
    const fps = matteFps(v.avgFps || 30, req.minSpeed)
    const ratio = downsampleRatioFor(w, h)
    const frameBytes = w * h * 3
    const estTotal = Math.max(1, Math.round(fps * window.durationSec))

    // Recurrent state: zero on the first frame, then the model's own outputs fed
    // back each step for temporal stability. Created before spawning ffmpeg for
    // the same no-leak reason as the model check above.
    const zero = (): OrtTensor => new ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1])
    let r1 = zero()
    let r2 = zero()
    let r3 = zero()
    let r4 = zero()
    // downsample_ratio is a scalar the RVM export shapes as (1,); some exports use
    // a 0-d scalar. Start at (1,) and fall back to () once, on the first frame.
    const makeRatio = (dims: number[]): OrtTensor => new ort.Tensor('float32', new Float32Array([ratio]), dims)
    let ratioT = makeRatio([1])
    const srcData = new Float32Array(3 * w * h) // reused every frame

    /** The first frame settles what later frames reuse: the ratio's tensor shape
     *  and — on the GPU — that the device really runs this model. A DirectML
     *  failure falls back to the CPU session instead of failing the job. */
    const runFirst = async (feeds: Record<string, OrtTensor>): Promise<OrtOutputs> => {
      const tryShapes = async (s: OrtSession): Promise<OrtOutputs> => {
        try {
          return await s.run({ ...feeds, downsample_ratio: ratioT })
        } catch {
          ratioT = makeRatio([]) // retry once with a 0-d scalar shape
          return await s.run({ ...feeds, downsample_ratio: ratioT })
        }
      }
      try {
        return await tryShapes(session)
      } catch (err) {
        if (device !== 'gpu') throw err
        log.warn('GPU inference failed, retrying on the CPU', err)
        gpuUnusable = true
        session = await getSession(ort, modelPath, 'cpu')
        device = 'cpu'
        ratioT = makeRatio([1])
        setLabel(job.id, onDevice(device))
        return await tryShapes(session)
      }
    }

    const { ffmpeg } = await getBinaries()
    const tmpOut = join(getSubdir('tmp'), `nobg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`)
    const preFilter = v.isHdr ? hdrToSdrChain(v) : ''
    const audio = asset.probe.audio ? { input: asset.originalPath, window } : undefined

    // Both children die with the job's signal (cancel) — and on every error
    // route below, via the explicit kills in the catch.
    const decode = startFfmpeg(ffmpeg, buildMatteDecodeArgs(asset.originalPath, w, h, fps, preFilter, window), {
      signal
    })
    const encode = startFfmpeg(ffmpeg, buildMatteEncodeArgs(tmpOut, w, h, fps, audio), { signal })
    const ein = encode.child.stdin
    ein.on('error', () => {}) // swallow EPIPE if the encoder exits early

    let n = 0
    try {
      try {
        for await (const frame of rawFrames(decode.child.stdout, frameBytes)) {
          if (signal.aborted) throw new Error('Canceled.')
          const src = new ort.Tensor('float32', frameToSrcTensor(frame, w, h, srcData), [1, 3, h, w])
          const feeds = { src, r1i: r1, r2i: r2, r3i: r3, r4i: r4, downsample_ratio: ratioT }
          const out = n === 0 ? await runFirst(feeds) : await session.run(feeds)
          const rgba = compositeRgba(out.fgr.data as Float32Array, out.pha.data as Float32Array, w, h)
          r1 = out.r1o as OrtTensor
          r2 = out.r2o as OrtTensor
          r3 = out.r3o as OrtTensor
          r4 = out.r4o as OrtTensor
          if (!ein.write(rgba)) await once(ein, 'drain')
          n++
          if (n % 4 === 0) setProgress(job.id, Math.min(0.98, n / estTotal))
        }
      } catch (err) {
        if (signal.aborted) throw err
        const detail = err instanceof Error ? err.message : String(err)
        const decErr = decode.stderrTail()
        throw new Error(`Frame processing failed: ${detail}${decErr ? ` · ${decErr.slice(-300)}` : ''}`)
      }
      ein.end()
      await encode.exited
      await decode.exited
      if (n === 0) throw new Error('No frames were produced from the source.')
      if (signal.aborted) throw new Error('Canceled.')
    } catch (err) {
      // Kill whatever is still alive (a no-op for exited processes) and drop the
      // partial output so failed or canceled jobs leave nothing behind.
      decode.child.kill()
      encode.child.kill()
      await Promise.allSettled([decode.exited, encode.exited]) // release the file before rm
      await bestEffort(fsp.rm(tmpOut, { force: true }), 'removing the partial matte', log)
      throw err
    }

    // Content-address the result, then register it as a normal library asset.
    const span = `${clock(window.startSec)}–${clock(window.startSec + window.durationSec)}`
    const result = await importGenerated(tmpOut, `${parse(asset.fileName).name} (no bg ${span}).webm`, project)
    // Build the alpha (WebM) preview proxy before reporting done, so the caller
    // can swap the clip in and it plays at once. Its own job shows its progress.
    setLabel(job.id, `${onDevice(device)} · preparing preview`)
    const proxyReady =
      result.proxyReady ||
      (await ensureProxy(result.id, project).then(
        () => true,
        (e) => {
          log.error('alpha proxy failed', e)
          return false
        }
      ))
    // A cancel that lands after the last frame still wins: the finished asset
    // stays on disk (unreferenced, like any unused import) but is not handed
    // back, so nothing on the timeline changes.
    if (signal.aborted) throw new Error('Canceled.')
    const ready: MediaAsset = { ...result, proxyReady }
    finishJob(job.id, ready)
    return ready
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    if (signal.aborted) return null
    throw error
  }
}
