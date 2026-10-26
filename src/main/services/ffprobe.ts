import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProbeInfo } from '@shared/media'
import { kindFromExt } from '@shared/media'
import { getBinaries } from './ffmpeg'
import { parseFfprobeJson, recordedUtcFromTags, type FfprobeJson } from './ffprobeParse'

const execFileAsync = promisify(execFile)

/**
 * Probe a media file into structured info (rotation/VFR/HDR aware). A still
 * also reads its first frame's side data: that is the only place an EXIF
 * orientation shows (docs/FFMPEG-NOTES.md "EXIF orientation"). Asked for with
 * `-show_entries`, not `-show_frames`, which would print every EXIF tag too.
 */
export async function probeFile(path: string): Promise<ProbeInfo> {
  const { ffprobe } = await getBinaries()
  if (!ffprobe) throw new Error('ffprobe not found')
  const frame =
    kindFromExt(path) === 'image'
      ? ['-read_intervals', '%+#1', '-show_entries', 'frame_side_data=side_data_type,rotation']
      : []
  const { stdout } = await execFileAsync(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...frame, path],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  )
  return parseFfprobeJson(JSON.parse(stdout) as FfprobeJson)
}

/** When a clip started recording (ISO, UTC) per its container's tags, or null
 *  (`recordedUtcFromTags`). Read on demand — a workout overlay asks once, when
 *  it syncs to that clip. */
export async function probeRecordedUtc(path: string): Promise<string | null> {
  const { ffprobe } = await getBinaries()
  if (!ffprobe) throw new Error('ffprobe not found')
  const { stdout } = await execFileAsync(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_entries', 'format_tags', path],
    { windowsHide: true, maxBuffer: 1024 * 1024 }
  )
  return recordedUtcFromTags((JSON.parse(stdout) as FfprobeJson).format?.tags)
}
