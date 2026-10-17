/**
 * Output formats (aspect ratios). The bug this pins: picking Square in the
 * Format menu left the preview 9:16 (and the export squashed the frame). A
 * format is a window centred on the canonical 1080×1920 space, so switching
 * must reshape the PREVIEW and the EXPORT while moving NO layer data; a clip
 * whose aspect differs from the frame must stay movable and resizable (its
 * off-frame handles pin to the frame edge), and the export crops what lies
 * outside. ARRANGE via store, ACT via the real Format select / pointer drags /
 * Export button, ASSERT on store + DOM + the real ffmpeg output.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { FFMPEG, FFPROBE } from './bin'

const layersJson = (page: Page): Promise<string> =>
  page.evaluate(() => JSON.stringify(window.__reelStores.useProject.getState().project!.layers))

/** The preview frame's on-screen aspect (w/h). */
async function frameAspect(page: Page): Promise<number> {
  const b = (await page.getByTestId('preview-frame').boundingBox())!
  return b.width / b.height
}

async function pickFormat(page: Page, id: string): Promise<void> {
  const select = page.getByTestId('format-select')
  if (!(await select.isVisible())) await page.getByRole('button', { name: 'Format ▾' }).click()
  await select.selectOption(id)
}

test('switching the format reshapes the preview and moves no layer', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject } = window.__reelStores
    useProject.getState().addVideoLayer('V', 'no-such-media', 0, 5, false)
    useProject.getState().updateLayer('V', { x: 700, y: 300, scale: 1.3 })
    useProject.getState().addLayer({
      id: 'T',
      hidden: false,
      startSec: 0,
      endSec: 3,
      x: 540,
      y: 1700,
      scale: 1,
      content: {
        kind: 'text',
        text: 'Hook',
        fontFamily: 'inter',
        fontSizePx: 76,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000', padPx: 0 }
      }
    })
  })
  const before = await layersJson(page)

  // Reel: 9:16 with the Instagram safe-zone guides.
  expect(Math.abs((await frameAspect(page)) - 9 / 16)).toBeLessThan(0.02)
  await expect(page.getByTestId('safe-zone')).toHaveCount(2)

  await pickFormat(page, 'landscape')
  await expect(page.getByTestId('preview-stage')).toHaveAttribute('data-format', 'landscape')
  await expect.poll(async () => Math.abs((await frameAspect(page)) - 16 / 9)).toBeLessThan(0.02)
  await expect(page.getByTestId('safe-zone')).toHaveCount(0) // no platform UI on 16:9
  await expect(page.getByTestId('preview-frame')).toContainText('16:9 · 1920 × 1080')
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.preset)).toBe('landscape')
  expect(await layersJson(page)).toBe(before)

  // The originally reported case.
  await pickFormat(page, 'square')
  await expect.poll(async () => Math.abs((await frameAspect(page)) - 1)).toBeLessThan(0.02)
  expect(await layersJson(page)).toBe(before)

  // And back: nothing was lost on the way.
  await pickFormat(page, 'reel')
  await expect.poll(async () => Math.abs((await frameAspect(page)) - 9 / 16)).toBeLessThan(0.02)
  await expect(page.getByTestId('safe-zone')).toHaveCount(2)
  expect(await layersJson(page)).toBe(before)
})

