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
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'
import { PATCHES, exportedPatches, frameAt, makePatchClip, previewPatches } from './colorPatches'

/** Max per-channel difference (0–255) between preview and export, any patch. */
const TOLERANCE = 12

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
  // Exposure above 1 with contrast below 1: the one combination where the clamp
  // BETWEEN the two steps changes the picture (bright patches clip, then compress).
  { name: 'exposure up, contrast down', color: { brightness: 0.4, contrast: 0.6, saturation: 1.5 } },
  {
    name: 'the grade plus a tint',
    color: { brightness: 0.15, contrast: 1.3, saturation: 1.4 },
    tint: { color: '#ffd999', amount: 0.5 }
  }
]

test('a graded clip exports with the colours the preview shows (exposure, contrast, saturation, tint)', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(300_000)

  // The patches are drawn in RGB and converted to YUV with the BT.709 matrix and tagged as such, like phone footage.
  const clip = join(projectsDir, 'E2E', 'patches.mp4')
  makePatchClip(clip)

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
