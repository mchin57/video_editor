/**
 * PURE pre/post-processing for the pose models (no onnx/node deps, so it's
 * unit-tested against synthetic tensors). Mirrors rtmlib's "body with feet"
 * pipeline (Apache-2.0, github.com/Tau-J/rtmlib), which these model files were
 * exported for:
 *
 *  - YOLOX-m person detector (HumanArt): the frame letterboxed into 640×640
 *    (top-left, padded with 114), raw 0–255 values, NCHW float32. Its output is
 *    either already non-max-suppressed (`dets` [1,N,5] + `labels`) or the raw
 *    anchor grid ([1,8400,85]); both are handled.
 *  - RTMPose-m Halpe26 (26 keypoints, 256×192): each person box, padded 1.25×
 *    and widened to the model's aspect, is warped into the input, normalised by
 *    ImageNet mean/std; SimCC outputs (x/y classification over 2× the input
 *    size) decode to keypoints by argmax.
 *
 * Frames arrive as BGR24 HWC (ffmpeg `-pix_fmt bgr24`) — OpenCV's order, which
 * is what rtmlib feeds both models.
 *
 * Verified against the real model files (2026-10-24, install steps in
 * mchin57/video_editor#201): the detector takes `input` [1,3,640,640] and
 * returns NMS-baked `dets` [1,N,5] + `labels` int64 [1,N]; the pose model takes
 * `input` [1,3,256,192] and returns `simcc_x` [1,26,384] + `simcc_y` [1,26,512].
 * On a real side-on bike clip the skeleton landed on the rider's joints (BGR
 * order and the Halpe26 keypoint order confirmed by eye). `e2e/poseDetect.spec.ts`
 * runs the real job when the models are installed.
 */

import type { Detection, Keypoints } from '@shared/pose'
import { KEYPOINTS } from '@shared/pose'

/** File-name prefixes the pose models are installed under (models dir). */
export const DETECTOR_PREFIX = 'yolox'
export const POSE_PREFIX = 'rtmpose'
export const POSE_MODEL_PREFIXES = [DETECTOR_PREFIX, POSE_PREFIX]

export const DET_SIZE = 640
const PAD_VALUE = 114
/** Score floor for a raw-grid detector (obj × class), and for a baked-NMS one. */
const DET_SCORE_RAW = 0.7
const DET_SCORE_BAKED = 0.3
const NMS_IOU = 0.45
/** People per frame the pose model runs on (largest first). */
export const MAX_PEOPLE = 6

export const POSE_W = 192
export const POSE_H = 256
const SIMCC_SPLIT = 2
const POSE_MEAN = [123.675, 116.28, 103.53]
const POSE_STD = [58.395, 57.12, 57.375]
const BOX_PADDING = 1.25

/** Bilinear sample of channel `c` at (x, y) in an HWC 3-channel frame; 0 outside. */
function sample(frame: Uint8Array, w: number, h: number, x: number, y: number, c: number): number {
  if (x < -1 || y < -1 || x > w || y > h) return 0
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const at = (xx: number, yy: number): number =>
    xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : frame[(yy * w + xx) * 3 + c]
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
  const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
  return top * (1 - fy) + bot * fy
}

/**
 * The detector input: the frame scaled by `ratio` (fit inside DET_SIZE²,
 * bilinear with pixel-centre alignment like cv2.resize) at the top-left of a
 * 114-grey square, as NCHW float32 0–255.
 */
export function letterbox(
  frame: Uint8Array,
  w: number,
  h: number,
  out = new Float32Array(3 * DET_SIZE * DET_SIZE)
): { tensor: Float32Array; ratio: number } {
  const ratio = Math.min(DET_SIZE / w, DET_SIZE / h)
  const rw = Math.round(w * ratio)
  const rh = Math.round(h * ratio)
  const plane = DET_SIZE * DET_SIZE
  out.fill(PAD_VALUE)
  for (let y = 0; y < rh; y++) {
    const sy = (y + 0.5) / ratio - 0.5
    for (let x = 0; x < rw; x++) {
      const sx = (x + 0.5) / ratio - 0.5
      const o = y * DET_SIZE + x
      for (let c = 0; c < 3; c++) out[c * plane + o] = sample(frame, w, h, sx, sy, c)
    }
  }
  return { tensor: out, ratio }
}

