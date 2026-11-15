/**
 * A clip's colour grade EXPORTS the way the preview draws it (#216). The
 * Inspector's Exposure / Contrast / Saturation sliders and the tint were once
 * drawn with different maths: the preview's CSS `brightness() contrast()
 * saturate()` multiplies exposure, the export's ffmpeg `eq` ADDED it (grey 64 at
 * +0.2 read 76 in the preview and 122 in the export). The export now rebuilds
 * the CSS chain from `shared/grade.ts` (`lutrgb` + `colorchannelmixer`).
 *
 * Method: one synthetic clip of 8 flat colour patches (greys and saturated
 * colours). For each grade: read the PREVIEW's patches from a real screenshot
 * of the preview canvas, export with the real ffmpeg, decode a frame of the
 * output, and compare patch by patch at the same positions. TOLERANCE below is
 * what the two may differ by: the remaining gap is the 8-bit YUV round trip and
 * Chromium's vs ffmpeg's YUV decode (an UNGRADED clip is checked first so that
 * baseline is visible) — the old `eq` chain missed by 20–60 levels.
 *
 * ARRANGE via store, ACT via the real export IPC (native Save dialog stubbed),
 * ASSERT on pixels. Skipped without the bundled ffmpeg.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

/** Patch colours, row-major in a 2 × 4 grid. */
const PATCHES: [number, number, number][] = [
  [64, 64, 64],
  [128, 128, 128],
  [192, 192, 192],
  [192, 64, 32],
  [64, 128, 192],
  [200, 30, 30],
  [30, 200, 90],
  [250, 240, 10]
]
const COLS = 2
const ROWS = 4
/** Max per-channel difference (0–255) between preview and export, any patch. */
const TOLERANCE = 12

const W = 1080
const H = 1920

/** The centre of patch `i` as a fraction of the frame. */
const patchCentre = (i: number): { fx: number; fy: number } => ({
  fx: ((i % COLS) + 0.5) / COLS,
  fy: (Math.floor(i / COLS) + 0.5) / ROWS
})

type Grade = { brightness: number; contrast: number; saturation: number }
const CASES: { name: string; color?: Grade; tint?: { color: string; amount: number } }[] = [
  { name: 'ungraded (the YUV baseline)' },
  { name: 'exposure +0.2', color: { brightness: 0.2, contrast: 1, saturation: 1 } },
  { name: 'exposure -0.3', color: { brightness: -0.3, contrast: 1, saturation: 1 } },
  { name: 'contrast 1.5', color: { brightness: 0, contrast: 1.5, saturation: 1 } },
  { name: 'contrast 0.6', color: { brightness: 0, contrast: 0.6, saturation: 1 } },
  { name: 'saturation 1.4', color: { brightness: 0, contrast: 1, saturation: 1.4 } },
  { name: 'saturation 0.4', color: { brightness: 0, contrast: 1, saturation: 0.4 } },
  { name: 'exposure, contrast and saturation together', color: { brightness: 0.15, contrast: 1.3, saturation: 1.4 } },
  {
    name: 'the grade plus a tint',
    color: { brightness: 0.15, contrast: 1.3, saturation: 1.4 },
    tint: { color: '#ffd999', amount: 0.5 }
  }
]

/** A frame of `file` at `t` as a per-pixel RGB reader (ffmpeg's own decode). */
function frameAt(file: string, t: number): (x: number, y: number) => number[] {
  const buf = execFileSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: W * H * 3 + 1024 }
  )
  return (x, y) => {
    const i = (y * W + x) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
}

/** The mean RGB of the 4×4 block around patch `i` in the exported frame. */
const exportedPatches = (px: (x: number, y: number) => number[]): number[][] =>
  PATCHES.map((_, i) => {
    const { fx, fy } = patchCentre(i)
    const sum = [0, 0, 0]
    for (let dy = -2; dy < 2; dy++)
      for (let dx = -2; dx < 2; dx++) {
        const p = px(Math.round(fx * W) + dx, Math.round(fy * H) + dy)
        for (let c = 0; c < 3; c++) sum[c] += p[c]
      }
    return sum.map((v) => Math.round(v / 16))
  })

