import { describe, expect, it } from 'vitest'
import {
  createEmptyComposition,
  createEmptyProject,
  DEFAULT_VOLUME_LEVEL_ID,
  migrateProject,
  normalizeVolumeLevels,
  PROJECT_VERSION,
  type AudioClip,
  type Layer,
  type Project,
  type VolumeLevel
} from './project'
import type { LoudnessSeries } from './loudness'
import {
  addVolumeLevel,
  clipGain,
  extractedAudioClip,
  fxSourceClip,
  LEVEL_TARGET_RANGE,
  levelMemberCounts,
  levelStatusText,
  removeVolumeLevel,
  renameVolumeLevel,
  seriesNeeded,
  setVolumeLevelTarget,
  suggestLevelName,
  validateLevelName,
  withVolumeLevel,
  type GainContext
} from './volumeLevels'

/** A steady signal: every 0.1 s step at momentary `m` LUFS with sample peak `p`. */
function steady(m: number | null, p: number | null, seconds = 20): LoudnessSeries {
  const n = Math.round(seconds * 10)
  return {
    version: 1,
    stepSec: 0.1,
    startSec: 0,
    momentary: Array.from({ length: n }, (_, i) => (i < 3 ? null : m)),
    peak: Array.from({ length: n }, () => p)
  }
}

const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: 'c1',
  mediaId: 'm1',
  startSec: 0,
  inSec: 0,
  outSec: 10,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  kind: 'extracted',
  ...over
})

const LEVELS: VolumeLevel[] = [
  { id: DEFAULT_VOLUME_LEVEL_ID, name: 'Default', targetLufs: -16 },
  { id: 'loud', name: 'Loud', targetLufs: -10 }
]

const ctxWith = (series: Record<string, LoudnessSeries | null>, durations: Record<string, number> = {}): GainContext => ({
  levels: LEVELS,
  seriesOf: (id) => series[id],
  durationOf: (id) => durations[id] ?? 0
})

