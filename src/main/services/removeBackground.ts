/**
 * Background removal ("subject-aware crop"): run the RVM video-matting model over
 * a source clip frame-by-frame in the main process and save the alpha result as a
 * NEW library asset — a transparent VP9 (yuva420p) WebM. The new clip composites
 * over whatever layers sit beneath it, in both preview and export, through the
 * normal video pipeline. Discovery mirrors whisper: the ONNX model is found under
 * the bundled models dir (installer) or <data>/bin/models (user-provided).
 *
 * Pipeline: ffmpeg decodes upright raw RGB frames → RVM (onnxruntime) emits a
 * foreground + alpha per frame (carrying recurrent state for temporal stability)
 * → a second ffmpeg encodes the straight-alpha RGBA frames to the WebM. The pure
 * frame/tensor + arg helpers live in removeBackgroundArgs.ts (unit-tested).
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, promises as fsp, readdirSync } from 'node:fs'
import { basename, join, parse } from 'node:path'
import type { Readable } from 'node:stream'
import type { MediaAsset } from '@shared/media'
import { getSubdir, getBundledModelsDir } from '../config'
import { getBinaries } from './ffmpeg'
import { getAsset, hashFile, importFile, ensureProxy } from './mediaStore'
import { hdrToSdrChain } from './proxy'
import { createJob, failJob, finishJob, setProgress } from './jobs'
import {
  buildMatteDecodeArgs,
  buildMatteEncodeArgs,
  compositeRgba,
  downsampleRatioFor,
  frameToSrcTensor,
  matteDims
} from './removeBackgroundArgs'

type OrtModule = typeof import('onnxruntime-node')
type OrtTensor = import('onnxruntime-node').Tensor
type OrtSession = import('onnxruntime-node').InferenceSession

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
  } catch {
    return false
  }
}

// onnxruntime-node is loaded lazily (native module) so a load failure can't crash
// the whole main process at import; the session is cached per model path.
let ortMod: OrtModule | null = null
const sessions = new Map<string, Promise<OrtSession>>()

async function loadOrt(): Promise<OrtModule> {
  if (!ortMod) ortMod = await import('onnxruntime-node')
  return ortMod
}

function getSession(ort: OrtModule, modelPath: string): Promise<OrtSession> {
  let s = sessions.get(modelPath)
  if (!s) {
    s = ort.InferenceSession.create(modelPath)
    sessions.set(modelPath, s)
  }
  return s
}

/** Yield fixed-size frames from a raw stream, honouring backpressure: the async
 *  iterator pauses the pipe between frames while inference/encoding runs. */
async function* rawFrames(stream: Readable, frameBytes: number): AsyncGenerator<Uint8Array> {
  let buf: Uint8Array = new Uint8Array(0)
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= frameBytes) {
      yield buf.subarray(0, frameBytes)
      buf = buf.subarray(frameBytes)
    }
  }
}

/**
 * Matte a source clip → a new transparent WebM library asset. Reports progress on
 * the jobs channel. Throws if the model is missing or the source has no video.
 */
