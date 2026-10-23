import { describe, expect, it } from 'vitest'
import {
  HALPE26,
  KEYPOINTS,
  POSE_ANGLES,
  POSE_LINKS,
  POSE_MIN_SCORE,
  clipPoseShapes,
  clipPoseView,
  joinTrack,
  togglePersonTrack,
  validPicks,
  compactKeypoints,
  defaultPoseSettings,
  nextPersonColor,
  personAt,
  rebasePoseData,
  remapPicks,
  remapTracks,
  trackPresence,
  poseCovers,
  poseShapes,
  smoothTrack,
  toView,
  trackAt,
  trackBoxesAt,
  trackPeople,
  viewToCanvas,
  type Detection,
  type Keypoints,
  type PoseData,
  type PoseTrack,
  type PoseView
} from './pose'

/** Keypoints with every point at (x + i, y + i), all confident. */
const body = (x: number, y: number, score = 0.9): Keypoints =>
  Array.from({ length: KEYPOINTS }, (_, i) => [x + i, y + i, score]).flat()
const det = (x: number, y: number, w = 100, h = 200): Detection => ({
  box: [x, y, x + w, y + h],
  kps: body(x, y)
})
const idx = (name: (typeof HALPE26)[number]): number => HALPE26.indexOf(name)

describe('the keypoint layout', () => {
  it('is Halpe26, and every link and angle names real points', () => {
    expect(KEYPOINTS).toBe(26)
    for (const [a, b] of POSE_LINKS) expect([a, b].every((i) => i >= 0 && i < 26)).toBe(true)
    for (const d of Object.values(POSE_ANGLES)) expect([d.a, d.vertex, d.b].every((i) => i >= 0)).toBe(true)
    expect(POSE_ANGLES.leftKnee.vertex).toBe(idx('leftKnee'))
  })
})

describe('trackPeople', () => {
  it('keeps two people apart and gives each a stable id', () => {
    const frames = [0, 1, 2, 3].map((f) => [det(100 + f * 5, 100), det(600 - f * 5, 100)])
    const tracks = trackPeople(frames, 1000 * 1000, 5)
    expect(tracks.map((t) => t.id)).toEqual([1, 2])
    expect(tracks[0].frames.every((k) => k && k[0] < 300)).toBe(true)
    expect(tracks[1].frames.every((k) => k && k[0] > 400)).toBe(true)
  })

  it('bridges a short gap but starts a new person after a long one', () => {
    const seen = (f: number): Detection[] => (f === 2 || f >= 5 ? [] : [det(100, 100)])
    const short = trackPeople([0, 1, 2, 3, 4].map(seen), 1e6, 3)
    expect(short).toHaveLength(1)
    expect(short[0].frames.map((k) => k !== null)).toEqual([true, true, false, true, true])
    const long = trackPeople([...[0, 1].map(() => [det(100, 100)]), [], [], [], [det(100, 100)]], 1e6, 2)
    expect(long.map((t) => [t.id, t.first])).toEqual([
      [1, 0],
      [2, 5]
    ])
  })

  it('follows a fast mover whose boxes stop overlapping', () => {
    // A narrow 100×300 runner moving 105px a frame: no overlap, but well
    // within half its height of where it was.
    const frames = [0, 1, 2].map((f) => [det(100 + f * 105, 100, 100, 300)])
    expect(trackPeople(frames, 1e6, 5)).toHaveLength(1)
  })

  it('weighs a person by how big and how long they are on screen', () => {
    const frames = [0, 1].map(() => [det(0, 0, 400, 800), det(900, 0, 50, 100)])
    const [big, small] = trackPeople(frames, 1000 * 1000, 5)
    expect(big.weight).toBeGreaterThan(small.weight * 10)
    expect(defaultPoseSettings({ tracks: [small, big], startSec: 0, fps: 30 }).people[0].tracks).toEqual([big.id])
  })

  it('picks the default person within the clip’s own footage', () => {
    // Track 1 is big but only in source 0–1s; track 2 is smaller but in 2–3s.
    const data = {
      startSec: 0,
      fps: 10,
      tracks: [
        { id: 1, first: 0, frames: Array.from({ length: 10 }, () => body(0, 0)), weight: 10 },
        { id: 2, first: 20, frames: Array.from({ length: 10 }, () => body(0, 0)), weight: 1 }
      ]
    }
    expect(defaultPoseSettings(data).people[0].tracks).toEqual([1])
    expect(defaultPoseSettings(data, { inSec: 2, outSec: 3 }).people[0].tracks).toEqual([2])
    expect(trackPresence(data, data.tracks[1], 2, 4)).toEqual({ seen: 10, fraction: 0.5 })
  })
})