describe('clipGain — a clip in a level', () => {
  it('matches the window loudness to the target', () => {
    const c = clip({ volumeLevelId: 'default' })
    const g = clipGain(c, [c], ctxWith({ m1: steady(-30, -20) }))
    expect(g.gainDb).toBeCloseTo(14, 2)
    expect(g.status).toMatchObject({ kind: 'matched' })
    expect(g.levelId).toBe('default')
    expect(levelStatusText(g.status, g.gainDb)).toBe('Matched · +14.0 dB')
  })

  it('cuts a clip louder than the target', () => {
    const c = clip({ volumeLevelId: 'default' })
    const g = clipGain(c, [c], ctxWith({ m1: steady(-10, -3) }))
    expect(g.gainDb).toBeCloseTo(-6, 2)
    expect(g.status.kind).toBe('matched')
  })

  it('caps the boost so the peak stays at −1 dBFS, and says how short it is', () => {
    // −36 LUFS with a −12 dBFS peak (the recovery teleprompter recording):
    // +20 wanted, only +11 fits under −1 dBFS.
    const c = clip({ volumeLevelId: 'default' })
    const g = clipGain(c, [c], ctxWith({ m1: steady(-36, -12) }))
    expect(g.gainDb).toBeCloseTo(11, 2)
    expect(g.status).toMatchObject({ kind: 'short', byDb: 9 })
    expect(levelStatusText(g.status, g.gainDb)).toBe('Short by 9.0 dB (would clip) · +11.0 dB')
  })

  it('caps a cut too when the source already peaks above the ceiling', () => {
    const c = clip({ volumeLevelId: 'default' })
    const g = clipGain(c, [c], ctxWith({ m1: steady(-16.5, 0) }))
    expect(g.gainDb).toBeCloseTo(-1, 2)
    expect(g.status).toMatchObject({ kind: 'short', byDb: 1.5 })
  })

  it('leaves a clip quieter than −45 LUFS (or silent) as it is: nothing to match', () => {
    const c = clip({ volumeLevelId: 'default', gainDb: -8 })
    for (const s of [steady(-50, -40), steady(null, null)]) {
      const g = clipGain(c, [c], ctxWith({ m1: s }))
      expect(g.gainDb).toBe(0)
      expect(g.status.kind).toBe('silent')
    }
    // Right at the floor still matches.
    expect(clipGain(c, [c], ctxWith({ m1: steady(-45, -30) })).status.kind).toBe('matched')
  })

  it('leaves a window under 0.4 s as it is: too short', () => {
    const c = clip({ volumeLevelId: 'default', inSec: 2, outSec: 2.3 })
    const g = clipGain(c, [c], ctxWith({ m1: steady(-30, -20) }))
    expect(g.gainDb).toBe(0)
    expect(g.status.kind).toBe('tooShort')
  })

  it('leaves the clip as it is while the series is measuring, and when there is none', () => {
    const c = clip({ volumeLevelId: 'default', gainDb: 5 })
    const measuring = clipGain(c, [c], ctxWith({}))
    expect(measuring).toMatchObject({ gainDb: 0, status: { kind: 'measuring' } })
    const none = clipGain(c, [c], ctxWith({ m1: null }))
    expect(none).toMatchObject({ gainDb: 0, status: { kind: 'silent' } })
  })

  it('measures only the clip’s own in..out window', () => {
    // Loud first 10 s, quiet after: a clip trimmed to the quiet half gets the boost.
    const s = steady(-20, -10)
    for (let i = 100; i < 200; i++) {
      s.momentary[i] = -32
      s.peak[i] = -25
    }
    const quiet = clip({ volumeLevelId: 'default', inSec: 12, outSec: 18 })
    expect(clipGain(quiet, [quiet], ctxWith({ m1: s })).gainDb).toBeCloseTo(16, 2)
    const loud = clip({ volumeLevelId: 'default', inSec: 1, outSec: 9 })
    expect(clipGain(loud, [loud], ctxWith({ m1: s })).gainDb).toBeCloseTo(4, 2)
  })

  it('a whole-source clip ends at the source duration, or where the series does', () => {
    const c = clip({ volumeLevelId: 'default', outSec: 0 })
    expect(clipGain(c, [c], ctxWith({ m1: steady(-26, -20) }, { m1: 20 })).gainDb).toBeCloseTo(10, 2)
    expect(clipGain(c, [c], ctxWith({ m1: steady(-26, -20) })).gainDb).toBeCloseTo(10, 2)
  })

  it('keeps the own gainDb untouched, and leaving the level restores it', () => {
    const c = clip({ volumeLevelId: 'loud', gainDb: -7 })
    const ctx = ctxWith({ m1: steady(-30, -20) })
    expect(clipGain(c, [c], ctx).gainDb).toBeCloseTo(19, 2) // −10 − (−30), own −7 unused
    const out = withVolumeLevel(c, null)
    expect(out.volumeLevelId).toBeUndefined()
    expect(out.gainDb).toBe(-7)
    expect(clipGain(out, [out], ctx)).toMatchObject({ gainDb: -7, levelId: null, status: { kind: 'none' } })
  })

  it('mute still wins (the gain is still resolved, for an unmute)', () => {
    const c = clip({ volumeLevelId: 'default', mute: true })
    const g = clipGain(c, [c], ctxWith({ m1: steady(-30, -20) }))
    expect(g.audible).toBe(false)
    expect(g.gainDb).toBeCloseTo(14, 2)
  })
})

describe('clipGain — a clip in no level', () => {
  it('plays at its own gainDb and needs no series', () => {
    const c = clip({ gainDb: -4 })
    expect(clipGain(c, [c], ctxWith({}))).toEqual({ gainDb: -4, audible: true, levelId: null, status: { kind: 'none' } })
    expect(seriesNeeded(c, [c], LEVELS)).toBeNull()
    expect(seriesNeeded(clip({ volumeLevelId: 'default' }), [], LEVELS)).toBe('m1')
  })

  it('treats a level id the project no longer has as no level', () => {
    const c = clip({ gainDb: 2, volumeLevelId: 'gone' })
    expect(clipGain(c, [c], ctxWith({ m1: steady(-30, -20) }))).toMatchObject({ gainDb: 2, status: { kind: 'none' } })
  })
})

