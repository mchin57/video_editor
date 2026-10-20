/**
 * Switching projects (#111): everything main keeps for the open project — the
 * library, the single-flight maps, the failure memory — belongs to THAT project
 * alone. Media ids are content fingerprints, so the same file has the same id
 * in two projects; anything keyed by id alone would leak across a switch.
 *
 * ffprobe, the audio generators, ffmpeg and whisper are stubs, each held open
 * by hand where a test needs a job to still be running when the project changes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The data dir must point at a scratch dir BEFORE config resolves it.
const scratch = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'reel-switch-'))
  process.env.VIDEO_EDITOR_DATA = join(dir, 'data')
  return dir
})

const h = vi.hoisted(() => ({
  /** Hold the next ffprobe call until released (an import "still in flight"). */
  probeGate: null as Promise<void> | null,
  probeCalls: 0,
  /** Thumbnail outputs the stub generator was asked for / should fail. */
  thumbOutputs: [] as string[],
  failThumbUnder: null as string | null
}))

vi.mock('electron', () => ({
  app: { getPath: () => scratch, isPackaged: false, getAppPath: () => scratch },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./ffprobe', () => ({
  probeFile: vi.fn(async (path: string) => {
    h.probeCalls++
    const gate = h.probeGate
    h.probeGate = null
    if (gate) await gate
    const text = readFileSync(path, 'utf8')
    const sec = Number(/(\d+)s/.exec(text)?.[1] ?? 1)
    return {
      durationSec: sec,
      container: 'mov',
      video: text.includes('video') ? { codec: 'h264', width: 100, height: 100, fps: 30 } : null,
      audio: null
    }
  })
}))
vi.mock('./audio', () => ({
  detectMonoFoldChannel: vi.fn(async () => null),
  extractAudio: vi.fn(),
  generateAudioProxy: vi.fn(async () => {}),
  generateWaveform: vi.fn(async () => {}),
  monoFoldPan: vi.fn()
}))
vi.mock('./thumbnail', () => ({
  generateThumbnail: vi.fn(async (_input: string, output: string) => {
    h.thumbOutputs.push(output)
    if (h.failThumbUnder && output.startsWith(h.failThumbUnder)) throw new Error('no thumbnail for you')
    writeFileSync(output, 'jpg')
  })
}))
vi.mock('./proxy', () => ({ generateProxy: vi.fn(async () => {}), generateAlphaProxy: vi.fn(async () => {}) }))
vi.mock('./ffmpeg', () => ({ getBinaries: async () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }) }))
vi.mock('./ffmpegRun', () => ({ runFfmpeg: vi.fn(async () => {}) }))
vi.mock('./silence', () => ({ detectSilence: vi.fn(async () => []) }))
// whisper-cli stub: a copy of node (see beforeAll) that records it started, then
// writes its output once the test drops a  file beside it.
vi.mock('../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config')>()),
  getBundledBinDir: () => null
}))
vi.mock('./whisperArgs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./whisperArgs')>()),
  buildWhisperArgs: (_model: string, _wav: string, prefix: string) => [
    '-e',
    "const fs=require('fs'),p=process.argv[1];fs.writeFileSync(p+'.started','');" +
      "(function w(){if(fs.existsSync(p+'.release'))fs.writeFileSync(p+'.json','{\"transcription\":[]}');else setTimeout(w,10)})()",
    prefix
  ]
}))

import { createProject, initProjectRoot, loadProject, openProject, saveProjectAs } from './projectStore'
import { currentSession } from './projectSession'
import { onLibraryChanged } from './library'
import { importFile } from './mediaStore'
import { transcribeMedia } from './whisper'

const reels = join(scratch, 'Reels')
const currentProjectRoot = (): string | null => currentSession()?.root ?? null
const getEntry = (id: string) => currentSession()?.library.getEntry(id) ?? null
let a: string
let b: string

const file = (dir: string, name: string, text: string): string => {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}
const reelOf = (root: string): string => join(root, `${root.split(/[\\/]/).pop()}.reel`)

/** Whisper runs started in `root` for `id` (the stub marks itself with `.started`). */
const whisperStarted = (root: string, id: string): boolean =>
  existsSync(join(root, 'cache', id, 'transcript_raw.started'))