/** An ONNX output as the decoders need it. */
export interface RawOutput {
  dims: readonly number[]
  data: Float32Array | BigInt64Array | Int32Array
}

const iou = (a: number[], b: number[]): number => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const inter = ix * iy
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
  return union > 0 ? inter / union : 0
}

/** Greedy non-max suppression: indices of the boxes kept, best score first. */
export function nms(boxes: number[][], scores: number[], iouThr = NMS_IOU): number[] {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a])
  const keep: number[] = []
  for (const i of order) if (keep.every((k) => iou(boxes[k], boxes[i]) <= iouThr)) keep.push(i)
  return keep
}

/**
 * People in a frame from the detector's outputs: boxes in frame px (clipped
 * to it), best first, at most `MAX_PEOPLE`. Takes either export of YOLOX — the
 * NMS-baked one (`[1,N,5]` boxes + scores, optional labels) or the raw anchor
 * grid (`[1,A,5+classes]`, decoded over strides 8/16/32 and suppressed here) —
 * and keeps the PERSON class (0) only.
 */
export function decodeDetections(outputs: RawOutput[], ratio: number, w: number, h: number): number[][] {
  const clip = (b: number[]): number[] => [
    Math.max(0, Math.min(w, b[0] / ratio)),
    Math.max(0, Math.min(h, b[1] / ratio)),
    Math.max(0, Math.min(w, b[2] / ratio)),
    Math.max(0, Math.min(h, b[3] / ratio))
  ]
  const valid = (b: number[]): boolean => b[2] - b[0] > 4 && b[3] - b[1] > 4
  const dets = outputs.find((o) => o.dims[o.dims.length - 1] === 5)
  if (dets) {
    const n = dets.dims[dets.dims.length - 2]
    const labels = outputs.find((o) => o !== dets && o.dims.length === 2 && o.dims[1] === n)
    const out: { box: number[]; score: number }[] = []
    for (let i = 0; i < n; i++) {
      const d = Array.from(dets.data.slice(i * 5, i * 5 + 5), Number)
      if (labels && Number(labels.data[i]) !== 0) continue
      if (d[4] <= DET_SCORE_BAKED) continue
      const box = clip(d)
      if (valid(box)) out.push({ box, score: d[4] })
    }
    return out
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PEOPLE)
      .map((o) => o.box)
  }
  const raw = outputs[0]
  const stride = raw.dims[raw.dims.length - 1]
  const anchors = raw.dims[raw.dims.length - 2]
  const boxes: number[][] = []
  const scores: number[] = []
  let a = 0
  for (const s of [8, 16, 32]) {
    const g = DET_SIZE / s
    for (let gy = 0; gy < g; gy++) {
      for (let gx = 0; gx < g; gx++, a++) {
        if (a >= anchors) break
        const o = a * stride
        const score = Number(raw.data[o + 4]) * Number(raw.data[o + 5]) // objectness × person
        if (score <= DET_SCORE_RAW) continue
        const cx = (Number(raw.data[o]) + gx) * s
        const cy = (Number(raw.data[o + 1]) + gy) * s
        const bw = Math.exp(Number(raw.data[o + 2])) * s
        const bh = Math.exp(Number(raw.data[o + 3])) * s
        const box = clip([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2])
        if (!valid(box)) continue
        boxes.push(box)
        scores.push(score)
      }
    }
  }
  return nms(boxes, scores)
    .slice(0, MAX_PEOPLE)
    .map((i) => boxes[i])
}

