/**
 * The loudness series (`shared/loudness.ts`): one ffmpeg pass per media asset
 * with audio, cached as `cache/<id>/loudness.json`. Volume levels read it — the
 * preview through the `getLoudness` IPC, the export through `ensureLoudness`.
 *
 * The pass (verified ffmpeg 8.1.1 — FFMPEG-NOTES "Loudness series"):
 *   [mono-fold pan] → aresample=48000 → asetnsamples=4800 (exactly 0.1 s
 *   frames) → astats (per-frame sample peak, reset every frame) → ebur128
 *   (momentary loudness as frame metadata) → ametadata=print to a file.
 * `buildLoudnessArgs` and `parseLoudnessPrint` are pure (unit-tested).
 */

import { existsSync, promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isLoudnessSeries, LOUDNESS_STEP_SEC, LOUDNESS_VERSION, type LoudnessSeries } from '@shared/loudness'
import { writeAtomically } from './atomicWrite'
import { monoFoldPan } from './audio'
import { getBinaries } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'
import { cachePath } from './projectLayout'
import { requireSession, type ProjectSession } from './projectSession'
import { createLogger, bestEffort } from '@shared/log'

const log = createLogger('loudness')

/** 48 kHz × 0.1 s: the frame size that makes one metadata frame one series step. */
const SAMPLE_RATE = 48000
const STEP_SAMPLES = Math.round(SAMPLE_RATE * LOUDNESS_STEP_SEC)

/**
 * ffmpeg args for the measuring pass. `printFile` is where `ametadata` writes
 * its log: pass a bare file name and run ffmpeg with that directory as its
 * cwd — a Windows absolute path inside a filtergraph needs its drive colon
 * escaped, a relative name needs nothing.
 */
export function buildLoudnessArgs(input: string, printFile: string, foldChannel: number | null = null): string[] {
  const chain = [
    ...(foldChannel != null ? [monoFoldPan(foldChannel)] : []),
    `aresample=${SAMPLE_RATE}`,
    `asetnsamples=n=${STEP_SAMPLES}:p=0`,
    'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level',
    'ebur128=metadata=1',
    `ametadata=mode=print:file=${printFile}`
  ].join(',')
  return ['-hide_banner', '-nostdin', '-nostats', '-i', input, '-map', '0:a:0', '-vn', '-af', chain, '-f', 'null', '-']
}

/** A metadata value as a series number: finite and above ffmpeg's floor, rounded to 0.01 dB; else null. */
function level(raw: string | undefined, floor: number): number | null {
  if (raw == null) return null
  const v = Number(raw)
  if (!Number.isFinite(v) || v <= floor) return null
  return Math.round(v * 100) / 100
}

/**
 * Parse the `ametadata=mode=print` log into a series: each `frame:N pts:… pts_time:T`
 * header starts a 0.1 s step; `lavfi.r128.M` is its momentary loudness (`nan` /
 * the −120.7 floor → null) and `lavfi.astats.Overall.Peak_level` its peak
 * (`-inf` → null).
 */
export function parseLoudnessPrint(text: string): LoudnessSeries {
  const momentary: (number | null)[] = []
  const peak: (number | null)[] = []
  let startSec: number | null = null
  let m: string | undefined
  let p: string | undefined
  let open = false
  const flush = (): void => {
    if (!open) return
    momentary.push(level(m, -120))
    peak.push(level(p, -Infinity))
    m = p = undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const header = /^frame:\d+\s+pts:-?\d+\s+pts_time:(\S+)/.exec(line)
    if (header) {
      flush()
      open = true
      if (startSec == null) {
        const t = Number(header[1])
        startSec = Number.isFinite(t) ? Math.round(t * 1000) / 1000 : 0
      }
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    if (key === 'lavfi.r128.M') m = line.slice(eq + 1).trim()
    else if (key === 'lavfi.astats.Overall.Peak_level') p = line.slice(eq + 1).trim()
  }
  flush()
  return { version: LOUDNESS_VERSION, stepSec: LOUDNESS_STEP_SEC, startSec: startSec ?? 0, momentary, peak }
}

/** Measure `input` and write its series to `output` (atomically: the file only
 *  ever exists complete). The print log lives next to it and is always removed. */
export async function generateLoudness(
  input: string,
  output: string,
  foldChannel: number | null = null
): Promise<LoudnessSeries> {
  const { ffmpeg } = await getBinaries()
  const dir = dirname(output)
  const printName = `${basename(output, '.json')}.print.txt`
  const printPath = join(dir, printName)
  let series: LoudnessSeries | null = null
  try {
    await writeAtomically(output, async (part) => {
      await runFfmpeg(ffmpeg, buildLoudnessArgs(input, printName, foldChannel), 0, undefined, dir)
      series = parseLoudnessPrint(await fsp.readFile(printPath, 'utf8'))
      if (series.momentary.length === 0) throw new Error('the loudness pass produced no measurements')
      await fsp.writeFile(part, JSON.stringify(series))
    })
  } finally {
    await bestEffort(fsp.rm(printPath, { force: true }), 'removing the loudness print file', log)
  }
  return series!
}

/** Read a cached series; null if absent, unreadable or of another version. */
export async function readLoudnessFile(path: string): Promise<LoudnessSeries | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(path, 'utf8'))
    return isLoudnessSeries(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const loudnessPath = (root: string, id: string): string => cachePath(root, id, 'loudness.json')

/** What generation needs to know about an asset. */
export interface LoudnessSource {
  id: string
  /** The original's current location (null/undefined = missing). */
  path: string | null | undefined
  hasAudio: boolean
  foldChannel: number | null
}

// One measurement per file in flight, the failures to not retry until the
// project reopens or a relink gives new content (`forgetLoudnessFailure`), and
// the passes currently reading an original are all on the ProjectSession.
// At most two passes run at once, across projects (opening a project kicks one
// per asset, each reading its whole original): that cap is the machine's.
const MAX_PASSES = 2

/**
 * Run at most `max` of the given tasks at once; the rest wait their turn (FIFO).
 * A finishing task HANDS its slot to the next waiter rather than freeing it:
 * freeing it would let a newcomer arriving before the woken waiter resumes
 * (a microtask later) take the slot too, briefly running `max + 1`.
 */
export function createLimiter(max: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async (run) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    else active++
    try {
      return await run()
    } finally {
      const next = waiting.shift()
      if (next)
        next() // the slot passes straight to it: `active` is unchanged
      else active--
    }
  }
}