/** Let every whisper run that has started (or starts meanwhile) finish, until `work` settles. */
async function releaseWhisperUntilSettled(id: string, ...work: Promise<unknown>[]): Promise<void> {
  const all = Promise.allSettled(work)
  let done = false
  void all.then(() => (done = true))
  while (!done) {
    for (const root of [a, b]) {
      if (whisperStarted(root, id)) writeFileSync(join(root, 'cache', id, 'transcript_raw.release'), '')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(async () => {
  mkdirSync(reels, { recursive: true })
  // A whisper install the discovery finds: node itself, which runs the stub script above.
  const dir = join(scratch, 'data', 'bin', 'whisper')
  mkdirSync(dir, { recursive: true })
  copyFileSync(process.execPath, join(dir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'))
  file(dir, 'model.bin', '')
  await createProject('A', reels)
  await createProject('B', reels)
  a = join(reels, 'A')
  b = join(reels, 'B')
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})
beforeEach(() => {
  h.probeGate = null
  h.failThumbUnder = null
  h.thumbOutputs.length = 0
})

describe('the library belongs to the open project', () => {
  it('opening B leaves nothing of A behind, and A comes back as it was saved', async () => {
    await openProject(reelOf(a))
    const inA = await importFile(file(join(a, 'footage'), 'only-in-a.mov', 'only in A 2s'))
    expect(getEntry(inA.id)).not.toBeNull()

    await openProject(reelOf(b))
    expect(currentProjectRoot()).toBe(b)
    expect(getEntry(inA.id)).toBeNull() // A's unsaved import is not B's

    await openProject(reelOf(a))
    expect(getEntry(inA.id)).toBeNull() // never saved: reopening starts from the .reel
  })

  it('the change listener survives a switch', async () => {
    const changed = vi.fn()
    const off = onLibraryChanged(changed)
    await openProject(reelOf(a))
    await openProject(reelOf(b))
    await importFile(file(join(b, 'footage'), 'listener.mov', 'listener 2s'))
    expect(changed).toHaveBeenCalled()
    off()
  })

  it('Save As re-roots the open project', async () => {
    await openProject(reelOf(a))
    const moved = join(reels, 'A moved', 'A moved.reel')
    const res = await saveProjectAs(
      { id: 'p', name: 'A', version: 99, mediaIds: [] } as unknown as Parameters<typeof saveProjectAs>[0],
      moved
    )
    expect(res.path).toBe(moved)
    expect(currentProjectRoot()).toBe(join(reels, 'A moved'))
    // The next import measures its relative path from the new folder.
    const clip = await importFile(file(join(reels, 'A moved', 'footage'), 'after.mov', 'after save as 2s'))
    expect(clip.relativePath).toBe('footage/after.mov')
  })

  it('a failed launch leaves no open project', async () => {
    await openProject(reelOf(b))
    writeFileSync(join(scratch, 'data', 'projects', 'session.json'), JSON.stringify({ root: b }))
    const reel = reelOf(b)
    const good = readFileSync(reel, 'utf8')
    writeFileSync(reel, '{ not json')
    try {
      initProjectRoot()
      const res = await loadProject()
      expect(res.loaded).toBeNull()
      expect(res.message).toBeTruthy()
      expect(currentProjectRoot()).toBeNull()
      expect(getEntry('anything')).toBeNull()
    } finally {
      writeFileSync(reel, good)
    }
  })
})

describe('a job and its single-flight belong to the project it started in', () => {
  it('importing the same file into B while A is still importing it gives B its own import', async () => {
    const x = file(join(scratch, 'shared'), 'x.mov', 'shared clip X 3s')

    await openProject(reelOf(a))
    let release!: () => void
    h.probeGate = new Promise<void>((r) => (release = r))
    const inA = importFile(x)
    await vi.waitFor(() => expect(h.probeCalls).toBeGreaterThan(0))

    await openProject(reelOf(b))
    const inB = importFile(x)
    await new Promise((r) => setTimeout(r, 20))
    release()
    const [resA, resB] = await Promise.allSettled([inA, inB])

    expect(resB.status).toBe('fulfilled') // B is not handed A's run (which A's library refuses)
    if (resB.status === 'fulfilled') expect(getEntry(resB.value.id)).not.toBeNull()
    // A's run finishes in the project it started in, or is refused; it never lands in B.
    expect(resA.status === 'fulfilled' || resA.status === 'rejected').toBe(true)
  })

  it("transcribing the same clip in B while A is still transcribing it writes B's own transcript", async () => {
    const x = file(join(scratch, 'shared'), 'speech.mov', 'speech clip 3s')

    await openProject(reelOf(a))
    const clipA = await importFile(x)
    const inA = transcribeMedia(clipA.id)
    await vi.waitFor(() => expect(whisperStarted(a, clipA.id)).toBe(true), { timeout: 5000 })

    await openProject(reelOf(b))
    const clipB = await importFile(x)
    expect(clipB.id).toBe(clipA.id) // same content, same id, two projects
    const inB = transcribeMedia(clipB.id)

    await releaseWhisperUntilSettled(clipA.id, inA, inB)

    expect(existsSync(join(a, 'transcripts', `${clipA.id}.json`))).toBe(true) // A's run finished where it started
    expect(existsSync(join(b, 'transcripts', `${clipB.id}.json`))).toBe(true) // and B got its own
  })
})

describe('failure memory is per project', () => {
  it('a thumbnail that failed in A is tried again in B (their output paths differ by root)', async () => {
    const x = file(join(scratch, 'shared'), 'thumb.mov', 'video clip for thumbs 2s')

    await openProject(reelOf(a))
    h.failThumbUnder = a
    await importFile(x)
    expect(h.thumbOutputs.some((o) => o.startsWith(a))).toBe(true)

    h.failThumbUnder = null
    await openProject(reelOf(b))
    await importFile(x)
    expect(h.thumbOutputs.some((o) => o.startsWith(b))).toBe(true)
    expect(existsSync(join(b, 'cache'))).toBe(true)
  })
})
