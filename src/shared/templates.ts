/**
 * Templates: a saved bundle of timeline pieces you drop at the playhead — text,
 * graphics and image layers, sound clips, and optionally an effect on the CLIP
 * under the playhead (a freeze hold, a zoom across it, a colour grade and
 * tint). "We'll be right back" is the canonical one: freeze + zoom + sepia +
 * a sting + a title.
 *
 * Everything is timed from the DROP POINT (t = 0) and laid out in the
 * canonical 1080×1920 space, exactly like a project's own layers, so dropping
 * is a shift in time and nothing else (`lib/templates.ts` in the renderer does
 * the drop; main stores templates under `<data>/templates/<id>/`).
 *
 * Media a template carries (an image layer's picture, a sound) are FILES in
 * its own folder: inside a template, an image layer's `mediaId` and a sound's
 * `file` are those file names. `mapTemplateFiles` swaps them for library media
 * ids on the way in (save) and back out (drop) — never rewrite them by hand.
 *
 * Pure — main (storage, import/export) and the renderer (gallery, drop) share it.
 */

import type { AudioClip, ColorAdjust, Layer, LutRef } from './project'
import type { Tint } from './tint'
import { isNeutralTint } from './tint'
import { PROJECT_VERSION, createEmptyProject, isNeutralColor, migrateProject } from './project'
import { GRAPHIC_TOOLS } from './graphics'
import { EASINGS } from './markAnim'
import { ENTRANCES, EXITS, LOOPS } from './markPresets'
import { audioPlayedSec } from './audioTiming'
import { TRANSITION_KINDS } from './transitions'
import { FORBIDDEN_NAME_CHARS, RESERVED_DEVICE_NAME } from './fileName'

/** Bump when the stored shape changes incompatibly (`sanitizeTemplate` refuses newer). */
export const TEMPLATE_FORMAT_VERSION = 1

/** Longest template name kept. */
export const TEMPLATE_NAME_MAX = 60

/** The share file's extension (File ▸ Export template… / Import template…). */
export const TEMPLATE_FILE_EXT = 'reeltemplate'

/** A template's effect on the clip under the drop point. */
export interface TemplateClipEffect {
  /** How long the frame under the playhead is held (seconds). Everything after
   *  the drop point on the timeline moves later by this much. */
  holdSec: number
  /** Where the held frame ends up by the end of the hold, relative to where it
   *  was at the drop point: `scale` multiplies its zoom, `dx`/`dy` move it in
   *  canonical px. Null = no zoom. */
  zoom: { scale: number; dx: number; dy: number } | null
  /** Colour correction of the held frame (null = left as the clip has it),
   *  the newer controls included. */
  color: ColorAdjust | null
  /** Tint ("Color wash") of the held frame (null = left as the clip has it). */
  tint: Tint | null
  /** A LUT on the held frame (absent/null = left as the clip has it). Inside a
   *  template its `file` is a `.cube` in the template's folder, swapped for the
   *  project's copy only through `mapTemplateLuts`. */
  lut?: LutRef | null
}

/** An audio clip's mix and timing, minus its identity and media. `speed`
 *  (absent = 1×) is the clip's constant speed. */
export type TemplateAudioClip = Pick<
  AudioClip,
  'startSec' | 'inSec' | 'outSec' | 'gainDb' | 'mute' | 'fadeInSec' | 'fadeOutSec' | 'duck' | 'kind' | 'speed'
>

/** A sound the template plays, or an empty SLOT for one the user picks. */
export interface TemplateAudio {
  /** What the gallery calls it ("Sting", "Music"). */
  label: string
  /** The sound file in the template's folder; null = an empty slot (dropping
   *  skips it until a sound is chosen). */
  file: string | null
  clip: TemplateAudioClip
}

export interface ReelTemplate {
  id: string
  name: string
  formatVersion: number
  /** Overlay layers (text / graphics / image), timed from the drop point. */
  layers: Layer[]
  audio: TemplateAudio[]
  clipEffect: TemplateClipEffect | null
  /** The project schema (`PROJECT_VERSION`) its layers were saved in, so
   *  `migrateTemplate` can bring them up to date (absent = 29, the version
   *  templates shipped with). */
  projectVersion?: number
  /** A user template made from a built-in one (by choosing its sound): it
   *  stands in for that built-in in the gallery, and deleting it brings the
   *  original back. */
  basedOn?: string
}

/** One gallery entry: a template and whether it is built in (built-ins can't
 *  be deleted; choosing their sound makes a user copy). */
