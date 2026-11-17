/**
 * The colour TABLE (#105, #55): a look that uses a newer control (temperature,
 * green / magenta, vibrance) or a `.cube` LUT is baked into one 3D table that
 * the preview draws with WebGL over the clip and the export applies with
 * ffmpeg `lut3d` (shared/grade.ts, FFMPEG-NOTES "Colour table").
 *
 * - Parity: for each new control, a LUT at two strengths and a graded image,
 *   the preview's patches (a REAL screenshot) match the exported frame's.
 * - Placement: the canvas draws exactly where the plain element would — a
 *   cropped, flipped, rotated clip and a background-removed one look the same
 *   graded with a near-neutral look as ungraded.
 * - The fallback: a lost WebGL context shows the clip ungraded with a notice.
 *
 * ARRANGE via the store, ACT via the real export IPC (Save dialog stubbed),
 * ASSERT on pixels. Skipped without the bundled ffmpeg.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'
import {
  PATCHES,
  exportedPatches,
  frameAt,
  makePatchClip,
  patchCentre,
  patchGraph,
  previewPatches,
  previewPixels,
  worstDiff
} from './colorPatches'

/** Max per-channel difference (0–255), as in colorParity.spec.ts. */
const TOLERANCE = 12

type Look = { color?: Record<string, number>; tint?: { color: string; amount: number }; lut?: unknown }
const neutral = { brightness: 0, contrast: 1, saturation: 1 }

/** A smooth but strong 17-point table: lifts red, crushes blue, bends green. */
function warmCube(): string {
  const n = 17
  const lines = ['TITLE "E2E warm"', `LUT_3D_SIZE ${n}`]
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const [R, G, B] = [r, g, b].map((v) => v / (n - 1))
        lines.push([Math.min(1, R * 1.15 + 0.03), G ** 1.25, B * 0.7].map((v) => v.toFixed(6)).join(' '))
      }
  return lines.join('\r\n') + '\r\n'
}

/** Import `file` as a LUT through the real IPC (its Open dialog stubbed). */
async function importLut(page: Page, electronApp: ElectronApplication, file: string) {
  await electronApp.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, file)
  const lut = await page.evaluate(() => window.api.importLutDialog())
  await electronApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog
  })
  return lut!
}

/** Set layer `id`'s look and wait for the preview to have drawn it (table path or CSS). */
async function setLook(page: Page, id: string, look: Look): Promise<void> {
  const before = await page.evaluate(
    (id) => document.querySelector(`[data-layer-id="${id}"] [data-testid="grade-canvas"]`)?.getAttribute('data-bakes'),
    id
  )
  await page.evaluate(
    ({ id, look }) =>
      window.__reelStores.useProject
        .getState()
        .updateLayerContent(id, { color: look.color, tint: look.tint, lut: look.lut } as never),
    { id, look }
  )
  // A table look: wait for a new bake; then two frames for the drawn picture to reach the screen.
  await expect
    .poll(async () =>
      page.evaluate((id) => {
        const c = document.querySelector(`[data-layer-id="${id}"] [data-testid="grade-canvas"]`)
        return c ? c.getAttribute('data-bakes') : 'css'
      }, id)
    )
    .not.toBe(before ?? 'none')
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.waitForTimeout(150)
}

/** Export the project and read its patches at `t`. */
async function exportPatches(page: Page, electronApp: ElectronApplication, out: string, t = 1) {
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: false })
  })
  return exportedPatches(frameAt(out, t))
}

async function waitForProxy(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0]?.proxyReady, id), {
      timeout: 30_000
    })
    .toBe(true)
}

