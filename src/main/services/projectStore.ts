/**
 * Project persistence — a project is a FOLDER (docs/MEDIA-POINTERS.md; layout
 * in `projectLayout.ts`):
 *
 *  - `<Name>.reel` is the save file: the document plus its library (the media
 *    records — paths + fingerprints). Created by New, then written ONLY by
 *    File ▸ Save / Save As.
 *  - `autosave.json` is the working copy the renderer writes continuously, so a
 *    crash or quit can't lose work; it EXISTS exactly while there are unsaved
 *    changes (Save deletes it), which is how "dirty" survives a relaunch. It
 *    carries the in-memory library too.
 *  - There is no untitled project: New asks for a name and a location and
 *    creates the folder. With nothing to reopen, the app shows a start screen.
 *
 * Which folder is open is main's state (`projectRoot`), remembered across
 * launches in `<data>/projects/session.json`. All document writes go through
 * one queue, so a late autosave can never land after (and resurrect over) a
 * Save, and an autosave from a document that is no longer open is dropped.
 */

import { existsSync, promises as fsp, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { LaunchState, LoadedProject } from '@shared/ipc'
import type { MediaRecord } from '@shared/media'
import type { Project } from '@shared/project'
import { createEmptyProject, migrateProject, PROJECT_VERSION } from '@shared/project'
import { validateProjectName } from '@shared/projectName'
import { getSubdir } from '../config'
import { replaceFile } from './atomicWrite'
import { copyAtomic } from './linkOrCopy'
import { closeLibrary, openLibrary, rebaseLibrary, recordsFor, resolveAll } from './library'
import { fromRelativePath } from './mediaRef'
import { currentProjectRoot, getProjectRoot, setProjectRoot } from './projectRoot'
import {
  autosavePath,
  cacheDir,
  cacheRoot,
  cleanupPlan,
  docPath,
  generatedRoot,
  projectFolderFor,
  projectSubdirs,
  sweepPlan,
  transcriptsRoot
} from './projectLayout'

export { REEL_EXT } from './projectLayout'
export type { LoadedProject } from '@shared/ipc'

/** The `.reel` on disk: the document plus the library records saved with it. */
type SavedDoc = Project & { library?: MediaRecord[] }

const sessionPath = (): string => join(getSubdir('projects'), 'session.json')

/** Id of the document open in the renderer — autosaves for any other are stale. */
let openId: string | null = null
/** Why the last project couldn't be reopened at launch (for the start screen). */
let launchMessage: string | null = null

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

/** The document as written to disk: bumped version, its library attached. */
function withLibrary(project: Project): SavedDoc {
  const doc = { ...project, version: PROJECT_VERSION, updatedAt: new Date().toISOString() }
  return { ...doc, library: recordsFor(JSON.stringify(doc)) }
}

// --- Formats -------------------------------------------------------------------

/**
 * Which model a document on disk belongs to: `legacy` (schema < 24, media in
 * the old shared library — converted, docs/MEDIA-POINTERS.md "Migration"),
 * `hardlink` (schema 24, a short-lived test format — restored from backup
 * instead), or `current`.
 */
export function documentFormat(raw: unknown): 'legacy' | 'hardlink' | 'current' {
  const v = (raw as { version?: unknown } | null)?.version
  if (typeof v !== 'number' || v < 24) return 'legacy'
  return v === 24 ? 'hardlink' : 'current'
}

/** Refuse a document this build can't open, before anything is discarded. */
function assertOpenable(raw: unknown): void {
  const format = documentFormat(raw)
  if (format === 'legacy') {
    // File ▸ Open converts an old file before calling openProject (ipc.ts).
    throw new Error('This project uses the old shared media library and has to be converted first.')
  }
  if (format === 'hardlink') {
    throw new Error(
      'This project was saved by a short-lived test build (project format 24) that this version ' +
        "doesn't open. Restore it from your backup, then convert it as an old project."
    )
  }
}

// --- Session -------------------------------------------------------------------

function rememberRoot(root: string): void {
  setProjectRoot(root)
  try {
    writeFileSync(sessionPath(), JSON.stringify({ root }))
  } catch (error) {
    console.error('could not record the open project', error)
  }
}

/**
 * Pick the folder to reopen at launch (before the window exists): the last
 * open project if its `.reel` is still there, else none — the renderer then
 * shows the start screen, with a note if the last project went missing.
 */
export function initProjectRoot(): void {
  launchMessage = null
  try {
    const s = JSON.parse(readFileSync(sessionPath(), 'utf8')) as { root?: unknown }
    if (typeof s.root === 'string') {
      if (existsSync(docPath(s.root))) {
        setProjectRoot(s.root)
        return
      }
      launchMessage = `Your last project couldn't be found: ${s.root}`
    }
  } catch {
    /* no session yet */
  }
  setProjectRoot(null)
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
 * Cleanup on open (docs/MEDIA-POINTERS.md "Cleanup on open"): delete what
 * neither the saved document nor the autosave still uses — media removed from
 * the library (kept until now so undo worked). `cache/<id>` dirs, `generated/`
 * files and `transcripts/<id>.json`, and NOTHING ELSE: the user's footage
 * often shares the folder. Skipped entirely if a document that exists can't be
 * read or parsed: never delete on a guess.
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
  const files = (dir: string): string[] => listDir(dir).filter((n) => statSync(join(dir, n), { throwIfNoEntry: false })?.isFile())
  const plan = cleanupPlan({ generated: files(generatedRoot(root)), transcripts: files(transcriptsRoot(root)) }, docs)
  for (const name of plan.generated) await fsp.rm(join(generatedRoot(root), name), { force: true }).catch(() => {})
  for (const name of plan.transcripts) await fsp.rm(join(transcriptsRoot(root), name), { force: true }).catch(() => {})
  for (const id of sweepPlan(listDir(cacheRoot(root)), docs)) {
    await fsp.rm(cacheDir(root, id), { recursive: true, force: true }).catch(() => {})
  }
}

// --- Load / open / create ---------------------------------------------------------

/**
 * Open the folder's working state — the autosave if there is one (unsaved
 * changes), else the saved document — into the renderer's document and main's
 * library, locating every original. A path fixed while locating makes the
 * project dirty (it changed in memory; only Save writes it).
 */
async function readFolder(root: string): Promise<LoadedProject> {
  const doc = docPath(root)
  let raw: SavedDoc
  let dirty = false
  try {
    raw = (await readJson(autosavePath(root))) as SavedDoc
    dirty = true
  } catch {
    raw = (await readJson(doc)) as SavedDoc
  }
  const { library, ...rest } = raw
  // A folder project is named by its folder (the folder is what the user sees,
  // renames and moves).
  const project = { ...migrateProject(rest), name: basename(root) }
  for (const dir of projectSubdirs(root)) await fsp.mkdir(dir, { recursive: true })
  openLibrary(root, Array.isArray(library) ? library : [])
  if (await resolveAll()) dirty = true
  openId = project.id
  return { project, path: doc, dirty }
}

/** The project to show at launch: the last one, or none (start screen). */
export function loadProject(): Promise<LaunchState> {
  return serial(async () => {
    const root = currentProjectRoot()
    if (!root) return { loaded: null, message: launchMessage }
    try {
      assertOpenable(await readJson(docPath(root)))
      await sweep(root)
      return { loaded: await readFolder(root), message: null }
    } catch (error) {
      setProjectRoot(null)
      closeLibrary()
      return { loaded: null, message: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** Throw away the open project's unsaved state — the renderer already asked. */
async function discardCurrent(): Promise<void> {
  const root = currentProjectRoot()
  if (root) await fsp.rm(autosavePath(root), { force: true })
}

/**
 * File ▸ New: create `<location>/<name>/` with its `.reel` (an empty project),
 * `generated/`, `transcripts/` and `cache/`, then open it. Refuses an invalid
 * name or a folder that already exists. The current project's unsaved state is
 * discarded (the renderer confirmed).
 */
export function createProject(name: string, location: string): Promise<LoadedProject> {
  return serial(async () => {
    const problem = validateProjectName(name)
    if (problem) throw new Error(problem)
    const clean = name.trim()
    if (!existsSync(location)) throw new Error(`That location doesn't exist: ${location}`)
    const root = join(location, clean)
    if (existsSync(root)) throw new Error(`A folder named "${clean}" already exists there.`)
    await fsp.mkdir(root)
    for (const dir of projectSubdirs(root)) await fsp.mkdir(dir, { recursive: true })
    await writeJsonAtomic(docPath(root), { ...createEmptyProject(crypto.randomUUID(), clean), version: PROJECT_VERSION, library: [] })
    await discardCurrent()
    rememberRoot(root)
    return readFolder(root)
  })
}

/**
 * File ▸ Open of a project folder's `.reel`. The current project's unsaved
 * state is discarded (the renderer confirmed), the folder becomes the open
 * root, and its cache is swept.
 */
export function openProject(reelPath: string): Promise<LoadedProject> {
  return serial(async () => {
    const root = dirname(reelPath)
    // Validate before discarding anything: a bad file must not cost the open
    // project its unsaved work.
    assertOpenable(await readJson(reelPath))
    // Keep `<Name>/<Name>.reel` true when the user renamed the folder.
    if (reelPath !== docPath(root) && !existsSync(docPath(root))) await fsp.rename(reelPath, docPath(root))
    await discardCurrent()
    rememberRoot(root)
    await sweep(root)
    return readFolder(root)
  })
}

// --- Autosave / save -----------------------------------------------------------

/** The renderer's debounced working-copy write (document + in-memory library). */
export function saveProject(project: Project): Promise<void> {
  return serial(async () => {
    const root = currentProjectRoot()
    if (!root || project.id !== openId) return // a late write from a document no longer open
    await writeJsonAtomic(autosavePath(root), withLibrary(project))
  })
}

/** Write a document and the in-memory library records it uses to `path`,
 *  returning the document as saved (bumped version + time, no library). */
export async function writeProjectFile(path: string, project: Project): Promise<Project> {
  const saved = withLibrary(project)
  await writeJsonAtomic(path, saved)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { library, ...doc } = saved
  return doc
}

/** Read and migrate a document (library stripped). Throws on bad input. */
export async function readProjectFile(path: string): Promise<Project> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { library, ...rest } = (await readJson(path)) as SavedDoc
  return migrateProject(rest)
}

/** File ▸ Save: write the document and its library into the `.reel`, and drop
 *  the autosave (there are no unsaved changes any more). */
export function saveProjectFile(project: Project): Promise<Project> {
  return serial(async () => {
    const root = getProjectRoot()
    const saved = await writeProjectFile(docPath(root), { ...project, name: basename(root) })
    await fsp.rm(autosavePath(root), { force: true })
    openId = saved.id
    return saved
  })
}

// --- Save As -------------------------------------------------------------------

/** Copy every file of `from` into `to` (flat or nested), skipping partials. */
async function copyTree(from: string, to: string): Promise<void> {
  for (const ent of await fsp.readdir(from, { withFileTypes: true }).catch(() => [])) {
    const src = join(from, ent.name)
    const dest = join(to, ent.name)
    if (ent.isDirectory()) {
      await fsp.mkdir(dest, { recursive: true })
      await copyTree(src, dest)
    } else if (!ent.name.endsWith('.tmp') && !ent.name.includes('.part') && !existsSync(dest)) {
      await copyAtomic(src, dest)
    }
  }
}

/**
 * File ▸ Save As to `chosenPath` (the `.reel` the Save dialog returned; the
 * folder is `projectFolderFor` it). The new folder gets the structure, copies
 * of `generated/` and `transcripts/`, and the document with every relative
 * path measured from its new place (absolute paths don't change). `cache/`
 * isn't copied — it rebuilds. The old folder keeps its last save.
 */
export function saveProjectAs(project: Project, chosenPath: string): Promise<{ path: string; project: Project }> {
  return serial(async () => {
    const from = getProjectRoot()
    const to = projectFolderFor(chosenPath)
    if (to !== from) {
      for (const dir of [to, ...projectSubdirs(to)]) await fsp.mkdir(dir, { recursive: true })
      await copyTree(generatedRoot(from), generatedRoot(to))
      await copyTree(transcriptsRoot(from), transcriptsRoot(to))
      rebaseLibrary(to, fromRelativePath)
      await fsp.rm(autosavePath(from), { force: true })
      rememberRoot(to)
    }
    const saved = await writeProjectFile(docPath(to), { ...project, name: basename(to) })
    await fsp.rm(autosavePath(to), { force: true })
    openId = saved.id
    return { path: docPath(to), project: saved }
  })
}

/** The default `.reel` path the Save As dialog suggests. */
export function suggestedSavePath(project: Project, documentsDir: string): string {
  const base = (project.name || '').trim() || 'Reel'
  return join(documentsDir, `${base}.reel`)
}