test('a clip overflowing a 16:9 frame stays movable and corner-resizable', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().setPreset('landscape')
    // Missing media previews as a square box: at 1.5× it is 1620 logical px
    // tall, well past the 1080-tall frame at both top and bottom.
    useProject.getState().addVideoLayer('V', 'no-such-media', 0, 5, false)
    useProject.getState().updateLayer('V', { scale: 1.5 })
    useUi.getState().selectLayer('V')
  })
  const layer = (): Promise<{ x: number; y: number; scale: number }> =>
    page.evaluate(() => {
      const l = window.__reelStores.useProject.getState().project!.layers[0]
      return { x: l.x, y: l.y, scale: l.scale }
    })

  // Corners + top/bottom sit outside the frame → pinned to its edge; the
  // side handles are inside and stay put. Every handle is on the frame.
  const stage = (await page.getByTestId('preview-stage').boundingBox())!
  for (const h of ['nw', 'n', 'ne', 'se', 's', 'sw']) {
    await expect(page.locator(`[data-handle="${h}"]`)).toHaveAttribute('data-pinned', '')
  }
  for (const h of ['e', 'w']) {
    await expect(page.locator(`[data-handle="${h}"]`)).not.toHaveAttribute('data-pinned', '')
  }
  for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const b = (await page.locator(`[data-handle="${h}"]`).boundingBox())!
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    expect(cx).toBeGreaterThanOrEqual(stage.x - 1)
    expect(cx).toBeLessThanOrEqual(stage.x + stage.width + 1)
    expect(cy).toBeGreaterThanOrEqual(stage.y - 1)
    expect(cy).toBeLessThanOrEqual(stage.y + stage.height + 1)
  }

  // Drag the (pinned) SE corner toward the center: a uniform shrink.
  const se = (await page.locator('[data-handle="se"]').boundingBox())!
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2)
  await page.mouse.down()
  await page.mouse.move(se.x + se.width / 2 - 60, se.y + se.height / 2 - 60, { steps: 6 })
  await page.mouse.up()
  const resized = await layer()
  expect(resized.scale).toBeLessThan(1.5)
  expect(resized.scale).toBeGreaterThan(0.8)

  // Drag the clip body right: x moves by the client delta in LOGICAL px
  // (the canonical canvas is 1080 logical px wide on screen).
  const canvas = (await page.getByTestId('preview-canvas').boundingBox())!
  const perClient = 1080 / canvas.width
  const fx = stage.x + stage.width / 2
  const fy = stage.y + stage.height / 2
  await page.mouse.move(fx, fy)
  await page.mouse.down()
  await page.mouse.move(fx + 80, fy, { steps: 6 })
  await page.mouse.up()
  const moved = await layer()
  expect(moved.x - resized.x).toBeCloseTo(80 * perClient, 0)
  expect(moved.y).toBeCloseTo(resized.y, 5)
})

test('cropping to the project aspect fills a 16:9 frame; removing it fits again', async ({ appPage: page }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  const src = bandedClip()
  await page.evaluate(async (p) => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().setPreset('landscape')
    const [asset] = await window.api.importPaths([p])
    useProject.getState().addMedia([asset.id])
    // A phone clip dropped into a 16:9 project lands fitted: pillarboxed.
    useProject.getState().addVideoLayer('V', asset.id, 0, 2, false, 9 / 16)
    useUi.getState().selectLayer('V')
  }, src)
  const scale = (): Promise<number> =>
    page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0].scale)
  expect(await scale()).toBeCloseTo(0.5625, 6)

  // The Inspector offers the PROJECT's aspect, and the editor crops to it.
  await page.getByRole('button', { name: 'Crop to 16:9' }).click()
  await expect(page.getByText('Crop to 16:9 — drag to move, drag the corner to resize')).toBeVisible()
  await page.getByRole('button', { name: 'Save crop' }).click()
  const crop = await page.evaluate(() => {
    const c = window.__reelStores.useProject.getState().project!.layers[0].content
    return c.kind === 'video' ? c.crop : null
  })
  expect(crop!.w / crop!.h).toBeCloseTo(16 / 9, 1)
  // Same frame-relative zoom (100%) → the 16:9 crop fills the 16:9 frame.
  expect(await scale()).toBeCloseTo(1920 / 1080, 2)
  await expect(page.getByText('Zoom · 100%')).toBeVisible()

  // Removing the crop keeps that zoom too: back to the pillarboxed fit.
  await page.getByRole('button', { name: 'Remove crop' }).click()
  expect(await scale()).toBeCloseTo(0.5625, 2)
})

