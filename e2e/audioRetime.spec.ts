/**
 * Audio clips re-timed with their linked clip (#58; docs/superpowers/plans/
 * 2026-11-14-audio-clip-retiming.md): speed and freeze holds on audio.
 *
 *  - a speed picked in the Inspector on a LINKED clip resizes the clip and its
 *    audio together, in one undo step;
 *  - an exported 0.5× linked clip has audio as long as its picture (ffprobe);
 *  - an exported frozen linked clip is SILENT during the hold and sounds around
 *    it (levels measured inside and outside);
 *  - the preview's follower plays the source second the shared mapping says at
 *    several playhead times on a 2× clip and across a hold (paused there, at the
 *    held point, with no gain).
 *
 * ARRANGE via `window.__reelStores`, ACT via real clicks or the app's own export
 * call, ASSERT on store + DOM + the output file. Every native dialog is cancelled
 * by the fixture except the export's Save dialog, which is stubbed to a temp file.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { AudioClip, Layer } from '../src/shared/project'
import { audioSourceAt } from '../src/shared/audioTiming'
import { test, expect } from './fixtures'
import { FFMPEG, FFPROBE } from './bin'

const ff = (args: string[]): void => {
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args])
}

/** A 1080×1920 clip with a continuous 1 kHz tone (lavfi's 1/8 full scale). */
function clipWithSound(out: string, sec: number): void {
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=gray:s=1080x1920:r=30:d=${sec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=1000:sample_rate=48000:duration=${sec}`,
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    out
  ])
}

async function importOne(page: Page, path: string): Promise<string> {
  return page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, path)
}

/** Each stream's duration (seconds) of a file, by codec type. */
function durations(file: string): { video: number; audio: number } {
  const out = execFileSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  )
  const d = { video: NaN, audio: NaN }
  for (const line of out.trim().split(/\r?\n/)) {
    const [kind, sec] = line.split(',')
    if (kind === 'video' || kind === 'audio') d[kind] = Number(sec)
  }
  return d
}

/** Mean level (dB) of `[a, b)` of a file's audio (`volumedetect`). */
function meanDb(file: string, a: number, b: number): number {
  const run = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-i',
      file,
      '-vn',
      '-af',
      `atrim=${a}:${b},volumedetect`,
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(run.stderr)
  if (run.status !== 0 || !m) throw new Error(`volumedetect failed: ${run.stderr.slice(-400)}`)
  return m[1] === '-inf' ? -Infinity : Number(m[1])
}

async function exportTo(page: Page, app: ElectronApplication, out: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: false })
  })
  expect(existsSync(out)).toBe(true)
}

const state = (page: Page): Promise<{ layer: Layer; audio: AudioClip[]; past: number }> =>
  page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    return { layer: s.project!.layers[0], audio: s.project!.audioClips, past: s.past.length }
  })

test('a speed picked on a linked clip resizes it and its audio together, in one undo step', async ({
  appPage: page
}) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 0, 10, true) // lands linked to its audio
    useUi.getState().selectLayer('L1')
  })
  const before = await state(page)
  expect(before.audio).toHaveLength(1)
  const audioId = before.audio[0].id
  const tileWidth = async (testId: string): Promise<number> => (await page.getByTestId(testId).boundingBox())!.width
  const w0 = await tileWidth('tile-layer-L1')
  expect(Math.abs((await tileWidth(`tile-audio-${audioId}`)) - w0)).toBeLessThan(2)

  await page.getByRole('button', { name: '0.5×', exact: true }).click()
  const after = await state(page)
  expect(after.past).toBe(before.past + 1)
  expect(after.layer.endSec).toBeCloseTo(20, 6)
  expect((after.layer.content as { speed?: number }).speed).toBe(0.5)
  expect(after.audio[0].speed).toBe(0.5)
  // Both tiles doubled, side by side; the audio tile wears the speed badge.
  await expect.poll(() => tileWidth('tile-layer-L1')).toBeGreaterThan(w0 * 1.9)
  expect(Math.abs((await tileWidth(`tile-audio-${audioId}`)) - (await tileWidth('tile-layer-L1')))).toBeLessThan(2)
  await expect(page.getByTestId(`tile-speed-${audioId}`)).toHaveText('0.5×')

  // One undo puts both back.
  await page.keyboard.press('Control+z')
  const undone = await state(page)
  expect(undone.layer.endSec).toBeCloseTo(10, 6)
  expect('speed' in undone.audio[0]).toBe(false)
})

test('export: a 0.5× linked clip has audio as long as its picture', async ({ appPage: page, electronApp }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(180_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-retime-speed-'))
  const src = join(dir, 'clip.mp4')
  clipWithSound(src, 4)
  const id = await importOne(page, src)
  await page.evaluate((m) => {
    const s = window.__reelStores.useProject.getState()
    s.addVideoLayer('V', m, 0, 4, true)
    s.setVideoSpeed('V', 0.5)
  }, id)
  const s = await state(page)
  expect(s.layer.endSec).toBeCloseTo(8, 6)
  expect(s.audio[0].speed).toBe(0.5)

  const out = join(dir, 'out.mp4')
  await exportTo(page, electronApp, out)
  const d = durations(out)
  console.log('[audioRetime] 0.5× durations', JSON.stringify(d))
  expect(d.video).toBeCloseTo(8, 1)
  // atempo at 0.5× ends ~17 ms short (FFMPEG-NOTES "Audio clip speed & holds");
  // the AAC frame adds up to ~21 ms either way.
  expect(Math.abs(d.audio - d.video)).toBeLessThan(0.1)
  // And it is sound all the way to the end, not a short clip padded out.
  expect(meanDb(out, 7.2, 7.8)).toBeGreaterThan(-40)
  rmSync(dir, { recursive: true, force: true })
})

test('export: a frozen linked clip is silent during the hold and sounds around it', async ({
  appPage: page,
  electronApp
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(180_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-retime-hold-'))
  const src = join(dir, 'clip.mp4')
  clipWithSound(src, 5)
  const id = await importOne(page, src)
  await page.evaluate((m) => {
    const s = window.__reelStores.useProject.getState()
    s.addVideoLayer('V', m, 0, 5, true)
    s.addFreeze('V', 2, 1.5) // the picture holds 2..3.5; the audio must too
  }, id)
  const s = await state(page)
  expect(s.layer.endSec).toBeCloseTo(6.5, 6)
  expect(s.audio).toHaveLength(1)
  expect(s.audio[0].freezes).toEqual([{ atSec: 2, holdSec: 1.5 }])

  const out = join(dir, 'out.mp4')
  await exportTo(page, electronApp, out)
  const before = meanDb(out, 0.5, 1.8)
  const during = meanDb(out, 2.15, 3.35)
  const after = meanDb(out, 3.7, 6.2)
  console.log('[audioRetime] hold levels dB', JSON.stringify({ before, during, after }))
  expect(before).toBeGreaterThan(-30)
  expect(after).toBeGreaterThan(-30)
  expect(Math.abs(after - before)).toBeLessThan(1)
  expect(during).toBeLessThan(-70)
  rmSync(dir, { recursive: true, force: true })
})

test('preview: the follower plays the mapped source second on a 2× clip and waits, silent, across a hold', async ({
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-retime-preview-'))
  const wav = join(dir, 'tone.wav')
  ff(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=8', '-ac', '1', '-c:a', 'pcm_s16le', wav])
  const mediaId = await importOne(page, wav)
  // Source 0.5..3 plays 1..2.25, silent 2.25..3.25 (held at source 3), then
  // 3..7.5 plays 3.25..5.5.
  const clip: AudioClip = {
    id: 'S',
    mediaId,
    startSec: 1,
    inSec: 0.5,
    outSec: 7.5,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    duck: false,
    kind: 'music',
    speed: 2,
    freezes: [{ atSec: 3, holdSec: 1 }]
  }
  await page.evaluate((c) => window.__reelStores.useProject.getState().addAudioClip(c), clip)
  const el = page.locator('[data-testid="audio-follower"][data-clip-id="S"]')
  await expect(el).toHaveCount(1, { timeout: 30_000 })
  expect(await el.evaluate((a: HTMLAudioElement) => [a.playbackRate, a.preservesPitch])).toEqual([2, true])

  for (const t of [1.5, 2, 2.5, 3, 4, 5]) {
    await page.evaluate((s) => {
      window.__reelStores.usePlayback.getState().setPlaying(false)
      window.__reelStores.usePlayback.getState().setTime(s)
    }, t)
    const want = audioSourceAt(clip, 7.5, t)
    await expect
      .poll(() => el.evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 15_000 })
      .toBeCloseTo(want, 2)
    const inHold = t >= 2.25 && t < 3.25
    const gain = await el.evaluate((a: HTMLAudioElement) => window.__reelStores.appliedGain(a))
    if (inHold) expect(gain).toBe(0)
    else expect(gain).toBeCloseTo(1, 3)
  }
  rmSync(dir, { recursive: true, force: true })
})
