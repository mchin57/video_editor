/**
 * whisper.cpp transcription. Extracts 16k mono audio from a media's original,
 * runs whisper-cli word-level (-ml 1 -sow -ojf, with DTW token timestamps when
 * the model maps to a `-dtw` preset), parses to a Transcript (source time), and
 * caches it as the project's transcripts/<id>.json (project-owned: it is
 * slow to rebuild, so it does not live in the disposable cache). Discovery looks under
 * <dataDir>/bin/whisper (whisper-cli in Release/, bin/ or build/bin/, with a
 * .bin model alongside).
 *
 * The whole ORIGINAL is transcribed, never a per-clip slice; clip trims are
 * applied afterwards in the renderer (renderer/lib/captions.ts). The wav is
 * mono-folded like the mix and a quiet source is lifted toward a target level
 * first (whisperArgs.ts `transcribeGainDb`). One
 * silencedetect pass over the wav serves two fixes: decoding starts just before
 * the first speech (whisper drops a file's opening sentence after leading
 * junk), and each word ends where its sound stops.
 */

import { spawn } from 'node:child_process'
import { existsSync, promises as fsp, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isCurrentTranscript, TRANSCRIPT_VERSION, type Transcript } from '@shared/transcript'
import { getSubdir, getBundledBinDir } from '../config'
import { getBinaries } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'
import { replaceFile } from './atomicWrite'
import { requireUsable, scratchDirFor, transcriptFile } from './mediaStore'
import { clearStaleTranscript, getEntry } from './library'
import { singleFlight } from './atomicWrite'
import { parseWhisperTranscript, type WhisperJson } from './whisperParse'
import {
  buildTranscribeExtractArgs,
  buildWhisperArgs,
  decodeStartSec,
  dtwPreset,
  transcribeGainDb
} from './whisperArgs'
import { windowLoudness } from '@shared/loudness'
import { monoFoldPan } from './audio'
import { ensureLoudness } from './loudness'
import { detectSilence } from './silence'
import { createJob, failJob, finishJob, setProgress } from './jobs'


/** Whisper search roots, bundled (installer) first, then the user data dir. */
function whisperDirs(): string[] {
  const dirs: string[] = []
  const bundled = getBundledBinDir()
  if (bundled) dirs.push(join(bundled, 'whisper'))
  dirs.push(join(getSubdir('bin'), 'whisper'))
  return dirs
}

export function discoverWhisper(): { cli: string; model: string } | null {
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  for (const dir of whisperDirs()) {
    // Build layouts vary: MSVC emits Release\, the cmake/Unix default emits
    // build\bin\ (or bin\), and the bundled/flat layout drops it straight in dir.
    const cli = [
      join(dir, 'Release', exe),
      join(dir, 'bin', exe),
      join(dir, 'build', 'bin', exe),
      join(dir, exe)
    ].find((p) => existsSync(p))
    if (!cli) continue
    let model: string | null = null
    try {
      const bin = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.bin'))
      if (bin) model = join(dir, bin)
    } catch {
      continue
    }
    if (model && existsSync(model)) return { cli, model }
  }
  return null
}

export function whisperAvailable(): boolean {
  return discoverWhisper() !== null
}

export function runWhisper(cli: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // Results come from the -ojf file, never stdout. stdout MUST NOT be an
    // undrained pipe: `-ml 1` + `-dtw` re-prints every earlier segment per new
    // word (quadratic: ~130 KB for 80 words), the pipe fills, and whisper blocks
    // forever at 0% CPU.
    const child = spawn(cli, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let tail = ''
    child.stderr.on('data', (b: Buffer) => {
      tail = (tail + b.toString()).slice(-3000)
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`whisper exited ${code}: ${tail.slice(-500)}`))
    )
  })
}

/** Run whisper over a wav, asking for DTW token timestamps where possible. */
async function runTranscription(
  cli: string,
  model: string,
  wav: string,
  outPrefix: string,
  offsetSec: number
): Promise<void> {
  const preset = dtwPreset(model)
  if (preset) {
    try {
      await runWhisper(cli, buildWhisperArgs(model, wav, outPrefix, preset, offsetSec))
      return
    } catch {
      // An older binary without -dtw/-nfa still transcribes; the parser will
      // fall back to segment offsets and stamp the transcript accordingly.
    }
  }
  await runWhisper(cli, buildWhisperArgs(model, wav, outPrefix, null, offsetSec))
}

