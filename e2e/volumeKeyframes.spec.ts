/**
 * The volume line ("rubber band") on audio tiles, and audible fades in the
 * preview (shared/audioEnvelope.ts; docs/superpowers/plans/2026-11-14-volume-
 * keyframes.md; #138, #217).
 *
 *  - the preview's applied gain follows fades × line at several playhead times
 *    (the same `envelopeGainAt` the export's expression mirrors);
 *  - the exported file is quieter inside a dip by the line's amount;
 *  - on the tile: click the line to add a point, drag it (level and time, never
 *    past a neighbour), double-click / Delete remove it — one undo step each —
 *    while the tile body still moves the clip, and an unselected tile shows no
 *    line at all.
 *
 * ARRANGE via `window.__reelStores`, ACT via real pointer/keyboard events,
 * ASSERT on store + DOM + output audio. Every native dialog is cancelled by the
 * fixture except the export's Save dialog, which is stubbed to a temp file.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { AudioClip, VolumeKeyframe } from '../src/shared/project'
import { envelopeGainAt } from '../src/shared/audioEnvelope'
import { dbToFrac, fracToDb } from '../src/renderer/src/lib/volumeLine'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

/** A mono 48 kHz WAV of a 1 kHz tone (lavfi's 1/8 full scale). */
function tone(out: string, sec: number): void {
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=1000:sample_rate=48000:duration=${sec}`,
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    out
  ])
}

/** ffmpeg's integrated loudness (LUFS) of `[a, b)` of a file's audio. */
function measure(file: string, a: number, b: number): number {
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
      `atrim=${a}:${b},asetpts=N/SR/TB,ebur128=framelog=quiet`,
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  const m = /^\s+I:\s+(-?[\d.]+) LUFS/m.exec(run.stderr)
  if (run.status !== 0 || !m) throw new Error(`ebur128 failed: ${run.stderr.slice(-400)}`)
  return Number(m[1])
}

async function importOne(page: Page, path: string): Promise<string> {
  return page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, path)
}

const audioClip = (over: Partial<AudioClip> & Pick<AudioClip, 'id' | 'mediaId'>): AudioClip => ({
  startSec: 0,
  inSec: 0,
  outSec: 4,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  kind: 'music',
  ...over
})

const addClip = (page: Page, clip: AudioClip): Promise<void> =>
  page.evaluate((c) => window.__reelStores.useProject.getState().addAudioClip(c), clip)

const clipOf = (page: Page, id: string): Promise<AudioClip | undefined> =>
  page.evaluate((cid) => window.__reelStores.useProject.getState().project?.audioClips.find((a) => a.id === cid), id)

const lineOf = async (page: Page, id: string): Promise<VolumeKeyframe[]> =>
  (await clipOf(page, id))?.volumeKeyframes ?? []

const historyLen = (page: Page): Promise<number> =>
  page.evaluate(() => window.__reelStores.useProject.getState().past.length)

/** The linear gain actually in force on a clip's preview follower. */
async function previewGain(page: Page, id: string): Promise<number> {
  const el = page.locator(`[data-testid="audio-follower"][data-clip-id="${id}"]`)
  await expect(el).toHaveCount(1, { timeout: 30_000 })
  return el.evaluate((a: HTMLAudioElement) => window.__reelStores.appliedGain(a))
}

const setPlayhead = (page: Page, t: number): Promise<void> =>
  page.evaluate((s) => {
    window.__reelStores.usePlayback.getState().setPlaying(false)
    window.__reelStores.usePlayback.getState().setTime(s)
  }, t)

test('preview: the applied gain follows the fades and the volume line at the playhead, boosts included', async ({
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-vline-preview-'))
  const wav = join(dir, 'tone.wav')
  tone(wav, 8)
  const mediaId = await importOne(page, wav)
  const clip = audioClip({
    id: 'P',
    mediaId,
    startSec: 1,
    inSec: 1,
    outSec: 7,
    gainDb: -3,
    fadeInSec: 1,
    fadeOutSec: 1.5,
    volumeKeyframes: [
      { sourceSec: 3, db: 0 },
      { sourceSec: 3.5, db: -12 },
      { sourceSec: 4.5, db: -12 },
      { sourceSec: 5, db: 6 }
    ]
  })
  await addClip(page, clip)
  const base = Math.pow(10, -3 / 20)
  // Fade-in, the dip, the ramp, the +6 dB boost (above unity: the GainNode
  // route), the fade-out — each the shared envelope's own number.
  for (const t of [1.5, 2.5, 3.25, 4, 5, 5.3, 5.6, 6.2, 6.75]) {
    await setPlayhead(page, t)
    const want = base * envelopeGainAt(clip, 7, t)
    await expect.poll(() => previewGain(page, 'P'), { timeout: 15_000 }).toBeCloseTo(want, 3)
  }
  // Mid fade-in really is a fade (#217): half way, half the gain.
  await setPlayhead(page, 1.5)
  await expect.poll(() => previewGain(page, 'P')).toBeCloseTo(base * 0.5, 3)
  // The boost is realised (routed), not clamped at unity by element.volume.
  await setPlayhead(page, 5.3)
  await expect.poll(() => previewGain(page, 'P')).toBeGreaterThan(1)
  expect(
    await page
      .locator('[data-testid="audio-follower"][data-clip-id="P"]')
      .evaluate((a: HTMLAudioElement) => window.__reelStores.isRouted(a))
  ).toBe(true)
  rmSync(dir, { recursive: true, force: true })
})

test('export: the file is quieter inside a −12 dB dip by the line’s amount, and unchanged around it', async ({
  appPage: page,
  electronApp
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(180_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-vline-export-'))
  const bg = join(dir, 'black.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=1080x1920:r=30:d=8',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    bg
  ])
  const wav = join(dir, 'tone.wav')
  tone(wav, 8)
  const bgId = await importOne(page, bg)
  const toneId = await importOne(page, wav)
  await page.evaluate((id) => window.__reelStores.useProject.getState().addVideoLayer('BG', id, 0, 8, false), bgId)
  // Clip at timeline 1 s from source 0.5 s: the dip (source 2.5..4.5) plays
  // at timeline 3..5 s.
  await addClip(
    page,
    audioClip({
      id: 'E',
      mediaId: toneId,
      startSec: 1,
      inSec: 0.5,
      outSec: 7.5,
      volumeKeyframes: [
        { sourceSec: 2.4, db: 0 },
        { sourceSec: 2.5, db: -12 },
        { sourceSec: 4.5, db: -12 },
        { sourceSec: 4.6, db: 0 }
      ]
    })
  )
  const out = join(dir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: false })
  })
  expect(existsSync(out)).toBe(true)
  const before = measure(out, 1.3, 2.8)
  const during = measure(out, 3.3, 4.8)
  const after = measure(out, 5.3, 7.8)
  console.log('[volumeKeyframes] export LUFS', JSON.stringify({ before, during, after }))
  expect(Math.abs(before - during - 12)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(after - before)).toBeLessThanOrEqual(0.5)
  rmSync(dir, { recursive: true, force: true })
})

/** The selected tile's line (its SVG box) and a helper mapping (source s, dB) → page px. */
async function lineGeometry(
  page: Page,
  id: string
): Promise<{ x: (sourceSec: number) => number; y: (db: number) => number; h: number; pps: number }> {
  const svg = page.getByTestId(`volume-line-${id}`)
  await expect(svg).toHaveCount(1)
  const box = (await svg.boundingBox())!
  const clip = (await clipOf(page, id))!
  const pps = box.width / (clip.outSec - clip.inSec)
  return {
    x: (s) => box.x + (s - clip.inSec) * pps,
    y: (db) => box.y + dbToFrac(db) * box.height,
    h: box.height,
    pps
  }
}

test('tile: click the line to add a point, drag it, double-click / Delete remove it — one undo step each; the body still moves the clip', async ({
  appPage: page
}) => {
  await addClip(page, audioClip({ id: 'A', mediaId: 'no-media', startSec: 1, inSec: 0, outSec: 6 }))
  const tile = page.getByTestId('tile-audio-A')
  // The Audio lane can sit below the panel's visible height: bring it into view.
  await expect(tile).toBeVisible()
  await tile.scrollIntoViewIfNeeded()

  // Unselected: no line, and a press where the line would be still moves the clip.
  await expect(page.getByTestId('volume-line-A')).toHaveCount(0)
  let tb = (await tile.boundingBox())!
  await page.mouse.move(tb.x + 60, tb.y + 7)
  await page.mouse.down()
  await page.mouse.move(tb.x + 60 + 48, tb.y + 7, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await clipOf(page, 'A'))?.startSec).toBeGreaterThan(1.5)
  await page.evaluate(() => window.__reelStores.useProject.getState().undo())
  await expect.poll(async () => (await clipOf(page, 'A'))?.startSec).toBe(1)
  expect(await lineOf(page, 'A')).toEqual([])
  await expect(page.getByTestId('volume-line-A')).toHaveCount(1) // the press selected it

  // Click the flat line at source 1 s: one point, ON the line (0 dB), one undo step.
  let g = await lineGeometry(page, 'A')
  let h0 = await historyLen(page)
  await page.mouse.click(g.x(1), g.y(0))
  await expect.poll(() => lineOf(page, 'A')).toHaveLength(1)
  let line = await lineOf(page, 'A')
  expect(line[0].sourceSec).toBeCloseTo(1, 1)
  expect(line[0].db).toBe(0)
  expect(await historyLen(page)).toBe(h0 + 1)
  // Two more, at 3 s and 5 s.
  await page.mouse.click(g.x(3), g.y(0))
  await page.mouse.click(g.x(5), g.y(0))
  await expect.poll(() => lineOf(page, 'A')).toHaveLength(3)
  await expect(page.getByTestId('volume-point-A-1')).toBeVisible()

  // Drag the middle point down 8 px: its level drops by the tile's scale; one undo step.
  g = await lineGeometry(page, 'A')
  line = await lineOf(page, 'A')
  h0 = await historyLen(page)
  const px = g.x(line[1].sourceSec)
  await page.mouse.move(px, g.y(0))
  await page.mouse.down()
  await page.mouse.move(px, g.y(0) + 8, { steps: 6 })
  await page.mouse.up()
  const wantDb = Math.round(fracToDb(dbToFrac(0) + 8 / g.h) * 10) / 10
  await expect.poll(async () => (await lineOf(page, 'A'))[1].db).toBeCloseTo(wantDb, 0)
  expect((await lineOf(page, 'A'))[1].db).toBeLessThan(-3)
  expect((await lineOf(page, 'A'))[1].sourceSec).toBeCloseTo(line[1].sourceSec, 2) // straight down: time kept
  expect(await historyLen(page)).toBe(h0 + 1)
  expect((await clipOf(page, 'A'))?.startSec).toBe(1) // the clip didn't move
  // Ctrl+Z takes the whole drag back in one go.
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await lineOf(page, 'A'))[1].db).toBe(0)
  await page.keyboard.press('Control+y')
  await expect.poll(async () => (await lineOf(page, 'A'))[1].db).toBeLessThan(-3)

  // Sideways: never past its neighbour (stops 10 ms short of the point at 5 s).
  g = await lineGeometry(page, 'A')
  line = await lineOf(page, 'A')
  const mx = g.x(line[1].sourceSec)
  const my = g.y(line[1].db)
  await page.mouse.move(mx, my)
  await page.mouse.down()
  await page.mouse.move(mx + 6 * g.pps, my, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await lineOf(page, 'A'))[1].sourceSec).toBeCloseTo(line[2].sourceSec - 0.01, 3)
  expect(await lineOf(page, 'A')).toHaveLength(3)

  // Double-click the first point: it goes, the rest stay.
  g = await lineGeometry(page, 'A')
  line = await lineOf(page, 'A')
  await page.mouse.dblclick(g.x(line[0].sourceSec), g.y(line[0].db))
  await expect.poll(() => lineOf(page, 'A')).toHaveLength(2)

  // Click a point and press Delete: only that point goes — never the clip.
  g = await lineGeometry(page, 'A')
  line = await lineOf(page, 'A')
  h0 = await historyLen(page)
  await page.mouse.click(g.x(line[1].sourceSec), g.y(line[1].db))
  await expect(page.getByTestId('volume-point-A-1')).toHaveAttribute('data-picked', 'true')
  expect(await historyLen(page)).toBe(h0) // a click on a point changes nothing
  await page.keyboard.press('Delete')
  await expect.poll(() => lineOf(page, 'A')).toHaveLength(1)
  expect(await clipOf(page, 'A')).toBeDefined()
  expect(await historyLen(page)).toBe(h0 + 1)

  // The Inspector lists the point; its exact level field edits it; Clear flattens.
  await expect(page.getByTestId('volume-line-section')).toContainText('1 point')
  const dbField = page.getByLabel('Point 1 level')
  await dbField.fill('-9')
  await dbField.press('Enter')
  await expect.poll(async () => (await lineOf(page, 'A'))[0].db).toBe(-9)
  await page.getByTestId('volume-line-clear').click()
  await expect.poll(async () => (await clipOf(page, 'A'))?.volumeKeyframes).toBeUndefined()

  // The selected tile's body (below the line) still moves the clip, and the
  // line rides along in source time.
  await page.evaluate(() =>
    window.__reelStores.useProject.getState().setVolumeKeyframes('A', [
      { sourceSec: 2, db: 0 },
      { sourceSec: 4, db: -12 }
    ])
  )
  await tile.scrollIntoViewIfNeeded()
  tb = (await tile.boundingBox())!
  await page.mouse.move(tb.x + 30, tb.y + tb.height - 3)
  await page.mouse.down()
  await page.mouse.move(tb.x + 30 + 96, tb.y + tb.height - 3, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await clipOf(page, 'A'))?.startSec).toBeGreaterThan(2.5)
  expect(await lineOf(page, 'A')).toEqual([
    { sourceSec: 2, db: 0 },
    { sourceSec: 4, db: -12 }
  ])
})
