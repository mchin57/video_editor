/**
 * Rotation reaches the EXPORT the way the preview draws it (layer rotation,
 * `shared/rotation.ts`). Pixels of a real ffmpeg export, three checks:
 *
 *  1. Rotated TEXT: libass burn (plain, t 0–1) vs Chromium raster of the same
 *     block (a white→white "gradient", t 1–2 — the preview's own CSS, rotated)
 *     cover the same ink box.
 *  2. Rotated MEDIA: a 400×200 red clip at +30° lands CLOCKWISE about its
 *     centre, and the corners of its rotated bounds stay transparent.
 *  3. A rotated SLIDE travels along the text's OWN axis (the preview's choice;
 *     the burn's `\move` about a fixed `\org` does the same), not screen-down.
 *
 * ARRANGE via store, ACT via the real export IPC (Save dialog stubbed), ASSERT
 * on output pixels. Skipped without the bundled ffmpeg, like textParity.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const W = 1080
const H = 1920

function frameAt(file: string, t: number): (x: number, y: number) => number[] {
  const buf = execFileSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    {
      maxBuffer: W * H * 3 + 1024
    }
  )
  return (x, y) => {
    const i = (Math.round(y) * W + Math.round(x)) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
}

/** Bounding box + centroid of "ink" (bright grey-ish pixels) within a y band. */
function ink(px: (x: number, y: number) => number[], y0: number, y1: number, min = 100) {
  let x0 = W,
    x1 = -1,
    top = H,
    bot = -1,
    sx = 0,
    sy = 0,
    n = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y)
      if (r > min && g > min && b > min) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        top = Math.min(top, y)
        bot = Math.max(bot, y)
        sx += x
        sy += y
        n++
      }
    }
  }
  return { x0, x1, y0: top, y1: bot, cx: sx / n, cy: sy / n, n }
}

test('rotated text, media and slides export the way the preview draws them', async ({ appPage: page, electronApp }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(180_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-rotexport-'))
  const bg = join(dir, 'black.mp4')
  const red = join(dir, 'red.mp4')
  const enc = ['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast']
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=4', ...enc, bg])
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=400x200:r=30:d=4', ...enc, red])

  await page.evaluate(
    async ({ bg, red }) => {
      const { useProject } = window.__reelStores
      const [bgA, redA] = await window.api.importPaths([bg, red])
      const s = useProject.getState()
      s.addMedia([bgA.id, redA.id])
      s.addVideoLayer('BG', bgA.id, 0, 4, false)
      const text = (id: string, t0: number, t1: number, over: Record<string, unknown> = {}) => ({
        id,
        hidden: false,
        startSec: t0,
        endSec: t1,
        x: 540,
        y: 500,
        scale: 1,
        rotationDeg: 30,
        content: {
          kind: 'text' as const,
          text: 'ROTATED TEXT',
          fontFamily: 'inter',
          fontSizePx: 90,
          color: '#ffffff',
          pill: { enabled: false, color: '#000000cc', padPx: 18 },
          ...over
        }
      })
      s.addLayer(text('T0', 0, 1))
      s.addLayer(text('T1', 1, 2, { gradient: { from: '#ffffff', to: '#ffffff', angle: 90 } }))
      s.addLayer(text('S', 2, 4, { text: 'SLIDE', animation: { in: 'slideUp', inSec: 1, out: 'none', outSec: 0.3 } }))
      // 2:1 clip at scale 400/1080 → a 400×200 box.
      s.addLayer({
        id: 'R',
        hidden: false,
        startSec: 0,
        endSec: 4,
        x: 540,
        y: 1400,
        scale: 400 / 1080,
        rotationDeg: 30,
        content: { kind: 'video', mediaId: redA.id, inSec: 0, outSec: 4, mute: true, gainDb: 0 }
      })
    },
    { bg, red }
  )

  const out = join(dir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })

  // 1. libass vs Chromium raster of the same rotated block: same ink box.
  const burned = ink(frameAt(out, 0.5), 250, 750)
  const raster = ink(frameAt(out, 1.5), 250, 750)
  expect(burned.n).toBeGreaterThan(500)
  // Same place: the ink centroids agree closely. The extremes are single glyph
  // tips, where libass and Chromium anti-alias a few px differently (measured
  // 3–6px on a 650px tilted line, the same ±0.5% the upright parity allows).
  expect(Math.abs(burned.cx - raster.cx), 'ink centroid x').toBeLessThanOrEqual(3)
  expect(Math.abs(burned.cy - raster.cy), 'ink centroid y').toBeLessThanOrEqual(3)
  for (const k of ['x0', 'x1', 'y0', 'y1'] as const) {
    expect(Math.abs(burned[k] - raster[k]), `ink ${k}`).toBeLessThanOrEqual(8)
  }
  // …and it is actually tilted (a 30° line of text is much taller than 90px).
  expect(burned.y1 - burned.y0).toBeGreaterThan(200)

  // 2. Red clip at +30°: its +x axis end lands at (+cos, +sin) — clockwise.
  const f = frameAt(out, 0.5)
  const isRed = (p: number[]): boolean => p[0] > 150 && p[1] < 80 && p[2] < 80
  const c30 = Math.cos(Math.PI / 6)
  expect(isRed(f(540 + 180 * c30, 1400 + 180 * 0.5)), 'clockwise end').toBe(true)
  expect(isRed(f(540 + 180 * c30, 1400 - 180 * 0.5)), 'counter-clockwise spot').toBe(false)
  const rw = 400 * c30 + 200 * 0.5
  const rh = 400 * 0.5 + 200 * c30
  const corner = f(540 - rw / 2 + 4, 1400 - rh / 2 + 4)
  expect(corner[0], 'rotated-bounds corner is transparent (base shows)').toBeLessThan(40)

  // 3. Mid-slide (inFrac 0.5 → 45 logical px still to travel) vs at rest: the
  //    offset runs along the text's own axis, rotateVec(0, 45, 30°).
  const mid = ink(frameAt(out, 2.5), 250, 750, 60)
  const rest = ink(frameAt(out, 3.5), 250, 750, 60)
  expect(mid.cx - rest.cx).toBeGreaterThan(-45 * 0.5 - 5)
  expect(mid.cx - rest.cx).toBeLessThan(-45 * 0.5 + 5)
  expect(mid.cy - rest.cy).toBeGreaterThan(45 * c30 - 5)
  expect(mid.cy - rest.cy).toBeLessThan(45 * c30 + 5)
})