test('a clip graded through the colour table exports with the colours the preview shows', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(420_000)

  const clip = join(projectsDir, 'E2E', 'patches.mp4')
  makePatchClip(clip)
  const cube = join(projectsDir, 'warm.cube')
  writeFileSync(cube, warmCube())
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, clip)
  await waitForProxy(page, id)
  await page.evaluate((id) => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('V', id, 0, 2, false, 540 / 960)
    usePlayback.getState().setTime(1)
  }, id)
  await page.addStyleTag({ content: '[data-testid="safe-zone"] { display: none !important }' })
  await expect
    .poll(async () => (await previewPatches(page, electronApp))[1][0], { timeout: 15_000 })
    .toBeGreaterThan(110)
  const lut = await importLut(page, electronApp, cube)
  expect(lut.name).toBe('warm')

  const CASES: { name: string; look: Look }[] = [
    { name: 'temperature +0.7 (warm)', look: { color: { ...neutral, temperature: 0.7 } } },
    { name: 'temperature −0.7 (cool)', look: { color: { ...neutral, temperature: -0.7 } } },
    { name: 'tint +0.7 (magenta)', look: { color: { ...neutral, greenMagenta: 0.7 } } },
    { name: 'tint −0.7 (green)', look: { color: { ...neutral, greenMagenta: -0.7 } } },
    { name: 'vibrance +0.8', look: { color: { ...neutral, vibrance: 0.8 } } },
    { name: 'vibrance −0.8', look: { color: { ...neutral, vibrance: -0.8 } } },
    {
      name: 'everything: old sliders, new controls and a wash',
      look: {
        color: {
          brightness: 0.15,
          contrast: 1.3,
          saturation: 1.4,
          temperature: 0.4,
          greenMagenta: -0.2,
          vibrance: 0.3
        },
        tint: { color: '#ffd999', amount: 0.3 }
      }
    },
    { name: 'a LUT at 100 %', look: { lut: { ...lut, strength: 1 } } },
    { name: 'a LUT at 40 %', look: { lut: { ...lut, strength: 0.4 } } },
    {
      name: 'a LUT at 60 % after a grade',
      look: { color: { brightness: 0.1, contrast: 1.2, saturation: 1, vibrance: 0.4 }, lut: { ...lut, strength: 0.6 } }
    }
  ]
  const dir = mkdtempSync(join(tmpdir(), 'reel-colortable-'))
  const report: string[] = []
  const ungraded = await previewPatches(page, electronApp)
  // The same frame exported with no look: each case's export must move away from it.
  const ungradedExport = await exportPatches(page, electronApp, join(dir, 'ungraded.mp4'))
  for (const [n, c] of CASES.entries()) {
    await setLook(page, 'V', c.look)
    // The table path is in use: the canvas is drawn and the plain <video> hidden.
    await expect(page.locator('[data-layer-id="V"] [data-testid="grade-canvas"]')).toHaveCount(1)
    await expect(page.getByTestId('grade-warning')).toHaveCount(0)
    const preview = await previewPatches(page, electronApp)
    const exported = await exportPatches(page, electronApp, join(dir, `case${n}.mp4`))
    const worst = worstDiff(preview, exported)
    const exportMoved = worstDiff(exported, ungradedExport)
    report.push(
      `${c.name}: worst ${worst} (preview moved ${worstDiff(preview, ungraded)}, export moved ${exportMoved})`
    )
    expect
      .soft(worst, `${c.name}: preview ${JSON.stringify(preview)} vs export ${JSON.stringify(exported)}`)
      .toBeLessThanOrEqual(TOLERANCE)
    // And the look really changed the picture (not a pass by doing nothing).
    expect.soft(worstDiff(preview, ungraded), `${c.name} changed nothing`).toBeGreaterThan(8)
    // On BOTH sides: an export that ignored the control would still sit within
    // the tolerance of a preview that moved little; it must move by more.
    expect.soft(exportMoved, `${c.name}: the export did not move`).toBeGreaterThan(TOLERANCE)
  }
  console.log(`[colorTable] preview vs export per case (tolerance ${TOLERANCE}):\n  ${report.join('\n  ')}`)
})