const limited = createLimiter(MAX_PASSES)

/**
 * Where the original is NOW. A pass can wait in the limiter long enough for a
 * library Rename (or relink) to move the file, so the path is read from the
 * open library when the pass actually starts — the one captured at queue time
 * may be gone. After a project switch the captured path stands (the pass
 * finishes in the project it started in, like any long job).
 */
function inputNow(s: ProjectSession, src: LoudnessSource): string | null {
  if (!s.isCurrent) return src.path ?? null
  const entry = s.library.getEntry(src.id)
  return entry ? entry.path : (src.path ?? null)
}

/**
 * The asset's series: the cached file, else measured now (shared by every
 * concurrent caller). Null when the asset has no audio, its original is
 * missing (and nothing is cached), or measuring failed — never throws.
 */
export async function ensureLoudnessFor(s: ProjectSession, src: LoudnessSource): Promise<LoudnessSeries | null> {
  if (!src.hasAudio) return null
  const out = loudnessPath(s.root, src.id)
  const cached = existsSync(out) ? await readLoudnessFile(out) : null
  if (cached) return cached
  if (!src.path || s.loudnessFailed.has(out)) return null
  return s.loudnessFlight(out, () =>
    limited(async () => {
      const input = inputNow(s, src)
      if (!input) return null // gone missing while queued: not a failure to remember
      s.loudnessReading.add(out)
      try {
        await fsp.mkdir(dirname(out), { recursive: true })
        // A stale (other-version) file is replaced; the rename needs it gone.
        await fsp.rm(out, { force: true })
        return await generateLoudness(input, out, src.foldChannel)
      } catch (error) {
        // A file that vanished under the pass (renamed or moved meanwhile) says
        // nothing about its content: leave it to be measured at its new path.
        if (existsSync(input)) s.loudnessFailed.add(out)
        log.error(`measuring ${src.id} failed`, error)
        return null
      } finally {
        s.loudnessReading.delete(out)
      }
    })
  )
}

/** Whether a loudness pass is reading the asset's original right now (a
 *  queued one isn't: it reads the path when it starts). Rename refuses then —
 *  Windows won't rename a file ffmpeg holds open. */
export function loudnessPassReading(s: ProjectSession, id: string): boolean {
  return s.loudnessReading.has(loudnessPath(s.root, id))
}

/** Start a missing series in the background (the media store's hydrate: new
 *  imports and already-imported files alike). Cheap when the file exists. */
export function kickLoudness(s: ProjectSession, src: LoudnessSource): void {
  if (!src.hasAudio || !src.path) return
  const out = loudnessPath(s.root, src.id)
  if (existsSync(out) || s.loudnessFailed.has(out)) return
  void ensureLoudnessFor(s, src)
}

/** Forget a remembered failure for everything under an asset's cache dir
 *  (its content changed: measure afresh). */
export function forgetLoudnessFailure(s: ProjectSession, dir: string): void {
  for (const out of [...s.loudnessFailed]) if (out.startsWith(dir)) s.loudnessFailed.delete(out)
}

/**
 * A media asset's series in the project (default: the open one), by id — read from the cache, or
 * measured now if it is missing. The export reads levels through this (and the
 * `getLoudness` IPC is this). Null = unknown id, no audio, original missing
 * with nothing cached, or the measurement failed.
 */
export async function ensureLoudness(
  mediaId: string,
  s: ProjectSession = requireSession()
): Promise<LoudnessSeries | null> {
  const res = await s.library.resolveEntry(mediaId)
  if (!res) return null
  const { record } = res.entry
  return ensureLoudnessFor(s, {
    id: mediaId,
    path: res.entry.path,
    hasAudio: !!record.probe.audio,
    foldChannel: record.probe.audio?.monoFoldChannel ?? null
  })
}
