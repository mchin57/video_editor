import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  initProjectRoot,
  loadProject,
  newProject,
  openProject,
  saveProject,
  saveProjectAs,
  saveProjectFile
} from './projectStore'
import { getProjectRoot } from './projectRoot'
import { createEmptyProject, PROJECT_VERSION } from '@shared/project'

const ID_A = 'aaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbb'

/** Fake an imported asset in a folder: a source file hardlinked as its original. */
function fakeAsset(root: string, id: string, source: string): void {
  mkdirSync(join(root, 'media', id), { recursive: true })
  mkdirSync(join(root, 'cache', id), { recursive: true })
  writeFileSync(join(root, 'media', id, 'original.mov'), readFileSync(source)) // stands in for the link
  const s = statSync(join(root, 'media', id, 'original.mov'))
  writeFileSync(
    join(root, 'media', id, 'asset.json'),
    JSON.stringify({ id, file: 'original.mov', storage: 'copy', sourcePath: source, size: s.size, mtimeMs: s.mtimeMs })
  )
  writeFileSync(join(root, 'cache', id, 'proxy.mp4'), 'proxy')
}

let source: string
beforeAll(() => {
  source = join(scratch, 'IMG_0001.MOV')
  writeFileSync(source, 'raw footage')
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('project folder lifecycle', () => {
  it('starts in an empty scratch project, not yet saved', async () => {
    initProjectRoot()
    const res = await loadProject()
    expect(getProjectRoot()).toBe(join(scratch, 'data', 'projects', 'scratch'))
    expect(res.path).toBeNull()
    expect(res.dirty).toBe(false)
    expect(res.project.version).toBe(PROJECT_VERSION)
  })

  it('autosave marks the project dirty across a relaunch; late writes for another document are dropped', async () => {
    const p = { ...createEmptyProject('p1', 'Untitled Reel'), mediaIds: [ID_A] }
    await newProject(p)
    await saveProject(p)
    expect(existsSync(join(getProjectRoot(), 'autosave.json'))).toBe(true)
    const res = await loadProject()
    expect(res.dirty).toBe(true)
    expect(res.project.mediaIds).toEqual([ID_A])

    await saveProject({ ...createEmptyProject('someone-else', 'X'), mediaIds: ['zzz'] })
    expect((await loadProject()).project.id).toBe('p1')
  })

  it('first Save As moves the scratch folder’s media into <Name>/ and clears the scratch', async () => {
    const scratchRoot = getProjectRoot()
    fakeAsset(scratchRoot, ID_A, source)
    fakeAsset(scratchRoot, ID_B, source) // imported, then removed from the library
    const p = { ...createEmptyProject('p1', 'Untitled Reel'), mediaIds: [ID_A] }
    await saveProject(p)

    const chosen = join(scratch, 'Reels', 'Race day.reel')
    const res = await saveProjectAs(p, chosen)
    const root = join(scratch, 'Reels', 'Race day')
    expect(res.path).toBe(join(root, 'Race day.reel'))
    expect(res.project.name).toBe('Race day')
    expect(getProjectRoot()).toBe(root)
    expect(existsSync(join(root, 'media', ID_A, 'original.mov'))).toBe(true)
    expect(existsSync(join(root, 'cache', ID_A, 'proxy.mp4'))).toBe(true)
    expect(existsSync(join(root, 'media', ID_B))).toBe(false) // unreferenced: not carried
    expect(existsSync(join(root, 'autosave.json'))).toBe(false) // saved = clean
    expect(existsSync(scratchRoot)).toBe(false)

    const reopened = await loadProject()
    expect(reopened.dirty).toBe(false)
    expect(reopened.path).toBe(res.path)
  })

  it('Save writes the .reel and drops the autosave', async () => {
    const root = getProjectRoot()
    const p = { ...createEmptyProject('p1', 'Race day'), mediaIds: [ID_A], preset: 'square' as const }
    await saveProject(p)
    expect(existsSync(join(root, 'autosave.json'))).toBe(true)
    await saveProjectFile(p)
    expect(existsSync(join(root, 'autosave.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'Race day.reel'), 'utf8')).preset).toBe('square')
  })

  it('Save As from a saved folder links media into the copy and leaves the original folder at its last save', async () => {
    const from = getProjectRoot()
    const p = { ...createEmptyProject('p1', 'Race day'), mediaIds: [ID_A] }
    await saveProject(p) // unsaved edits in the old folder…
    await saveProjectAs(p, join(scratch, 'Reels', 'Race day v2.reel'))
    const to = join(scratch, 'Reels', 'Race day v2')
    const orig = join(from, 'media', ID_A, 'original.mov')
    const copy = join(to, 'media', ID_A, 'original.mov')
    expect(statSync(copy).ino).toBe(statSync(orig).ino) // same bytes, no extra disk
    expect(existsSync(join(from, 'autosave.json'))).toBe(false) // …now belong to the new folder
    expect(JSON.parse(readFileSync(join(to, 'media', ID_A, 'asset.json'), 'utf8')).storage).toBe('link')
  })

  it('opening a folder sweeps media nothing references, and remembers it for the next launch', async () => {
    const root = join(scratch, 'Reels', 'Race day')
    fakeAsset(root, ID_B, source)
    const res = await openProject(join(root, 'Race day.reel'))
    expect(res.project.name).toBe('Race day')
    expect(existsSync(join(root, 'media', ID_B))).toBe(false)
    expect(existsSync(join(root, 'cache', ID_B))).toBe(false)
    expect(existsSync(join(root, 'media', ID_A))).toBe(true)

    initProjectRoot()
    expect(getProjectRoot()).toBe(root)
  })

  it('a folder renamed in Explorer still opens, its .reel renamed to match', async () => {
    const { renameSync } = await import('node:fs')
    const old = join(scratch, 'Reels', 'Race day v2')
    const moved = join(scratch, 'Reels', 'Final cut')
    renameSync(old, moved)
    const res = await openProject(join(moved, 'Race day v2.reel'))
    expect(res.path).toBe(join(moved, 'Final cut.reel'))
    expect(res.project.name).toBe('Final cut')
  })

  it('New discards the open project’s unsaved changes', async () => {
    const root = getProjectRoot()
    const p = { ...createEmptyProject('p1', 'Final cut'), mediaIds: [ID_A] }
    await saveProject(p)
    await newProject(createEmptyProject('p2', 'Untitled Reel'))
    expect(existsSync(join(root, 'autosave.json'))).toBe(false)
    expect(existsSync(join(root, 'Final cut.reel'))).toBe(true)
  })
})