test('a graded picture exports with the colours the preview shows', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(240_000)

  const png = join(projectsDir, 'patches.png')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', patchGraph(540, 960, 1), '-frames:v', '1', png])
  const cube = join(projectsDir, 'warm.cube')
  writeFileSync(cube, warmCube())
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, png)
  // A picture fills the 9:16 frame at scale 1 (contain); 540×960 is 9:16.
  await page.evaluate((id) => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addLayer({
      id: 'I',
      hidden: false,
      startSec: 0,
      endSec: 2,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'image', mediaId: id, opacity: 1 }
    })
    usePlayback.getState().setTime(1)
  }, id)
  await page.addStyleTag({ content: '[data-testid="safe-zone"] { display: none !important }' })
  const layerId = 'I'
  await expect
    .poll(async () => (await previewPatches(page, electronApp))[1][0], { timeout: 15_000 })
    .toBeGreaterThan(110)
  const lut = await importLut(page, electronApp, cube)
  const dir = mkdtempSync(join(tmpdir(), 'reel-colortable-img-'))
  const cases: { name: string; look: Look }[] = [
    {
      name: 'old sliders and a wash (CSS / lutrgb path)',
      look: { color: { brightness: 0.15, contrast: 1.3, saturation: 1.4 }, tint: { color: '#ffd999', amount: 0.4 } }
    },
    {
      name: 'temperature, vibrance and a LUT at 70 %',
      look: { color: { ...neutral, temperature: 0.5, vibrance: 0.5 }, lut: { ...lut, strength: 0.7 } }
    }
  ]
  const ungraded = await previewPatches(page, electronApp)
  const ungradedExport = await exportPatches(page, electronApp, join(dir, 'ungraded.mp4'))
  for (const [n, c] of cases.entries()) {
    await setLook(page, layerId, c.look)
    const preview = await previewPatches(page, electronApp)
    const exported = await exportPatches(page, electronApp, join(dir, `img${n}.mp4`))
    const worst = worstDiff(preview, exported)
    const exportMoved = worstDiff(exported, ungradedExport)
    console.log(
      `[colorTable] picture, ${c.name}: worst ${worst} (preview moved ${worstDiff(preview, ungraded)}, export moved ${exportMoved})`
    )
    expect
      .soft(worst, `${c.name}: preview ${JSON.stringify(preview)} vs export ${JSON.stringify(exported)}`)
      .toBeLessThanOrEqual(TOLERANCE)
    // Both sides moved, by more than the tolerance (a side ignoring the look fails).
    expect.soft(worstDiff(preview, ungraded), `${c.name}: the preview did not move`).toBeGreaterThan(TOLERANCE)
    expect.soft(exportMoved, `${c.name}: the export did not move`).toBeGreaterThan(TOLERANCE)
  }
})

/** A 13 × 23 grid of sample points over the whole preview frame. */
const GRID = Array.from({ length: 13 * 23 }, (_, i) => ({
  fx: ((i % 13) + 0.5) / 13,
  fy: (Math.floor(i / 13) + 0.5) / 23
}))

/** Mean and worst per-channel difference between two samplings of the grid. */
function gridDiff(a: number[][], b: number[][]): { mean: number; worst: number } {
  let sum = 0
  let worst = 0
  a.forEach((p, i) =>
    p.forEach((v, c) => {
      const d = Math.abs(v - b[i][c])
      sum += d
      worst = Math.max(worst, d)
    })
  )
  return { mean: sum / (a.length * 3), worst }
}

/**
 * Frame fractions of an n × n grid over the middle of layer `id`'s box, along
 * its own (rotated) axes, `inset` in from each side — points that are always
 * inside that clip, wherever its keyframes have moved it.
 */
async function pointsInLayer(page: Page, id: string, n = 7, inset = 0.2): Promise<{ fx: number; fy: number }[]> {
  return page.evaluate(
    ({ id, n, inset }) => {
      const el = document.querySelector(`[data-layer-id="${id}"]`) as HTMLElement
      const stage = document.querySelector('[data-testid="preview-canvas"]') as HTMLElement
      const sr = stage.getBoundingClientRect()
      const er = el.getBoundingClientRect()
      const k = sr.width / stage.offsetWidth
      const t = getComputedStyle(el).transform
      const m = t && t !== 'none' ? new DOMMatrixReadOnly(t) : new DOMMatrixReadOnly()
      const s = Math.hypot(m.a, m.b) || 1
      const ang = Math.atan2(m.b, m.a)
      const w = el.offsetWidth * s * k
      const h = el.offsetHeight * s * k
      const cx = er.left + er.width / 2
      const cy = er.top + er.height / 2
      const out: { fx: number; fy: number }[] = []
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const u = (inset + ((1 - 2 * inset) * (i + 0.5)) / n - 0.5) * w
          const v = (inset + ((1 - 2 * inset) * (j + 0.5)) / n - 0.5) * h
          const x = cx + u * Math.cos(ang) - v * Math.sin(ang)
          const y = cy + u * Math.sin(ang) + v * Math.cos(ang)
          out.push({ fx: (x - sr.left) / sr.width, fy: (y - sr.top) / sr.height })
        }
      return out
    },
    { id, n, inset }
  )
}

/** An almost-neutral look that still goes through the colour table. */
const NEAR_NEUTRAL: Look = { color: { ...neutral, vibrance: 0.01 } }

const ff = (args: string[]): void => {
  execFileSync(FFMPEG, ['-y', '-v', 'error', ...args])
}