export interface TemplateEntry {
  template: ReelTemplate
  builtIn: boolean
}

/** The layer kinds a template may carry. Video footage is never saved (a
 *  clip's EFFECT is, as `clipEffect`); layouts and compound clips are not. */
export const TEMPLATE_LAYER_KINDS = ['text', 'graphics', 'image'] as const
export type TemplateLayerKind = (typeof TEMPLATE_LAYER_KINDS)[number]

/** Whether a layer may go into a template. */
export const isTemplateLayer = (l: Layer): boolean =>
  (TEMPLATE_LAYER_KINDS as readonly string[]).includes(l.content.kind)

/** The template's length: the hold, or the last piece's end, whichever is later. */
export function templateDuration(t: ReelTemplate): number {
  let end = t.clipEffect?.holdSec ?? 0
  for (const l of t.layers) end = Math.max(end, l.endSec)
  for (const a of t.audio) {
    // Played length: a sound keeps its speed and holds in a template.
    const len = a.clip.outSec > 0 ? audioPlayedSec(a.clip, a.clip.outSec) : 0
    end = Math.max(end, a.clip.startSec + len)
  }
  return end
}

/** Every MEDIA file the template refers to (pictures, sounds), deduped, in
 *  order. Its LUTs are `templateLutFiles`; all of them, `templateAllFiles`. */
export function templateFiles(t: ReelTemplate): string[] {
  const out: string[] = []
  const add = (f: string): void => {
    if (f && !out.includes(f)) out.push(f)
  }
  for (const l of t.layers) if (l.content.kind === 'image') add(l.content.mediaId)
  for (const a of t.audio) if (a.file) add(a.file)
  return out
}

/** Every LUT reference in the template (the clip effect's, then each picture's), in order. */
export function templateLutRefs(t: ReelTemplate): LutRef[] {
  const out: LutRef[] = []
  if (t.clipEffect?.lut) out.push(t.clipEffect.lut)
  for (const l of t.layers) if (l.content.kind === 'image' && l.content.lut) out.push(l.content.lut)
  return out
}

/** Every `.cube` LUT file the template refers to (the clip effect's, a picture's), deduped. */
export const templateLutFiles = (t: ReelTemplate): string[] => [
  ...new Set(
    templateLutRefs(t)
      .map((r) => r.file)
      .filter(Boolean)
  )
]

/** The names (as the Inspector shows them) the template gives LUT file `file`, deduped. */
export const templateLutNames = (t: ReelTemplate, file: string): string[] => [
  ...new Set(
    templateLutRefs(t)
      .filter((r) => r.file === file)
      .map((r) => r.name)
  )
]

/** Every file the template's folder must hold: its media, then its LUTs. */
export const templateAllFiles = (t: ReelTemplate): string[] => [
  ...new Set([...templateFiles(t), ...templateLutFiles(t)])
]

/**
 * Rewrite every media reference through `fn` — file names → media ids on a
 * drop, media ids → file names on a save. `null` drops the reference: an image
 * layer goes, a sound becomes an empty slot. (LUTs: `mapTemplateLuts`.)
 */
export function mapTemplateFiles(t: ReelTemplate, fn: (ref: string) => string | null): ReelTemplate {
  const layers = t.layers.flatMap((l) => {
    if (l.content.kind !== 'image') return [l]
    const to = fn(l.content.mediaId)
    return to ? [{ ...l, content: { ...l.content, mediaId: to } }] : []
  })
  const audio = t.audio.map((a) => (a.file ? { ...a, file: fn(a.file) } : a))
  return { ...t, layers, audio }
}

/**
 * Rewrite every LUT reference's `file` through `fn` — the template's file
 * names → the project's `luts/` names on a drop, and back on a save. `null`
 * drops that LUT (the rest of the look stays).
 */
export function mapTemplateLuts(t: ReelTemplate, fn: (file: string) => string | null): ReelTemplate {
  const map = (lut: LutRef | null | undefined): LutRef | null | undefined => {
    if (!lut) return lut
    const to = fn(lut.file)
    return to ? { ...lut, file: to } : null
  }
  const layers = t.layers.map((l) =>
    l.content.kind === 'image' && l.content.lut ? { ...l, content: { ...l.content, lut: map(l.content.lut) } } : l
  )
  const clipEffect = t.clipEffect?.lut ? { ...t.clipEffect, lut: map(t.clipEffect.lut) } : t.clipEffect
  return { ...t, layers, clipEffect }
}

