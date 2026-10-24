/**
 * Pose overlay: body keypoints detected on a video clip (main's
 * `services/poseDetect.ts`, RTMPose Halpe26 + a YOLOX person detector), and how
 * they're drawn on it. ONE implementation shared by the preview and the export:
 *
 *  - The DATA is per media file, sampled in SOURCE time (`PoseData`, saved in
 *    the project folder). A clip looks it up through its own source-time mapping
 *    (`videoSourceTime`), so trims, splits, freezes and speed ramps just work.
 *  - Detections are grouped into people by `trackPeople` (stable ids across
 *    frames, bridging short gaps), then smoothed (`smoothTrack`, One-Euro).
 *  - A clip's SETTINGS (`PoseSettings`, on `VideoContent.pose`) pick which
 *    people show (a person may be several tracks re-joined), their colours and
 *    which joint angles are labelled.
 *  - `poseShapes` turns one person at one instant into the same SVG pieces
 *    graphics marks are made of (`shared/graphics.ts`), in the clip's VIEW
 *    space — its crop, mirrored by its flips, sized as its box at zoom 1 — so
 *    the overlay scales, moves and rotates with the clip on both sides.
 */

import { angleMark, markShapes, type MarkShape, type Pt } from './graphics'
import { rotateVec } from './rotation'
import { containBox } from './layers'
import type { VideoContent } from './project'

// --- The keypoint layout (Halpe26) ----------------------------------------------

/** Halpe26 keypoints in model output order. */
export const HALPE26 = [
  'nose',
  'leftEye',
  'rightEye',
  'leftEar',
  'rightEar',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'leftHip',
  'rightHip',
  'leftKnee',
  'rightKnee',
  'leftAnkle',
  'rightAnkle',
  'head',
  'neck',
  'hip',
  'leftBigToe',
  'rightBigToe',
  'leftSmallToe',
  'rightSmallToe',
  'leftHeel',
  'rightHeel'
] as const
export type KeypointName = (typeof HALPE26)[number]
export const KEYPOINTS = HALPE26.length
const kp = (name: KeypointName): number => HALPE26.indexOf(name)

/** The coaching skeleton: limbs, torso, feet and the head on the neck (the
 *  face points are left out — they clutter a body overlay). */
export const POSE_LINKS: [number, number][] = [
  ['head', 'neck'],
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle'],
  ['leftAnkle', 'leftHeel'],
  ['leftAnkle', 'leftBigToe'],
  ['leftHeel', 'leftBigToe'],
  ['rightAnkle', 'rightHeel'],
  ['rightAnkle', 'rightBigToe'],
  ['rightHeel', 'rightBigToe']
].map(([a, b]) => [kp(a as KeypointName), kp(b as KeypointName)])

/** Points drawn as joint dots (every skeleton end). */
export const POSE_JOINTS: number[] = [...new Set(POSE_LINKS.flat())]

/** A joint angle: measured AT `vertex`, between the limbs to `a` and `b`. */
export interface PoseAngleDef {
  id: PoseAngleId
  label: string
  a: number
  vertex: number
  b: number
}
export const POSE_ANGLE_IDS = [
  'leftKnee',
  'rightKnee',
  'leftHip',
  'rightHip',
  'leftElbow',
  'rightElbow',
  'leftShoulder',
  'rightShoulder',
  'leftAnkle',
  'rightAnkle'
] as const
export type PoseAngleId = (typeof POSE_ANGLE_IDS)[number]

