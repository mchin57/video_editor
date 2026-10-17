import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The data dir must point at a scratch dir BEFORE config resolves it.
const scratch = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'reel-rename-'))
  process.env.VIDEO_EDITOR_DATA = join(dir, 'data')
  return dir
})
vi.mock('electron', () => ({ app: { getPath: () => scratch }, BrowserWindow: { getAllWindows: () => [] } }))
// No real ffmpeg: the probe answers from the file's text, generators are no-ops.
vi.mock('./ffprobe', () => ({
  probeFile: vi.fn(async (path: string) => {
    const { readFileSync } = await import('node:fs')
    const sec = Number(/(\d+)s/.exec(readFileSync(path, 'utf8'))?.[1] ?? 1)
    return { durationSec: sec, container: 'wav', video: null, audio: { codec: 'pcm', sampleRate: 48000, channels: 1 } }
  })
}))
vi.mock('./audio', () => ({
  detectMonoFoldChannel: vi.fn(async () => null),
  extractAudio: vi.fn(),
  generateAudioProxy: vi.fn(async () => {}),
  generateWaveform: vi.fn(async () => {})
}))

// The real loudness module, except whether a pass is reading a file right now.
vi.mock('./loudness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./loudness')>()),
  loudnessPassReading: vi.fn(() => false)
}))

import { createProject, openProject } from './projectStore'
import { makeVideoLayer } from '@shared/layers'
import { createEmptyProject } from '@shared/project'
import { importFile, importGenerated, renameFailureMessage, renameMedia } from './mediaStore'
import { getEntry } from './library'
import { createJob, finishJob } from './jobs'
import { loudnessPassReading } from './loudness'

const reels = join(scratch, 'Reels')
let root: string

