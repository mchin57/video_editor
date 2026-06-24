import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// projectStore imports ../config which imports electron; stub it so the module
// loads under vitest. (readProjectFile/writeProjectFile take absolute paths and
// never touch the data dir, so getPath is only a safety net.)
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { readProjectFile, writeProjectFile } from './projectStore'
import { createEmptyProject, migrateProject } from '@shared/project'
import { makeVideoLayer } from '@shared/layers'

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
    p.mediaIds.push('m1')
    p.layers.push(makeVideoLayer('c1', 'm1', 0, 3))
    const path = join(dir, 'my-reel.reel')

    const saved = await writeProjectFile(path, p)
    expect(Number.isNaN(Date.parse(saved.updatedAt))).toBe(false) // updatedAt bumped to a real time

    const loaded = await readProjectFile(path)
    expect(loaded.id).toBe('abc')
    expect(loaded.name).toBe('My Reel')
    expect(loaded.layers).toHaveLength(1)
    expect(loaded.layers[0].content.kind).toBe('video')
    expect((loaded.layers[0].content as { mediaId: string }).mediaId).toBe('m1')
    expect(loaded.mediaIds).toEqual(['m1']) // project-scoped library survives the round-trip
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
    // No mediaIds on a pre-scoping file → derive from the media it references.
    expect(loaded.mediaIds).toEqual(['song'])
  })
})

describe('project-scoped media migration', () => {
  it('seeds mediaIds from referenced clips, images, and audio when absent', () => {
    const migrated = migrateProject({
      id: 'p',
      name: 'P',
      version: 2,
      preset: 'reel',
      clips: [
        { id: 'c1', mediaId: 'vid', inSec: 0, outSec: 3, crop: null, mute: false, gainDb: 0 },
        { id: 'c2', mediaId: 'vid', inSec: 3, outSec: 6, crop: null, mute: false, gainDb: 0 } // dupe id
      ],
      overlays: [],
      imageOverlays: [{ id: 'o1', mediaId: 'logo', startSec: 0, endSec: 3, x: 0, y: 0, w: 1, h: 1, anchor: 'center', opacity: 1 }],
      audioClips: [
        { id: 'a1', mediaId: 'song', startSec: 0, inSec: 0, outSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, duck: false, kind: 'music' }
      ],
      captions: { enabled: false, stylePreset: 'reels-bold', yBaseline: 1340, segments: [] },
      script: [],
      createdAt: 'x',
      updatedAt: 'y'
    })
    // Deduped across all three media-bearing collections.
    expect(migrated.mediaIds).toEqual(['vid', 'logo', 'song'])
  })

  it('leaves an existing mediaIds list untouched', () => {
    const migrated = migrateProject({ ...createEmptyProject('p', 'P'), mediaIds: ['kept'] })
    expect(migrated.mediaIds).toEqual(['kept'])
  })
})