const angle = (id: PoseAngleId, label: string, a: KeypointName, v: KeypointName, b: KeypointName): PoseAngleDef => ({
  id,
  label,
  a: kp(a),
  vertex: kp(v),
  b: kp(b)
})
export const POSE_ANGLES: Record<PoseAngleId, PoseAngleDef> = {
  leftKnee: angle('leftKnee', 'L knee', 'leftHip', 'leftKnee', 'leftAnkle'),
  rightKnee: angle('rightKnee', 'R knee', 'rightHip', 'rightKnee', 'rightAnkle'),
  leftHip: angle('leftHip', 'L hip', 'leftShoulder', 'leftHip', 'leftKnee'),
  rightHip: angle('rightHip', 'R hip', 'rightShoulder', 'rightHip', 'rightKnee'),
  leftElbow: angle('leftElbow', 'L elbow', 'leftShoulder', 'leftElbow', 'leftWrist'),
  rightElbow: angle('rightElbow', 'R elbow', 'rightShoulder', 'rightElbow', 'rightWrist'),
  leftShoulder: angle('leftShoulder', 'L shoulder', 'leftHip', 'leftShoulder', 'leftElbow'),
  rightShoulder: angle('rightShoulder', 'R shoulder', 'rightHip', 'rightShoulder', 'rightElbow'),
  leftAnkle: angle('leftAnkle', 'L ankle', 'leftKnee', 'leftAnkle', 'leftBigToe'),
  rightAnkle: angle('rightAnkle', 'R ankle', 'rightKnee', 'rightAnkle', 'rightBigToe')
}

/** One-click angle sets per discipline. */
export const POSE_PRESETS: { id: 'swim' | 'bike' | 'run'; label: string; angles: PoseAngleId[] }[] = [
  { id: 'swim', label: 'Swim', angles: ['leftElbow', 'rightElbow', 'leftShoulder', 'rightShoulder'] },
  { id: 'bike', label: 'Bike', angles: ['leftKnee', 'rightKnee', 'leftHip', 'rightHip', 'leftAnkle', 'rightAnkle'] },
  { id: 'run', label: 'Run', angles: ['leftKnee', 'rightKnee', 'leftHip', 'rightHip', 'leftElbow', 'rightElbow'] }
]

/** Colours handed to the 1st, 2nd, … person picked. */
export const PERSON_COLORS = ['#FFD60A', '#33D1FF', '#FF4FD8', '#7CFF4F', '#FF8A33', '#B48CFF']
/** Below this model score a keypoint is hidden rather than drawn wrong (an arm
 *  under the water, a leg behind the bike). */
export const POSE_MIN_SCORE = 0.3
/** An angle is a NUMBER a coach reads, so its three joints must clear a
 *  stricter bar than a line on the skeleton. Measured on a side-on bike clip:
 *  the near leg scored ~0.75, the hidden far knee/ankle ~0.36–0.41 — enough
 *  to sketch the far leg, not to print a misleading degree over the near one. */
export const POSE_ANGLE_MIN_SCORE = 0.5

/** Whether an angle is labelled for these keypoints: all three joints sure. */
export const angleSure = (k: Keypoints, d: Pick<PoseAngleDef, 'a' | 'vertex' | 'b'>): boolean =>
  [d.a, d.vertex, d.b].every((i) => k[i * 3 + 2] >= POSE_ANGLE_MIN_SCORE)
/** Stroke width of a new overlay, logical px (at the clip's zoom 1). */
export const POSE_DEFAULT_WIDTH = 6

// --- Data (per media, source time) ------------------------------------------------

/** One person's keypoints at one instant: `[x, y, score]` × 26, source px. */
export type Keypoints = number[]

/** One tracked person: a run of frames (null = not seen in that frame). */
export interface PoseTrack {
  id: number
  /** Frame index of `frames[0]`. */
  first: number
  frames: (Keypoints | null)[]
  /** How prominent the person is: Σ box area / frame area over the frames
   *  seen. The default pick is the heaviest track. */
  weight: number
}

/** The saved detection for one media file. */
export interface PoseData {
  version: 1
  mediaId: string
  /** The source window detected, seconds. */
  startSec: number
  durationSec: number
  /** Sampling rate in SOURCE time (frame i is at `startSec + i / fps`). */
  fps: number
  frameCount: number
  /** The upright source picture the keypoints are in, px. */
  width: number
  height: number
  /** What produced it (shown in the Inspector). */
  model: string
  tracks: PoseTrack[]
}

/** A person on a clip: one or more tracks (re-joined after a break). */
export interface PosePerson {
  tracks: number[]
  color: string
}

/** A video clip's pose overlay (`VideoContent.pose`). */
export interface PoseSettings {
  /** Drawn at all (off keeps the picks for later). */
  show: boolean
  people: PosePerson[]
  angles: PoseAngleId[]
  /** Stroke width, logical px at the clip's zoom 1. */
  widthPx: number
}