export async function getTranscript(mediaId: string): Promise<Transcript | null> {
  // A forced relink gave the clip new content: its transcript is stale.
  if (getEntry(mediaId)?.staleTranscript) return null
  try {
    const cached = JSON.parse(await fsp.readFile(transcriptFile(mediaId), 'utf8')) as Transcript
    // A transcript from an older pipeline can be missing words or mistime them
    // (see TRANSCRIPT_VERSION). Treat it as stale so the next caption run redoes
    // it instead of serving it forever.
    return isCurrentTranscript(cached) ? cached : null
  } catch {
    return null
  }
}

const transcribeFlight = singleFlight<Transcript>() // keyed by media id

/**
 * Transcribe a media file (cached). Reports progress on the jobs channel.
 * Concurrent calls for one media coalesce onto a single run — they would
 * otherwise write the same audio16k.wav / transcript_raw files.
 */
export function transcribeMedia(mediaId: string): Promise<Transcript> {
  return transcribeFlight(mediaId, () => transcribeOnce(mediaId))
}

async function transcribeOnce(mediaId: string): Promise<Transcript> {
  const cached = await getTranscript(mediaId)
  if (cached) return cached

  const whisper = discoverWhisper()
  if (!whisper) throw new Error('whisper.cpp is not installed (bin/whisper).')
  const asset = await requireUsable(mediaId)

  const job = createJob('transcribe', `Captions · ${asset.fileName}`, mediaId, { uses: [mediaId] })
  const transcriptPath = transcriptFile(mediaId) // captured now: the project may switch mid-job
  const dir = await scratchDirFor(mediaId)
  const wav = join(dir, 'audio16k.wav')
  const rawPrefix = join(dir, 'transcript_raw')
  try {
    const { ffmpeg } = await getBinaries()
    // Lift a quiet source first: whisper and silencedetect both read this wav,
    // and the −30 dB silence gate otherwise hears quiet speech as silence. The
    // level comes from the volume-match loudness series (usually cached); no
    // series just means no boost.
    const series = await ensureLoudness(mediaId)
    const level = series ? windowLoudness(series, 0, asset.probe.durationSec) : null
    const gainDb = transcribeGainDb(level?.status === 'ok' ? level.lufs : null)
    const fold = asset.probe.audio?.monoFoldChannel
    await runFfmpeg(ffmpeg, buildTranscribeExtractArgs(
      asset.originalPath, wav, fold != null ? monoFoldPan(fold) : null, gainDb
    ), 0)
    setProgress(job.id, 0.25)

    // Skip whatever precedes the first speech: whisper drops the opening
    // sentence after a leading click or a long lead-in. A failed detection just
    // decodes the whole file, as before.
    const silences = await detectSilence(wav, asset.probe.durationSec).catch(() => [])
    const startSec = decodeStartSec(silences, asset.probe.durationSec)
    setProgress(job.id, 0.3)

    await runTranscription(whisper.cli, whisper.model, wav, rawPrefix, startSec)
    setProgress(job.id, 0.9)

    const json = JSON.parse(await fsp.readFile(`${rawPrefix}.json`, 'utf8')) as WhisperJson
    const { words, timing } = parseWhisperTranscript(json, silences)
    const transcript: Transcript = {
      mediaId,
      words,
      model: basename(whisper.model),
      createdAt: new Date().toISOString(),
      timing,
      version: TRANSCRIPT_VERSION,
      decodeStartSec: startSec
    }
    // temp + rename, so a reader never sees a half-written transcript.
    await fsp.mkdir(join(transcriptPath, '..'), { recursive: true })
    await replaceFile(transcriptPath, JSON.stringify(transcript, null, 2))
    clearStaleTranscript(mediaId) // it describes the clip's current content now

    // Clean up scratch files. (`transcribed` is read from the file's existence.)
    await fsp.rm(wav, { force: true }).catch(() => {})
    await fsp.rm(`${rawPrefix}.json`, { force: true }).catch(() => {})

    finishJob(job.id, transcript)
    return transcript
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}
