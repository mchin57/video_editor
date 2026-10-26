/**
 * A workout overlay reaches the EXPORT where the preview draws it, at the
 * moment of the recording the tile maps each frame to: pixels of a real ffmpeg
 * export (the widgets rasterised frame by frame by the export's Chromium,
 * encoded to an alpha intermediate, composited over the clip).
 *
 *  - The ride heads due north for 599 s, so its route is a vertical line and
 *    the live map's dot climbs it at a constant rate. The map is 600 px wide
 *    centred on (540, 900): the route runs y 1200 (start) → 600 (end) at x 540.
 *  - The tile plays the whole ride at 100×: timeline 1 s is ride 100 s (dot at
 *    y ≈ 1100), timeline 4 s is ride 400 s (dot at y ≈ 799).
 *  - The preview's own dot path at timeline 1 s is at that same point.
 *
 * Skipped without the bundled ffmpeg, like the other export pixel specs.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'
import { buildFitFile } from '../src/main/services/__fixtures__/fitFile'

const W = 1080
const H = 1920

function frameAt(file: string, t: number): (x: number, y: number) => number[] {
  const buf = execFileSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: W * H * 3 + 1024 }
  )
  return (x, y) => {
    const i = (Math.round(y) * W + Math.round(x)) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
}

/** Where the dot is at ride second `r` (the route: y 1200 → 600 over 599 s). */
const dotY = (r: number): number => 600 + 600 * (1 - r / 599)

test('the live map dot is exported where the preview draws it, at the mapped moment', async ({
  appPage: page,
  electronApp,
  scratchDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  const fit = join(scratchDir, 'North.fit')
  writeFileSync(
    fit,
    buildFitFile({
      samples: Array.from({ length: 600 }, (_, i) => ({ sec: i, lat: 43.8 + i * 0.0001, lon: -91.3, powerW: 200 }))
    })
  )
  const bg = join(scratchDir, 'bg.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${W}x${H}:r=30:d=6`,
    '-pix_fmt',
    'yuv420p',
    bg
  ])
  const [bgId, fitId] = await page.evaluate(
    async (paths) => {
      const assets = await window.api.importPaths(paths)
      window.__reelStores.useProject.getState().addMedia(assets.map((a) => a.id))
      return assets.map((a) => a.id)
    },
    [bg, fit]
  )
  await expect
    .poll(async () => page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0]?.proxyReady, bgId), {
      timeout: 60_000
    })
    .toBe(true)

  await page.evaluate(
    ([bgId, fitId]) => {
      const { useProject, usePlayback } = window.__reelStores
      useProject.getState().addVideoLayer('BG', bgId, 0, 6, false)
      useProject.getState().addWorkoutLayer({
        id: 'W',
        hidden: false,
        startSec: 0,
        endSec: 5.99,
        x: 540,
        y: 960,
        scale: 1,
        content: {
          kind: 'workout',
          mediaId: fitId,
          inSec: 0,
          outSec: 599,
          speed: 100,
          widgets: [{ id: 'm', metric: 'liveMap', x: 540, y: 900, sizePx: 600, color: '#FFFFFF' }]
        }
      })
      usePlayback.getState().setTime(1)
    },
    [bgId, fitId]
  )

  // The preview's dot at timeline 1 s (ride 100 s): a path starting r left of centre.
  const dot = page.getByTestId('workout-layer').locator('path[fill="#FFD60A"]')
  const d = (await dot.getAttribute('d'))!
  const [, x0, y0] = /^M([\d.]+) ([\d.]+)/.exec(d)!.map(Number)
  const r = 600 / 28
  expect(x0 + r).toBeCloseTo(540, 1)
  expect(y0).toBeCloseTo(dotY(100), 1)

  const out = join(scratchDir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })

  const yellow = (p: number[]): boolean => p[0] > 200 && p[1] > 160 && p[2] < 90
  const white = (p: number[]): boolean => p[0] > 200 && p[1] > 200 && p[2] > 200
  const t1 = frameAt(out, 1)
  expect(yellow(t1(540, dotY(100))), 'dot at ride 100 s').toBe(true)
  expect(yellow(t1(540, dotY(400))), 'not yet at ride 400 s').toBe(false)
  expect(white(t1(540, 700)), 'the route').toBe(true)
  const t4 = frameAt(out, 4)
  expect(yellow(t4(540, dotY(400))), 'dot at ride 400 s').toBe(true)
  expect(yellow(t4(540, dotY(100))), 'moved on').toBe(false)
  // Nothing drawn off the map.
  expect(t1(200, 300)[0], 'nothing else drawn').toBeLessThan(30)
})
