/**
 * Volume levels — named loudness targets audio clips join (File ▸ Volume
 * levels, the Inspector's "Volume level" picker, the timeline's right-click
 * "Add to volume level ▸").
 *
 * THE PARITY POINT: `clipGain` is the one place a clip's effective gain is
 * decided. The preview (`PreviewStage`'s audio followers, series via the
 * `getLoudness` IPC) and the export (`exportAudioClips` in
 * `main/services/exporterArgs.ts`, series via `ensureLoudness`) both call it
 * with the same clip, levels and loudness series, so what you hear while
 * editing is what the export mixes. @see docs/SHARED.md
 *
 * The rule, for a clip in a level:
 *  - gain = target − the gated loudness of the clip's own source window
 *    (`windowLoudness` over in..out);
 *  - capped so the window's sample peak + gain stays at or below −1 dBFS
 *    ("short by N dB (would clip)");
 *  - 0 dB — the level leaves the source as it is — when there is nothing to
 *    match (no gated loudness, or quieter than −45 LUFS), when the window is
 *    under 0.4 s, or while the series is still being measured.
 * A clip in no level plays at its own `gainDb`. In a level, `gainDb` is kept
 * but unused, so leaving the level restores it. Mute still wins (`audible`).
 * An effect track (`kind: 'fx'`) never joins a level itself: it gets the same
 * CHANGE its source clip received (level gain − the source's own gain), so a
 * wet/dry balance survives the source being levelled.
 */

import type { AudioClip, Project, VolumeLevel } from './project'
import { audioClipAudible, DEFAULT_TARGET_LUFS, DEFAULT_VOLUME_LEVEL_ID, effectiveOut } from './project'
import { windowLoudness, type LoudnessSeries } from './loudness'
import { audioClipsDeep, mapAudioClipsDeep } from './compositions'

/** A levelled clip's sample peak may not exceed this (dBFS). */
export const LEVEL_PEAK_CEILING_DB = -1
/** Below this window loudness there is nothing worth matching (LUFS). */
export const LEVEL_FLOOR_LUFS = -45
/** The level loudness control's range (LUFS). */
export const LEVEL_TARGET_RANGE = { min: -40, max: -6 } as const
/** Longest level name. */
export const LEVEL_NAME_MAX = 40

/** Why a clip has the gain it has — what the Inspector's status line says. */
export type LevelStatus =
  /** In no level: its own `gainDb`. */
  | { kind: 'none' }
  /** Matched to the target. `lufs` is the window loudness it was matched from. */
  | { kind: 'matched'; lufs: number }
  /** Boosted only as far as the peak allows: `byDb` short of the target. */
  | { kind: 'short'; byDb: number; lufs: number }
  /** Nothing to match (silence, or quieter than `LEVEL_FLOOR_LUFS`): left at 0 dB. */
  | { kind: 'silent' }
  /** Under one 400 ms block: left at 0 dB. */
  | { kind: 'tooShort' }
  /** The loudness series isn't available yet: left at 0 dB. */
  | { kind: 'measuring' }
  /** An effect track following its source clip's level by `deltaDb`. */
  | { kind: 'follows'; sourceId: string; deltaDb: number; source: LevelStatus }

export interface ClipGain {
  /** The gain to apply (dB). */
  gainDb: number
  /** False = muted: the preview holds it at 0, the export leaves it out. */
  audible: boolean
  /** The level that decided the gain (an effect track: its source's), or null. */
  levelId: string | null
  status: LevelStatus
}

export interface GainContext {
  /** The PROJECT's levels (root-only; nested clips join the same list). */
  levels: readonly VolumeLevel[]
  /** The media's loudness series: `undefined` = not available yet (measuring),
   *  `null` = there is none (no audio, measurement failed). */
  seriesOf: (mediaId: string) => LoudnessSeries | null | undefined
  /** Source duration (seconds); 0 = unknown (a whole-source clip then ends
   *  where its series does). */
  durationOf: (mediaId: string) => number
}

const round2 = (x: number): number => Math.round(x * 100) / 100

/** The level a clip has joined — null for none, a deleted level, or an effect track. */
export function levelOf(clip: AudioClip, levels: readonly VolumeLevel[]): VolumeLevel | null {
  if (clip.kind === 'fx' || !clip.volumeLevelId) return null
  return levels.find((l) => l.id === clip.volumeLevelId) ?? null
}

function seriesEnd(s: LoudnessSeries): number {
  return s.startSec + Math.max(s.momentary.length, s.peak.length) * s.stepSec
}

