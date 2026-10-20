import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The data dir must point at a scratch dir BEFORE config resolves it.
const scratch = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'reel-folders-'))
  process.env.VIDEO_EDITOR_DATA = join(dir, 'data')
  return dir
})
vi.mock('electron', () => ({ app: { getPath: () => scratch } }))

import {
  createProject,
  initProjectRoot,
  loadProject,
  openProject,
  saveProject,
  saveProjectAs,
  saveProjectFile
} from './projectStore'
import { currentSession } from './projectSession'
import type { Library } from './library'
import { fingerprintFile, fingerprintId } from './fingerprint'
import { toRelativePath } from './mediaRef'
import { PROJECT_VERSION, type Project } from '@shared/project'
import type { MediaRecord } from '@shared/media'

const reels = join(scratch, 'Reels')
const currentProjectRoot = (): string | null => currentSession()?.root ?? null
const getEntry = (id: string) => currentSession()!.library.getEntry(id)
const resolveEntry = (id: string) => currentSession()!.library.resolveEntry(id)
const putEntry = (...args: Parameters<Library['putEntry']>) => currentSession()!.library.putEntry(...args)
const reelOf = (root: string): Record<string, unknown> & { library: MediaRecord[] } =>
  JSON.parse(readFileSync(join(root, `${root.split(/[\\/]/).pop()}.reel`), 'utf8'))

/** Add a library item pointing at `path`, the way an import does (minus the probe). */
async function pointAt(root: string, path: string): Promise<MediaRecord> {
  const fingerprint = await fingerprintFile(path)
  const record: MediaRecord = {
    id: fingerprintId(fingerprint),
    fileName: path.split(/[\\/]/).pop()!,
    relativePath: toRelativePath(root, path),
    absolutePath: path,
    fingerprint,
    importedAt: new Date().toISOString(),
    probe: { durationSec: 1, container: 'mov', video: null, audio: null },
    kind: 'video'
  }
  putEntry(record, path, root)
  return record
}

let project: Project
let root: string
let clip: MediaRecord