test('a table-graded clip draws exactly where the plain clip does: crop, flip, rotation, keyframes, alpha, playback', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(240_000)

  // A moving, asymmetric clip (so a missed flip, crop or rotation shows), and
  // a background-removed one: VP9 with alpha, transparent on its left half.
  const moving = join(projectsDir, 'moving.mp4')
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=540x960:r=30:d=6',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    moving
  ])
  const matte = join(projectsDir, 'matte.webm')
  const alphaGraph = `${patchGraph(540, 960, 6)},format=rgba,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=if(lt(X\\,270)\\,0\\,255)`
  ff([
    '-f',
    'lavfi',
    '-i',
    alphaGraph,
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    matte
  ])
  const backdrop = join(projectsDir, 'backdrop.png')
  ff(['-f', 'lavfi', '-i', 'color=c=0x2050d0:s=540x960', '-frames:v', '1', backdrop])
  const ids = await page.evaluate(
    async (paths) => {
      const assets = await window.api.importPaths(paths)
      window.__reelStores.useProject.getState().addMedia(assets.map((a) => a.id))
      return assets.map((a) => ({ id: a.id, alpha: !!a.probe.video?.hasAlpha }))
    },
    [moving, matte, backdrop]
  )
  expect(ids[1].alpha, 'the matte imports as a clip with alpha').toBe(true)
  for (const { id } of ids.slice(0, 2)) await waitForProxy(page, id)

  await page.evaluate(
    ([m, a, b]) => {
      const { useProject, usePlayback } = window.__reelStores
      const s = useProject.getState()
      const base = { hidden: false, startSec: 0, endSec: 6 }
      const clip = (mediaId: string) => ({
        kind: 'video' as const,
        mediaId,
        inSec: 0,
        outSec: 6,
        mute: true,
        gainDb: 0
      })
      // Back to front: a blue backdrop; the matte over it (its left half see-through);
      // the moving clip, cropped, mirrored, turned and keyframed (position, zoom, opacity).
      s.addLayer({ ...base, id: 'B', x: 540, y: 960, scale: 1, content: { kind: 'image', mediaId: b, opacity: 1 } })
      s.addLayer({ ...base, id: 'A', x: 540, y: 700, scale: 0.7, content: clip(a) })
      s.addLayer({
        ...base,
        id: 'V',
        x: 560,
        y: 1300,
        scale: 0.6,
        rotationDeg: 25,
        keyframes: [
          { tSec: 0, x: 520, y: 1250, scale: 0.55, opacity: 1 },
          { tSec: 6, x: 600, y: 1350, scale: 0.65, opacity: 0.6 }
        ],
        content: { ...clip(m), crop: { x: 40, y: 120, w: 400, h: 600 }, flipH: true }
      })
      usePlayback.getState().setTime(1.5)
    },
    ids.map((i) => i.id)
  )
  await page.addStyleTag({ content: '[data-testid="safe-zone"] { display: none !important }' })
  await expect(page.locator('[data-layer-id="V"] video')).toHaveCount(1)
  await expect(page.locator('[data-layer-id="A"] video')).toHaveCount(1)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-layer-id] video')].every((v) => (v as HTMLVideoElement).readyState >= 2)
  )
  await page.waitForTimeout(400)

  const plain = await previewPixels(page, electronApp, GRID)
  // Inside the moved clip's own box too: a whole-frame mean is mostly backdrop, so
  // a canvas that ignored the keyframed opacity (0.9 here) would hide in it.
  const inV = await pointsInLayer(page, 'V')
  const plainV = await previewPixels(page, electronApp, inV)
  await setLook(page, 'V', NEAR_NEUTRAL)
  await setLook(page, 'A', NEAR_NEUTRAL)
  await expect(page.locator('[data-testid="grade-canvas"]')).toHaveCount(2)
  // The plain elements are hidden while their canvases draw.
  expect(await page.locator('[data-layer-id="V"] video').evaluate((v) => getComputedStyle(v).opacity)).toBe('0')
  const graded = await previewPixels(page, electronApp, GRID)
  const still = gridDiff(plain, graded)
  console.log(`[colorTable] placement, paused: mean ${still.mean.toFixed(2)}, worst ${still.worst}`)
  // A canvas that missed the crop, the flip or the rotation would put other parts of the picture here.
  expect(still.mean, 'graded picture sits where the plain one did').toBeLessThan(2.5)
  const box = gridDiff(plainV, await previewPixels(page, electronApp, inV))
  console.log(`[colorTable] placement, paused, inside the moved clip: mean ${box.mean.toFixed(2)}, worst ${box.worst}`)
  expect(box.mean, 'inside the moved clip (crop, flip, rotation, keyframed opacity)').toBeLessThan(2.5)
  // The matte's see-through half still shows the blue backdrop.
  const left = await previewPixels(page, electronApp, [{ fx: 0.35, fy: 0.3 }])
  expect(left[0][2], `backdrop shows through the matte: ${JSON.stringify(left)}`).toBeGreaterThan(150)

  // Playing: the canvas follows the clip (its picture changes), and once
  // paused it shows the same frame the plain clip shows there.
  const before = await previewPixels(page, electronApp, GRID)
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setPlaying(true))
  await page.waitForTimeout(900)
  const during = await previewPixels(page, electronApp, GRID)
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setPlaying(false))
  expect(gridDiff(before, during).mean, 'the graded clip moves while playing').toBeGreaterThan(3)
  await page.waitForTimeout(500)
  const gradedAfter = await previewPixels(page, electronApp, GRID)
  const inVAfter = await pointsInLayer(page, 'V')
  const gradedAfterV = await previewPixels(page, electronApp, inVAfter)
  await setLook(page, 'V', {})
  await setLook(page, 'A', {})
  await page.waitForTimeout(400)
  const plainAfter = await previewPixels(page, electronApp, GRID)
  const played = gridDiff(plainAfter, gradedAfter)
  console.log(`[colorTable] placement, after playing: mean ${played.mean.toFixed(2)}, worst ${played.worst}`)
  expect(played.mean, 'after playing, the graded frame is the plain clip’s frame').toBeLessThan(2.5)
  const playedBox = gridDiff(await previewPixels(page, electronApp, inVAfter), gradedAfterV)
  console.log(
    `[colorTable] placement, after playing, inside the moved clip: mean ${playedBox.mean.toFixed(2)}, worst ${playedBox.worst}`
  )
  expect(playedBox.mean, 'after playing, inside the moved clip').toBeLessThan(2.5)
})

