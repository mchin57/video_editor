/**
 * Shared library storage (shared/sharedLibrary.ts holds the format,
 * docs/SHARED-LIBRARY.md the behavior): editor-wide, one folder per item under
 * `<data>/shared/<id>/` holding `item.json` plus the item's OWN copy of its
 * file and, for video and graphics the browser can't draw, a `thumb.jpg`. A
 * text piece is only its record. The same layout as templates
 * (services/templates.ts): the record is written last, so a half-written item
 * never lists, and a failed add removes its folder again.
 *
 * Every function takes the shared `root`, so tests run against a temp dir; the
 * IPC handlers pass `sharedRoot()`. Probing and thumbnails go through `deps`,
 * so tests need no ffmpeg.
 */

import { existsSync, promises as fsp } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Fingerprint, ProbeInfo } from '@shared/media'
import { kindOfFile } from '@shared/media'
import { newId } from '@shared/ids'
import { bestEffort, createLogger } from '@shared/log'
import {
  BROWSER_IMAGE_EXTS,
  SHARED_FORMAT_VERSION,
  SHARED_ITEM_JSON,
  SHARED_KIND_LABELS,
  cleanSharedName,
  isSharedFileName,
  makeSharedText,
  migrateSharedItem,
  sanitizeSharedItem,
  sharedKindOf,
  sortShared,
  type SharedAddResult,
  type SharedItem,
  type SharedKind
} from '@shared/sharedLibrary'
import { getSubdir } from '../config'
import { replaceFile } from './atomicWrite'
import { fingerprintFile, sameFingerprint } from './fingerprint'
import { safeFileName } from './projectLayout'

const log = createLogger('shared-library')

/** The thumbnail file in an item's folder (video, and graphics the browser can't draw). */
const THUMB = 'thumb.jpg'

const KIND_NOUN: Record<Exclude<SharedKind, 'text'>, string> = {
  sound: 'a sound',
  graphic: 'a picture',
  video: 'a video'
}

/** Where the shared library lives: `<data>/shared`. */
export const sharedRoot = (): string => getSubdir('shared')

/** What adding a file needs from ffmpeg (real ones in the app, fakes in tests). */
export interface SharedDeps {
  probe: (path: string) => Promise<ProbeInfo>
  /** Write a JPEG thumbnail of `input` to `output` (`still` = a single image). */
  thumbnail: (input: string, output: string, probe: ProbeInfo, still: boolean) => Promise<void>
}

/** An item's folder, or null when `id` couldn't be one (a path, `..`). */
function dirOf(root: string, id: string): string | null {
  return isSharedFileName(id) ? join(root, id) : null
}

/** Item `id` as stored (null when there is none, or it is damaged or its file is gone). */
async function readItem(root: string, id: string): Promise<SharedItem | null> {
  const dir = dirOf(root, id)
  if (!dir) return null
  let raw: string
  try {
    raw = await fsp.readFile(join(dir, SHARED_ITEM_JSON), 'utf8')
  } catch {
    return null // not an item folder
  }
  let item: SharedItem | null = null
  try {
    item = sanitizeSharedItem(JSON.parse(raw))
  } catch (error) {
    log.warn(`shared item ${id} is not valid JSON; skipped`, error)
    return null
  }
  if (!item || item.id !== id) {
    log.warn(`shared item ${id} is damaged; skipped`)
    return null
  }
  if (item.file && !existsSync(join(dir, item.file))) {
    log.warn(`shared item ${id} has lost its file; skipped`)
    return null
  }
  if (item.preview && !existsSync(join(dir, item.preview))) item = { ...item, preview: null }
  return migrateSharedItem(item)
}

/** Every item, in gallery order (by name). */
export async function listShared(root: string): Promise<SharedItem[]> {
  let names: string[]
  try {
    names = await fsp.readdir(root)
  } catch {
    return []
  }
  const out: SharedItem[] = []
  for (const n of names) {
    const item = await readItem(root, n)
    if (item) out.push(item)
  }
  return sortShared(out)
}

/** Item `id`, or a readable error when it has gone. */
async function requireItem(root: string, id: string): Promise<SharedItem> {
  const item = await readItem(root, id)
  if (!item) throw new Error('That shared item no longer exists.')
  return item
}

/** Write `item`'s record (into a folder that exists). */
const writeRecord = (root: string, item: SharedItem): Promise<void> =>
  replaceFile(join(root, item.id, SHARED_ITEM_JSON), JSON.stringify(item, null, 2))

/**
 * Copy the file at `srcPath` in as a new item named `name` (default: the
 * file's name without its extension). The same content already shared is not
 * copied again: `existing` names that item. Throws a readable reason for a
 * file that can't be shared (a workout, an unreadable file).
 */