/** A clip's starting overlay for `data`: the most prominent person, no angles. */
export function defaultPoseSettings(
  data: Pick<PoseData, 'tracks' | 'startSec' | 'fps'>,
  window?: { inSec: number; outSec: number }
): PoseSettings {
  // Ranked within the clip's own footage: a detection grown to cover other
  // clips may hold someone who never appears in this one.
  const rank = (t: PoseTrack): number => {
    const seen = t.frames.filter(Boolean).length || 1
    return window ? (t.weight * trackPresence(data, t, window.inSec, window.outSec).seen) / seen : t.weight
  }
  const top = [...data.tracks].filter((t) => rank(t) > 0).sort((a, b) => rank(b) - rank(a))[0]
  return {
    show: true,
    people: top ? [{ tracks: [top.id], color: PERSON_COLORS[0] }] : [],
    angles: [],
    widthPx: POSE_DEFAULT_WIDTH
  }
}

/** How much of a source window a track is seen in: frames seen there, and as
 *  a fraction of the window's frames (what the Inspector shows as "% of the clip"). */
export function trackPresence(
  data: Pick<PoseData, 'startSec' | 'fps'>,
  t: PoseTrack,
  inSec: number,
  outSec: number
): { seen: number; fraction: number } {
  const f0 = Math.max(0, Math.round((inSec - data.startSec) * data.fps))
  const f1 = Math.max(f0, Math.round((outSec - data.startSec) * data.fps))
  let seen = 0
  for (let f = Math.max(f0, t.first); f < Math.min(f1, t.first + t.frames.length); f++)
    if (t.frames[f - t.first]) seen++
  return { seen, fraction: f1 > f0 ? seen / (f1 - f0) : 0 }
}

/** Mean distance between two poses over the keypoints both are sure of
 *  (Infinity when they share fewer than 4). */
function poseDistance(a: Keypoints, b: Keypoints): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < KEYPOINTS; i++) {
    if (a[i * 3 + 2] < POSE_MIN_SCORE || b[i * 3 + 2] < POSE_MIN_SCORE) continue
    sum += Math.hypot(a[i * 3] - b[i * 3], a[i * 3 + 1] - b[i * 3 + 1])
    n++
  }
  return n >= 4 ? sum / n : Infinity
}

/**
 * Which new track is each old one, after a re-detection renumbered everyone
 * (a grown window changes the order people first appear in): at every frame
 * of the new detection, an old track and a new one whose poses lie within a
 * few percent of the picture of each other count as one sighting together;
 * pairs are then matched one-to-one, most sightings first. An old track never
 * matched is absent from the map.
 */
export function remapTracks(prev: PoseData, next: PoseData): Map<number, number> {
  const near = 0.04 * Math.max(next.width, next.height)
  const together = new Map<string, number>()
  for (let f = 0; f < next.frameCount; f++) {
    const t = next.startSec + f / next.fps
    for (const nt of next.tracks) {
      const nk = trackFrame(nt, f)
      if (!nk) continue
      for (const ot of prev.tracks) {
        const ok = trackAt(prev, ot, t)
        if (ok && poseDistance(ok, nk) < near) {
          const key = `${ot.id}:${nt.id}`
          together.set(key, (together.get(key) ?? 0) + 1)
        }
      }
    }
  }
  const pairs = [...together].sort((a, b) => b[1] - a[1])
  const map = new Map<number, number>()
  const taken = new Set<number>()
  for (const [key] of pairs) {
    const [o, n] = key.split(':').map(Number)
    if (map.has(o) || taken.has(n)) continue
    map.set(o, n)
    taken.add(n)
  }
  return map
}

/** A clip's picks carried over a re-detection through `remapTracks`' map:
 *  tracks renamed, any with no match dropped, people left empty removed. */
export function remapPicks(s: PoseSettings, map: Map<number, number>): PoseSettings {
  const people = s.people
    .map((p) => ({ ...p, tracks: p.tracks.flatMap((t) => (map.has(t) ? [map.get(t)!] : [])) }))
    .filter((p) => p.tracks.length > 0)
  return { ...s, people }
}