/** What a template does, for its gallery card ("Freeze 3s · zoom · tint · 1 text · sting: none"). */
export function templateSummary(t: ReelTemplate): string {
  const parts: string[] = []
  const fx = t.clipEffect
  if (fx) {
    parts.push(`Freeze ${fmtSec(fx.holdSec)}`)
    if (fx.zoom) parts.push('zoom')
    if (fx.tint && !isNeutralTint(fx.tint)) parts.push('tint')
    else if (fx.color && !isNeutralColor(fx.color)) parts.push('grade')
    if (fx.lut) parts.push('LUT')
  }
  const count = (kind: string, one: string, many: string): void => {
    const n = t.layers.filter((l) => l.content.kind === kind).length
    if (n) parts.push(`${n} ${n === 1 ? one : many}`)
  }
  count('text', 'text', 'texts')
  count('graphics', 'graphic', 'graphics')
  count('image', 'image', 'images')
  for (const a of t.audio) parts.push(`${a.label.toLowerCase()}: ${a.file ? 'set' : 'none'}`)
  return parts.join(' · ')
}

const fmtSec = (s: number): string => `${Math.round(s * 10) / 10}s`

/**
 * The moment a gallery preview shows: the start of the window where the most
 * layers are on screen, nudged in so entrance animations have landed.
 */
export function templatePreviewTime(t: ReelTemplate): number {
  if (!t.layers.length) return 0
  let best = 0
  let bestCount = -1
  for (const l of t.layers) {
    const at = Math.min(l.startSec + 0.8, (l.startSec + l.endSec) / 2)
    const n = t.layers.filter((o) => o.startSec <= at && at < o.endSec).length
    if (n > bestCount) {
      best = at
      bestCount = n
    }
  }
  return best
}

/** The name a template is saved under: trimmed and capped; null when blank. */
export function cleanTemplateName(name: string): string | null {
  const n = name.trim().replace(/\s+/g, ' ').slice(0, TEMPLATE_NAME_MAX).trim()
  return n || null
}

// --- Validation (stored + imported templates) ---------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

/** The template's own JSON file, which no media file may be named. */
export const TEMPLATE_JSON = 'template.json'

/**
 * A file name stored inside a template: a bare name Windows accepts — no
 * folders, no `..`, no reserved device name (CON, NUL, COM1…), no trailing dot
 * or space — and never the template's own `template.json`.
 */
export function isTemplateFileName(v: unknown): v is string {
  return (
    isStr(v) &&
    v.length > 0 &&
    v.length <= 255 &&
    !FORBIDDEN_NAME_CHARS.test(v) &&
    !/[. ]$/.test(v) &&
    !RESERVED_DEVICE_NAME.test(v) &&
    v.toLowerCase() !== TEMPLATE_JSON
  )
}

const isOptObj = (v: unknown, ok: (o: Record<string, unknown>) => boolean): boolean =>
  v === undefined || v === null || (isObj(v) && ok(v))

const validKeyframe = (k: unknown): boolean =>
  isObj(k) && [k.tSec, k.x, k.y, k.scale].every(isNum) && (k.opacity === undefined || isNum(k.opacity))

const validPoint = (p: unknown): boolean => isObj(p) && isNum(p.x) && isNum(p.y)

const validMarkKeyframe = (k: unknown): boolean =>
  isObj(k) &&
  [k.tSec, k.dx, k.dy, k.scale, k.rotationDeg, k.opacity, k.drawn, k.widthPx].every(isNum) &&
  isStr(k.color) &&
  (k.fill === undefined || isStr(k.fill)) &&
  (EASINGS as { id: unknown }[]).some((e) => e.id === k.easing)

/** A mark's presets. Validation runs BEFORE `migrateTemplate`, so a template saved
 *  before v37 (a `reveal`, no `entrance`) still passes; the migration converts it. */
const validMarkPresets = (m: Record<string, unknown>): boolean => {
  const kindOk = (list: { id: string }[], o: unknown, len: string): boolean =>
    isObj(o) && list.some((e) => e.id === o.kind) && isNum(o[len])
  const entranceOk = m.entrance === undefined ? isStr(m.reveal) : kindOk(ENTRANCES, m.entrance, 'sec')
  return (
    entranceOk &&
    (m.exit === undefined || kindOk(EXITS, m.exit, 'sec')) &&
    (m.loop === undefined || kindOk(LOOPS, m.loop, 'cycleSec'))
  )
}