/** A person box as the pose model's crop: centre, and size padded 1.25× then
 *  widened or heightened to the input's 192:256 aspect. */
export function poseCrop(box: number[]): { cx: number; cy: number; sw: number; sh: number } {
  const cx = (box[0] + box[2]) / 2
  const cy = (box[1] + box[3]) / 2
  let sw = (box[2] - box[0]) * BOX_PADDING
  let sh = (box[3] - box[1]) * BOX_PADDING
  const aspect = POSE_W / POSE_H
  if (sw > sh * aspect) sh = sw / aspect
  else sw = sh * aspect
  return { cx, cy, sw, sh }
}

/**
 * The pose input for one crop: output pixel (u, v) samples the frame at
 * `centre + (u - W/2, v - H/2) · (crop / input)` — cv2.warpAffine's mapping for
 * rtmlib's warp matrix — bilinear, black outside the frame, then normalised
 * per channel (index order, as rtmlib applies it), NCHW float32.
 */
export function warpToPoseInput(
  frame: Uint8Array,
  w: number,
  h: number,
  crop: { cx: number; cy: number; sw: number },
  out = new Float32Array(3 * POSE_W * POSE_H)
): Float32Array {
  const k = crop.sw / POSE_W
  const plane = POSE_W * POSE_H
  for (let v = 0; v < POSE_H; v++) {
    const y = crop.cy + (v - POSE_H / 2) * k
    for (let u = 0; u < POSE_W; u++) {
      const x = crop.cx + (u - POSE_W / 2) * k
      const o = v * POSE_W + u
      for (let c = 0; c < 3; c++) out[c * plane + o] = (sample(frame, w, h, x, y, c) - POSE_MEAN[c]) / POSE_STD[c]
    }
  }
  return out
}

/**
 * Keypoints from the SimCC outputs: per keypoint, the argmax along x
 * (`[1,K,2W]`) and y (`[1,K,2H]`) is its position at half-pixel resolution,
 * and the mean of the two maxima its score; mapped back through the crop to
 * frame px. Which output is x is told apart by length (2·192 vs 2·256).
 */
export function decodeSimcc(outputs: RawOutput[], crop: { cx: number; cy: number; sw: number; sh: number }): Keypoints {
  const byLen = (len: number): RawOutput | undefined => outputs.find((o) => o.dims[o.dims.length - 1] === len)
  const ox = byLen(POSE_W * SIMCC_SPLIT)
  const oy = byLen(POSE_H * SIMCC_SPLIT)
  if (!ox || !oy)
    throw new Error(`Unexpected pose-model outputs: ${outputs.map((o) => `[${o.dims.join(',')}]`).join(' ')}`)
  const lx = POSE_W * SIMCC_SPLIT
  const ly = POSE_H * SIMCC_SPLIT
  const argmax = (data: RawOutput['data'], off: number, len: number): [number, number] => {
    let best = 0
    let val = -Infinity
    for (let i = 0; i < len; i++) {
      const v = Number(data[off + i])
      if (v > val) {
        val = v
        best = i
      }
    }
    return [best, val]
  }
  const out: Keypoints = []
  for (let kpi = 0; kpi < KEYPOINTS; kpi++) {
    const [xi, xv] = argmax(ox.data, kpi * lx, lx)
    const [yi, yv] = argmax(oy.data, kpi * ly, ly)
    const score = 0.5 * (xv + yv)
    const x = (xi / SIMCC_SPLIT / POSE_W) * crop.sw + crop.cx - crop.sw / 2
    const y = (yi / SIMCC_SPLIT / POSE_H) * crop.sh + crop.cy - crop.sh / 2
    out.push(x, y, score > 0 ? score : 0)
  }
  return out
}

/** One frame's detections, as the tracker takes them. */
export const toDetection = (box: number[], kps: Keypoints): Detection => ({
  box: [box[0], box[1], box[2], box[3]],
  kps
})