/**
 * The detection re-based onto a re-rendered copy of a source window (a
 * background-removed matte: its t=0 is source second `windowStartSec`, its
 * picture `size` px — the source scaled): times shift back by the window start
 * and positions scale, so the same people (same track ids — a clip's picks
 * carry straight over) stand where they do in the copy.
 */
export function rebasePoseData(
  data: PoseData,
  mediaId: string,
  windowStartSec: number,
  size: { w: number; h: number }
): PoseData {
  const kx = size.w / data.width
  const ky = size.h / data.height
  const scale = (k: Keypoints): Keypoints =>
    compactKeypoints(k.map((v, i) => (i % 3 === 0 ? v * kx : i % 3 === 1 ? v * ky : v)))
  return {
    ...data,
    mediaId,
    startSec: data.startSec - windowStartSec,
    width: size.w,
    height: size.h,
    tracks: data.tracks.map((t) => ({ ...t, frames: t.frames.map((k) => (k ? scale(k) : null)) }))
  }
}

/** The next colour for a newly picked person. */
export const nextPersonColor = (s: Pick<PoseSettings, 'people'>): string =>
  PERSON_COLORS.find((c) => !s.people.some((p) => p.color === c)) ??
  PERSON_COLORS[s.people.length % PERSON_COLORS.length]

/** Show or hide one tracked person: a track already picked leaves (its
 *  person goes with it once empty); a new one becomes a person of its own. */
export function togglePersonTrack(s: PoseSettings, trackId: number): PoseSettings {
  const owner = s.people.findIndex((p) => p.tracks.includes(trackId))
  if (owner < 0) return { ...s, people: [...s.people, { tracks: [trackId], color: nextPersonColor(s) }] }
  const people = s.people
    .map((p, i) => (i === owner ? { ...p, tracks: p.tracks.filter((t) => t !== trackId) } : p))
    .filter((p) => p.tracks.length > 0)
  return { ...s, people }
}

/** "This is also them": add a track to picked person `index` (taking it from
 *  any other person that had it), e.g. after they were lost behind a lane rope. */
export function joinTrack(s: PoseSettings, trackId: number, index: number): PoseSettings {
  if (index < 0 || index >= s.people.length) return s
  const people = s.people
    .map((p, i) =>
      i === index
        ? { ...p, tracks: p.tracks.includes(trackId) ? p.tracks : [...p.tracks, trackId] }
        : { ...p, tracks: p.tracks.filter((t) => t !== trackId) }
    )
    .filter((p) => p.tracks.length > 0)
  return { ...s, people }
}

/** The picks that still exist in `data` (a re-detection renumbers tracks):
 *  unknown tracks dropped, empty people removed. Returns `s` when unchanged. */
export function validPicks(s: PoseSettings, data: Pick<PoseData, 'tracks'>): PoseSettings {
  const ids = new Set(data.tracks.map((t) => t.id))
  const people = s.people
    .map((p) => ({ ...p, tracks: p.tracks.filter((t) => ids.has(t)) }))
    .filter((p) => p.tracks.length)
  const same =
    people.length === s.people.length && people.every((p, i) => p.tracks.length === s.people[i].tracks.length)
  return same ? s : { ...s, people }
}

/** A track's keypoints at frame `f` (null = not seen then / outside its run). */
function trackFrame(t: PoseTrack, f: number): Keypoints | null {
  return f >= t.first && f < t.first + t.frames.length ? t.frames[f - t.first] : null
}

const lerpKps = (a: Keypoints, b: Keypoints, u: number): Keypoints => a.map((v, i) => v + (b[i] - v) * u)

/**
 * A track's keypoints at source second `sourceSec`, interpolated between the
 * two frames around it (a slowed-down clip shows in-between poses rather than
 * stepping); null outside the detected window or when the track isn't seen.
 */
export function trackAt(data: PoseData, track: PoseTrack, sourceSec: number): Keypoints | null {
  const pos = (sourceSec - data.startSec) * data.fps
  if (pos < -0.5 || pos > data.frameCount - 0.5) return null
  const f0 = Math.max(0, Math.min(data.frameCount - 1, Math.floor(pos)))
  const u = Math.min(1, Math.max(0, pos - f0))
  const a = trackFrame(track, f0)
  const b = trackFrame(track, f0 + 1)
  if (a && b) return lerpKps(a, b, u)
  // One side missing (the track's edge, or a dropped frame): the nearer frame
  // if it was seen, else nothing — never stretch a pose across a gap.
  return u < 0.5 ? a : b
}