/**
 * Synthesize a 9:16 clip of four horizontal bands — red, lime, blue, yellow —
 * each a quarter of its height (480 logical rows at scale 1). A centred
 * 1080-row window then shows 60 rows red, 480 lime, 480 blue, 60 yellow; the
 * old squash (y × 0.5625) showed four EQUAL bands, so sampling at rows 200 and
 * 900 tells a crop from a squash.
 */
function bandedClip(): string {
  const mp4 = join(mkdtempSync(join(tmpdir(), 'reel-aspect-')), 'bands.mp4')
  const band = (c: string): string[] => ['-f', 'lavfi', '-i', `color=c=${c}:s=270x120:r=30:d=2`]
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...band('red'),
    ...band('lime'),
    ...band('blue'),
    ...band('yellow'),
    '-filter_complex',
    '[0:v][1:v][2:v][3:v]vstack=inputs=4',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    mp4
  ])
  return mp4
}

/** One RGB frame of `file` at t=1s. */
function grabFrame(file: string, w: number, h: number): (x: number, y: number) => Rgb {
  const buf = execFileSync(
    FFMPEG,
    ['-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: w * h * 3 + 1024 }
  )
  return (x, y) => {
    const i = (y * w + x) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
}

type Rgb = [number, number, number]
const COLORS: Record<string, (p: Rgb) => boolean> = {
  red: ([r, g, b]) => r > 180 && g < 80 && b < 80,
  lime: ([r, g, b]) => g > 180 && r < 80 && b < 80,
  blue: ([r, g, b]) => b > 180 && r < 80 && g < 80,
  yellow: ([r, g, b]) => r > 180 && g > 180 && b < 80,
  black: ([r, g, b]) => r < 40 && g < 40 && b < 40
}

for (const c of [
  // A 9:16 clip filling the Reel, then the project switched to 16:9: the clip
  // keeps its size, so the frame shows its middle 1080 rows, pillarboxed.
  {
    preset: 'landscape',
    w: 1920,
    h: 1080,
    samples: [
      [960, 30, 'red'],
      [960, 200, 'lime'],
      [960, 900, 'blue'],
      [960, 1060, 'yellow'],
      [100, 540, 'black'],
      [1820, 540, 'black']
    ]
  },
  // …and to 1:1: the frame shows its middle 1080 rows, edge to edge.
  {
    preset: 'square',
    w: 1080,
    h: 1080,
    samples: [
      [540, 30, 'red'],
      [540, 200, 'lime'],
      [540, 900, 'blue'],
      [540, 1060, 'yellow']
    ]
  }
] as const) {
  test(`export in ${c.preset} crops a 9:16 clip to the centred frame`, async ({ appPage: page, electronApp }) => {
    test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
    test.setTimeout(120_000)

    const src = bandedClip()
    await page.evaluate(async (p) => {
      const { useProject } = window.__reelStores
      const [asset] = await window.api.importPaths([p])
      useProject.getState().addMedia([asset.id])
      // Added in the Reel, fitted to it (a 9:16 clip fills 9:16 at scale 1).
      useProject.getState().addVideoLayer('V', asset.id, 0, 2, false, 9 / 16)
    }, src)
    expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0].scale)).toBe(1)

    await pickFormat(page, c.preset)

    const out = join(mkdtempSync(join(tmpdir(), 'reel-aspect-out-')), `${c.preset}.mp4`)
    await electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
    }, out)
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(page.getByRole('button', { name: '✓ Reveal export' })).toBeVisible({ timeout: 90_000 })
    expect(statSync(out).size).toBeGreaterThan(0)

    const dims = execFileSync(FFPROBE, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      out
    ])
      .toString()
      .trim()
    expect(dims).toBe(`${c.w},${c.h}`)

    const px = grabFrame(out, c.w, c.h)
    for (const [x, y, color] of c.samples) {
      expect({ x, y, color, rgb: px(x, y), ok: COLORS[color](px(x, y)) }).toMatchObject({ ok: true })
    }
  })
}
