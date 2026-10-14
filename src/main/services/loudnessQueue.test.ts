/**
 * `ensureLoudnessFor` around a library Rename: a pass that waited in the
 * limiter must measure the file where it is NOW, and a pass whose input
 * vanished under it must not be remembered as a failure. ffmpeg is a stub
 * that each test releases by hand (and that fails, like the real one, on a
 * missing input).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  root: '',
  entries: new Map<string, { path: string | null }>(),
  runs: [] as { input: string; release: (opts?: { fail?: boolean }) => void }[]
}))

vi.mock('./ffmpeg', () => ({ getBinaries: async () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }) }))
vi.mock('./projectRoot', () => ({ currentProjectRoot: () => h.root, getProjectRoot: () => h.root }))
vi.mock('./library', () => ({
  getEntry: (id: string) => h.entries.get(id) ?? null,
  resolveEntry: async () => null
}))
vi.mock('./ffmpegRun', () => ({
  runFfmpeg: (_bin: string, args: string[], _dur: number, _progress: unknown, cwd: string) =>
    new Promise<void>((resolve, reject) => {
      const input = args[args.indexOf('-i') + 1]
      const printName = /file=([^,]+)$/.exec(args[args.indexOf('-af') + 1])![1]
      h.runs.push({
        input,
        release: (opts) => {
          if (opts?.fail || !existsSync(input)) return reject(new Error(`ffmpeg failed reading ${input}`))
          writeFileSync(join(cwd, printName), 'frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.Peak_level=-6\nlavfi.r128.M=-20\n')
          resolve()
        }
      })
    })
}))

import { ensureLoudnessFor, loudnessPassReading, type LoudnessSource } from './loudness'

let scratch: string
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'reel-loudq-'))
  h.root = join(scratch, 'project')
  mkdirSync(join(scratch, 'media'), { recursive: true })
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A media file on disk, in the library under `id`. */
function media(id: string): LoudnessSource {
  const path = join(scratch, 'media', `${id}.wav`)
  writeFileSync(path, id)
  h.entries.set(id, { path })
  return { id, path, hasAudio: true, foldChannel: null }
}
/** Library Rename, as `renameMedia` does it: the file, then the entry. */
function rename(src: LoudnessSource, stem: string): LoudnessSource {
  const to = join(scratch, 'media', `${stem}.wav`)
  renameSync(src.path!, to)
  h.entries.set(src.id, { path: to })
  return { ...src, path: to }
}
const runsReach = (n: number): Promise<void> => vi.waitFor(() => expect(h.runs.length).toBe(n))
/** The started pass reading `path` (passes sharing the limiter start in no fixed order). */
const runOf = (path: string | null | undefined): (typeof h.runs)[number] => {
  const run = h.runs.find((r) => r.input === path)
  if (!run) throw new Error(`no pass is reading ${path}`)
  return run
}

describe('ensureLoudnessFor and a Rename', () => {
  it('a pass queued behind the limiter measures the file at its renamed path', async () => {
    h.runs.length = 0
    const [srcA, srcB] = [media('a'), media('b')]
    const a = ensureLoudnessFor(h.root, srcA)
    const b = ensureLoudnessFor(h.root, srcB)
    const c = media('c')
    const queued = ensureLoudnessFor(h.root, c)
    await runsReach(2) // a and b hold both slots; c waits
    const renamed = rename(c, 'c renamed')
    // renameMedia's hydrate kicks the pass again with the new path: it joins the queued one.
    const again = ensureLoudnessFor(h.root, renamed)
    runOf(srcA.path).release()
    await runsReach(3)
    expect(h.runs[2].input).toBe(renamed.path)
    h.runs[2].release()
    runOf(srcB.path).release()
    await Promise.all([a, b])
    expect(await queued).toMatchObject({ momentary: [-20], peak: [-6] })
    expect(await again).toEqual(await queued)
  })

  it('a pass whose input vanished under it is not remembered as a failure', async () => {
    h.runs.length = 0
    const d = media('d')
    const first = ensureLoudnessFor(h.root, d)
    await runsReach(1)
    const renamed = rename(d, 'd renamed') // moved after ffmpeg was handed the old path
    h.runs[0].release()
    expect(await first).toBeNull()
    const second = ensureLoudnessFor(h.root, renamed)
    await runsReach(2)
    expect(h.runs[1].input).toBe(renamed.path)
    h.runs[1].release()
    expect(await second).toMatchObject({ momentary: [-20] })
  })

  it('reports a pass as reading its original only while it runs (not while queued)', async () => {
    h.runs.length = 0
    const [f, g, k] = [media('f'), media('g'), media('k')]
    const runs = [f, g, k].map((s) => ensureLoudnessFor(h.root, s))
    await runsReach(2)
    expect([f, g, k].map((s) => loudnessPassReading(h.root, s.id))).toEqual([true, true, false])
    runOf(f.path).release()
    await runsReach(3)
    expect(loudnessPassReading(h.root, 'f')).toBe(false)
    expect(loudnessPassReading(h.root, 'k')).toBe(true)
    runOf(g.path).release()
    runOf(k.path).release()
    await Promise.all(runs)
    expect([f, g, k].some((s) => loudnessPassReading(h.root, s.id))).toBe(false)
  })

  it('a genuine failure (the file is there) is still remembered for the session', async () => {
    h.runs.length = 0
    const e = media('e')
    const first = ensureLoudnessFor(h.root, e)
    await runsReach(1)
    h.runs[0].release({ fail: true })
    expect(await first).toBeNull()
    expect(await ensureLoudnessFor(h.root, e)).toBeNull()
    expect(h.runs.length).toBe(1) // not retried
  })
})
