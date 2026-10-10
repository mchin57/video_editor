/**
 * Project persistence — a project is a FOLDER that owns its media
 * (docs/PROJECT-FOLDERS.md; layout in `projectLayout.ts`):
 *
 *  - `<Name>.reel` is the saved document (explicit File ▸ Save).
 *  - `autosave.json` is the working copy the renderer writes continuously, so a
 *    crash or quit can't lose work; it EXISTS exactly while there are unsaved
 *    changes (Save deletes it), which is how "dirty" survives a relaunch.
 *  - An unsaved project lives in the scratch folder `<data>/projects/scratch`;
 *    its first Save moves the whole folder to the chosen place.
 *
 * Which folder is open is main's state (`projectRoot`), remembered across
 * launches in `<data>/projects/session.json`. All document writes go through
 * one queue, so a late autosave can never land after (and resurrect over) a
 * Save, and an autosave from a document that is no longer open is dropped.
 */

import { existsSync, mkdirSync, promises as fsp, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MediaAsset } from '@shared/media'
import type { Project } from '@shared/project'
import { createEmptyProject, migrateProject, PROJECT_VERSION } from '@shared/project'
import { getSubdir } from '../config'
import { replaceFile } from './atomicWrite'
import { copyAtomic, linkOrCopy } from './linkOrCopy'
import { convertWorkingCopy } from './legacyConvert'
import { isLegacyDoc } from './legacyPlan'
import { getProjectRoot, setProjectRoot } from './projectRoot'
import {
  autosavePath,
  cacheDir,
  cacheRoot,
  docPath,
  isMediaId,
  mediaDir,
  mediaRoot,
  projectFolderFor,
  sweepPlan
} from './projectLayout'

export { REEL_EXT } from './projectLayout'

/** What the renderer adopts: the document, its `.reel` (null = unsaved
 *  scratch project) and whether it carries unsaved changes. */
export interface LoadedProject {
  project: Project
  path: string | null
  dirty: boolean
}

const scratchRoot = (): string => join(getSubdir('projects'), 'scratch')
const sessionPath = (): string => join(getSubdir('projects'), 'session.json')
const isScratch = (root: string): boolean => root === scratchRoot()

/** Id of the document open in the renderer — autosaves for any other are stale. */
let openId: string | null = null
/** No session file yet: the first launch since project folders, when the old
 *  working copy (projects/current.json) is converted into the scratch project. */
let firstLaunch = false

// --- Write queue -------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve()
/** Run `task` after every earlier document write has settled. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await replaceFile(path, JSON.stringify(data, null, 2))
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(path, 'utf8'))
}

// --- Session -------------------------------------------------------------------

function rememberRoot(root: string): void {
  setProjectRoot(root)
  try {
    writeFileSync(sessionPath(), JSON.stringify({ root: isScratch(root) ? null : root }))
  } catch (error) {
    console.error('could not record the open project', error)
  }
}

/**
 * Pick the folder to open at launch (before the window exists, so the media
 * protocol always has a root): the last open project if it is still there,
 * else the scratch folder.
 */
export function initProjectRoot(): void {
  let root: string | null = null
  firstLaunch = !existsSync(sessionPath())
  try {
    const s = JSON.parse(readFileSync(sessionPath(), 'utf8')) as { root?: unknown }
    if (typeof s.root === 'string' && existsSync(docPath(s.root))) root = s.root
  } catch {
    /* no session yet */
  }
  root ??= scratchRoot()
  mkdirSync(root, { recursive: true })
  setProjectRoot(root)
}

// --- Sweep ---------------------------------------------------------------------

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Delete `media/<id>` + `cache/<id>` that neither the saved document nor the
 * autosave mentions — media removed from the library (kept until now so undo
 * worked) or imported and never used. Undo history doesn't survive closing a
 * project, so on open nothing can bring them back. Skipped entirely if a
 * document that exists can't be read: never delete on a guess.
 */
async function sweep(root: string): Promise<void> {
  const docs: string[] = []
  for (const path of [docPath(root), autosavePath(root)]) {
    if (!existsSync(path)) continue
    try {
      docs.push(await fsp.readFile(path, 'utf8'))
    } catch {
      return
    }
  }
  if (!docs.length) return
  const present = [...new Set([...listDir(mediaRoot(root)), ...listDir(cacheRoot(root))])]
  for (const id of sweepPlan(present, docs)) {
    await fsp.rm(mediaDir(root, id), { recursive: true, force: true }).catch(() => {})
    await fsp.rm(cacheDir(root, id), { recursive: true, force: true }).catch(() => {})
  }
}

// --- Load / open / new -----------------------------------------------------------

/** Read the folder's working state: the autosave if there is one (unsaved
 *  changes), else the saved document, else a fresh project. */