/** The gain a level gives `clip` (its own `gainDb` plays no part). */
export function levelMatch(
  clip: AudioClip,
  level: VolumeLevel,
  ctx: GainContext
): { gainDb: number; status: Exclude<LevelStatus, { kind: 'none' } | { kind: 'follows' }> } {
  const series = ctx.seriesOf(clip.mediaId)
  if (series === undefined) return { gainDb: 0, status: { kind: 'measuring' } }
  if (series === null) return { gainDb: 0, status: { kind: 'silent' } }
  const out = effectiveOut(clip, ctx.durationOf(clip.mediaId) || seriesEnd(series))
  const w = windowLoudness(series, clip.inSec, out)
  if (w.status === 'tooShort') return { gainDb: 0, status: { kind: 'tooShort' } }
  if (w.lufs == null || w.lufs < LEVEL_FLOOR_LUFS) return { gainDb: 0, status: { kind: 'silent' } }
  const want = level.targetLufs - w.lufs
  const ceiling = w.peakDb == null ? Infinity : LEVEL_PEAK_CEILING_DB - w.peakDb
  if (want > ceiling + 1e-9) {
    return { gainDb: round2(ceiling), status: { kind: 'short', byDb: round2(want - ceiling), lufs: w.lufs } }
  }
  return { gainDb: round2(want), status: { kind: 'matched', lufs: w.lufs } }
}

/**
 * The clip an effect track was rendered from, among `clips` (its own
 * composition's): same source media, not itself an effect, whose trim overlaps
 * the stretch of source this piece of the effect covers the most (ties go to
 * the same link group). Null when nothing matches — e.g. an effect made from a
 * video layer's own audio, which levels never touch.
 */
export function fxSourceClip(
  clip: AudioClip,
  clips: readonly AudioClip[],
  durationOf: (mediaId: string) => number = () => 0
): AudioClip | null {
  const fx = clip.fx
  if (!fx) return null
  const candidates = clips.filter((c) => c.id !== clip.id && c.kind !== 'fx' && c.mediaId === fx.fromMediaId)
  if (candidates.length === 0) return null
  const sameGroup = (c: AudioClip): number => (c.linkGroupId != null && c.linkGroupId === clip.linkGroupId ? 1 : 0)
  const pick = (a: number, b: number): AudioClip | null => {
    const scored = candidates
      .map((c) => ({ c, overlap: Math.min(b, effectiveOut(c, durationOf(c.mediaId) || Infinity)) - Math.max(a, c.inSec) }))
      .filter((s) => s.overlap > 1e-9)
      .sort((x, y) => (Math.abs(y.overlap - x.overlap) > 1e-9 ? y.overlap - x.overlap : sameGroup(y.c) - sameGroup(x.c)))
    return scored[0]?.c ?? null
  }
  // The rendered file starts at `fromInSec` of the source, so a piece trimmed
  // into it covers fromIn + in .. fromIn + out (the echo tail runs past fromOut).
  const a = fx.fromInSec + clip.inSec
  const b = Math.min(fx.fromOutSec, clip.outSec > 0 ? fx.fromInSec + clip.outSec : fx.fromOutSec)
  return (b > a ? pick(a, b) : null) ?? pick(fx.fromInSec, fx.fromOutSec)
}

/**
 * THE effective gain of an audio clip — preview and export both resolve
 * through this. `clips` is the clip's own composition (an effect track finds
 * its source there).
 */
export function clipGain(clip: AudioClip, clips: readonly AudioClip[], ctx: GainContext): ClipGain {
  const audible = audioClipAudible(clip)
  if (clip.kind === 'fx') {
    const src = clip.fx ? fxSourceClip(clip, clips, ctx.durationOf) : null
    const srcLevel = src ? levelOf(src, ctx.levels) : null
    if (!src || !srcLevel) return { gainDb: clip.gainDb, audible, levelId: null, status: { kind: 'none' } }
    const m = levelMatch(src, srcLevel, ctx)
    const deltaDb = round2(m.gainDb - src.gainDb)
    return {
      gainDb: round2(clip.gainDb + deltaDb),
      audible,
      levelId: srcLevel.id,
      status: { kind: 'follows', sourceId: src.id, deltaDb, source: m.status }
    }
  }
  const level = levelOf(clip, ctx.levels)
  if (!level) return { gainDb: clip.gainDb, audible, levelId: null, status: { kind: 'none' } }
  const m = levelMatch(clip, level, ctx)
  return { gainDb: m.gainDb, audible, levelId: level.id, status: m.status }
}

/** Whether resolving `clip` needs any loudness series (else none is fetched). */
export function seriesNeeded(clip: AudioClip, clips: readonly AudioClip[], levels: readonly VolumeLevel[]): string | null {
  if (clip.kind === 'fx') {
    const src = clip.fx ? fxSourceClip(clip, clips) : null
    return src && levelOf(src, levels) ? src.mediaId : null
  }
  return levelOf(clip, levels) ? clip.mediaId : null
}

const signed = (db: number): string => `${db > 0 ? '+' : db < 0 ? '−' : '±'}${Math.abs(db).toFixed(1)}`

/** The Inspector's one-line explanation of a clip's level gain. */
export function levelStatusText(status: LevelStatus, gainDb: number): string {
  switch (status.kind) {
    case 'none':
      return ''
    case 'matched':
      return `Matched · ${signed(gainDb)} dB`
    case 'short':
      return `Short by ${status.byDb.toFixed(1)} dB (would clip) · ${signed(gainDb)} dB`
    case 'silent':
      return 'Nothing to match — too quiet to measure · left as is'
    case 'tooShort':
      return 'Too short to measure (under 0.4 s) · left as is'
    case 'measuring':
      return 'Measuring…'
    case 'follows':
      return `Follows the level of the clip it was made from · ${signed(status.deltaDb)} dB`
  }
}