const validMark = (m: unknown): boolean =>
  isObj(m) &&
  isStr(m.id) &&
  (GRAPHIC_TOOLS as readonly unknown[]).includes(m.tool) &&
  Array.isArray(m.points) &&
  m.points.length >= 2 &&
  m.points.every(validPoint) &&
  isStr(m.color) &&
  isNum(m.widthPx) &&
  isNum(m.atSec) &&
  validMarkPresets(m) &&
  (m.fill === undefined || m.fill === null || isStr(m.fill)) &&
  (m.radiusPx === undefined || isNum(m.radiusPx)) &&
  (m.dropWidth === undefined || isNum(m.dropWidth)) &&
  (m.keyframes === undefined || (Array.isArray(m.keyframes) && m.keyframes.every(validMarkKeyframe))) &&
  (m.pivot === undefined || validPoint(m.pivot)) &&
  (m.rotationDeg === undefined || isNum(m.rotationDeg)) &&
  (m.scale === undefined || isNum(m.scale)) &&
  (m.opacity === undefined || isNum(m.opacity)) &&
  isOptObj(m.sparkle, (sp) => isNum(sp.density) && isStr(sp.color))

/** Every field the preview and the export read off a text layer, typed. */
function validText(c: Record<string, unknown>): boolean {
  return (
    isStr(c.text) &&
    isStr(c.fontFamily) &&
    isNum(c.fontSizePx) &&
    c.fontSizePx > 0 &&
    isStr(c.color) &&
    isObj(c.pill) &&
    typeof c.pill.enabled === 'boolean' &&
    isStr(c.pill.color) &&
    isNum(c.pill.padPx) &&
    isOptObj(c.stroke, (s) => isNum(s.widthPx) && isStr(s.color)) &&
    isOptObj(c.shadow, (s) => isNum(s.distancePx) && isStr(s.color) && isNum(s.blur)) &&
    isOptObj(c.gradient, (g) => isStr(g.from) && isStr(g.to) && isNum(g.angle)) &&
    isOptObj(c.animation, (a) => isStr(a.in) && isNum(a.inSec) && isStr(a.out) && isNum(a.outSec)) &&
    isOptObj(c.effects, (e) => isOptObj(e.sparkle, (sp) => isNum(sp.density) && isStr(sp.color))) &&
    (c.widthPx === undefined || isNum(c.widthPx))
  )
}

/** A tile edge's transition (shared/transitions.ts): a known kind and a positive length. */
const validTransition = (t: unknown): boolean =>
  isObj(t) && typeof t.kind === 'string' && t.kind in TRANSITION_KINDS && isNum(t.sec) && t.sec > 0

function validLayer(v: unknown): v is Layer {
  if (!isObj(v) || !isStr(v.id) || !isObj(v.content)) return false
  if (![v.startSec, v.endSec, v.x, v.y, v.scale].every(isNum)) return false
  if ((v.endSec as number) <= (v.startSec as number)) return false
  if (v.keyframes !== undefined && !(Array.isArray(v.keyframes) && v.keyframes.every(validKeyframe))) return false
  for (const k of ['rotationDeg', 'stretchX', 'stretchY'] as const) if (v[k] !== undefined && !isNum(v[k])) return false
  for (const k of ['transitionIn', 'transitionOut'] as const)
    if (v[k] !== undefined && !validTransition(v[k])) return false
  const c = v.content
  switch (c.kind) {
    case 'text':
      return validText(c)
    case 'graphics':
      return Array.isArray(c.marks) && c.marks.every(validMark)
    case 'image':
      return isTemplateFileName(c.mediaId) && isNum(c.opacity) && validLook(c)
    default:
      return false
  }
}

function validAudio(v: unknown): v is TemplateAudio {
  if (!isObj(v) || !isStr(v.label) || !isObj(v.clip)) return false
  if (v.file !== null && !isTemplateFileName(v.file)) return false
  const c = v.clip
  return (
    [c.startSec, c.inSec, c.outSec, c.gainDb, c.fadeInSec, c.fadeOutSec].every(isNum) &&
    isStr(c.kind) &&
    (c.speed === undefined || (isNum(c.speed) && c.speed > 0))
  )
}

/** A colour grade: the three sliders, and the newer controls when present. */
const validColor = (col: Record<string, unknown>): boolean =>
  isNum(col.brightness) &&
  isNum(col.contrast) &&
  isNum(col.saturation) &&
  (['temperature', 'greenMagenta', 'vibrance'] as const).every((k) => col[k] === undefined || isNum(col[k]))