test('with WebGL gone the clip shows ungraded, with a notice', async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  const clip = join(projectsDir, 'E2E', 'patches.mp4')
  makePatchClip(clip)
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, clip)
  await waitForProxy(page, id)
  await page.evaluate((id) => {
    window.__reelStores.useProject.getState().addVideoLayer('V', id, 0, 2, false, 540 / 960)
    window.__reelStores.usePlayback.getState().setTime(1)
  }, id)
  await setLook(page, 'V', { color: { ...neutral, temperature: 0.5 } })
  const video = page.locator('[data-layer-id="V"] video')
  expect(await video.evaluate((v) => getComputedStyle(v).opacity)).toBe('0')
  await expect(page.getByTestId('grade-warning')).toHaveCount(0)
  // The GPU drops the context (as a driver reset would).
  await page
    .getByTestId('grade-canvas')
    .evaluate((c) => (c as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext())
  await expect(page.getByTestId('grade-warning')).toContainText('WebGL unavailable')
  expect(await video.evaluate((v) => getComputedStyle(v).opacity)).toBe('1')
})

test('with no WebGL2 at all the clip shows ungraded, with a notice', async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  const clip = join(projectsDir, 'E2E', 'patches.mp4')
  makePatchClip(clip)
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, clip)
  await waitForProxy(page, id)
  // A machine whose browser offers no WebGL2 context.
  await page.evaluate(() => {
    const orig = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      return kind === 'webgl2' ? null : (orig as (...a: unknown[]) => unknown).call(this, kind, ...rest)
    } as typeof orig
  })
  await page.evaluate((id) => {
    window.__reelStores.useProject.getState().addVideoLayer('V', id, 0, 2, false, 540 / 960)
    window.__reelStores.usePlayback.getState().setTime(1)
  }, id)
  await page.waitForFunction(
    () => (document.querySelector('[data-layer-id="V"] video') as HTMLVideoElement)?.readyState >= 2
  )
  await setLook(page, 'V', { color: { ...neutral, temperature: 0.5 } })
  await expect(page.locator('[data-layer-id="V"] [data-testid="grade-warning"]')).toContainText('WebGL unavailable')
  const video = page.locator('[data-layer-id="V"] video')
  expect(await video.evaluate((v) => getComputedStyle(v).opacity)).toBe('1')
  await expect(page.locator('[data-layer-id="V"] [data-testid="grade-canvas"]')).not.toHaveAttribute('data-drawn')
})