describe('re-detection', () => {
  const data = (startSec: number, tracks: PoseTrack[]): PoseData => ({
    version: 1,
    mediaId: 'm',
    startSec,
    durationSec: 2,
    fps: 10,
    frameCount: 20,
    width: 1000,
    height: 1000,
    model: 'test',
    tracks
  })
  const run = (id: number, x: number, first = 0, n = 20): PoseTrack => ({
    id,
    first,
    frames: Array.from({ length: n }, () => body(x, 100)),
    weight: 1
  })

  it('matches old people to the renumbered new ones, and carries every clip’s picks over', () => {
    // Before: 1 = the athlete at x 200, 2 = a coach at x 700.
    const prev = data(1, [run(1, 200), run(2, 700)])
    // After a grown window someone else appears first: ids shift by one.
    const next = data(0, [run(1, 450, 0, 5), run(2, 202, 5, 15), run(3, 698, 5, 15)])
    const map = remapTracks(prev, next)
    expect([...map]).toEqual([
      [1, 2],
      [2, 3]
    ])
    const picks = {
      show: true,
      people: [
        { tracks: [1], color: 'a' },
        { tracks: [2, 9], color: 'b' }
      ],
      angles: [],
      widthPx: 6
    }
    expect(remapPicks(picks, map).people).toEqual([
      { tracks: [2], color: 'a' },
      { tracks: [3], color: 'b' }
    ])
  })

  it('drops a pick it cannot find again', () => {
    const map = remapTracks(data(0, [run(1, 200)]), data(0, [run(1, 800)]))
    expect(map.size).toBe(0)
    expect(
      remapPicks({ show: true, people: [{ tracks: [1], color: 'a' }], angles: [], widthPx: 6 }, map).people
    ).toEqual([])
  })
})

describe('smoothTrack', () => {
  it('calms jitter on a still joint and restarts after a gap', () => {
    const jitter = (f: number): Keypoints => body(100 + (f % 2 ? 4 : -4), 100)
    const track: PoseTrack = {
      id: 1,
      first: 0,
      frames: [...Array.from({ length: 30 }, (_, f) => jitter(f)), null],
      weight: 1
    }
    const s = smoothTrack(track, 30)
    const spread = (frames: (Keypoints | null)[]): number => {
      const xs = frames.slice(10, 30).map((k) => k![0])
      return Math.max(...xs) - Math.min(...xs)
    }
    expect(spread(s.frames)).toBeLessThan(spread(track.frames) / 2)
    expect(s.frames[30]).toBeNull()
    // Scores pass through untouched.
    expect(s.frames[5]![2]).toBe(0.9)
  })

  it('keeps up with a steady move (small lag)', () => {
    const track: PoseTrack = {
      id: 1,
      first: 0,
      frames: Array.from({ length: 30 }, (_, f) => body(100 + f * 20, 100)),
      weight: 1
    }
    const last = smoothTrack(track, 30).frames[29]!
    expect(Math.abs(last[0] - (100 + 29 * 20))).toBeLessThan(30)
  })
})

