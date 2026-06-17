import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// projectStore imports ../config which imports electron; stub it so the module
// loads under vitest. (readProjectFile/writeProjectFile take absolute paths and
// never touch the data dir, so getPath is only a safety net.)
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { readProjectFile, writeProjectFile } from './projectStore'
import { createEmptyProject } from '@shared/project'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'reel-proj-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('portable .reel files', () => {
  it('round-trips a project through write + read', async () => {
    const p = createEmptyProject('abc', 'My Reel')
    p.clips.push({ id: 'c1', mediaId: 'm1', inSec: 0, outSec: 3, crop: null, mute: false, gainDb: 0 })
    const path = join(dir, 'my-reel.reel')

    const saved = await writeProjectFile(path, p)
    expect(Number.isNaN(Date.parse(saved.updatedAt))).toBe(false) // updatedAt bumped to a real time

    const loaded = await readProjectFile(path)
    expect(loaded.id).toBe('abc')
    expect(loaded.name).toBe('My Reel')
    expect(loaded.clips).toHaveLength(1)
    expect(loaded.clips[0].mediaId).toBe('m1')
  })

  it('writes atomically — no leftover .tmp file', async () => {
    const path = join(dir, 'atomic.reel')
    await writeProjectFile(path, createEmptyProject('x', 'X'))
    await expect(fsp.access(`${path}.tmp`)).rejects.toThrow()
  })

  it('migrates a legacy (v1) project on read', async () => {
    const legacy = {
      id: 'old',
      name: 'Legacy',
      version: 1,
      preset: 'reel',
      clips: [],
      overlays: [],
      captions: { enabled: false, stylePreset: 'reels-bold', yBaseline: 1340, segments: [] },
      script: [],
      createdAt: 'x',
      updatedAt: 'y',
      music: { mediaId: 'song', volumeDb: -10, fadeOutSec: 2, duck: true }
    }
    const path = join(dir, 'legacy.reel')
    await fsp.writeFile(path, JSON.stringify(legacy))

    const loaded = await readProjectFile(path)
    expect(loaded.audioClips).toHaveLength(1)
    expect(loaded.audioClips[0].mediaId).toBe('song')
    expect((loaded as unknown as Record<string, unknown>).music).toBeUndefined()
  })
})