/** A person (its tracks, in order) at `sourceSec`: the first track seen then. */
export function personAt(data: PoseData, person: Pick<PosePerson, 'tracks'>, sourceSec: number): Keypoints | null {
  for (const id of person.tracks) {
    const t = data.tracks.find((x) => x.id === id)
    const k = t ? trackAt(data, t, sourceSec) : null
    if (k) return k
  }
  return null
}

/** Whether the detection covers a clip's source window (re-detect if not). */
export function poseCovers(data: Pick<PoseData, 'startSec' | 'durationSec'>, inSec: number, outSec: number): boolean {
  const EPS = 1 / 60
  return inSec >= data.startSec - EPS && outSec <= data.startSec + data.durationSec + EPS
}

// --- Tracking & smoothing (run once, after detection) --------------------------------

/** One detected person in one frame: its box (x1, y1, x2, y2 source px) and keypoints. */
export interface Detection {
  box: [number, number, number, number]
  kps: Keypoints
}

const iou = (a: Detection['box'], b: Detection['box']): number => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const inter = ix * iy
  const area = (r: Detection['box']): number => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
  const union = area(a) + area(b) - inter
  return union > 0 ? inter / union : 0
}

/** How alike two boxes are for tracking: overlap, or — for a fast mover whose
 *  boxes no longer overlap frame to frame — closeness relative to its size. */
function boxAffinity(prev: Detection['box'], next: Detection['box']): number {
  const o = iou(prev, next)
  if (o > 0) return o
  const reach = Math.max(prev[2] - prev[0], prev[3] - prev[1], 1) * 0.5
  const d = Math.hypot((prev[0] + prev[2] - next[0] - next[2]) / 2, (prev[1] + prev[3] - next[1] - next[3]) / 2)
  // Within half its size: a match, ranked under any real overlap.
  return d < reach ? MIN_AFFINITY + 0.05 * (1 - d / reach) : 0
}

/** Below this a detection starts a new person instead of continuing one. */
const MIN_AFFINITY = 0.02

/**
 * Group per-frame detections into people. Greedy, best match first: each
 * detection continues the live track whose last box it overlaps most; a track
 * unseen for more than `maxGap` frames ends (a person who walks off and comes
 * back later gets a new id — the Inspector lets you re-join them). Ids are
 * 1, 2, … in order of first appearance.
 */
export function trackPeople(frames: Detection[][], frameArea: number, maxGap: number): PoseTrack[] {
  interface Live {
    track: PoseTrack
    lastBox: Detection['box']
    lastFrame: number
  }
  const live: Live[] = []
  const done: PoseTrack[] = []
  let nextId = 1
  frames.forEach((dets, f) => {
    // Retire tracks that have been gone too long.
    for (let i = live.length - 1; i >= 0; i--) {
      if (f - live[i].lastFrame > maxGap + 1) done.push(live.splice(i, 1)[0].track)
    }
    const pairs: { t: number; d: number; a: number }[] = []
    live.forEach((l, t) => dets.forEach((det, d) => pairs.push({ t, d, a: boxAffinity(l.lastBox, det.box) })))
    pairs.sort((x, y) => y.a - x.a)
    const usedT = new Set<number>()
    const usedD = new Set<number>()
    for (const p of pairs) {
      if (p.a < MIN_AFFINITY || usedT.has(p.t) || usedD.has(p.d)) continue
      usedT.add(p.t)
      usedD.add(p.d)
      const l = live[p.t]
      const det = dets[p.d]
      while (l.track.first + l.track.frames.length < f) l.track.frames.push(null)
      l.track.frames.push(det.kps)
      l.track.weight += boxArea(det.box) / frameArea
      l.lastBox = det.box
      l.lastFrame = f
    }
    dets.forEach((det, d) => {
      if (usedD.has(d)) return
      live.push({
        track: { id: nextId++, first: f, frames: [det.kps], weight: boxArea(det.box) / frameArea },
        lastBox: det.box,
        lastFrame: f
      })
    })
  })
  return [...done, ...live.map((l) => l.track)].sort((a, b) => a.id - b.id)
}