// --- Membership + level edits (pure; the store wraps each in one undo step) ---

/**
 * THE constructor for audio pulled off footage (a video dropped with audio,
 * the assistant's sequences, Extract audio) — the one place auto-join is
 * decided: with `autoJoin` (Settings ▸ "Auto-join new clips to the Default
 * volume level") the clip lands in Default. Imported audio and effect tracks
 * are built elsewhere and never auto-join.
 */
export function extractedAudioClip(
  f: { id: string; mediaId: string; startSec: number; inSec: number; outSec: number; linkGroupId?: string },
  autoJoin: boolean
): AudioClip {
  return {
    id: f.id,
    mediaId: f.mediaId,
    startSec: f.startSec,
    inSec: f.inSec,
    outSec: f.outSec,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    duck: false,
    ...(f.linkGroupId ? { linkGroupId: f.linkGroupId } : {}),
    ...(autoJoin ? { volumeLevelId: DEFAULT_VOLUME_LEVEL_ID } : {}),
    kind: 'extracted'
  }
}

/** `clip` in `levelId` (null = none). An effect track is returned unchanged. */
export function withVolumeLevel(clip: AudioClip, levelId: string | null): AudioClip {
  if (clip.kind === 'fx') return clip
  if ((clip.volumeLevelId ?? null) === levelId) return clip
  if (levelId) return { ...clip, volumeLevelId: levelId }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { volumeLevelId, ...rest } = clip
  return rest
}

/** Null, or why `name` can't name a level (`exceptId` = the level being renamed). */
export function validateLevelName(name: string, levels: readonly VolumeLevel[], exceptId?: string): string | null {
  const n = name.trim()
  if (!n) return 'Give the level a name.'
  if (n.length > LEVEL_NAME_MAX) return `Keep it under ${LEVEL_NAME_MAX} characters.`
  const taken = levels.some((l) => l.id !== exceptId && l.name.trim().toLowerCase() === n.toLowerCase())
  return taken ? 'A level with that name already exists.' : null
}

/** A free "Level N" name to start the create dialog with. */
export function suggestLevelName(levels: readonly VolumeLevel[]): string {
  for (let i = levels.length + 1; ; i++) {
    const name = `Level ${i}`
    if (validateLevelName(name, levels) === null) return name
  }
}

export const clampTargetLufs = (lufs: number): number =>
  Math.min(LEVEL_TARGET_RANGE.max, Math.max(LEVEL_TARGET_RANGE.min, lufs))

/** Add a level (a new id, the default target unless given). */
export function addVolumeLevel(p: Project, level: { id: string; name: string; targetLufs?: number }): Project {
  if (p.volumeLevels.some((l) => l.id === level.id)) return p
  return {
    ...p,
    volumeLevels: [
      ...p.volumeLevels,
      { id: level.id, name: level.name.trim(), targetLufs: clampTargetLufs(level.targetLufs ?? DEFAULT_TARGET_LUFS) }
    ]
  }
}

/** Rename a level. Default keeps its name. */
export function renameVolumeLevel(p: Project, id: string, name: string): Project {
  const n = name.trim()
  if (id === DEFAULT_VOLUME_LEVEL_ID || !n) return p
  const l = p.volumeLevels.find((x) => x.id === id)
  if (!l || l.name === n) return p
  return { ...p, volumeLevels: p.volumeLevels.map((x) => (x.id === id ? { ...x, name: n } : x)) }
}

/** Set a level's loudness — every clip in it follows. */
export function setVolumeLevelTarget(p: Project, id: string, targetLufs: number): Project {
  const t = clampTargetLufs(targetLufs)
  const l = p.volumeLevels.find((x) => x.id === id)
  if (!l || l.targetLufs === t) return p
  return { ...p, volumeLevels: p.volumeLevels.map((x) => (x.id === id ? { ...x, targetLufs: t } : x)) }
}

/**
 * Delete a level: every clip in it (nested comps included) leaves it and so
 * returns to its own volume. Default can't be deleted.
 */
export function removeVolumeLevel(p: Project, id: string): Project {
  if (id === DEFAULT_VOLUME_LEVEL_ID || !p.volumeLevels.some((l) => l.id === id)) return p
  const cleared = mapAudioClipsDeep(p, (a) => (a.volumeLevelId === id ? withVolumeLevel(a, null) : a))
  return { ...cleared, volumeLevels: p.volumeLevels.filter((l) => l.id !== id) }
}

/** How many clips (nested comps included) are in each level, by id. */
export function levelMemberCounts(p: Project): Map<string, number> {
  const counts = new Map<string, number>()
  for (const a of audioClipsDeep(p)) {
    const l = levelOf(a, p.volumeLevels)
    if (l) counts.set(l.id, (counts.get(l.id) ?? 0) + 1)
  }
  return counts
}