test('graded clips coming and going give their WebGL contexts back: a long graded picture keeps drawing', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(240_000)
  const clip = join(projectsDir, 'E2E', 'patches.mp4')
  makePatchClip(clip)
  const png = join(projectsDir, 'patches.png')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', patchGraph(540, 960, 1), '-frames:v', '1', png])
  const [clipId, picId] = await page.evaluate(
    async (paths) => {
      const assets = await window.api.importPaths(paths)
      window.__reelStores.useProject.getState().addMedia(assets.map((a) => a.id))
      return assets.map((a) => a.id)
    },
    [clip, png]
  )
  await waitForProxy(page, clipId)
  // Chromium keeps 16 live WebGL contexts: 20 graded clips, one after another,
  // under a graded picture that stays on screen the whole time.
  const N = 20
  await page.evaluate(
    ({ clipId, picId, n }) => {
      const { useProject, usePlayback } = window.__reelStores
      const s = useProject.getState()
      const at = { hidden: false, x: 540, scale: 0.5 }
      s.addLayer({
        ...at,
        id: 'P',
        startSec: 0,
        endSec: n + 1,
        y: 480,
        content: { kind: 'image', mediaId: picId, opacity: 1 }
      })
      for (let i = 0; i < n; i++) {
        s.addLayer({
          ...at,
          id: `C${i}`,
          startSec: i,
          endSec: i + 1,
          y: 1440,
          content: {
            kind: 'video',
            mediaId: clipId,
            inSec: 0,
            outSec: 1,
            mute: true,
            gainDb: 0,
            color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0.5 }
          }
        })
      }
      usePlayback.getState().setTime(0.5)
    },
    { clipId, picId, n: N }
  )
  await page.addStyleTag({ content: '[data-testid="safe-zone"] { display: none !important }' })
  // The picture sits in the top half of the frame, at half size.
  const PIC = PATCHES.map((_, i) => {
    const { fx, fy } = patchCentre(i)
    return { fx: 0.25 + fx * 0.5, fy: fy * 0.5 }
  })
  await expect
    .poll(async () => (await previewPixels(page, electronApp, PIC))[1][0], { timeout: 15_000 })
    .toBeGreaterThan(110)
  const plain = await previewPixels(page, electronApp, PIC)
  await setLook(page, 'P', { color: { ...neutral, temperature: 0.6 } })
  const picCanvas = page.locator('[data-layer-id="P"] [data-testid="grade-canvas"]')
  await expect(picCanvas).toHaveAttribute('data-drawn', '1')
  const graded = await previewPixels(page, electronApp, PIC)
  expect(worstDiff(graded, plain), 'the picture is graded').toBeGreaterThan(8)
  await picCanvas.evaluate((c) => {
    const w = window as unknown as { __picLost: number }
    w.__picLost = 0
    c.addEventListener('webglcontextlost', () => w.__picLost++)
  })
  // Keep every graded canvas that comes and goes, as a garbage collector that
  // hasn't run yet would: then only an explicit release frees its context (a
  // collected canvas frees it too, but whenever the GC gets round to it).
  await page.evaluate(() => {
    const w = window as unknown as { __kept: HTMLCanvasElement[] }
    w.__kept = []
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLCanvasElement && n.dataset.testid === 'grade-canvas') w.__kept.push(n)
    }).observe(document.body, { childList: true, subtree: true })
  })

  for (let i = 0; i < N; i++) {
    await page.evaluate((t) => window.__reelStores.usePlayback.getState().setTime(t), i + 0.5)
    // Each clip's canvas really drew (so its context is fresher than the picture's).
    await expect(page.locator(`[data-layer-id="C${i}"] [data-testid="grade-canvas"]`)).toHaveAttribute(
      'data-drawn',
      '1',
      { timeout: 15_000 }
    )
  }
  await expect(page.locator('[data-testid="grade-canvas"]')).toHaveCount(2)
  // The picture never lost its context, shows no notice and still draws graded.
  expect(
    await page.evaluate(() => (window as unknown as { __picLost: number }).__picLost),
    'picture context lost'
  ).toBe(0)
  await expect(page.locator('[data-layer-id="P"] [data-testid="grade-warning"]')).toHaveCount(0)
  const after = await previewPixels(page, electronApp, PIC)
  expect(
    worstDiff(after, graded),
    `still graded: ${JSON.stringify(after)} vs ${JSON.stringify(graded)}`
  ).toBeLessThanOrEqual(2)
  // Because every clip canvas that left the page gave its context back.
  const kept = await page.evaluate(() => {
    const w = window as unknown as { __kept: HTMLCanvasElement[] }
    const gone = w.__kept.filter((c) => !c.isConnected)
    return { gone: gone.length, released: gone.filter((c) => c.getContext('webgl2')?.isContextLost()).length }
  })
  expect(kept.gone).toBeGreaterThanOrEqual(N - 2)
  expect(kept.released, 'unmounted canvases released their contexts').toBe(kept.gone)
})