const boxArea = (b: Detection['box']): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])

/**
 * One-Euro filter (Casiez et al.): a low-pass whose cutoff rises with speed, so
 * a still joint stops jittering while a fast one doesn't lag. Applied per
 * coordinate along each continuous run of a track (a gap restarts it). Scores
 * are left as they are.
 */
export function smoothTrack(track: PoseTrack, fps: number, minCutoff = 1.0, beta = 0.004): PoseTrack {
  const alpha = (cutoff: number): number => {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau * fps)
  }
  const dAlpha = alpha(1)
  const n = KEYPOINTS * 3
  let x: number[] | null = null
  let dx: number[] = []
  const frames = track.frames.map((k) => {
    if (!k) {
      x = null
      return null
    }
    if (!x) {
      x = k.slice()
      dx = new Array(n).fill(0)
      return k.slice()
    }
    const prev: number[] = x
    const out = k.slice()
    for (let i = 0; i < n; i++) {
      if (i % 3 === 2) continue // score
      const d = (k[i] - prev[i]) * fps
      dx[i] = dx[i] + dAlpha * (d - dx[i])
      const a = alpha(minCutoff + beta * Math.abs(dx[i]))
      out[i] = prev[i] + a * (k[i] - prev[i])
    }
    x = out
    return out
  })
  return { ...track, frames }
}

/** Rounded for saving (0.1 px, scores to 0.01) — keeps a minute's file small. */
export function compactKeypoints(k: Keypoints): Keypoints {
  return k.map((v, i) => (i % 3 === 2 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10))
}

// --- Drawing ---------------------------------------------------------------------

/**
 * The clip's VIEW space the overlay is drawn in: its crop of the source (or the
 * whole picture), mirrored by its flips, scaled to `size` — the clip's box at
 * zoom 1 in logical px. Stroke widths and label sizes are logical px in this
 * space, so the overlay zooms with the clip like everything else on it.
 */
export interface PoseView {
  crop: { x: number; y: number; w: number; h: number }
  flipH?: boolean
  flipV?: boolean
  size: { w: number; h: number }
}

/**
 * The view a video clip draws its overlay in: its crop (display px, rescaled
 * to the detection's px — the same picture, possibly decoded smaller) and
 * flips, sized as its box at zoom 1 (`containBox`) — so the preview's SVG
 * filling the box and the export's overlay sized to it agree.
 */
export function clipPoseView(
  c: Pick<VideoContent, 'crop' | 'flipH' | 'flipV'>,
  data: Pick<PoseData, 'width' | 'height'>,
  display: { w: number; h: number }
): PoseView {
  const kx = data.width / (display.w || data.width)
  const ky = data.height / (display.h || data.height)
  const crop = c.crop
    ? { x: c.crop.x * kx, y: c.crop.y * ky, w: c.crop.w * kx, h: c.crop.h * ky }
    : { x: 0, y: 0, w: data.width, h: data.height }
  const size = containBox(crop.w / crop.h, 1)
  return { crop, flipH: c.flipH, flipV: c.flipV, size: { w: size.w, h: size.h } }
}

/** Source px → view units. */
export function toView(v: PoseView, x: number, y: number): Pt {
  let u = ((x - v.crop.x) / v.crop.w) * v.size.w
  let w = ((y - v.crop.y) / v.crop.h) * v.size.h
  if (v.flipH) u = v.size.w - u
  if (v.flipV) w = v.size.h - w
  return { x: u, y: w }
}

/**
 * One person's overlay at one instant, as SVG pieces in view space: the
 * skeleton's links and joint dots (hiding any keypoint under
 * `POSE_MIN_SCORE`), then each chosen angle drawn exactly like a graphics
 * angle mark (arc + degree label) at its joint.
 */
