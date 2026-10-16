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
import { join } from 'node:path'
import { test, expect } from './fixtures'
import type { LayoutContent } from '../src/shared/project'
import { FFMPEG } from './bin'

test('Format adds a layout; Inspector reshapes it; block drags in time', async ({
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

  // Reshape from the Inspector's Layout section (the layer is selected after
  // adding): "Change layout" opens the picker; pick the 2×2 grid.
  await page.getByTitle('Change the layout arrangement').click()
  await expect(picker).toBeVisible()
  await picker.getByTitle('2×2 grid (4 cells)').click()
  await expect(picker).toHaveCount(0)
  s = await state()
  expect(s.c.presetId).toBe('grid-2x2')
  expect(s.c.cells).toHaveLength(4)
  await expect(page.locator('[data-resizebox] .border-dashed')).toHaveCount(4)

  // Drag the block 2s right — a plain move, window preserved.
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

/** Synthesize + import a tiny clip; returns its asset id (proxy pending). */
async function importClip(page: import('@playwright/test').Page, name: string): Promise<string> {
  const mp4 = join(mkdtempSync(join(tmpdir(), 'reel-cell-')), name)
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=270x480:rate=30',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
    mp4
  ])
  return page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, mp4)
}

/** Add a Split L|R layout via the Format menu picker (layer is auto-selected). */
async function addSplitLayout(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Format ▾' }).click()
  await page.getByTitle('Add a multi-clip layout (split screen / panels) at the playhead').click()
  await page.getByTestId('layout-picker').getByTitle('Split L|R (2 cells)').click()
}

const cellMediaId = (page: import('@playwright/test').Page, i: number): Promise<string | null> =>
  page.evaluate(
    (idx) =>
      (window.__reelStores.useProject.getState().project!.layers[0].content as LayoutContent).cells[idx]
        .mediaId,
    i
  )

test('assigning a clip to a cell (Inspector) shows a ClipCard, no add-to-timeline', async ({
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')

  const assetId = await importClip(page, 'cell.mp4')
  await addSplitLayout(page)

  // The cells now live in the Inspector's Layout section (the layer is selected
  // after adding). Assign the clip to cell 0 via its picker.
  const cell0 = page.getByTestId('layout-cell-0')
  await expect(cell0).toBeVisible()
  await cell0.getByTitle('Clip shown in this cell').selectOption({ label: 'cell.mp4' })
  await expect.poll(() => cellMediaId(page, 0)).toBe(assetId)

  // The cell renders the shared ClipCard: thumbnail + trim controls, and NO
  // add-to-timeline button (that's library-only — the clip is in the layout).
  await expect(cell0.locator(`img[src*="${assetId}/thumb.jpg"]`)).toBeVisible()
  await expect(cell0.getByTitle('Source in-point (s)')).toBeVisible()
  await expect(cell0.getByTitle('Add clip at the playhead')).toHaveCount(0)
})

test('dragging a library clip onto a cell assigns it, overwriting the old clip', async ({
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')

  const first = await importClip(page, 'first.mp4')
  const second = await importClip(page, 'second.mp4')
  await addSplitLayout(page)
  const cell0 = page.getByTestId('layout-cell-0')
  await expect(cell0).toBeVisible()

  // Drag the FIRST clip onto cell 0 (HTML5 dnd via a synthetic DataTransfer,
  // the same payload the Library card sets and the Timeline reads).
  const drop = async (assetId: string): Promise<void> => {
    const dt = await page.evaluateHandle((id) => {
      const d = new DataTransfer()
      d.setData('application/x-reel-asset', id)
      return d
    }, assetId)
    await cell0.dispatchEvent('dragover', { dataTransfer: dt })
    await cell0.dispatchEvent('drop', { dataTransfer: dt })
  }

  await drop(first)
  await expect.poll(() => cellMediaId(page, 0)).toBe(first)

  // Dropping the SECOND clip overwrites the first.
  await drop(second)
  await expect.poll(() => cellMediaId(page, 0)).toBe(second)

  // The other cell stayed empty — the drop only touched the one it landed on.
  expect(await cellMediaId(page, 1)).toBeNull()
})
