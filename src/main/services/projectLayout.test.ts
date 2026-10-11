import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  autosavePath,
  cleanupPlan,
  cachePath,
  docPath,
  isMediaId,
  generatedRoot,
  projectSubdirs,
  projectFolderFor,
  sweepPlan,
  transcriptPath,
  safeFileName,
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

  it('makes a display name a legal file name (the OS has to accept it, not just the regex)', () => {
    // Background removal names its output with a time range: ':' is illegal on Windows.
    const safe = safeFileName('clip (no bg 0:03–0:05).webm')
    expect(safe).toBe('clip (no bg 0.03–0.05).webm')
    expect(safeFileName('a<b>c"d/e\\f|g?h*i\u0001.wav')).toBe('a_b_c_d_e_f_g_h_i_.wav')
    expect(safeFileName('trailing. . ')).toBe('trailing')
    expect(safeFileName('CON.png')).toBe('_CON.png')
    expect(safeFileName(':::')).toBe('media') // nothing usable left
    const dir = mkdtempSync(join(tmpdir(), 'reel-names-'))
    try {
      writeFileSync(join(dir, safe), 'x')
      expect(readdirSync(dir)).toEqual([safe])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cleanup keeps what a saved document uses and never deletes on an unreadable one', () => {
    const reel = JSON.stringify({
      mediaIds: ['aaaaaaaaaaaa'],
      library: [
        { id: 'aaaaaaaaaaaa', generated: true, relativePath: 'generated/Clip (no bg 0.03–0.05).webm' },
        { id: 'bbbbbbbbbbbb', relativePath: 'footage/IMG_1.MOV' }
      ]
    })
    const autosave = JSON.stringify({ mediaIds: ['cccccccccccc'], library: [{ id: 'cccccccccccc', generated: true, relativePath: 'generated/x (still).png' }] })
    const present = {
      generated: ['clip (no bg 0.03–0.05).webm', 'x (still).png', 'orphan (audio).wav'],
      transcripts: ['aaaaaaaaaaaa.json', 'cccccccccccc.json', 'dddddddddddd.json', 'notes.txt']
    }
    expect(cleanupPlan(present, [reel, autosave])).toEqual({
      generated: ['orphan (audio).wav'],
      transcripts: ['dddddddddddd.json'] // never a file that isn't <id>.json
    })
    expect(cleanupPlan(present, [reel, '{ torn'])).toEqual({ generated: [], transcripts: [] })
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
