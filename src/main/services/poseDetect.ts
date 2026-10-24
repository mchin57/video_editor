/**
 * Body-pose detection: run the YOLOX person detector and RTMPose (Halpe26)
 * over ONE source window of a media item, frame by frame, group the people into
 * tracks, smooth them and save the result in the project folder
 * (`pose/<mediaId>.json`, shared/pose.ts `PoseData`). Clips then draw it in
 * source time, so it is detected once per media item, not per clip.
 *
 * Pipeline: ffmpeg decodes the window to upright BGR frames (≤1280px, at
 * `matteFps` — 30 per second of played time, more for slow-mo)
 * → per frame, the detector finds people → the pose model runs on each (up to
 * `MAX_PEOPLE`) → `trackPeople` + `smoothTrack` → keypoints scaled to the
 * source's display size → saved atomically. The pure model plumbing is in
 * poseModel.ts (unit-tested); this file is the orchestration.
 *
 * The job is cancelable: `cancelJob` aborts its signal, which kills the ffmpeg
 * child and stops the frame loop; nothing is written for a canceled run.
 */

import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import type { DetectPoseRequest, PoseAvailability } from '@shared/ipc'
import { bestEffort, createLogger } from '@shared/log'
import {
  compactKeypoints,
  rebasePoseData,
  smoothTrack,
  trackPeople,
  type Detection,
  type Keypoints,
  type PoseData
} from '@shared/pose'
import { getBinaries } from './ffmpeg'
import { startFfmpeg } from './ffmpegRun'
import { requireUsable } from './mediaStore'
import { requireSession, type ProjectSession } from './projectSession'
import { posePath } from './projectLayout'
import { hdrToSdrChain } from './proxy'
import { writeAtomically } from './atomicWrite'
import { activeJobUsing, createJob, failJob, finishJob, setLabel, setProgress } from './jobs'
import { buildMatteDecodeArgs, matteDims, matteFps, rawFrames } from './removeBackgroundArgs'
import {
  bestSession,
  fallBackToCpu,
  findModel,
  modelDirs,
  loadOrt,
  ortLoads,
  type InferenceDevice,
  type OrtModule,
  type OrtOutputs,
  type OrtSession
} from './onnx'
import {
  DETECTOR_PREFIX,
  DET_SIZE,
  POSE_H,
  POSE_PREFIX,
  POSE_W,
  decodeDetections,
  decodeSimcc,
  letterbox,
  poseCrop,
  toDetection,
  warpToPoseInput,
  type RawOutput
} from './poseModel'

/** Frames are decoded no bigger than this on the long edge — the detector
 *  sees 640px anyway, and the pose crops stay sharp. */
const POSE_MAX_EDGE = 1280
/** A person unseen for longer than this (seconds) ends their track. */
const TRACK_GAP_SEC = 0.7
const MODEL_LABEL = 'RTMPose-m Halpe26 + YOLOX-m'
const log = createLogger('pose')

/** The installed model files, or null for one that is missing. */
function poseModels(): { detector: string | null; pose: string | null } {
  return { detector: findModel(DETECTOR_PREFIX), pose: findModel(POSE_PREFIX) }
}

/** Feature gate for the Inspector: both models present and onnxruntime loads. */
export async function poseAvailable(): Promise<PoseAvailability> {
  const m = poseModels()
  const dirs = modelDirs()
  const modelsDir = dirs[dirs.length - 1] // the user's own (bundled first, if any)
  const missing = [
    ...(m.detector ? [] : [`${DETECTOR_PREFIX}….onnx (person detector)`]),
    ...(m.pose ? [] : [`${POSE_PREFIX}….onnx (pose model)`])
  ]
  if (missing.length) return { ready: false, missing, modelsDir }
  return (await ortLoads('pose detection'))
    ? { ready: true, missing: [], modelsDir }
    : { ready: false, missing: ['onnxruntime'], modelsDir }
}

/** The saved detection for a media item in a project (the open one by
 *  default — an export passes the session it started in), or null. */
export async function getPose(mediaId: string, s: ProjectSession = requireSession()): Promise<PoseData | null> {
  const file = posePath(s.root, mediaId)
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as PoseData
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null // not detected yet
    throw error
  }
}