describe('clipGain — an effect track follows its source clip', () => {
  const dry = clip({ id: 'dry', mediaId: 'voice', inSec: 4, outSec: 10, gainDb: -3, volumeLevelId: 'default', linkGroupId: 'g' })
  const wet = clip({
    id: 'wet',
    mediaId: 'echo',
    inSec: 0,
    outSec: 0,
    gainDb: -2,
    kind: 'fx',
    linkGroupId: 'g',
    fx: { settings: { kind: 'echo', echo: { delayMs: 260, decay: 0.45, repeats: 3 } }, fromMediaId: 'voice', fromInSec: 4, fromOutSec: 10 }
  })

  it('gets the same change the level gave its source', () => {
    const ctx = ctxWith({ voice: steady(-30, -20) })
    // Source: level gain +14 instead of its own −3 → a change of +17.
    expect(clipGain(dry, [dry, wet], ctx).gainDb).toBeCloseTo(14, 2)
    const g = clipGain(wet, [dry, wet], ctx)
    expect(g.gainDb).toBeCloseTo(15, 2) // own −2 + 17
    expect(g.status).toMatchObject({ kind: 'follows', sourceId: 'dry', deltaDb: 17 })
    expect(g.levelId).toBe('default')
    expect(seriesNeeded(wet, [dry, wet], LEVELS)).toBe('voice')
  })

  it('keeps its own gain when the source is in no level', () => {
    const plain = withVolumeLevel(dry, null)
    expect(clipGain(wet, [plain, wet], ctxWith({}))).toMatchObject({ gainDb: -2, status: { kind: 'none' } })
  })

  it('never joins a level itself', () => {
    const joined = { ...wet, volumeLevelId: 'loud' }
    expect(clipGain(joined, [joined], ctxWith({ echo: steady(-30, -20) }))).toMatchObject({ gainDb: -2, levelId: null })
    expect(withVolumeLevel(wet, 'loud')).toBe(wet)
  })

  it('follows the piece of a split source its own stretch came from', () => {
    const left = { ...dry, id: 'L', inSec: 4, outSec: 6 }
    const right = { ...dry, id: 'R', inSec: 6, outSec: 10, linkGroupId: 'g2' }
    const tailPiece = { ...wet, inSec: 2.5, outSec: 6 } // covers source 6.5..10
    expect(fxSourceClip(tailPiece, [left, right, tailPiece])?.id).toBe('R')
    const headPiece = { ...wet, inSec: 0, outSec: 1.5 } // covers source 4..5.5
    expect(fxSourceClip(headPiece, [left, right, headPiece])?.id).toBe('L')
    // The pure echo tail past the dry clip falls back to the whole render's window.
    const pureTail = { ...wet, inSec: 6.2, outSec: 7 }
    expect(fxSourceClip(pureTail, [left, right, pureTail])?.id).toBe('R')
  })

  it('has no source when nothing on the lane uses the media', () => {
    expect(fxSourceClip(wet, [wet])).toBeNull()
  })
})