async function readFolder(root: string): Promise<LoadedProject> {
  const scratch = isScratch(root)
  const doc = docPath(root)
  let project: Project | null = null
  let dirty = false
  try {
    project = migrateProject(await readJson(autosavePath(root)))
    dirty = true
  } catch {
    if (!scratch && existsSync(doc)) project = migrateProject(await readJson(doc))
  }
  project ??= createEmptyProject(crypto.randomUUID(), 'Untitled Reel')
  // A folder project is named by its folder (the folder is what the user sees,
  // renames and moves).
  if (!scratch) project = { ...project, name: basename(root) }
  openId = project.id
  return { project, path: scratch ? null : doc, dirty }
}

/** The project to show at launch (the root `initProjectRoot` chose). */
export function loadProject(): Promise<LoadedProject> {
  return serial(async () => {
    const root = getProjectRoot()
    if (firstLaunch && isScratch(root)) {
      firstLaunch = false
      await convertWorkingCopy(root).catch((error) => console.error('could not convert the old working copy', error))
      rememberRoot(root)
    }
    await sweep(root)
    return readFolder(root)
  })
}

/** Throw away the open project's unsaved state — the renderer already asked. */
async function discardCurrent(): Promise<void> {
  const root = getProjectRoot()
  if (isScratch(root)) await fsp.rm(root, { recursive: true, force: true })
  else await fsp.rm(autosavePath(root), { force: true })
}

/** File ▸ New: discard the current project's unsaved state, open an empty
 *  scratch folder for `project` (the renderer's fresh document). */
export function newProject(project: Project): Promise<void> {
  return serial(async () => {
    await discardCurrent()
    const root = scratchRoot()
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.mkdir(root, { recursive: true })
    rememberRoot(root)
    openId = project.id
  })
}

/**
 * File ▸ Open of a `.reel` inside a project folder. The current project's
 * unsaved state is discarded (the renderer confirmed), the folder becomes the
 * open root, and unreferenced media is swept.
 */
export function openProject(reelPath: string): Promise<LoadedProject> {
  return serial(async () => {
    const root = dirname(reelPath)
    // Keep `<Name>/<Name>.reel` true when the user renamed the folder.
    if (reelPath !== docPath(root) && !existsSync(docPath(root))) await fsp.rename(reelPath, docPath(root))
    // Validate before discarding anything: a bad file must not cost the open
    // project its unsaved work. A legacy file is converted first (ipc.ts).
    const raw = await readJson(docPath(root))
    if (isLegacyDoc(raw)) throw new Error('This project uses the old shared library and has to be converted first.')
    migrateProject(raw)
    await discardCurrent()
    rememberRoot(root)
    await sweep(root)
    return readFolder(root)
  })
}

// --- Autosave / save -----------------------------------------------------------

/** The renderer's debounced working-copy write. */
export function saveProject(project: Project): Promise<void> {
  return serial(async () => {
    if (project.id !== openId) return // a late write from a document no longer open
    const root = getProjectRoot()
    await fsp.mkdir(root, { recursive: true })
    await writeJsonAtomic(autosavePath(root), { ...project, updatedAt: new Date().toISOString() })
  })
}

/** Write a document to a path, returning it as saved (bumped time). */
export async function writeProjectFile(path: string, project: Project): Promise<Project> {
  const saved = { ...project, version: PROJECT_VERSION, updatedAt: new Date().toISOString() }
  await writeJsonAtomic(path, saved)
  return saved
}

/** Read and migrate a document. Throws on bad input. */
export async function readProjectFile(path: string): Promise<Project> {
  return migrateProject(await readJson(path))
}

/** File ▸ Save of an already-saved folder project: write the document, and
 *  drop the autosave (there are no unsaved changes any more). */
export function saveProjectFile(project: Project): Promise<Project> {
  return serial(async () => {
    const root = getProjectRoot()
    if (isScratch(root)) throw new Error('This project has no folder yet — use Save As.')
    const saved = await writeProjectFile(docPath(root), { ...project, name: basename(root) })
    await fsp.rm(autosavePath(root), { force: true })
    openId = saved.id
    return saved
  })
}

// --- Save As -------------------------------------------------------------------

/** Read an asset record without resolving it (we only need its fields). */
async function readRecord(path: string): Promise<(MediaAsset & { file: string }) | null> {
  try {
    return (await readJson(path)) as MediaAsset & { file: string }
  } catch {
    return null
  }
}

/** Place a file we may share (an original or a cache file) — link, else copy. */
async function placeShared(src: string, dest: string): Promise<'link' | 'copy'> {
  if (existsSync(dest)) return 'link'
  return linkOrCopy(src, dest)
}

/**
 * Copy one media id's folders into another project: originals and cache files
 * are linked where possible (zero extra disk on one volume — and safe, since
 * nothing in a project is ever written in place), records and transcripts are
 * real copies. Across volumes an original first tries to relink to its SOURCE
 * if that is still on the destination volume unchanged (size + mtime), so a
 * project saved next to its footage never pays for a copy.
 */