async function addOne(
  root: string,
  srcPath: string,
  deps: SharedDeps,
  only?: Exclude<SharedKind, 'text'>,
  name?: string
): Promise<{ item: SharedItem; existing: boolean }> {
  let fp: Fingerprint
  try {
    fp = await fingerprintFile(srcPath)
  } catch (error) {
    log.warn(`reading ${srcPath} for the shared library failed`, error)
    throw new Error("It couldn't be read (it may have moved, or another program has it open).")
  }
  const same = (await listShared(root)).find((i) => i.fingerprint && sameFingerprint(i.fingerprint, fp))
  if (same) return { item: same, existing: true }

  let probe: ProbeInfo
  try {
    probe = await deps.probe(srcPath)
  } catch (error) {
    log.warn(`probing ${srcPath} for the shared library failed`, error)
    throw new Error("It couldn't be read as a sound, picture or video.")
  }
  const kind = sharedKindOf(kindOfFile(srcPath, probe))
  if (!kind) throw new Error("Only sounds, pictures and video can be shared, so it wasn't added.")
  if (only && kind !== only)
    throw new Error(`It isn't ${KIND_NOUN[only]}, so it belongs on the ${SHARED_KIND_LABELS[kind]} tab.`)

  const id = newId()
  const dir = join(root, id)
  const file = safeFileName(basename(srcPath))
  const fileName =
    file.toLowerCase() === SHARED_ITEM_JSON || file.toLowerCase() === THUMB ? `media${extname(file)}` : file
  const ext = extname(fileName).slice(1).toLowerCase()
  const drawable = kind === 'graphic' && (BROWSER_IMAGE_EXTS as readonly string[]).includes(ext)
  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.copyFile(srcPath, join(dir, fileName))
    let preview: string | null = drawable ? fileName : null
    if (kind !== 'sound' && !drawable) {
      await bestEffort(
        deps.thumbnail(join(dir, fileName), join(dir, THUMB), probe, kind === 'graphic'),
        `thumbnail for shared ${fileName}`,
        log
      )
      if (existsSync(join(dir, THUMB))) preview = THUMB
    }
    const item: SharedItem = {
      id,
      name: cleanSharedName(name ?? basename(srcPath, extname(srcPath))) ?? 'Untitled',
      kind,
      formatVersion: SHARED_FORMAT_VERSION,
      addedAt: new Date().toISOString(),
      file: fileName,
      preview,
      durationSec: kind === 'graphic' ? 0 : Math.max(0, probe.durationSec || 0),
      fingerprint: fp,
      layers: []
    }
    await writeRecord(root, item)
    return { item, existing: false }
  } catch (error) {
    await bestEffort(fsp.rm(dir, { recursive: true, force: true }), `removing half-added shared item ${id}`, log)
    throw error
  }
}

/**
 * Add the files at `paths` (each copied in). `only` limits them to one tab's
 * kind (the tab Add files… was used on); a file of another kind is skipped
 * with the reason. One file failing never stops the rest.
 */
export async function addSharedFiles(
  root: string,
  paths: string[],
  deps: SharedDeps,
  only?: Exclude<SharedKind, 'text'>,
  names?: (path: string) => string | undefined
): Promise<SharedAddResult> {
  await fsp.mkdir(root, { recursive: true })
  const added: string[] = []
  const already: string[] = []
  const skipped: SharedAddResult['skipped'] = []
  for (const p of paths) {
    try {
      const { item, existing } = await addOne(root, p, deps, only, names?.(p))
      ;(existing ? already : added).push(item.id)
    } catch (error) {
      skipped.push({ name: basename(p), reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { items: await listShared(root), added, already, skipped }
}

/**
 * Save `layers` (text layers timed from 0) as the text piece `name`. A text
 * piece with the same name is replaced, like a template. Returns the list.
 */
export async function saveSharedText(root: string, name: string, layers: unknown): Promise<SharedItem[]> {
  const made = makeSharedText(newId(), name, layers, new Date().toISOString())
  if ('error' in made) throw new Error(made.error)
  const same = (await listShared(root)).filter(
    (i) => i.kind === 'text' && i.name.toLowerCase() === made.name.toLowerCase()
  )
  const dir = join(root, made.id)
  try {
    await fsp.mkdir(dir, { recursive: true })
    await writeRecord(root, made)
  } catch (error) {
    await bestEffort(fsp.rm(dir, { recursive: true, force: true }), `removing half-saved text ${made.id}`, log)
    throw error
  }
  for (const o of same) await bestEffort(removeItemDir(root, o.id), `removing replaced text ${o.id}`, log)
  return listShared(root)
}

/** Rename item `id` (only its name in the gallery; the file keeps its own). */
export async function renameShared(root: string, id: string, name: string): Promise<SharedItem[]> {
  const clean = cleanSharedName(name)
  if (!clean) throw new Error('Give it a name.')
  const item = await requireItem(root, id)
  // Text pieces are found by name (saving one replaces the one of that name),
  // so two may never share a name.
  if (item.kind === 'text') {
    const taken = (await listShared(root)).some(
      (o) => o.kind === 'text' && o.id !== id && o.name.toLowerCase() === clean.toLowerCase()
    )
    if (taken) throw new Error(`You already have shared text called “${clean}”.`)
  }
  await writeRecord(root, { ...item, name: clean })
  return listShared(root)
}

async function removeItemDir(root: string, id: string): Promise<void> {
  const dir = dirOf(root, id)
  if (dir) await fsp.rm(dir, { recursive: true, force: true })
}

/** Delete item `id` and its copy. Projects that inserted it keep their own copies. */
export async function deleteShared(root: string, id: string): Promise<SharedItem[]> {
  await requireItem(root, id)
  await removeItemDir(root, id)
  return listShared(root)
}

/** The path of item `id`'s file, and the name a project's copy is shown as.
 *  Throws for a text piece (nothing to copy) or an item that has gone. */
export async function sharedFile(root: string, id: string): Promise<{ path: string; displayName: string }> {
  const item = await requireItem(root, id)
  if (!item.file) throw new Error('A text piece has no file to copy.')
  return { path: join(root, id, item.file), displayName: `${item.name}${extname(item.file)}` }
}
