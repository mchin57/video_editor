import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** A spawned ffmpeg plus the settled-on-exit promise every caller needs. */
export interface FfmpegChild {
  child: ChildProcessWithoutNullStreams
  /** Resolves on exit 0; rejects with the tail of stderr otherwise (or if the
   *  spawn itself fails). Pre-marked handled, so a caller that bails out early
   *  (kill + cleanup) need not await it to avoid an unhandled rejection. */
  exited: Promise<void>
  /** The last ~4 KB of stderr, for error messages. */
  stderrTail: () => string
}

/**
 * Spawn ffmpeg with the kill path wired in: when `signal` aborts, the process
 * is killed (an already-aborted signal kills it immediately). The caller owns
 * stdin/stdout — use this directly for piped work (raw frames in/out) and
 * `runFfmpeg` for plain file-to-file runs.
 */
export function startFfmpeg(
  ffmpeg: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal } = {}
): FfmpegChild {
  const { cwd, signal } = opts
  const child = spawn(ffmpeg, args, { windowsHide: true, cwd })
  let tail = ''
  child.stderr.on('data', (buf: Buffer) => {
    tail = (tail + buf.toString()).slice(-4000)
  })
  const kill = (): void => {
    child.kill()
  }
  signal?.addEventListener('abort', kill, { once: true })
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${tail.slice(-600)}`))
    })
  })
  exited.catch(() => {})
  if (signal?.aborted) kill()
  return { child, exited, stderrTail: () => tail }
}

/**
 * Run ffmpeg, reporting progress (0..1) parsed from `-progress pipe:1` output.
 * Resolves on exit 0, rejects with the tail of stderr otherwise.
 */
export function runFfmpeg(
  ffmpeg: string,
  args: string[],
  durationSec: number,
  onProgress?: (p: number) => void,
  cwd?: string
): Promise<void> {
  const { child, exited } = startFfmpeg(ffmpeg, args, { cwd })
  child.stdout.on('data', (buf: Buffer) => {
    const last = [...buf.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g)].at(-1)
    if (last && durationSec > 0 && onProgress) {
      onProgress(Math.min(0.999, Number(last[1]) / 1e6 / durationSec))
    }
  })
  return exited
}
