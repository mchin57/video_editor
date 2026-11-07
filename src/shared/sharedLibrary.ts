/**
 * The shared library (docs/SHARED-LIBRARY.md): editor-wide assets every project
 * can insert — sounds, graphics, video and saved text pieces — opened from
 * Insert ▸ Shared. Stored like templates: one folder per item under
 * `<data>/shared/<id>/` holding `item.json` plus the item's OWN copy of its file
 * (a text piece has no file; its layers are in the record). Inserting copies the
 * file into the open project (`generated/`), so a project never points into the
 * shared folder.
 *
 * Pure — main (storage) and the renderer (gallery, insert) share it.
 */

import type { Fingerprint, MediaKind } from './media'
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS } from './media'
import type { Layer } from './project'
import { PROJECT_VERSION } from './project'
import {
  TEMPLATE_FORMAT_VERSION,
  TEMPLATE_NAME_MAX,
  cleanTemplateName,
  isTemplateFileName,
  migrateTemplate,
  sanitizeTemplate,
  templateDuration,
  type ReelTemplate
} from './templates'

/** Bump when the stored shape changes incompatibly (`sanitizeSharedItem` refuses newer). */
export const SHARED_FORMAT_VERSION = 1

/** Each item's own record file, which no media file may be named. */
export const SHARED_ITEM_JSON = 'item.json'

/** The gallery tabs (Insert ▸ Shared ▸ …), in menu order. */
export const SHARED_KINDS = ['sound', 'graphic', 'video', 'text'] as const
export type SharedKind = (typeof SHARED_KINDS)[number]

/** A tab's label, and its menu row ("Sounds…"). */
export const SHARED_KIND_LABELS: Record<SharedKind, string> = {
  sound: 'Sounds',
  graphic: 'Graphics',
  video: 'Video',
  text: 'Text'
}

/** Longest item name kept (the template limit). */
export const SHARED_NAME_MAX = TEMPLATE_NAME_MAX

export interface SharedItem {
  id: string
  name: string
  kind: SharedKind
  formatVersion: number
  /** When it was added (ISO 8601). */
  addedAt: string
  /** The media file in the item's folder; null for a text piece. */
  file: string | null
  /** The file the gallery shows as its picture (the graphic itself when the
   *  browser can draw it, else a `thumb.jpg`); null = none. */
  preview: string | null
  /** The file's length (0 for a graphic); a text piece's own length. */
  durationSec: number
  /** The file's fingerprint, so adding the same file again finds this item;
   *  null for a text piece. */
  fingerprint: Fingerprint | null
  /** A text piece's text layers, timed from 0 and laid out in the 1080×1920
   *  space exactly as saved; empty for every other kind. */
  layers: Layer[]
  /** The project schema its layers were saved in (text pieces). */
  projectVersion?: number
}

/** Which tab a file of library kind `kind` goes in (null = can't be shared). */
export function sharedKindOf(kind: MediaKind): Exclude<SharedKind, 'text'> | null {
  switch (kind) {
    case 'audio':
      return 'sound'
    case 'image':
      return 'graphic'
    case 'video':
      return 'video'
    default:
      return null
  }
}

/** The file extensions the Add files… picker offers on tab `kind`. */
export function sharedExtsFor(kind: Exclude<SharedKind, 'text'>): readonly string[] {
  return kind === 'sound' ? AUDIO_EXTS : kind === 'graphic' ? IMAGE_EXTS : VIDEO_EXTS
}

/** Image types the gallery draws straight from the file (others get a thumb). */
export const BROWSER_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] as const

/** The name an item is stored under: trimmed and capped; null when blank. */
export const cleanSharedName = (name: string): string | null => cleanTemplateName(name)

// --- Text pieces ----------------------------------------------------------------

/** A text piece as a template with only layers — what the timeline drop
 *  (`dropTemplate`) and the gallery preview take, so text pieces land and
 *  look exactly like a template's text. */
export function sharedTextTemplate(item: SharedItem): ReelTemplate {
  return {
    id: item.id,
    name: item.name,
    formatVersion: TEMPLATE_FORMAT_VERSION,
    layers: item.layers,
    audio: [],
    clipEffect: null,
    projectVersion: item.projectVersion ?? PROJECT_VERSION
  }
}

/** `layers` (text layers, timed from 0) checked as a template would be, or
 *  null when any of them isn't a text layer we can place. */
function validTextLayers(layers: unknown, name: string, projectVersion: unknown): Layer[] | null {
  if (!Array.isArray(layers) || !layers.length) return null
  const t = sanitizeTemplate({
    id: 'text-piece',
    name,
    formatVersion: TEMPLATE_FORMAT_VERSION,
    layers,
    audio: [],
    clipEffect: null,
    ...(projectVersion !== undefined ? { projectVersion } : {})
  })
  if (!t || !t.layers.every((l) => l.content.kind === 'text')) return null
  return t.layers
}

