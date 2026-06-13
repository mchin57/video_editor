import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProbeInfo } from '@shared/media'
import { getBinaries } from './ffmpeg'
import { parseFfprobeJson, type FfprobeJson } from './ffprobeParse'

const execFileAsync = promisify(execFile)

/** Probe a media file into structured info (rotation/VFR/HDR aware). */
export async function probeFile(path: string): Promise<ProbeInfo> {
  const { ffprobe } = await getBinaries()
  if (!ffprobe) throw new Error('ffprobe not found')
  const { stdout } = await execFileAsync(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  )
  return parseFfprobeJson(JSON.parse(stdout) as FfprobeJson)
}