describe('looking up a pose in source time', () => {
  const data: PoseData = {
    version: 1,
    mediaId: 'm',
    startSec: 2,
    durationSec: 1,
    fps: 10,
    frameCount: 10,
    width: 1000,
    height: 1000,
    model: 'test',
    tracks: [
      { id: 1, first: 0, frames: [body(0, 0), body(10, 0), null, body(30, 0)], weight: 1 },
      { id: 2, first: 4, frames: [body(500, 0), body(510, 0)], weight: 1 }
    ]
  }

  it('interpolates between frames, never across a gap or outside the window', () => {
    expect(trackAt(data, data.tracks[0], 2.05)![0]).toBeCloseTo(5)
    expect(trackAt(data, data.tracks[0], 2.11)![0]).toBeCloseTo(10) // next frame missing: hold the nearer seen one
    expect(trackAt(data, data.tracks[0], 2.19)).toBeNull() // nearer frame is the gap
    expect(trackAt(data, data.tracks[0], 1.5)).toBeNull()
    expect(trackAt(data, data.tracks[0], 3.5)).toBeNull()
  })

  it('a re-joined person continues on its next track', () => {
    expect(personAt(data, { tracks: [1, 2] }, 2.0)![0]).toBe(0)
    expect(personAt(data, { tracks: [1, 2] }, 2.5)![0]).toBe(510)
    expect(personAt(data, { tracks: [1] }, 2.5)).toBeNull()
  })

  it('knows whether it covers a clip window', () => {
    expect(poseCovers(data, 2, 3)).toBe(true)
    expect(poseCovers(data, 1.5, 3)).toBe(false)
    expect(poseCovers(data, 2.2, 3.5)).toBe(false)
  })
})