// --- Validation -------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

/** A bare file name stored in an item's folder (the template rule), never `item.json`. */
export const isSharedFileName = (v: unknown): v is string =>
  isTemplateFileName(v) && v.toLowerCase() !== SHARED_ITEM_JSON

const validFingerprint = (v: unknown): v is Fingerprint =>
  isObj(v) && isNum(v.size) && isStr(v.start) && isStr(v.middle) && isStr(v.end)

/**
 * A stored record, or null when it isn't one we can use (wrong shape, a newer
 * format, a media item without its file, a text piece without text layers).
 * Checked as a whole, returned as given; main brings a text piece's layers up
 * to date with `migrateSharedItem` after.
 */
export function sanitizeSharedItem(v: unknown): SharedItem | null {
  if (!isObj(v) || !isStr(v.id) || !isSharedFileName(v.id)) return null
  if (!isStr(v.name) || !cleanSharedName(v.name)) return null
  if (!(SHARED_KINDS as readonly unknown[]).includes(v.kind)) return null
  if (!isNum(v.formatVersion) || v.formatVersion > SHARED_FORMAT_VERSION) return null
  if (!isStr(v.addedAt) || !isNum(v.durationSec) || v.durationSec < 0) return null
  if (v.preview !== null && !isSharedFileName(v.preview)) return null
  if (v.projectVersion !== undefined && !isNum(v.projectVersion)) return null
  if (v.kind === 'text') {
    if (v.file !== null || v.fingerprint !== null) return null
    if (!validTextLayers(v.layers, v.name, v.projectVersion)) return null
  } else {
    if (!isSharedFileName(v.file) || !validFingerprint(v.fingerprint)) return null
    if (!Array.isArray(v.layers) || v.layers.length) return null
  }
  return v as unknown as SharedItem
}

/** A text piece with its layers brought up to the current project schema
 *  (the template migration); any other item as it is. */
export function migrateSharedItem(item: SharedItem): SharedItem {
  if (item.kind !== 'text') return item
  const t = migrateTemplate(sharedTextTemplate(item))
  return { ...item, layers: t.layers, projectVersion: t.projectVersion }
}

/**
 * A new text piece record from `layers` (text layers, already timed from 0),
 * or a reason it can't be saved. `id` and `addedAt` come from the caller.
 */
export function makeSharedText(
  id: string,
  name: string,
  layers: unknown,
  addedAt: string
): SharedItem | { error: string } {
  const clean = cleanSharedName(name)
  if (!clean) return { error: 'Give the text a name.' }
  const ok = validTextLayers(layers, clean, PROJECT_VERSION)
  if (!ok) return { error: 'Only text layers can be saved as shared text.' }
  const item: SharedItem = {
    id,
    name: clean,
    kind: 'text',
    formatVersion: SHARED_FORMAT_VERSION,
    addedAt,
    file: null,
    preview: null,
    durationSec: 0,
    fingerprint: null,
    layers: ok,
    projectVersion: PROJECT_VERSION
  }
  return { ...item, durationSec: templateDuration(sharedTextTemplate(item)) }
}

/** The gallery's order within a tab: by name, then newest first. */
export function sortShared(items: SharedItem[]): SharedItem[] {
  return [...items].sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || b.addedAt.localeCompare(a.addedAt)
  )
}

/** What the gallery says after an add: "Added “Whoosh”." / "Added 3 files.",
 *  then what was already there and what was refused (with the reason). */
export function describeSharedAdd(res: SharedAddResult): string {
  const nameOf = (id: string): string => `“${res.items.find((i) => i.id === id)?.name ?? 'it'}”`
  const parts: string[] = []
  if (res.added.length === 1) parts.push(`Added ${nameOf(res.added[0])}.`)
  else if (res.added.length) parts.push(`Added ${res.added.length} files.`)
  if (res.already.length === 1) parts.push(`${nameOf(res.already[0])} is already in the shared library.`)
  else if (res.already.length) parts.push(`${res.already.length} were already in the shared library.`)
  for (const s of res.skipped) parts.push(`Not added: ${s.name}. ${s.reason}`)
  return parts.join(' ')
}

/** The result of adding files: the updated list, and what happened to each. */
export interface SharedAddResult {
  items: SharedItem[]
  /** Items that were added, in order. */
  added: string[]
  /** Files whose content was already in the shared library (the existing item ids). */
  already: string[]
  /** Files refused, with the reason. */
  skipped: { name: string; reason: string }[]
}