/** A LUT reference inside a template: a file in its folder, a name, a strength. */
const validLut = (l: Record<string, unknown>): boolean =>
  isTemplateFileName(l.file) && /\.cube$/i.test(l.file) && isStr(l.name) && isNum(l.strength)

/** A picture's colour look (all optional). */
const validLook = (c: Record<string, unknown>): boolean =>
  isOptObj(c.color, validColor) &&
  isOptObj(c.tint, (t) => isStr(t.color) && isNum(t.amount)) &&
  isOptObj(c.lut, validLut)

function validEffect(v: unknown): v is TemplateClipEffect {
  if (!isObj(v) || !isNum(v.holdSec) || v.holdSec <= 0) return false
  const z = v.zoom
  if (z !== null && !(isObj(z) && isNum(z.scale) && z.scale > 0 && isNum(z.dx) && isNum(z.dy))) return false
  const col = v.color
  if (col !== null && !(isObj(col) && validColor(col))) return false
  if (!isOptObj(v.lut, validLut)) return false
  const tint = v.tint
  return tint === null || (isObj(tint) && isStr(tint.color) && isNum(tint.amount))
}

/**
 * A stored or imported template, or null when it isn't one we can use (wrong
 * shape, a newer format, a piece we can't place, two files whose names differ
 * only in case — one file on Windows). Checked as a WHOLE — a half-valid
 * template would drop half its pieces — and returned as given; main brings
 * its layers up to date with `migrateTemplate` after.
 */
export function sanitizeTemplate(v: unknown): ReelTemplate | null {
  if (!isObj(v) || !isStr(v.id) || !v.id || !isStr(v.name) || !cleanTemplateName(v.name)) return null
  if (!isNum(v.formatVersion) || v.formatVersion > TEMPLATE_FORMAT_VERSION) return null
  if (!Array.isArray(v.layers) || !v.layers.every(validLayer)) return null
  if (!Array.isArray(v.audio) || !v.audio.every(validAudio)) return null
  if (v.clipEffect !== null && !validEffect(v.clipEffect)) return null
  if (v.basedOn !== undefined && !isStr(v.basedOn)) return null
  if (v.projectVersion !== undefined && !isNum(v.projectVersion)) return null
  const files = templateAllFiles(v as unknown as ReelTemplate).map((f) => f.toLowerCase())
  if (new Set(files).size !== files.length) return null
  if (!v.layers.length && !v.audio.length && !v.clipEffect) return null
  return v as unknown as ReelTemplate
}

/**
 * `t` with its layers brought up to the current project schema: they run
 * through the same `migrateProject` a saved project does (from the
 * `projectVersion` they were saved in), so a template saved today still drops
 * correctly after the document format moves on.
 */
export function migrateTemplate(t: ReelTemplate): ReelTemplate {
  const from = t.projectVersion ?? 29
  if (from >= PROJECT_VERSION) return t
  const doc = { ...createEmptyProject('template', t.name), version: from, layers: structuredClone(t.layers) }
  return { ...t, layers: migrateProject(doc).layers, projectVersion: PROJECT_VERSION }
}

// --- The share file ----------------------------------------------------------

/** What a `.reeltemplate` file holds: the template plus its files, base64. */
export interface TemplateShareFile {
  format: 'reel-template'
  version: number
  template: ReelTemplate
  files: Record<string, string>
}

/**
 * Read a share file's parsed JSON: the template and its files (still base64),
 * or a reason it can't be imported. Every file the template refers to must be
 * in it, and nothing else is taken.
 */
export function parseTemplateShare(
  v: unknown
): { template: ReelTemplate; files: Record<string, string> } | { error: string } {
  if (!isObj(v) || v.format !== 'reel-template') return { error: "That file isn't a Reel Editor template." }
  if (!isNum(v.version) || v.version > TEMPLATE_FORMAT_VERSION) {
    return { error: 'That template was made by a newer version of the editor.' }
  }
  const template = sanitizeTemplate(v.template)
  if (!template) return { error: "That template is damaged or incomplete, so it can't be imported." }
  const files = isObj(v.files) ? v.files : {}
  const out: Record<string, string> = {}
  for (const f of templateAllFiles(template)) {
    const data = files[f]
    if (!isStr(data)) return { error: `That template is missing its file "${f}".` }
    out[f] = data
  }
  return { template, files: out }
}