beforeAll(async () => {
  mkdirSync(reels, { recursive: true })
  await createProject('Rename', reels)
  root = join(reels, 'Rename')
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const file = (dir: string, name: string, text: string): string => {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}

describe('library Rename (docs/MEDIA-POINTERS.md "Rename")', () => {
  it('renames the file on disk, then the record: name, both paths; fingerprint and id stay', async () => {
    const a = await importFile(file(join(root, 'footage'), 'IMG_0001.wav', 'clip A 3s'))
    const before = getEntry(a.id)!.record
    const asset = await renameMedia(a.id, '  Swim drill ')
    const to = join(root, 'footage', 'Swim drill.wav')
    expect(readdirSync(join(root, 'footage'))).toEqual(['Swim drill.wav'])
    expect(asset).toMatchObject({
      id: a.id,
      status: 'ok',
      fileName: 'Swim drill.wav',
      originalPath: to,
      absolutePath: to,
      relativePath: 'footage/Swim drill.wav'
    })
    expect(getEntry(a.id)!.record.fingerprint).toEqual(before.fingerprint)
    expect(getEntry(a.id)!.path).toBe(to)
  })

  it('refuses a name another file in that folder already has, and changes nothing', async () => {
    const b = await importFile(file(join(root, 'taken'), 'b.wav', 'clip B 2s'))
    file(join(root, 'taken'), 'Other.wav', 'someone else')
    await expect(renameMedia(b.id, 'Other')).rejects.toThrow('already exists')
    await expect(renameMedia(b.id, 'other')).rejects.toThrow('already exists') // Windows: same name
    expect(readFileSync(join(root, 'taken', 'Other.wav'), 'utf8')).toBe('someone else') // never overwritten
    expect(existsSync(join(root, 'taken', 'b.wav'))).toBe(true)
    expect(getEntry(b.id)!.record).toMatchObject({ fileName: 'b.wav', relativePath: 'taken/b.wav' })
  })

  it('allows a case-only rename of the same file', async () => {
    const c = await importFile(file(join(root, 'case'), 'swim.wav', 'clip C 2s'))
    const asset = await renameMedia(c.id, 'Swim')
    expect(readdirSync(join(root, 'case'))).toEqual(['Swim.wav'])
    expect(asset).toMatchObject({ status: 'ok', fileName: 'Swim.wav', relativePath: 'case/Swim.wav' })
  })

  it('refuses an invalid name with the reason, before touching the disk', async () => {
    const d = await importFile(file(join(root, 'bad'), 'd.wav', 'clip D 2s'))
    await expect(renameMedia(d.id, 'a:b')).rejects.toThrow('can’t contain')
    await expect(renameMedia(d.id, 'NUL')).rejects.toThrow('reserved')
    await expect(renameMedia(d.id, '   ')).rejects.toThrow('Enter a name')
    expect(readdirSync(join(root, 'bad'))).toEqual(['d.wav'])
  })

  it('refuses while a job reads the file, and allows it once the job is done', async () => {
    const e = await importFile(file(join(root, 'busy'), 'e.wav', 'clip E 2s'))
    const job = createJob('transcribe', 'Captions · e.wav', e.id, { uses: [e.id] })
    await expect(renameMedia(e.id, 'later')).rejects.toThrow('Captions · e.wav')
    expect(readdirSync(join(root, 'busy'))).toEqual(['e.wav'])
    finishJob(job.id)
    await renameMedia(e.id, 'later')
    expect(readdirSync(join(root, 'busy'))).toEqual(['later.wav'])
  })

  it('refuses while a loudness pass is measuring the file (ffmpeg holds it open)', async () => {
    const m = await importFile(file(join(root, 'measuring'), 'm.wav', 'clip M 2s'))
    vi.mocked(loudnessPassReading).mockImplementation((_root, id) => id === m.id)
    await expect(renameMedia(m.id, 'later')).rejects.toThrow('still being measured for volume levels')
    expect(readdirSync(join(root, 'measuring'))).toEqual(['m.wav'])
    vi.mocked(loudnessPassReading).mockImplementation(() => false)
    await renameMedia(m.id, 'later')
    expect(readdirSync(join(root, 'measuring'))).toEqual(['later.wav'])
  })

  it('refuses a missing clip', async () => {
    const f = await importFile(file(join(root, 'gone'), 'f.wav', 'clip F 2s'))
    rmSync(join(root, 'gone', 'f.wav'))
    await expect(renameMedia(f.id, 'g')).rejects.toThrow('missing')
  })

  it('renames generated media the same way, keeping it generated', async () => {
    const tmp = file(join(scratch, 'tmp'), 'out.wav', 'rendered 2s')
    const g = await importGenerated(tmp, 'clip (no bg 0:03–0:05).wav')
    const asset = await renameMedia(g.id, 'swimmer cutout')
    expect(existsSync(join(root, 'generated', 'swimmer cutout.wav'))).toBe(true)
    expect(asset).toMatchObject({
      fileName: 'swimmer cutout.wav',
      relativePath: 'generated/swimmer cutout.wav',
      generated: true
    })
  })

  it('refuses an unknown clip (nothing records its file)', async () => {
    const dir = join(reels, 'Converted')
    mkdirSync(dir, { recursive: true })
    const doc = { ...createEmptyProject('cv', 'Converted'), version: 25, library: [] }
    doc.layers = [makeVideoLayer('v1', 'cccccccccccc', 0, 4)]
    writeFileSync(join(dir, 'Converted.reel'), JSON.stringify(doc))
    await openProject(join(dir, 'Converted.reel'))
    await expect(renameMedia('cccccccccccc', 'x')).rejects.toThrow('Relink it first')
  })
})

describe('renameFailureMessage', () => {
  const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })
  it('puts Windows in-use / permission errors in plain words, naming the editor as a possible holder', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const text = renameFailureMessage(err(code), 'IMG_1.MOV')
      // The editor's own thumbnail/waveform/silence passes read originals
      // without a job: the message must not blame only "another program".
      expect(text).toMatch(/in use — by another program, or the editor is still reading it/)
      expect(text).toMatch(/Try again in a moment/)
    }
    expect(renameFailureMessage(err('ENOENT'), 'IMG_1.MOV')).toMatch(/no longer where it was/)
    expect(renameFailureMessage(err('EIO'), 'IMG_1.MOV')).toMatch(/Couldn't rename “IMG_1.MOV”: EIO/)
  })
})
