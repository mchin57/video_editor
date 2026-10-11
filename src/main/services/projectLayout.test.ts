import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  autosavePath,
  cachePath,
  docPath,
  isMediaId,
  generatedRoot,
  projectSubdirs,
  projectFolderFor,
  sweepPlan,
  transcriptPath,
  uniqueFileName
} from './projectLayout'

const root = join('C:', 'Reels', 'bad brick')

describe('project folder layout', () => {
  it('names the document after its folder', () => {
    expect(docPath(root)).toBe(join(root, 'bad brick.reel'))
    expect(autosavePath(root)).toBe(join(root, 'autosave.json'))
  })

  it('keeps generated media, transcripts and derived files in their own folders', () => {
    expect(projectSubdirs(root)).toEqual([join(root, 'generated'), join(root, 'transcripts'), join(root, 'cache')])
    expect(generatedRoot(root)).toBe(join(root, 'generated'))
    expect(transcriptPath(root, 'ab12cd34ef56')).toBe(join(root, 'transcripts', 'ab12cd34ef56.json'))
    expect(cachePath(root, 'ab12cd34ef56', 'proxy.mp4')).toBe(join(root, 'cache', 'ab12cd34ef56', 'proxy.mp4'))
  })

  it('finds a free name for generated media', () => {
    const taken = new Set(['clip (still).png', 'clip (still) (2).png'])
    expect(uniqueFileName('new.png', (n) => taken.has(n))).toBe('new.png')
    expect(uniqueFileName('clip (still).png', (n) => taken.has(n))).toBe('clip (still) (3).png')
  })
})

describe('projectFolderFor (Save As target)', () => {
  it('creates <Name>/ next to the chosen .reel', () => {
    expect(projectFolderFor(join('C:', 'Reels', 'Race day.reel'))).toBe(join('C:', 'Reels', 'Race day'))
  })

  it('uses the folder the user is already in when it has the project name', () => {
    expect(projectFolderFor(join(root, 'bad brick.reel'))).toBe(root)
    expect(projectFolderFor(join(root, 'Bad Brick.reel'))).toBe(root) // Windows names are case-insensitive
  })

  it('does not adopt a differently named folder', () => {
    expect(projectFolderFor(join(root, 'other.reel'))).toBe(join(root, 'other'))
  })
})

describe('sweepPlan', () => {
  const a = 'aaaaaaaaaaaa'
  const b = 'bbbbbbbbbbbb'
  const c = 'cccccccccccc'

  it('deletes ids no document mentions', () => {
    const doc = JSON.stringify({ mediaIds: [a], layers: [] })
    expect(sweepPlan([a, b], [doc])).toEqual([b])
  })

  it('keeps an id mentioned anywhere — layers, nested comps, fx provenance, the autosave', () => {
    const saved = JSON.stringify({ mediaIds: [], layers: [{ content: { mediaId: a } }] })
    const autosave = JSON.stringify({ audioClips: [{ fx: { sourceMediaId: b } }] })
    expect(sweepPlan([a, b, c], [saved, autosave])).toEqual([c])
  })

  it('never touches names that are not media ids', () => {
    expect(sweepPlan(['tmp', 'desktop.ini', 'ABCDEF123456'], ['{}'])).toEqual([])
    expect(isMediaId('ab12cd34ef56')).toBe(true)
    expect(isMediaId('ab12cd34ef5')).toBe(false)
  })

  it('needs a quoted match, not a substring of another id', () => {
    expect(sweepPlan([a], [JSON.stringify({ note: `${a}x` })])).toEqual([a])
  })
})