async function copyMediaId(from: string, to: string, id: string): Promise<void> {
  const fromMedia = mediaDir(from, id)
  const toMedia = mediaDir(to, id)
  await fsp.mkdir(toMedia, { recursive: true })
  const rec = await readRecord(join(fromMedia, 'asset.json'))
  for (const name of listDir(fromMedia)) {
    const src = join(fromMedia, name)
    const dest = join(toMedia, name)
    if (existsSync(dest)) continue
    if (rec && name === rec.file) {
      const placed = await placeOriginal(src, dest, rec)
      if (rec.storage !== 'generated') rec.storage = placed
    } else if (name !== 'asset.json' && !name.endsWith('.tmp')) {
      await copyAtomic(src, dest) // transcript: tiny, written by us — never share it
    }
  }
  if (rec) await writeJsonAtomic(join(toMedia, 'asset.json'), rec)
  // Cache: share what exists; anything missing simply rebuilds on demand.
  const fromCache = cacheDir(from, id)
  const names = listDir(fromCache).filter((n) => !n.includes('.part') && !n.endsWith('.tmp'))
  if (names.length) await fsp.mkdir(cacheDir(to, id), { recursive: true })
  for (const name of names) {
    await placeShared(join(fromCache, name), join(cacheDir(to, id), name)).catch(() => {})
  }
}

/** An original into another project: link to our copy; failing that (another
 *  volume) link to the unchanged source if it lives there; else copy. */
async function placeOriginal(
  src: string,
  dest: string,
  rec: MediaAsset
): Promise<'link' | 'copy'> {
  try {
    await fsp.link(src, dest)
    return 'link'
  } catch {
    /* fall through */
  }
  if (rec.storage !== 'generated' && rec.sourcePath && (await sameStat(rec.sourcePath, rec))) {
    try {
      await fsp.link(rec.sourcePath, dest)
      return 'link'
    } catch {
      /* fall through */
    }
  }
  await copyAtomic(src, dest)
  return 'copy'
}

async function sameStat(path: string, rec: { size?: number; mtimeMs?: number }): Promise<boolean> {
  try {
    const s = await fsp.stat(path)
    return s.size === rec.size && s.mtimeMs === rec.mtimeMs
  } catch {
    return false
  }
}

/** Media ids in `from` the document `json` mentions (the sweep's keep rule). */
function idsToCarry(from: string, json: string): string[] {
  const present = [...new Set([...listDir(mediaRoot(from)), ...listDir(cacheRoot(from))])].filter(isMediaId)
  const drop = new Set(sweepPlan(present, [json]))
  return present.filter((id) => !drop.has(id))
}

/**
 * File ▸ Save As to `chosenPath` (the `.reel` the Save dialog returned; the
 * folder is `projectFolderFor` it). From the scratch folder the media MOVES
 * (renames on one volume); from a saved folder it is linked/copied and the old
 * folder keeps its last save (its unsaved edits now belong to the new one).
 */
export function saveProjectAs(project: Project, chosenPath: string): Promise<{ path: string; project: Project }> {
  return serial(async () => {
    const from = getProjectRoot()
    const to = projectFolderFor(chosenPath)
    if (to === from) {
      const saved = await writeProjectFile(docPath(to), { ...project, name: basename(to) })
      await fsp.rm(autosavePath(to), { force: true })
      openId = saved.id
      return { path: docPath(to), project: saved }
    }
    await fsp.mkdir(to, { recursive: true })
    const ids = idsToCarry(from, JSON.stringify(project))
    const scratch = isScratch(from)
    for (const id of ids) {
      if (scratch && (await moveIdDirs(from, to, id))) continue
      await copyMediaId(from, to, id)
    }
    const saved = await writeProjectFile(docPath(to), { ...project, name: basename(to) })
    await fsp.rm(autosavePath(to), { force: true })
    if (scratch) await fsp.rm(from, { recursive: true, force: true }).catch(() => {})
    else await fsp.rm(autosavePath(from), { force: true })
    rememberRoot(to)
    openId = saved.id
    return { path: docPath(to), project: saved }
  })
}

/** Rename an id's media + cache dirs into `to` (same volume, nothing open in
 *  them). False — and nothing half-moved left behind — if either rename fails. */
async function moveIdDirs(from: string, to: string, id: string): Promise<boolean> {
  if (existsSync(mediaDir(to, id)) || existsSync(cacheDir(to, id))) return false
  await fsp.mkdir(mediaRoot(to), { recursive: true })
  await fsp.mkdir(cacheRoot(to), { recursive: true })
  try {
    if (existsSync(mediaDir(from, id))) await fsp.rename(mediaDir(from, id), mediaDir(to, id))
  } catch {
    return false
  }
  try {
    if (existsSync(cacheDir(from, id))) await fsp.rename(cacheDir(from, id), cacheDir(to, id))
  } catch {
    // Media moved, cache didn't (a proxy still being written, another volume):
    // the cache is disposable — it rebuilds in the new folder on demand.
  }
  return true
}

/** The default `.reel` path the Save As dialog suggests. */
export function suggestedSavePath(project: Project, documentsDir: string): string {
  const base = (project.name || '').trim() || 'Untitled Reel'
  return join(documentsDir, `${base}.reel`)
}