beforeAll(() => {
  mkdirSync(reels, { recursive: true })
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('project folders (pointer model)', () => {
  it('launches to no project when there is nothing to reopen', async () => {
    initProjectRoot()
    expect(await loadProject()).toEqual({ loaded: null, message: null })
    expect(currentProjectRoot()).toBeNull()
  })

  it('New creates the whole folder, and refuses a bad name or an existing folder', async () => {
    const res = await createProject('  Race day ', reels)
    root = join(reels, 'Race day')
    project = res.project
    expect(res.path).toBe(join(root, 'Race day.reel'))
    expect(res.dirty).toBe(false)
    for (const dir of ['generated', 'transcripts', 'cache']) expect(existsSync(join(root, dir))).toBe(true)
    expect(reelOf(root)).toMatchObject({ version: PROJECT_VERSION, name: 'Race day', library: [] })
    expect(currentProjectRoot()).toBe(root)

    await expect(createProject('Race day', reels)).rejects.toThrow('already exists')
    await expect(createProject('a:b', reels)).rejects.toThrow()
    expect(currentProjectRoot()).toBe(root) // a refused New leaves the open project alone
  })

  it('the library reaches the .reel only on Save; the autosave carries it meanwhile', async () => {
    mkdirSync(join(root, 'footage'))
    const file = join(root, 'footage', 'IMG_0001.MOV')
    writeFileSync(file, 'raw footage')
    clip = await pointAt(root, file)
    project = { ...project, mediaIds: [clip.id] }

    await saveProject(project) // the renderer's autosave
    expect(reelOf(root).library).toEqual([])
    const autosave = JSON.parse(readFileSync(join(root, 'autosave.json'), 'utf8'))
    expect(autosave.library.map((r: MediaRecord) => r.id)).toEqual([clip.id])

    await saveProjectFile(project)
    expect(reelOf(root).library).toEqual([{ ...clip, relativePath: 'footage/IMG_0001.MOV' }])
    expect(existsSync(join(root, 'autosave.json'))).toBe(false)
  })

  it('a record the document no longer mentions is not saved', async () => {
    const extra = join(root, 'footage', 'unused.mov')
    writeFileSync(extra, 'never placed')
    await pointAt(root, extra)
    await saveProjectFile(project)
    expect(reelOf(root).library.map((r) => r.id)).toEqual([clip.id])
  })

  it('moved WITH its footage: the relative path finds it; the absolute path is fixed in memory only', async () => {
    const moved = join(scratch, 'Elsewhere', 'Race day')
    mkdirSync(join(scratch, 'Elsewhere'))
    renameSync(root, moved)
    const res = await openProject(join(moved, 'Race day.reel'))
    expect(res.dirty).toBe(true) // a path changed: unsaved
    expect(getEntry(clip.id)!.path).toBe(join(moved, 'footage', 'IMG_0001.MOV'))
    expect(getEntry(clip.id)!.record.absolutePath).toBe(join(moved, 'footage', 'IMG_0001.MOV'))
    expect(reelOf(moved).library[0].absolutePath).toBe(clip.absolutePath) // the .reel waits for Save
    await saveProjectFile(res.project)
    expect(reelOf(moved).library[0].absolutePath).toBe(join(moved, 'footage', 'IMG_0001.MOV'))
    root = moved
  })

  it('moved WITHOUT its footage: the absolute path finds it and the relative path is re-measured', async () => {
    const footage = join(root, 'footage', 'IMG_0001.MOV')
    const projectOnly = join(reels, 'Race day')
    mkdirSync(projectOnly)
    renameSync(join(root, 'Race day.reel'), join(projectOnly, 'Race day.reel'))
    const res = await openProject(join(projectOnly, 'Race day.reel'))
    expect(res.dirty).toBe(true)
    expect(getEntry(clip.id)!.path).toBe(footage)
    expect(getEntry(clip.id)!.record.relativePath).toBe(toRelativePath(projectOnly, footage))
    root = projectOnly
  })

  it('neither path holds the footage: missing (and a different file at the path is not it)', async () => {
    const footage = getEntry(clip.id)!.path!
    writeFileSync(footage, 'something else entirely')
    expect((await resolveEntry(clip.id))!.entry.path).toBeNull()
  })

  it('cleanup removes unused cache/generated/transcripts only: a user file in the project folder survives', async () => {
    await saveProjectFile(project)
    writeFileSync(join(root, 'my notes.txt'), 'mine')
    mkdirSync(join(root, 'b-roll'))
    writeFileSync(join(root, 'b-roll', 'unused take.mov'), 'mine too')
    mkdirSync(join(root, 'cache', 'abcdefabcdef'), { recursive: true })
    mkdirSync(join(root, 'cache', clip.id), { recursive: true })
    writeFileSync(join(root, 'generated', 'orphan (audio).wav'), 'x')
    writeFileSync(join(root, 'transcripts', 'abcdefabcdef.json'), '{}')
    writeFileSync(join(root, 'transcripts', `${clip.id}.json`), '{}')
    await openProject(join(root, 'Race day.reel'))
    expect(existsSync(join(root, 'my notes.txt'))).toBe(true)
    expect(existsSync(join(root, 'b-roll', 'unused take.mov'))).toBe(true)
    expect(existsSync(join(root, 'cache', 'abcdefabcdef'))).toBe(false)
    expect(existsSync(join(root, 'cache', clip.id))).toBe(true)
    expect(existsSync(join(root, 'generated', 'orphan (audio).wav'))).toBe(false)
    expect(existsSync(join(root, 'transcripts', 'abcdefabcdef.json'))).toBe(false)
    expect(existsSync(join(root, 'transcripts', `${clip.id}.json`))).toBe(true)
  })

  it('Save As copies generated/ + transcripts/, re-measures relative paths, and leaves the old folder at its last save', async () => {
    writeFileSync(join(root, 'generated', 'x (still).png'), 'png')
    writeFileSync(join(root, 'transcripts', `${clip.id}.json`), '{}')
    await saveProject(project) // unsaved edits in the old folder…
    const res = await saveProjectAs(project, join(scratch, 'Copies', 'Race day v2.reel'))
    const to = join(scratch, 'Copies', 'Race day v2')
    expect(res.path).toBe(join(to, 'Race day v2.reel'))
    expect(existsSync(join(to, 'generated', 'x (still).png'))).toBe(true)
    expect(existsSync(join(to, 'transcripts', `${clip.id}.json`))).toBe(true)
    expect(existsSync(join(root, 'autosave.json'))).toBe(false) // …now belong to the new folder
    const saved = reelOf(to).library[0]
    expect(saved.absolutePath).toBe(
      clip.absolutePath.replace(join(reels, 'Race day'), join(scratch, 'Elsewhere', 'Race day'))
    )
    expect(saved.relativePath).toBe(toRelativePath(to, saved.absolutePath))
    expect(currentProjectRoot()).toBe(to)
    initProjectRoot()
    expect(currentProjectRoot()).toBe(to) // remembered for the next launch
    root = to
  })

  it('a folder renamed in Explorer still opens, its .reel renamed to match', async () => {
    const moved = join(scratch, 'Copies', 'Final cut')
    renameSync(root, moved)
    const res = await openProject(join(moved, 'Race day v2.reel'))
    expect(res.path).toBe(join(moved, 'Final cut.reel'))
    expect(res.project.name).toBe('Final cut')
    root = moved
  })

  it('old formats are refused before the open project loses anything', async () => {
    await saveProject(project)
    const legacy = join(scratch, 'old.reel')
    writeFileSync(legacy, JSON.stringify({ id: 'o', version: 23, layers: [] }))
    await expect(openProject(legacy)).rejects.toThrow('old shared media library')
    const hardlink = join(scratch, 'v24.reel')
    writeFileSync(hardlink, JSON.stringify({ id: 'h', version: 24, layers: [] }))
    await expect(openProject(hardlink)).rejects.toThrow('Restore it from your backup')
    expect(existsSync(join(root, 'autosave.json'))).toBe(true) // unsaved work kept
    expect(currentProjectRoot()).toBe(root)
  })

  it('a late autosave from a document that is no longer open is dropped', async () => {
    await saveProjectFile(project)
    await saveProject({ ...project, id: 'someone-else' })
    expect(existsSync(join(root, 'autosave.json'))).toBe(false)
  })

  // --- Review findings (2026-10-11) -----------------------------------------

  it('Save As never writes over another project', async () => {
    const other = (await createProject('Other', reels)).project
    await saveProjectFile(other)
    const before = readFileSync(join(reels, 'Other', 'Other.reel'), 'utf8')
    const mine = (await createProject('Mine', reels)).project
    await expect(saveProjectAs(mine, join(reels, 'Other.reel'))).rejects.toThrow('already exists')
    expect(readFileSync(join(reels, 'Other', 'Other.reel'), 'utf8')).toBe(before)
    expect(currentProjectRoot()).toBe(join(reels, 'Mine')) // nothing switched
  })

  it('a second .reel in a project folder is refused (it would load and save the folder’s own)', async () => {
    writeFileSync(join(reels, 'Other', 'Other - copy.reel'), readFileSync(join(reels, 'Other', 'Other.reel')))
    await expect(openProject(join(reels, 'Other', 'Other - copy.reel'))).rejects.toThrow('open that file instead')
    expect(currentProjectRoot()).toBe(join(reels, 'Mine'))
  })

  it('a leftover autosave from another format is ignored, not loaded', async () => {
    writeFileSync(join(reels, 'Other', 'autosave.json'), JSON.stringify({ id: 'stale', version: 24, layers: [] }))
    const res = await openProject(join(reels, 'Other', 'Other.reel'))
    expect(res.project.id).not.toBe('stale')
    expect(res.dirty).toBe(false)
  })

  it('cleanup never touches a generated/ the app did not create', async () => {
    const footage = join(reels, 'Footage folder')
    mkdirSync(join(footage, 'generated'), { recursive: true })
    writeFileSync(join(footage, 'generated', 'my AI clip.mp4'), 'the user’s own')
    writeFileSync(join(footage, 'Footage folder.reel'), readFileSync(join(reels, 'Other', 'Other.reel')))
    await openProject(join(footage, 'Footage folder.reel'))
    expect(existsSync(join(footage, 'generated', 'my AI clip.mp4'))).toBe(true)
    // …while one the app made is cleaned (marker present).
    expect(existsSync(join(reels, 'Other', 'generated', '.reel-editor'))).toBe(true)
  })

  it('a library write for a project that is no longer open is refused', async () => {
    const record = getEntry(clip.id)?.record ?? clip
    expect(() => putEntry(record, null, join(reels, 'Mine'))).toThrow('The project changed')
  })

  it('a missing last project launches to the start screen with a note', async () => {
    rmSync(currentProjectRoot()!, { recursive: true, force: true })
    initProjectRoot()
    const launch = await loadProject()
    expect(launch.loaded).toBeNull()
    expect(launch.message).toContain("couldn't be found")
  })
})
