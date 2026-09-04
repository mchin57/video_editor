/**
 * Layers panel drag-to-restack. Converted to `startPointerDrag` in the
 * drag-helper sweep with no coverage at all, and the owner then reported it
 * wasn't dragging — this is the spec that should have existed first.
 *
 * The panel lists only layers whose span covers the PLAYHEAD, front → back, and
 * pins the bottom-most layer of the whole stack as the Background, so four
 * overlapping layers are needed to get three draggable rows.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const ROW_H = 30 // must match LayersPanel's ROW_H

/** BG + three draggable layers, all covering the playhead at t=1. */
async function arrangeStack(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject, usePlayback, useUi } = window.__reelStores
    for (const id of ['BG', 'A', 'B', 'C']) {
      useProject.getState().addVideoLayer(id, 'no-such-media', 0, 5, false)
    }
    usePlayback.getState().setTime(1)
    useUi.getState().clearSelection()
  })
}

/** Bottom → top stack order as stored in the document. */
const stackOrder = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.map((l) => l.id))

test('the panel lists the layers at the playhead, front to back', async ({ appPage: page }) => {
  await arrangeStack(page)
  expect(await stackOrder(page)).toEqual(['BG', 'A', 'B', 'C'])
  // Three drag handles: C, B, A (BG is pinned).
  await expect(page.getByTitle('Drag to reorder')).toHaveCount(3)
})

test('dragging a layer by its handle restacks it', async ({ appPage: page }) => {
  await arrangeStack(page)

  // The top row is the front-most layer, C. Drag it down two rows.
  const handle = page.getByTitle('Drag to reorder').first()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + ROW_H)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + ROW_H * 2)
  await page.mouse.up()

  // Front→back was [C, B, A]; C dropped to the back makes it [B, A, C],
  // i.e. bottom→top in the document: BG, C, A, B.
  await expect.poll(() => stackOrder(page)).toEqual(['BG', 'C', 'A', 'B'])
})

test('the dragged row is marked while the drag is live', async ({ appPage: page }) => {
  await arrangeStack(page)
  const handle = page.getByTitle('Drag to reorder').first()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + ROW_H)

  // Some row carries the dragging treatment (opacity + ring).
  await expect(page.locator('.ring-sky-400\\/60')).toHaveCount(1)
  await page.mouse.up()
  await expect(page.locator('.ring-sky-400\\/60')).toHaveCount(0)
})

/**
 * Why this can LOOK broken in real use. Both of these are pre-existing design,
 * not drag bugs — the drag machinery above works — but each produces "nothing
 * happens when I drag", so they are pinned here to keep the distinction clear.
 */
test('with only one layer above the background there is nothing to reorder', async ({
  appPage: page
}) => {
  await page.evaluate(() => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('BG', 'no-such-media', 0, 5, false)
    useProject.getState().addVideoLayer('ONLY', 'no-such-media', 0, 5, false)
    usePlayback.getState().setTime(1)
  })
  // The bottom-most layer of the whole stack is pinned as Background, so a
  // two-layer project offers exactly ONE draggable row — and dragging the only
  // row can't change any order.
  await expect(page.getByTitle('Drag to reorder')).toHaveCount(1)

  const handle = page.getByTitle('Drag to reorder').first()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + ROW_H * 3)
  await page.mouse.up()
  expect(await stackOrder(page)).toEqual(['BG', 'ONLY'])
})

test('only layers under the PLAYHEAD are listed', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('BG', 'no-such-media', 0, 5, false)
    useProject.getState().addVideoLayer('A', 'no-such-media', 0, 5, false)
    useProject.getState().addVideoLayer('LATE', 'no-such-media', 20, 5, false)
    usePlayback.getState().setTime(1)
  })
  // LATE doesn't cover t=1, so it isn't listed and can't be dragged — moving
  // the playhead is what brings a layer into the panel.
  await expect(page.getByTitle('Drag to reorder')).toHaveCount(1)
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(21))
  await expect(page.getByTitle('Drag to reorder')).toHaveCount(1)
})

test('the row BODY selects; only the ⠿ handle drags', async ({ appPage: page }) => {
  await arrangeStack(page)
  const before = await stackOrder(page)
  // Press on the row's label area (not the handle) and move: this selects the
  // layer and does nothing else, which is easy to mistake for a broken drag.
  const row = page.getByTitle('Drag to reorder').first()
  const box = (await row.boundingBox())!
  await page.mouse.move(box.x + 80, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, box.y + box.height / 2 + ROW_H * 2)
  await page.mouse.up()
  expect(await stackOrder(page)).toEqual(before)
})
