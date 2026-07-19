/**
 * Multi-clip layouts: the Format menu's "Add layout" opens a visual preset
 * picker; picking creates the layout layer, the timeline grows a Layout lane
 * with its block, the preview shows the (empty) cell slots while selected, and
 * the live preview reshapes via the picker. ARRANGE/ASSERT via store, ACT via
 * real clicks and drags.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from './fixtures'
import type { LayoutContent } from '../src/shared/project'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

test('Format menu picker adds a layout and reshapes it; block drags in time', async ({
  appPage: page
}) => {
  // Open the header FORMAT menu, then "Add layout" — which opens the visual
  // picker modal (the dropdown closes).
  await page.getByRole('button', { name: 'Format ▾' }).click()
  await page.getByTitle('Add a multi-clip layout (split screen / panels) at the playhead').click()
  const picker = page.getByTestId('layout-picker')
  await expect(picker).toBeVisible()

  // Pick Split L|R from the gallery → creates the layout, closes the modal.
  await picker.getByTitle('Split L|R (2 cells)').click()
  await expect(picker).toHaveCount(0)

  const state = (): Promise<{ startSec: number; endSec: number; c: LayoutContent }> =>
    page.evaluate(() => {
      const l = window.__reelStores.useProject.getState().project!.layers[0]
      return { startSec: l.startSec, endSec: l.endSec, c: l.content as LayoutContent }
    })
  let s = await state()
  expect(s.c.kind).toBe('layout')
  expect(s.c.presetId).toBe('split-lr')
  expect(s.c.cells).toHaveLength(2)

  // The Layout lane bubble and the block appear.
  await expect(page.getByText('Layout', { exact: true }).first()).toBeVisible()
  const block = page.locator('div[title="Layout"]')
  await expect(block).toBeVisible()

  // The preview outlines the empty cell slots while the layer is selected.
  await expect(page.locator('[data-resizebox] .border-dashed')).toHaveCount(2)

  // Reshape: reopen the menu, click the live preview (change ▾) → picker in
  // reshape mode, then pick the 2×2 grid.
  await page.getByRole('button', { name: 'Format ▾' }).click()
  await page.getByTitle('Change the arrangement').click()
  await expect(picker).toBeVisible()
  await picker.getByTitle('2×2 grid (4 cells)').click()
  await expect(picker).toHaveCount(0)
  s = await state()
  expect(s.c.presetId).toBe('grid-2x2')
  expect(s.c.cells).toHaveLength(4)
  await expect(page.locator('[data-resizebox] .border-dashed')).toHaveCount(4)

  // Drag the block 2s right — a plain move, window preserved. (The menu closed
  // when the picker opened, so nothing overlaps the timeline.)
  const scale = await page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)
  const bb = (await block.boundingBox())!
  const gx = bb.x + bb.width / 2
  const gy = bb.y + bb.height / 2
  await page.mouse.move(gx, gy)
  await page.mouse.down()
  await page.mouse.move(gx + 2 * scale, gy, { steps: 5 })
  await page.mouse.up()
  const after = await state()
  expect(after.startSec).toBeGreaterThan(1.5)
  expect(after.startSec).toBeLessThan(2.5)
  expect(after.endSec - after.startSec).toBeCloseTo(s.endSec - s.startSec, 1)
})

test('assigning a clip to a cell shows a ClipCard (preview, no add-to-timeline)', async ({
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')

  // Import a real clip so the cell picker has something to assign.
  const mp4 = join(mkdtempSync(join(tmpdir(), 'reel-cell-')), 'cell.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=270x480:rate=30',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
    mp4
  ])
  const assetId = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, mp4)

  // Add a Split L|R layout via the picker.
  await page.getByRole('button', { name: 'Format ▾' }).click()
  await page.getByTitle('Add a multi-clip layout (split screen / panels) at the playhead').click()
  await page.getByTestId('layout-picker').getByTitle('Split L|R (2 cells)').click()

  // Reopen the menu and assign the clip to cell 1 via its picker.
  await page.getByRole('button', { name: 'Format ▾' }).click()
  const menu = page.getByTestId('format-menu')
  await menu.getByTitle('Clip shown in this cell').first().selectOption({ label: 'cell.mp4' })

  // Store reflects the assignment.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__reelStores.useProject.getState().project!.layers[0].content as LayoutContent).cells[0].mediaId
      )
    )
    .toBe(assetId)

  // The cell renders the shared ClipCard: thumbnail (also in the live preview,
  // hence .first()) + trim controls, and NO add-to-timeline button (that's
  // library-only — the clip is in the layout).
  await expect(menu.locator(`img[src*="${assetId}/thumb.jpg"]`).first()).toBeVisible()
  await expect(menu.getByTitle('Source in-point (s)')).toBeVisible()
  await expect(menu.getByTitle('Add clip at the playhead')).toHaveCount(0)
})
