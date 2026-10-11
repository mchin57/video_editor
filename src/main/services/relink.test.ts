import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The data dir must point at a scratch dir BEFORE config resolves it.
const scratch = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'reel-relink-'))
  process.env.VIDEO_EDITOR_DATA = join(dir, 'data')
  return dir
})
vi.mock('electron', () => ({ app: { getPath: () => scratch } }))
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

import { createProject, saveProjectFile } from './projectStore'
import { createEmptyProject } from '@shared/project'
import { importFile, relinkCheck, relinkMedia } from './mediaStore'
import { getEntry } from './library'

const reels = join(scratch, 'Reels')
let root: string

beforeAll(async () => {
  mkdirSync(reels, { recursive: true })
  await createProject('Relink', reels)
  root = join(reels, 'Relink')
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

describe('Relink (docs/MEDIA-POINTERS.md)', () => {
  it('the same footage found elsewhere relinks, and the other missing clips in that folder come with it', async () => {
    const a = await importFile(file(join(root, 'footage'), 'a.wav', 'clip A 3s'))
    const b = await importFile(file(join(root, 'footage'), 'b.wav', 'clip B 4s'))
    renameSync(join(root, 'footage'), join(root, 'moved'))
    expect((await relinkCheck(a.id, join(root, 'moved', 'a.wav'))).matches).toBe(true)

    const res = await relinkMedia(a.id, join(root, 'moved', 'a.wav'))
    expect(res.cutsReset).toBe(false)
    expect(res.asset).toMatchObject({ status: 'ok', originalPath: join(root, 'moved', 'a.wav'), relativePath: 'moved/a.wav' })
    expect(res.alsoFound).toEqual(['b.wav']) // relink one, fix the rest
    expect(getEntry(b.id)!.path).toBe(join(root, 'moved', 'b.wav'))
  })

  it('a file that does not match lists the differing fields and needs force', async () => {
    const c = await importFile(file(join(root, 'c'), 'c.wav', 'clip C 5s'))
    const other = file(join(root, 'elsewhere'), 'c-redownload.wav', 'clip C, re-encoded 5s')
    const check = await relinkCheck(c.id, other)
    expect(check).toMatchObject({ matches: false, unknown: false })
    expect(check.differs).toContain('size')
    await expect(relinkMedia(c.id, other)).rejects.toThrow("isn't the same footage")

    // "Update path anyway", same length: the clip takes the new file, cuts kept.
    const kept = await relinkMedia(c.id, other, true)
    expect(kept.cutsReset).toBe(false)
    expect(getEntry(c.id)!.record.fingerprint.size).toBe(Buffer.byteLength('clip C, re-encoded 5s'))
    expect((await relinkCheck(c.id, other)).matches).toBe(true) // its fingerprint follows the file
  })

  it('accepting a file of a different length reports the cut reset; the old transcript is hidden, deleted only on Save', async () => {
    const d = await importFile(file(join(root, 'd'), 'd.wav', 'clip D 6s'))
    const transcript = join(root, 'transcripts', `${d.id}.json`)
    writeFileSync(transcript, '{}')
    mkdirSync(join(root, 'cache', d.id), { recursive: true })
    writeFileSync(join(root, 'cache', d.id, 'audio.m4a'), 'old proxy')
    const longer = file(join(root, 'd'), 'd-full.wav', 'clip D extended 9s')
    const res = await relinkMedia(d.id, longer, true)
    expect(res.cutsReset).toBe(true)
    expect(res.asset.probe.durationSec).toBe(9)
    expect(existsSync(join(root, 'cache', d.id, 'audio.m4a'))).toBe(false) // disposable: rebuilt from the new file
    // Not saved yet: the transcript is hidden but still on disk (reopening
    // without saving brings back the old record it belongs to).
    expect(res.asset.transcribed).toBe(false)
    expect(getEntry(d.id)!.staleTranscript).toBe(true)
    expect(existsSync(transcript)).toBe(true)
    await saveProjectFile({ ...createEmptyProject('p', 'Relink'), mediaIds: [d.id] })
    expect(existsSync(transcript)).toBe(false)
    expect(getEntry(d.id)!.staleTranscript).toBe(false)
  })

  it('re-importing the ORIGINAL after a forced relink gets its own id; the relinked clip keeps its file', async () => {
    const original = file(join(root, 'e'), 'e.wav', 'clip E 2s')
    const e = await importFile(original)
    const replacement = file(join(root, 'e'), 'e-other.wav', 'clip E replacement 2s')
    await relinkMedia(e.id, replacement, true) // the clip keeps id e.id, now holding other content
    const again = await importFile(original)
    expect(again.id).not.toBe(e.id)
    expect(getEntry(e.id)!.path).toBe(replacement)
    expect(getEntry(again.id)!.path).toBe(original)
  })
})