describe('drawing', () => {
  const view: PoseView = { crop: { x: 100, y: 0, w: 500, h: 1000 }, size: { w: 1000, h: 2000 } }

  it('maps source px into the crop, scaled, and mirrors for flips', () => {
    expect(toView(view, 100, 0)).toEqual({ x: 0, y: 0 })
    expect(toView(view, 350, 500)).toEqual({ x: 500, y: 1000 })
    expect(toView({ ...view, flipH: true }, 150, 0)).toEqual({ x: 900, y: 0 })
    expect(toView({ ...view, flipV: true }, 100, 250)).toEqual({ x: 0, y: 1500 })
  })

  it('draws the skeleton and dots, hiding unsure keypoints and their links', () => {
    const k = body(200, 100)
    k[idx('leftKnee') * 3 + 2] = POSE_MIN_SCORE / 2
    const shapes = poseShapes(k, '#ff0000', { angles: [], widthPx: 6 }, view)
    const [links, dots] = shapes
    if (links.kind !== 'path' || dots.kind !== 'path') throw new Error('expected paths')
    const knee = toView(view, k[idx('leftKnee') * 3], k[idx('leftKnee') * 3 + 1])
    expect(links.d).not.toContain(`${knee.x} ${knee.y}`)
    expect(links.stroke).toBe('#ff0000')
    expect(links.strokeWidth).toBe(6)
    expect(dots.d).not.toContain(`${knee.x} ${knee.y}`)
  })

  it('labels a chosen joint angle with its degrees, like a graphics angle mark', () => {
    // A right-angled left knee: hip straight above, ankle straight right.
    const k = body(0, 0)
    const set = (name: (typeof HALPE26)[number], x: number, y: number): void => {
      k[idx(name) * 3] = x
      k[idx(name) * 3 + 1] = y
    }
    set('leftKnee', 300, 500)
    set('leftHip', 300, 300)
    set('leftAnkle', 500, 500)
    const shapes = poseShapes(k, '#00ff00', { angles: ['leftKnee'], widthPx: 6 }, view)
    const label = shapes.find((s) => s.kind === 'label')
    expect(label && label.kind === 'label' && label.text).toBe('90°')
  })

  it('draws every picked person in their own colour, and nothing when hidden', () => {
    const data: PoseData = {
      version: 1,
      mediaId: 'm',
      startSec: 0,
      durationSec: 1,
      fps: 1,
      frameCount: 1,
      width: 1000,
      height: 1000,
      model: 'test',
      tracks: [
        { id: 1, first: 0, frames: [body(0, 0)], weight: 1 },
        { id: 2, first: 0, frames: [body(400, 0)], weight: 1 }
      ]
    }
    const settings = {
      show: true,
      people: [
        { tracks: [1], color: '#111111' },
        { tracks: [2], color: '#222222' }
      ],
      angles: [],
      widthPx: 4
    }
    const strokes = clipPoseShapes(data, settings, 0, view).flatMap((s) => (s.kind === 'path' ? [s.stroke] : []))
    expect(strokes).toContain('#111111')
    expect(strokes).toContain('#222222')
    expect(clipPoseShapes(data, { ...settings, show: false }, 0, view)).toEqual([])
    expect(nextPersonColor(settings)).not.toMatch(/#111111|#222222/)
    expect(trackBoxesAt(data, 0, view).map((b) => b.id)).toEqual([1, 2])
  })

  it('places a view point on the canvas through the clip box, rotation included', () => {
    const size = { w: 1000, h: 2000 }
    // Box 500×1000 centred at (540, 960): the view's centre lands on it.
    expect(viewToCanvas({ x: 500, y: 1000 }, { size }, { x: 540, y: 960 }, { w: 500, h: 1000 }, 0)).toEqual({
      x: 540,
      y: 960
    })
    // The view's right-middle edge, box turned 90° clockwise → straight below the centre.
    const p = viewToCanvas({ x: 1000, y: 1000 }, { size }, { x: 540, y: 960 }, { w: 500, h: 1000 }, 90)
    expect(p.x).toBeCloseTo(540)
    expect(p.y).toBeCloseTo(960 + 250)
  })

  it('compacts keypoints for saving', () => {
    expect(compactKeypoints([1.234, 5.678, 0.98765])).toEqual([1.2, 5.7, 0.99])
  })
})

describe('editing the picks', () => {
  const base = { show: true, people: [{ tracks: [1], color: '#FFD60A' }], angles: [], widthPx: 6 }

  it('toggling a track adds a person in the next colour, or takes it away', () => {
    const two = togglePersonTrack(base, 2)
    expect(two.people).toEqual([
      { tracks: [1], color: '#FFD60A' },
      { tracks: [2], color: '#33D1FF' }
    ])
    expect(togglePersonTrack(two, 1).people.map((p) => p.tracks)).toEqual([[2]])
  })

  it('joins a broken-off track to a person, taking it from anyone else', () => {
    const two = togglePersonTrack(base, 2)
    expect(joinTrack(two, 2, 0).people).toEqual([{ tracks: [1, 2], color: '#FFD60A' }])
    expect(joinTrack(two, 3, 5)).toBe(two)
  })

  it('drops picks a re-detection no longer has', () => {
    const s = {
      ...base,
      people: [
        { tracks: [1, 9], color: 'a' },
        { tracks: [8], color: 'b' }
      ]
    }
    expect(validPicks(s, { tracks: [{ id: 1, first: 0, frames: [], weight: 1 }] }).people).toEqual([
      { tracks: [1], color: 'a' }
    ])
    expect(validPicks(base, { tracks: [{ id: 1, first: 0, frames: [], weight: 1 }] })).toBe(base)
  })
})

describe('clipPoseView', () => {
  it('rescales the clip crop into the detection’s px and sizes the view as the box at zoom 1', () => {
    const v = clipPoseView(
      { crop: { x: 100, y: 200, w: 1000, h: 1000 }, flipH: true },
      { width: 960, height: 540 },
      { w: 1920, h: 1080 }
    )
    expect(v.crop).toEqual({ x: 50, y: 100, w: 500, h: 500 })
    expect(v.size).toEqual({ w: 1080, h: 1080 }) // a square fills the frame's width
    expect(v.flipH).toBe(true)
  })
})

describe('rebasePoseData', () => {
  it('shifts a detection onto a re-rendered window copy: times back, positions scaled, same people', () => {
    const data: PoseData = {
      version: 1,
      mediaId: 'src',
      startSec: 1,
      durationSec: 4,
      fps: 10,
      frameCount: 40,
      width: 2000,
      height: 4000,
      model: 'test',
      tracks: [{ id: 7, first: 0, frames: [body(100, 200)], weight: 1 }]
    }
    const r = rebasePoseData(data, 'matte', 3, { w: 1000, h: 2000 })
    expect(r).toMatchObject({ mediaId: 'matte', startSec: -2, width: 1000, height: 2000 })
    expect(r.tracks[0].id).toBe(7)
    expect(r.tracks[0].frames[0]!.slice(0, 3)).toEqual([50, 100, 0.9])
    // The copy's second 0 is the source's second 3: the same pose.
    expect(trackAt(r, r.tracks[0], -2)![0]).toBe(50)
  })
})