export function poseShapes(
  k: Keypoints,
  color: string,
  settings: Pick<PoseSettings, 'angles' | 'widthPx'>,
  view: PoseView
): MarkShape[] {
  const seen = (i: number): boolean => k[i * 3 + 2] >= POSE_MIN_SCORE
  const at = (i: number): Pt => toView(view, k[i * 3], k[i * 3 + 1])
  const f2 = (n: number): string => (Math.round(n * 100) / 100).toString()
  const w = settings.widthPx
  const out: MarkShape[] = []
  const links = POSE_LINKS.filter(([a, b]) => seen(a) && seen(b))
  if (links.length) {
    out.push({
      kind: 'path',
      d: links
        .map(([a, b]) => {
          const p = at(a)
          const q = at(b)
          return `M${f2(p.x)} ${f2(p.y)} L${f2(q.x)} ${f2(q.y)}`
        })
        .join(' '),
      stroke: color,
      strokeWidth: w,
      fill: null
    })
  }
  // A zero-length round-capped stroke is a dot.
  const dots = POSE_JOINTS.filter(seen).map((i) => {
    const p = at(i)
    return `M${f2(p.x)} ${f2(p.y)} L${f2(p.x)} ${f2(p.y)}`
  })
  if (dots.length) out.push({ kind: 'path', d: dots.join(' '), stroke: '#FFFFFF', strokeWidth: w * 1.8, fill: null })
  // Most confident first; an angle whose label would land on one already
  // placed is left out — side-on, both hips (or knees) can sit on the same
  // spot and print two numbers over each other.
  const conf = (d: PoseAngleDef): number => k[d.a * 3 + 2] + k[d.vertex * 3 + 2] + k[d.b * 3 + 2]
  const defs = settings.angles
    .map((id) => POSE_ANGLES[id])
    .filter((d) => angleSure(k, d))
    .sort((x, y) => conf(y) - conf(x))
  const placed: Pt[] = []
  for (const def of defs) {
    const m = { ...angleMark(def.id, at(def.vertex), at(def.a), at(def.b), 0), color, widthPx: w }
    // The arms are already the skeleton: keep the arc and the degree label.
    const shapes = markShapes(m).slice(1)
    const label = shapes.find((s) => s.kind === 'label')
    if (label && label.kind === 'label') {
      if (placed.some((p) => Math.hypot(p.x - label.x, p.y - label.y) < label.fontSizePx * 1.2)) continue
      placed.push({ x: label.x, y: label.y })
    }
    out.push(...shapes)
  }
  return out
}

/** Every person on the clip at `sourceSec`, drawn in view space. */
export function clipPoseShapes(data: PoseData, settings: PoseSettings, sourceSec: number, view: PoseView): MarkShape[] {
  if (!settings.show) return []
  return settings.people.flatMap((p) => {
    const k = personAt(data, p, sourceSec)
    return k ? poseShapes(k, p.color, settings, view) : []
  })
}

/** Each tracked person seen at `sourceSec`, as a box around its visible
 *  keypoints in view space — what the person picker draws and hit-tests. */
export function trackBoxesAt(
  data: PoseData,
  sourceSec: number,
  view: PoseView
): { id: number; x: number; y: number; w: number; h: number }[] {
  const out: { id: number; x: number; y: number; w: number; h: number }[] = []
  for (const t of data.tracks) {
    const k = trackAt(data, t, sourceSec)
    if (!k) continue
    const pts: Pt[] = []
    for (let i = 0; i < KEYPOINTS; i++)
      if (k[i * 3 + 2] >= POSE_MIN_SCORE) pts.push(toView(view, k[i * 3], k[i * 3 + 1]))
    if (pts.length < 3) continue
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const pad = 0.06 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    const x = Math.min(...xs) - pad
    const y = Math.min(...ys) - pad
    out.push({ id: t.id, x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y })
  }
  return out
}

/**
 * View space → the canonical canvas, for a clip box centred at `center`, of
 * size `box` (logical px, its zoom and stretch applied) and turned
 * `rotationDeg` — how "Convert to drawing" places a skeleton's lines on a
 * graphics tile right where the clip shows them.
 */
export function viewToCanvas(
  p: Pt,
  view: Pick<PoseView, 'size'>,
  center: Pt,
  box: { w: number; h: number },
  rotationDeg: number
): Pt {
  const lx = (p.x / view.size.w - 0.5) * box.w
  const ly = (p.y / view.size.h - 0.5) * box.h
  const r = rotateVec(lx, ly, rotationDeg)
  return { x: center.x + r.x, y: center.y + r.y }
}
