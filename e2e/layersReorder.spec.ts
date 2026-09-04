/**
 * Layers panel drag-to-restack. Converted to `startPointerDrag` in the
 * drag-helper sweep with no coverage at all, and the owner then reported it
 * wasn't dragging — this is the spec that should have existed first. (The
 * conversion was not the cause: this passed identically against the pre-sweep
 * implementation. The row the owner grabbed was the pinned "Background", since
 * removed — see `dropped the Background pin` below.)
 *
 * The panel lists only layers whose span covers the PLAYHEAD, front → back.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const ROW_H = 30 // must match LayersPanel's ROW_H

/** Four overlapping layers, all covering the playhead at t=1. */
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

const handles = (page: Page): ReturnType<Page['getByTitle']> => page.getByTitle('Drag to reorder')

/** Press the nth row's handle, move down `rows`, release. */
async function dragRow(page: Page, nth: number, rows: number): Promise<void> {
  const box = (await handles(page).nth(nth).boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= Math.abs(rows); i++) {
    await page.mouse.move(x, y + Math.sign(rows) * ROW_H * i)
  }
  await page.mouse.up()
}

test('every layer at the playhead gets a drag handle', async ({ appPage: page }) => {
  await arrangeStack(page)
  expect(await stackOrder(page)).toEqual(['BG', 'A', 'B', 'C'])
  // All four — the bottom-most is no longer pinned as an unmovable Background.
  await expect(handles(page)).toHaveCount(4)
})

test('dragging a layer by its handle restacks it', async ({ appPage: page }) => {
  await arrangeStack(page)
  // Front→back is [C, B, A, BG]; drop the front-most down two rows to get
  // [B, A, C, BG], i.e. bottom→top in the document: BG, C, A, B.
  await dragRow(page, 0, 2)
  await expect.poll(() => stackOrder(page)).toEqual(['BG', 'C', 'A', 'B'])
})

test('dropped the Background pin: the bottom-most layer can be raised', async ({
  appPage: page
}) => {
  await arrangeStack(page)
  // BG is last in the front→back list. Dragging it to the TOP makes it
  // front-most, which the old pin made impossible.
  await dragRow(page, 3, -3)
  await expect.poll(() => stackOrder(page)).toEqual(['A', 'B', 'C', 'BG'])
})

test('dropped the Background pin: a two-layer project can be reordered', async ({
  appPage: page
}) => {
  // The case the owner actually hit: with two layers the lower one WAS the
  // Background, so there was one draggable row and nothing to reorder.
  await page.evaluate(() => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('LOW', 'no-such-media', 0, 5, false)
    useProject.getState().addVideoLayer('HIGH', 'no-such-media', 0, 5, false)
    usePlayback.getState().setTime(1)
  })
  await expect(handles(page)).toHaveCount(2)
  await dragRow(page, 0, 1) // send HIGH behind LOW
  await expect.poll(() => stackOrder(page)).toEqual(['HIGH', 'LOW'])
})

test('the dragged row is marked while the drag is live', async ({ appPage: page }) => {
  await arrangeStack(page)
  const box = (await handles(page).first().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + ROW_H)

  await expect(page.locator('.ring-sky-400\\/60')).toHaveCount(1)
  await page.mouse.up()
  await expect(page.locator('.ring-sky-400\\/60')).toHaveCount(0)
})

test('only layers under the PLAYHEAD are listed', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('EARLY', 'no-such-media', 0, 5, false)
    useProject.getState().addVideoLayer('ALSO', 'no-such-media', 0, 5, false)
    useProject.getState().addVideoLayer('LATE', 'no-such-media', 20, 5, false)
    usePlayback.getState().setTime(1)
  })
  // LATE doesn't cover t=1, so it isn't listed; moving the playhead swaps which
  // layers are there to drag.
  await expect(handles(page)).toHaveCount(2)
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(21))
  await expect(handles(page)).toHaveCount(1)
})

test('the row BODY selects; only the ⠿ handle drags', async ({ appPage: page }) => {
  await arrangeStack(page)
  const before = await stackOrder(page)
  // Pressing the label area selects the layer and does nothing else — easy to
  // mistake for a broken drag, so it is pinned deliberately.
  const box = (await handles(page).first().boundingBox())!
  await page.mouse.move(box.x + 80, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, box.y + box.height / 2 + ROW_H * 2)
  await page.mouse.up()
  expect(await stackOrder(page)).toEqual(before)
})