/** One model on its best device, failing over to the CPU on its first run. */
class ModelRunner {
  private first = true
  constructor(
    private readonly ort: OrtModule,
    private readonly path: string,
    private session: OrtSession,
    public device: InferenceDevice
  ) {}

  static async open(ort: OrtModule, path: string): Promise<ModelRunner> {
    const { session, device } = await bestSession(ort, path)
    return new ModelRunner(ort, path, session, device)
  }

  async run(data: Float32Array, dims: number[]): Promise<RawOutput[]> {
    const feeds = { [this.session.inputNames[0]]: new this.ort.Tensor('float32', data, dims) }
    let out: OrtOutputs
    try {
      out = await this.session.run(feeds)
    } catch (err) {
      if (!this.first || this.device !== 'gpu') throw err
      this.session = await fallBackToCpu(this.ort, this.path, err)
      this.device = 'cpu'
      out = await this.session.run(feeds)
    }
    this.first = false
    return this.session.outputNames.map((n) => ({ dims: out[n].dims, data: out[n].data as RawOutput['data'] }))
  }
}

/**
 * Detect poses over the request's source window (grown to cover whatever was
 * already detected for the media, so other clips of it keep their coverage)
 * and save them. Resolves the saved data, or null when the job was canceled.
 */
export async function detectPose(req: DetectPoseRequest): Promise<PoseData | null> {
  const models = poseModels()
  if (!models.detector || !models.pose) throw new Error('The pose models are not installed.')
  const project = requireSession() // the detection lands in the project it started in
  const asset = await requireUsable(req.mediaId, project)
  const v = asset.probe.video
  if (!v) throw new Error('That clip has no video track.')
  // Two detections of one file would each grow the same old window and the
  // last to finish would drop the other's coverage: one at a time.
  if (activeJobUsing(req.mediaId)?.type === 'pose') throw new Error('This footage is already being detected.')
  const window = await coveringWindow(req, asset.probe.durationSec || 0)

  const baseLabel = `Detect pose · ${asset.fileName}`
  const job = createJob('pose', baseLabel, req.subjectId ?? req.mediaId, { cancelable: true, uses: [req.mediaId] })
  const signal = job.signal!
  try {
    const ort = await loadOrt()
    // Both sessions open before ffmpeg starts, so a bad model can't leak a child.
    const det = await ModelRunner.open(ort, models.detector)
    const pose = await ModelRunner.open(ort, models.pose)
    const device = (): string => (det.device === 'gpu' && pose.device === 'gpu' ? 'GPU' : 'CPU')
    setLabel(job.id, `${baseLabel} (${device()})`)

    const { w, h } = matteDims(v.displayWidth, v.displayHeight, POSE_MAX_EDGE)
    // Sampled like the matte: the export's 30 fps of PLAYED time — denser for
    // slow-mo (up to the source's own rate, 60 max), so a fast limb in a
    // slowed-down catch isn't interpolated across; in between, `trackAt` lerps.
    const fps = matteFps(v.avgFps || 30, req.minSpeed)
    const estTotal = Math.max(1, Math.round(fps * window.durationSec))
    const detIn = new Float32Array(3 * DET_SIZE * DET_SIZE)
    const poseIn = new Float32Array(3 * POSE_W * POSE_H)

    const { ffmpeg } = await getBinaries()
    const preFilter = v.isHdr ? hdrToSdrChain(v) : ''
    const decode = startFfmpeg(
      ffmpeg,
      buildMatteDecodeArgs(asset.originalPath, w, h, fps, preFilter, window, 'bgr24'),
      { signal }
    )
    const frames: Detection[][] = []
    try {
      for await (const frame of rawFrames(decode.child.stdout, w * h * 3)) {
        if (signal.aborted) throw new Error('Canceled.')
        const { tensor, ratio } = letterbox(frame, w, h, detIn)
        const boxes = decodeDetections(await det.run(tensor, [1, 3, DET_SIZE, DET_SIZE]), ratio, w, h)
        const people: Detection[] = []
        for (const box of boxes) {
          const crop = poseCrop(box)
          const out = await pose.run(warpToPoseInput(frame, w, h, crop, poseIn), [1, 3, POSE_H, POSE_W])
          people.push(toDetection(box, decodeSimcc(out, crop)))
        }
        frames.push(people)
        if (frames.length === 1) setLabel(job.id, `${baseLabel} (${device()})`)
        if (frames.length % 4 === 0) setProgress(job.id, Math.min(0.97, frames.length / estTotal))
      }
      await decode.exited
    } catch (err) {
      decode.child.kill()
      await Promise.allSettled([decode.exited])
      if (signal.aborted) throw err
      const detail = err instanceof Error ? err.message : String(err)
      const decErr = decode.stderrTail()
      throw new Error(`Pose detection failed: ${detail}${decErr ? ` · ${decErr.slice(-300)}` : ''}`)
    }
    if (frames.length === 0) throw new Error('No frames were decoded from the source.')
    if (signal.aborted) throw new Error('Canceled.')

    // People → tracks (in decode px), smoothed, then into the source's display px.
    const sx = (v.displayWidth || w) / w
    const sy = (v.displayHeight || h) / h
    const toSource = (k: Keypoints): Keypoints =>
      compactKeypoints(k.map((n, i) => (i % 3 === 0 ? n * sx : i % 3 === 1 ? n * sy : n)))
    const tracks = trackPeople(frames, w * h, Math.round(TRACK_GAP_SEC * fps)).map((t) => {
      const s = smoothTrack(t, fps)
      return { ...s, weight: Math.round(s.weight * 1000) / 1000, frames: s.frames.map((k) => (k ? toSource(k) : null)) }
    })
    const data: PoseData = {
      version: 1,
      mediaId: req.mediaId,
      startSec: window.startSec,
      durationSec: frames.length / fps,
      fps,
      frameCount: frames.length,
      width: v.displayWidth || w,
      height: v.displayHeight || h,
      model: MODEL_LABEL,
      tracks
    }
    const file = posePath(project.root, req.mediaId)
    await fsp.mkdir(dirname(file), { recursive: true })
    await writeAtomically(file, (part) => fsp.writeFile(part, JSON.stringify(data), 'utf8'))
    finishJob(job.id, null)
    return data
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    if (signal.aborted) return null
    throw error
  }
}

