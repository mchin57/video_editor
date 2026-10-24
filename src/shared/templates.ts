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

import type { AudioClip, ColorAdjust, Layer } from './project'
import type { Tint } from './tint'
import { isNeutralTint } from './tint'
import { isNeutralColor } from './project'

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
  /** Colour correction of the held frame (null = left as the clip has it). */
  color: ColorAdjust | null
  /** Tint of the held frame (null = left as the clip has it). */
  tint: Tint | null
}

/** An audio clip's mix and timing, minus its identity and media. */
export type TemplateAudioClip = Pick<
  AudioClip,
  'startSec' | 'inSec' | 'outSec' | 'gainDb' | 'mute' | 'fadeInSec' | 'fadeOutSec' | 'duck' | 'kind'
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
    const len = a.clip.outSec > 0 ? a.clip.outSec - a.clip.inSec : 0
    end = Math.max(end, a.clip.startSec + len)
  }
  return end
}

/** Every file the template refers to, deduped, in order. */
export function templateFiles(t: ReelTemplate): string[] {
  const out: string[] = []
  const add = (f: string): void => {
    if (f && !out.includes(f)) out.push(f)
  }
  for (const l of t.layers) if (l.content.kind === 'image') add(l.content.mediaId)
  for (const a of t.audio) if (a.file) add(a.file)
  return out
}

/**
 * Rewrite every media reference through `fn` — file names → media ids on a
 * drop, media ids → file names on a save. `null` drops the reference: an image
 * layer goes, a sound becomes an empty slot.
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

/** What a template does, for its gallery card ("Freeze 3s · zoom · tint · 1 text · sting: none"). */
export function templateSummary(t: ReelTemplate): string {
  const parts: string[] = []
  const fx = t.clipEffect
  if (fx) {
    parts.push(`Freeze ${fmtSec(fx.holdSec)}`)
    if (fx.zoom) parts.push('zoom')
    if (fx.tint && !isNeutralTint(fx.tint)) parts.push('tint')
    else if (fx.color && !isNeutralColor(fx.color)) parts.push('grade')
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

/** A file name stored inside a template: a bare name, no folders, no `..`. */
export function isTemplateFileName(v: unknown): v is string {
  return isStr(v) && v.length > 0 && v.length <= 255 && !/[\\/:*?"<>|\0]/.test(v) && v !== '.' && v !== '..'
}

function validLayer(v: unknown): v is Layer {
  if (!isObj(v) || !isStr(v.id) || !isObj(v.content)) return false
  if (![v.startSec, v.endSec, v.x, v.y, v.scale].every(isNum)) return false
  if ((v.endSec as number) <= (v.startSec as number)) return false
  if (v.keyframes !== undefined && !Array.isArray(v.keyframes)) return false
  const c = v.content
  switch (c.kind) {
    case 'text':
      return isStr(c.text) && isStr(c.fontFamily) && isNum(c.fontSizePx) && isStr(c.color) && isObj(c.pill as unknown)
    case 'graphics':
      return Array.isArray(c.marks)
    case 'image':
      return isTemplateFileName(c.mediaId) && isNum(c.opacity)
    default:
      return false
  }
}

function validAudio(v: unknown): v is TemplateAudio {
  if (!isObj(v) || !isStr(v.label) || !isObj(v.clip)) return false
  if (v.file !== null && !isTemplateFileName(v.file)) return false
  const c = v.clip
  return [c.startSec, c.inSec, c.outSec, c.gainDb, c.fadeInSec, c.fadeOutSec].every(isNum) && isStr(c.kind)
}

function validEffect(v: unknown): v is TemplateClipEffect {
  if (!isObj(v) || !isNum(v.holdSec) || v.holdSec <= 0) return false
  const z = v.zoom
  if (z !== null && !(isObj(z) && isNum(z.scale) && z.scale > 0 && isNum(z.dx) && isNum(z.dy))) return false
  const col = v.color
  if (col !== null && !(isObj(col) && isNum(col.brightness) && isNum(col.contrast) && isNum(col.saturation))) {
    return false
  }
  const tint = v.tint
  return tint === null || (isObj(tint) && isStr(tint.color) && isNum(tint.amount))
}

/**
 * A stored or imported template, or null when it isn't one we can use (wrong
 * shape, a newer format, a piece we can't place). Checked as a WHOLE — a
 * half-valid template would drop half its pieces — and returned as given: the
 * renderer's own migrations still run on the layers it places.
 */
export function sanitizeTemplate(v: unknown): ReelTemplate | null {
  if (!isObj(v) || !isStr(v.id) || !v.id || !isStr(v.name) || !cleanTemplateName(v.name)) return null
  if (!isNum(v.formatVersion) || v.formatVersion > TEMPLATE_FORMAT_VERSION) return null
  if (!Array.isArray(v.layers) || !v.layers.every(validLayer)) return null
  if (!Array.isArray(v.audio) || !v.audio.every(validAudio)) return null
  if (v.clipEffect !== null && !validEffect(v.clipEffect)) return null
  if (v.basedOn !== undefined && !isStr(v.basedOn)) return null
  if (!v.layers.length && !v.audio.length && !v.clipEffect) return null
  return v as unknown as ReelTemplate
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
  for (const f of templateFiles(template)) {
    const data = files[f]
    if (!isStr(data)) return { error: `That template is missing its file "${f}".` }
    out[f] = data
  }
  return { template, files: out }
}
