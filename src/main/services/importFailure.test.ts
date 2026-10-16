import { describe, expect, it } from 'vitest'
import { importFailureReason } from './importFailure'

// stderr captured from the real ffprobe 8.1.1 (`-v error … -show_format
// -show_streams <file>`), rejected through promisified execFile.
const probeError = (stderr: string): Error =>
  Object.assign(new Error(`Command failed: ffprobe.exe -v error …\n${stderr}`), { code: 1, stderr })

describe('importFailureReason', () => {
  it('names an empty file, whatever ffprobe said about it', () => {
    const err = probeError(
      '[mov,mp4,m4a,3gp,3g2,mj2 @ 000002896d15f040] moov atom not found\r\nC:/x/empty.mp4: Invalid data found when processing input\r\n'
    )
    expect(importFailureReason(err, 0)).toBe('The file is empty (0 bytes).')
  })

  it('says a missing file is missing (fs ENOENT)', () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\x\\gone.mp4'"), { code: 'ENOENT' })
    expect(importFailureReason(err)).toBe('File not found.')
  })

  it('says a missing file is missing (ffprobe)', () => {
    expect(importFailureReason(probeError('C:/x/gone.mp4: No such file or directory\r\n'))).toBe('File not found.')
  })

  it('reads a locked or unreadable file', () => {
    expect(importFailureReason(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))).toMatch(/in use/)
    expect(importFailureReason(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toMatch(/Permission denied/)
  })

  it('calls a video without its moov atom incomplete or damaged', () => {
    const err = probeError(
      '[mov,mp4,m4a,3gp,3g2,mj2 @ 000001f010bdf900] moov atom not found\r\nC:/x/garbage.mp4: Invalid data found when processing input\r\n'
    )
    expect(importFailureReason(err, 4000)).toMatch(/incomplete or damaged.*moov atom/)
  })

  it('calls a file cut short mid-header incomplete', () => {
    const err = probeError('[mov,mp4,m4a,3gp,3g2,mj2 @ 000002b0a39cecc0] error reading header\r\nC:/x/trunc.mp4: End of file\r\n')
    expect(importFailureReason(err, 3000)).toBe('The file is incomplete (cut short).')
  })

  it('calls a non-media file unreadable', () => {
    const err = probeError('C:/x/notes.txt: Invalid data found when processing input\r\n')
    expect(importFailureReason(err, 5)).toBe('Not a video, audio or image file this app can read.')
  })

  it("falls back to ffprobe's last line without the path", () => {
    expect(importFailureReason(probeError('C:/x/odd.mkv: Something unusual\r\n'), 10)).toBe('Something unusual')
  })

  it("falls back to the error's first line", () => {
    expect(importFailureReason(new Error('ffprobe not found'))).toBe('ffprobe not found')
    expect(importFailureReason('boom')).toBe('boom')
  })
})