/** The window to detect: the request's, grown to include any window already
 *  detected for the media (re-detecting replaces the file), clamped to the source. */
async function coveringWindow(
  req: DetectPoseRequest,
  sourceSec: number
): Promise<{ startSec: number; durationSec: number }> {
  let start = Math.max(0, req.startSec)
  let end = start + Math.max(0, req.durationSec)
  // An unreadable old file just isn't grown from — but say why.
  const prev = await getPose(req.mediaId).catch((error: unknown) => {
    log.warn('the saved pose file could not be read; detecting the requested window only', error)
    return null
  })
  if (prev) {
    start = Math.min(start, prev.startSec)
    end = Math.max(end, prev.startSec + prev.durationSec)
  }
  if (sourceSec > 0) end = Math.min(end, sourceSec)
  if (!(end - start > 0)) throw new Error('That clip segment is empty.')
  return { startSec: start, durationSec: end - start }
}

/**
 * Give a re-rendered copy of a source window (a background-removed matte) the
 * source's detection, re-based onto it (`rebasePoseData`), so a clip swapped to
 * the copy keeps its skeleton. Best-effort: no detection means nothing to do,
 * and a failure is logged — the matte itself is already done.
 */
export async function carryPoseToCopy(
  sourceId: string,
  copyId: string,
  windowStartSec: number,
  size: { w: number; h: number },
  s: ProjectSession
): Promise<void> {
  const data = await getPose(sourceId, s).catch((error: unknown) => {
    log.warn('the source pose file could not be read; the matte gets none', error)
    return null
  })
  if (!data) return
  const file = posePath(s.root, copyId)
  await bestEffort(
    (async () => {
      await fsp.mkdir(dirname(file), { recursive: true })
      await writeAtomically(file, (part) =>
        fsp.writeFile(part, JSON.stringify(rebasePoseData(data, copyId, windowStartSec, size)), 'utf8')
      )
    })(),
    'carrying the pose detection to the matte',
    log
  )
}
