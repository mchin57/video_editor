/**
 * Why a file could not be imported, in words for the person who picked it.
 * The raw error is a Node fs error (missing, locked) or ffprobe's
 * `Command failed: …` with the whole command line and its stderr — useless in a
 * notice, so it is boiled down here. The raw error still goes to main's log.
 *
 * The ffprobe lines matched below were read off the real binary (8.1.1):
 * docs/FFMPEG-NOTES.md "Unreadable imports".
 */

/** The parts of a thrown import error this reads. */
interface ErrorLike {
  code?: unknown
  message?: unknown
  stderr?: unknown
}

/**
 * A short reason for `err`. `size` is the file's size in bytes when it could
 * be read: a zero-byte file says so, whatever ffprobe made of it.
 */
export function importFailureReason(err: unknown, size?: number): string {
  if (size === 0) return 'The file is empty (0 bytes).'
  const e: ErrorLike = typeof err === 'object' && err !== null ? (err as ErrorLike) : { message: String(err) }
  const stderr = typeof e.stderr === 'string' ? e.stderr : ''
  const message = typeof e.message === 'string' ? e.message : ''
  switch (e.code) {
    case 'ENOENT':
      return 'File not found.'
    case 'EACCES':
    case 'EPERM':
      return "Permission denied: the file can't be read."
    case 'EBUSY':
      return 'The file is in use by another program.'
    case 'EISDIR':
      return 'That is a folder, not a file.'
  }
  if (/No such file or directory/i.test(stderr)) return 'File not found.'
  if (/moov atom not found/i.test(stderr)) {
    return 'The video is incomplete or damaged (its index, the moov atom, is missing).'
  }
  if (/End of file|error reading header|partial file/i.test(stderr)) {
    return 'The file is incomplete (cut short).'
  }
  if (/Invalid data found when processing input/i.test(stderr)) {
    return 'Not a video, audio or image file this app can read.'
  }
  // Anything else: ffprobe's last line without its "<path>: " prefix, or the
  // error's own first line.
  const last = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  if (last) return last.replace(/^.*?:\s(?=[^:]+$)/, '')
  return message.split(/\r?\n/)[0] || 'Unknown error.'
}