export async function removeBackgroundToLibrary(mediaId: string): Promise<MediaAsset> {
  const modelPath = discoverMatteModel()
  if (!modelPath) throw new Error('Background-removal model is not installed (resources/models).')
  const asset = await getAsset(mediaId)
  if (!asset) throw new Error(`unknown media ${mediaId}`)
  const v = asset.probe.video
  if (!v) throw new Error('That clip has no video track.')

  const job = createJob('matte', `Remove background · ${asset.fileName}`, mediaId)
  try {
    const ort = await loadOrt()
    const session = await getSession(ort, modelPath)
    // Fail early and clearly if a non-RVM ONNX was dropped in (inputs: src,
    // r1i..r4i, downsample_ratio) — checked BEFORE any ffmpeg is spawned so a
    // bad model can't leak live child processes.
    if (!session.inputNames.includes('src') || !session.inputNames.includes('downsample_ratio')) {
      throw new Error(
        `"${basename(modelPath)}" is not a Robust Video Matting model (inputs: ${session.inputNames.join(', ')}).`
      )
    }

    const { w, h } = matteDims(v.displayWidth, v.displayHeight)
    const fps = Math.min(60, Math.max(1, Math.round(v.avgFps || 30)))
    const ratio = downsampleRatioFor(w, h)
    const frameBytes = w * h * 3
    const estTotal = Math.max(1, Math.round(fps * (asset.probe.durationSec || 0)))

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
    let ratioFixed = false

    const { ffmpeg } = await getBinaries()
    const tmpOut = join(getSubdir('tmp'), `nobg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`)
    const preFilter = v.isHdr ? hdrToSdrChain(v) : ''

    const decode = spawn(ffmpeg, buildMatteDecodeArgs(asset.originalPath, w, h, fps, preFilter), { windowsHide: true })
    const encode = spawn(ffmpeg, buildMatteEncodeArgs(tmpOut, w, h, fps), { windowsHide: true })
    const dout = decode.stdout
    const ein = encode.stdin
    if (!dout || !ein) throw new Error('Failed to open ffmpeg pipes.')

    let decErr = ''
    let encErr = ''
    decode.stderr?.on('data', (b: Buffer) => (decErr = (decErr + b).slice(-4000)))
    encode.stderr?.on('data', (b: Buffer) => (encErr = (encErr + b).slice(-4000)))
    ein.on('error', () => {}) // swallow EPIPE if the encoder exits early

    const encodeDone = new Promise<void>((resolve, reject) => {
      encode.on('error', reject)
      encode.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg encode exited ${code}: ${encErr.slice(-500)}`))
      )
    })
    void encodeDone.catch(() => {}) // mark handled; the real await is below
    const decodeExit = new Promise<number>((resolve) => {
      decode.on('error', () => resolve(-1))
      decode.on('close', (code) => resolve(code ?? -1))
    })

    let n = 0
    try {
      try {
        for await (const frame of rawFrames(dout, frameBytes)) {
          const src = new ort.Tensor('float32', frameToSrcTensor(frame, w, h), [1, 3, h, w])
          const feeds = { src, r1i: r1, r2i: r2, r3i: r3, r4i: r4, downsample_ratio: ratioT }
          let out: Awaited<ReturnType<OrtSession['run']>>
          if (ratioFixed) {
            out = await session.run(feeds)
          } else {
            try {
              out = await session.run(feeds)
            } catch {
              ratioT = makeRatio([]) // retry once with a 0-d scalar shape
              out = await session.run({ ...feeds, downsample_ratio: ratioT })
            }
            ratioFixed = true
          }
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
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(`Frame processing failed: ${detail}${decErr ? ` · ${decErr.slice(-300)}` : ''}`)
      }
      ein.end()
      await encodeDone
      const dcode = await decodeExit
      if (dcode !== 0) throw new Error(`ffmpeg decode exited ${dcode}: ${decErr.slice(-500)}`)
      if (n === 0) throw new Error('No frames were produced from the source.')
    } catch (err) {
      // Kill whatever is still alive (a no-op for exited processes) and drop the
      // partial output so failed jobs don't accumulate scratch files.
      decode.kill()
      encode.kill()
      await fsp.rm(tmpOut, { force: true }).catch(() => {})
      throw err
    }

    // Content-address the result, then register it as a normal library asset.
    const hash = await hashFile(tmpOut)
    const finalPath = join(getSubdir('nobg'), `${hash}.webm`)
    if (existsSync(finalPath)) await fsp.rm(tmpOut, { force: true })
    else await fsp.rename(tmpOut, finalPath)
    const result = await importFile(finalPath, `${parse(asset.fileName).name} (no bg).webm`)
    finishJob(job.id, result)
    // Build the alpha (WebM) preview proxy in the background so the library row
    // flips to "ready to drop on the timeline" when it finishes.
    if (!result.proxyReady) void ensureProxy(result.id).catch((e) => console.error('alpha proxy failed', e))
    return result
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}
