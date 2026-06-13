import { spawn } from 'node:child_process'

/**
 * Run ffmpeg, reporting progress (0..1) parsed from `-progress pipe:1` output.
 * Resolves on exit 0, rejects with the tail of stderr otherwise.
 */
export function runFfmpeg(
  ffmpeg: string,
  args: string[],
  durationSec: number,
  onProgress?: (p: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let tail = ''
    child.stdout.on('data', (buf: Buffer) => {
      const last = [...buf.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g)].at(-1)
      if (last && durationSec > 0 && onProgress) {
        onProgress(Math.min(0.999, Number(last[1]) / 1e6 / durationSec))
      }
    })
    child.stderr.on('data', (buf: Buffer) => {
      tail = (tail + buf.toString()).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${tail.slice(-600)}`))
    })
  })
}