describe('level edits', () => {
  const project = (): Project => {
    const p = createEmptyProject('p', 'P')
    const nested: Layer = {
      id: 'comp',
      hidden: false,
      startSec: 0,
      endSec: 5,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'compound', comp: { ...createEmptyComposition(), audioClips: [clip({ id: 'n1', volumeLevelId: 'loud' })] } }
    }
    return {
      ...p,
      volumeLevels: [...p.volumeLevels, { id: 'loud', name: 'Loud', targetLufs: -10 }],
      layers: [nested],
      audioClips: [clip({ id: 'a', volumeLevelId: 'loud', gainDb: -5 }), clip({ id: 'b', volumeLevelId: 'default' })]
    }
  }

  it('deleting a level returns its clips — nested comps too — to their own volume', () => {
    const p = project()
    const next = removeVolumeLevel(p, 'loud')
    expect(next.volumeLevels.map((l) => l.id)).toEqual(['default'])
    expect(next.audioClips[0].volumeLevelId).toBeUndefined()
    expect(next.audioClips[0].gainDb).toBe(-5)
    expect(next.audioClips[1].volumeLevelId).toBe('default')
    const inner = next.layers[0].content.kind === 'compound' ? next.layers[0].content.comp.audioClips[0] : null
    expect(inner?.volumeLevelId).toBeUndefined()
    expect(levelMemberCounts(p).get('loud')).toBe(2)
    expect(levelMemberCounts(next).get('loud')).toBeUndefined()
  })

  it('Default can be neither deleted nor renamed, but its loudness can be set', () => {
    const p = project()
    expect(removeVolumeLevel(p, DEFAULT_VOLUME_LEVEL_ID)).toBe(p)
    expect(renameVolumeLevel(p, DEFAULT_VOLUME_LEVEL_ID, 'Voice')).toBe(p)
    expect(setVolumeLevelTarget(p, DEFAULT_VOLUME_LEVEL_ID, -14).volumeLevels[0]).toMatchObject({ name: 'Default', targetLufs: -14 })
  })

  it('adds, renames and clamps', () => {
    const p = addVolumeLevel(project(), { id: 'x', name: '  Music  ' })
    expect(p.volumeLevels.at(-1)).toEqual({ id: 'x', name: 'Music', targetLufs: -16 })
    expect(renameVolumeLevel(p, 'x', 'Bed').volumeLevels.at(-1)?.name).toBe('Bed')
    expect(setVolumeLevelTarget(p, 'x', -99).volumeLevels.at(-1)?.targetLufs).toBe(LEVEL_TARGET_RANGE.min)
    expect(setVolumeLevelTarget(p, 'x', 5).volumeLevels.at(-1)?.targetLufs).toBe(LEVEL_TARGET_RANGE.max)
  })

  it('validates names and suggests a free one', () => {
    expect(validateLevelName('', LEVELS)).toMatch(/name/)
    expect(validateLevelName('loud', LEVELS)).toMatch(/already exists/)
    expect(validateLevelName('Loud', LEVELS, 'loud')).toBeNull() // renaming to itself
    expect(validateLevelName('x'.repeat(41), LEVELS)).toMatch(/under/)
    expect(suggestLevelName(LEVELS)).toBe('Level 3')
  })
})

describe('auto-join (extractedAudioClip)', () => {
  it('joins Default only when the setting is on', () => {
    const f = { id: 'e', mediaId: 'm', startSec: 1, inSec: 0, outSec: 4, linkGroupId: 'g' }
    expect(extractedAudioClip(f, true)).toMatchObject({ kind: 'extracted', gainDb: 0, linkGroupId: 'g', volumeLevelId: 'default' })
    expect(extractedAudioClip(f, false).volumeLevelId).toBeUndefined()
  })
})

describe('migration (v26)', () => {
  it('adds Default to an older project and puts no existing clip in it', () => {
    const old = {
      ...createEmptyProject('p', 'P'),
      version: 25,
      audioClips: [clip({ id: 'a', gainDb: -6 }), clip({ id: 'b', kind: 'music' })]
    } as Partial<Project>
    delete old.volumeLevels
    const p = migrateProject(old)
    expect(p.version).toBe(PROJECT_VERSION)
    expect(p.volumeLevels).toEqual([{ id: 'default', name: 'Default', targetLufs: -16 }])
    expect(p.audioClips.every((a) => a.volumeLevelId === undefined)).toBe(true)
    expect(p.audioClips[0].gainDb).toBe(-6)
  })

  it('keeps Default’s loudness and the other levels, and restores a missing or renamed Default', () => {
    expect(
      normalizeVolumeLevels([
        { id: 'x', name: 'Music', targetLufs: -20 },
        { id: 'default', name: 'Renamed', targetLufs: -14 },
        { id: 'x', name: 'dup', targetLufs: -1 },
        { id: 'bad' }
      ])
    ).toEqual([
      { id: 'default', name: 'Default', targetLufs: -14 },
      { id: 'x', name: 'Music', targetLufs: -20 }
    ])
    expect(normalizeVolumeLevels([{ id: 'x', name: 'Music', targetLufs: -20 }])[0].id).toBe('default')
    const ok = [{ id: 'default', name: 'Default', targetLufs: -16 }]
    expect(normalizeVolumeLevels(ok)).toBe(ok)
  })
})