test('a LUT missing from the project shows a notice until the same file is imported again, then draws', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const clip = join(projectsDir, 'E2E', 'patches.mp4')
  makePatchClip(clip)
  const cube = join(projectsDir, 'warm.cube')
  writeFileSync(cube, warmCube())
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, clip)
  await waitForProxy(page, id)
  await page.evaluate((id) => {
    const { useProject, usePlayback, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('V', id, 0, 2, false, 540 / 960)
    usePlayback.getState().setTime(1)
    useUi.getState().selectLayer('V')
  }, id)
  await page.addStyleTag({ content: '[data-testid="safe-zone"] { display: none !important }' })
  await expect
    .poll(async () => (await previewPatches(page, electronApp))[1][0], { timeout: 15_000 })
    .toBeGreaterThan(110)
  const ungraded = await previewPatches(page, electronApp)

  // The project's copy of the LUT goes missing (a folder copied without luts/).
  const lut = await importLut(page, electronApp, cube)
  rmSync(join(projectsDir, 'E2E', 'luts', lut.file))
  await setLook(page, 'V', { lut: { ...lut, strength: 1 } })
  const warning = page.locator('[data-layer-id="V"] [data-testid="grade-warning"]')
  await expect(warning).toContainText('LUT “warm” is missing')

  // A lost and restored WebGL context keeps saying so (it does not reset to fine).
  await page.getByTestId('grade-canvas').evaluate((c) => {
    const ext = (c as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!
    ;(window as unknown as { __lose: WEBGL_lose_context }).__lose = ext
    ext.loseContext()
  })
  await expect(warning).toContainText('WebGL unavailable')
  await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext())
  await expect(warning).toContainText('LUT “warm” is missing')

  // Importing the very same file again (same content, so the same stored name)
  // through the Inspector clears the notice, and the table is drawn.
  await electronApp.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, cube)
  await page.getByTestId('lut-import').click()
  await expect(warning).toHaveCount(0)
  expect(existsSync(join(projectsDir, 'E2E', 'luts', lut.file))).toBe(true)
  await expect
    .poll(async () => worstDiff(await previewPatches(page, electronApp), ungraded), { timeout: 10_000 })
    .toBeGreaterThan(20)
})