/** The preview canvas's patches, read from a real screenshot (mean of a 4×4 block). */
async function previewPatches(page: Page, electronApp: import('@playwright/test').ElectronApplication) {
  const box = (await page.getByTestId('preview-canvas').boundingBox())!
  const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } })
  return electronApp.evaluate(
    ({ nativeImage }, { b64, fracs }) => {
      const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
      const { width, height } = img.getSize()
      const bgra = img.toBitmap()
      return fracs.map(({ fx, fy }) => {
        const sum = [0, 0, 0]
        for (let dy = -2; dy < 2; dy++)
          for (let dx = -2; dx < 2; dx++) {
            const i = ((Math.round(fy * height) + dy) * width + Math.round(fx * width) + dx) * 4
            sum[0] += bgra[i + 2]
            sum[1] += bgra[i + 1]
            sum[2] += bgra[i]
          }
        return sum.map((v) => Math.round(v / 16))
      })
    },
    { b64: png.toString('base64'), fracs: PATCHES.map((_, i) => patchCentre(i)) }
  )
}

test('a graded clip exports with the colours the preview shows (exposure, contrast, saturation, tint)', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(300_000)

  // The patches are drawn in RGB and converted to YUV with the BT.709 matrix and tagged as such, like phone footage.
  const clip = join(projectsDir, 'E2E', 'patches.mp4')
  let vf = 'color=c=black:s=540x960:r=30:d=2,format=rgb24'
  PATCHES.forEach(([r, g, b], i) => {
    const hex = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
    vf += `,drawbox=x=${(i % COLS) * 270}:y=${Math.floor(i / COLS) * 240}:w=270:h=240:color=0x${hex}:t=fill`
  })
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `${vf},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '0',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    clip
  ])

  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, clip)
  // The preview plays the proxy; wait for it so the screenshot shows the video.
  await expect
    .poll(async () => page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0]?.proxyReady, id), {
      timeout: 30_000
    })
    .toBe(true)
  await page.evaluate((id) => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('V', id, 0, 2, false, 540 / 960)
    usePlayback.getState().setTime(1)
  }, id)

  // The platform safe-zone guides tint the frame edges; they are not part of the picture.
  await page.addStyleTag({ content: '[data-testid="safe-zone"] { display: none !important }' })

  // The video has painted once the mid-grey patch is near grey 128.
  await expect
    .poll(async () => (await previewPatches(page, electronApp))[1][0], { timeout: 15_000 })
    .toBeGreaterThan(110)

  const dir = mkdtempSync(join(tmpdir(), 'reel-colorparity-'))
  const report: string[] = []
  for (const [n, c] of CASES.entries()) {
    await page.evaluate(
      (c) => window.__reelStores.useProject.getState().updateLayerContent('V', { color: c.color, tint: c.tint }),
      c
    )
    // Two animation frames: the CSS filter has been applied and painted.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const preview = await previewPatches(page, electronApp)

    const out = join(dir, `case${n}.mp4`)
    await electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
    }, out)
    await page.evaluate(async () => {
      const p = window.__reelStores.useProject.getState().project!
      await window.api.exportProject(p, { preset: p.preset, preferNvenc: false })
    })
    const exported = exportedPatches(frameAt(out, 1))

    let worst = 0
    PATCHES.forEach((_, i) => {
      for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(preview[i][ch] - exported[i][ch]))
    })
    report.push(`${c.name}: worst ${worst}`)
    expect
      .soft(worst, `${c.name}: preview ${JSON.stringify(preview)} vs export ${JSON.stringify(exported)}`)
      .toBeLessThanOrEqual(TOLERANCE)
  }
  console.log(
    `[colorParity] max preview/export difference per case (tolerance ${TOLERANCE}):\n  ${report.join('\n  ')}`
  )
})
