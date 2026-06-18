/**
 * whisper.cpp transcription. Extracts 16k mono audio from a media's original,
 * runs whisper-cli word-level (-ml 1 -sow -oj), parses to a Transcript (source
 * time), and caches it as media/<id>/transcript.json. Discovery looks under
 * <dataDir>/bin/whisper (whisper-cli in Release/, bin/ or build/bin/, with a
 * .bin model alongside).
 */

import { spawn } from 'node:child_process'
import { existsSync, promises as fsp, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Transcript } from '@shared/transcript'
import { getSubdir, getBundledBinDir } from '../config'
import { getBinaries } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'
import { getAsset } from './mediaStore'
import { parseWhisperJson, type WhisperJson } from './whisperParse'
import { createJob, failJob, finishJob, setProgress } from './jobs'

const transcriptPath = (id: string): string => join(getSubdir('media'), id, 'transcript.json')

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

export async function getTranscript(mediaId: string): Promise<Transcript | null> {
  try {
    return JSON.parse(await fsp.readFile(transcriptPath(mediaId), 'utf8')) as Transcript
  } catch {
    return null
  }
}

function runWhisper(cli: string, model: string, wav: string, outPrefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-m', model, '-f', wav, '-ml', '1', '-sow', '-oj', '-of', outPrefix, '-np']
    const child = spawn(cli, args, { windowsHide: true })
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

/** Transcribe a media file (cached). Reports progress on the jobs channel. */
export async function transcribeMedia(mediaId: string): Promise<Transcript> {
  const cached = await getTranscript(mediaId)
  if (cached) return cached

  const whisper = discoverWhisper()
  if (!whisper) throw new Error('whisper.cpp is not installed (bin/whisper).')
  const asset = await getAsset(mediaId)
  if (!asset) throw new Error(`unknown media ${mediaId}`)

  const job = createJob('transcribe', `Captions · ${asset.fileName}`, mediaId)
  const dir = join(getSubdir('media'), mediaId)
  const wav = join(dir, 'audio16k.wav')
  const rawPrefix = join(dir, 'transcript_raw')
  try {
    const { ffmpeg } = await getBinaries()
    await runFfmpeg(ffmpeg, [
      '-y', '-hide_banner', '-nostdin',
      '-i', asset.originalPath,
      '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wav
    ], 0)
    setProgress(job.id, 0.3)

    await runWhisper(whisper.cli, whisper.model, wav, rawPrefix)
    setProgress(job.id, 0.9)

    const json = JSON.parse(await fsp.readFile(`${rawPrefix}.json`, 'utf8')) as WhisperJson
    const transcript: Transcript = {
      mediaId,
      words: parseWhisperJson(json),
      model: basename(whisper.model),
      createdAt: new Date().toISOString()
    }
    await fsp.writeFile(transcriptPath(mediaId), JSON.stringify(transcript, null, 2))

    // Mark the asset and clean up scratch files.
    asset.transcribed = true
    await fsp.writeFile(join(dir, 'asset.json'), JSON.stringify(asset, null, 2)).catch(() => {})
    await fsp.rm(wav, { force: true }).catch(() => {})
    await fsp.rm(`${rawPrefix}.json`, { force: true }).catch(() => {})

    finishJob(job.id, transcript)
    return transcript
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}