test('the Inspector imports a LUT, sets its strength, shares it and picks it back; the newer controls reset', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const clip = join(projectsDir, 'E2E', 'patches.mp4')
  makePatchClip(clip)
  const cube = join(projectsDir, 'Warm_Look.cube')
  writeFileSync(cube, warmCube())
  const broken = join(projectsDir, 'broken.cube')
  writeFileSync(broken, 'LUT_3D_SIZE 2\n0 0 0\n')
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, clip)
  await waitForProxy(page, id)
  await page.evaluate((id) => {
    const { useProject, usePlayback, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('V', id, 0, 2, false, 540 / 960)
    usePlayback.getState().setTime(1)
    useUi.getState().selectLayer('V')
  }, id)
  await page.addStyleTag({ content: '[data-testid="safe-zone"] { display: none !important }' })
  await expect
    .poll(async () => (await previewPatches(page, electronApp))[1][0], { timeout: 15_000 })
    .toBeGreaterThan(110)
  const ungraded = await previewPatches(page, electronApp)
  const lutOf = () =>
    page.evaluate(() => {
      const l = window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'V')!
      return l.content.kind === 'video' ? (l.content.lut ?? null) : null
    })
  const pick = (path: string) =>
    electronApp.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
    }, path)

  // The old Tint is now "Color wash"; "Tint" is the green / magenta balance.
  await expect(page.getByTestId('lut-controls')).toBeVisible()
  await expect(page.getByText(/^Color wash/)).toBeVisible()
  await expect(page.getByTestId('color-greenMagenta')).toContainText('Tint')

  // A file that isn't a usable table is refused with the reason, and nothing is set.
  await pick(broken)
  await page.getByTestId('lut-import').click()
  await expect(page.getByTestId('lut-error')).toContainText('should have 8 entries')
  expect(await lutOf()).toBeNull()

  // Import LUT…: copied into the project's luts/ and applied at full strength.
  await pick(cube)
  await page.getByTestId('lut-import').click()
  await expect.poll(lutOf).toMatchObject({ name: 'Warm Look', strength: 1 })
  const lut = (await lutOf())!
  expect(lut.file).toMatch(/^[0-9a-f]{16}\.cube$/)
  expect(existsSync(join(projectsDir, 'E2E', 'luts', lut.file))).toBe(true)
  await expect(page.getByTestId('lut-select')).toHaveValue(`own:${lut.file}`)
  await expect(page.locator('[data-layer-id="V"] [data-testid="grade-canvas"]')).toHaveCount(1)
  await expect
    .poll(async () => worstDiff(await previewPatches(page, electronApp), ungraded), { timeout: 10_000 })
    .toBeGreaterThan(20)

  // Strength.
  await page.getByTestId('lut-controls').locator('input[type="range"]').fill('0.4')
  await expect.poll(async () => (await lutOf())?.strength).toBe(0.4)
  await expect(page.getByTestId('lut-controls')).toContainText('Strength 40%')

  // Save to shared library, then pick None and choose it back from the shared list.
  await page.getByTestId('lut-share').click()
  await expect(page.getByTestId('lut-note')).toContainText('Added “Warm Look”')
  const shared = await page.evaluate(async () => (await window.api.listShared()).filter((i) => i.kind === 'lut'))
  expect(shared.map((i) => i.name)).toEqual(['Warm Look'])
  await page.getByTestId('lut-select').selectOption('')
  await expect.poll(lutOf).toBeNull()
  await expect(page.locator('[data-layer-id="V"] [data-testid="grade-canvas"]')).toHaveCount(0)
  await page.getByTestId('lut-select').selectOption(`shared:${shared[0].id}`)
  await expect.poll(lutOf).toMatchObject({ file: lut.file, name: 'Warm Look', strength: 1 })

  // A newer control has its own reset, which leaves the others alone.
  await page.evaluate(() =>
    window.__reelStores.useProject.getState().updateLayerContent('V', {
      color: { brightness: 0.1, contrast: 1, saturation: 1, temperature: 0.5, vibrance: 0.3 }
    })
  )
  await page.getByTestId('color-temperature-reset').click()
  const color = await page.evaluate(() => {
    const l = window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'V')!
    return l.content.kind === 'video' ? l.content.color : null
  })
  expect(color).toEqual({ brightness: 0.1, contrast: 1, saturation: 1, vibrance: 0.3 })
  await expect(page.getByTestId('color-temperature-reset')).toHaveCount(0)
})

test('a still of a table-graded clip has the colours its export has (the table in a scratch folder)', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const clip = join(projectsDir, 'E2E', 'patches.mp4')
  makePatchClip(clip)
  const cube = join(projectsDir, 'warm.cube')
  writeFileSync(cube, warmCube())
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, clip)
  await waitForProxy(page, id)
  const lut = await importLut(page, electronApp, cube)
  const look = { color: { ...neutral, temperature: 0.6, vibrance: 0.5 }, lut: { ...lut, strength: 0.7 } }
  await page.evaluate(
    ({ id, look }) => {
      window.__reelStores.useProject.getState().addVideoLayer('V', id, 0, 2, false, 540 / 960)
      window.__reelStores.useProject.getState().updateLayerContent('V', look as never)
    },
    { id, look }
  )
  const dir = mkdtempSync(join(tmpdir(), 'reel-colortable-still-'))
  const png = join(dir, 'still.png')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, png)
  const saved = await page.evaluate(
    ({ id, look }) =>
      window.api.captureStillToDisk(
        { mediaId: id, sourceSec: 1, crop: null, color: look.color, tint: null, lut: look.lut },
        'still.png'
      ),
    { id, look }
  )
  expect(saved).toBe(png)
  const still = exportedPatches(frameAt(png, 0, true))
  const exported = await exportPatches(page, electronApp, join(dir, 'export.mp4'))
  const plainStill = join(dir, 'plain.png')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, plainStill)
  await page.evaluate(
    (id) => window.api.captureStillToDisk({ mediaId: id, sourceSec: 1, crop: null, color: null }, 'plain.png'),
    id
  )
  const plain = exportedPatches(frameAt(plainStill, 0, true))
  console.log(`[colorTable] still vs export: worst ${worstDiff(still, exported)}; moved ${worstDiff(still, plain)}`)
  // The still (a PNG) and the export (an H.264 encode) agree within the parity tolerance (measured: 7).
  expect(
    worstDiff(still, exported),
    `still ${JSON.stringify(still)} vs export ${JSON.stringify(exported)}`
  ).toBeLessThanOrEqual(TOLERANCE)
  expect(worstDiff(still, plain), 'the still is graded').toBeGreaterThan(15)
})
