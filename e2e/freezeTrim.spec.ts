/**
 * Regression for "freeze holds survive trim and split" plus a basic block-move
 * drag (docs/TIMELINE.md manual checklist item), and the freeze overlay on the
 * clip tile (#202): drawn over the hold, its right edge sets the hold, the clip's
 * right edge walks into it, a click picks it for Delete/Backspace, and a linked
 * clip's overlay is display-only. ARRANGE via store actions —
 * a video layer needs no real media for timeline math (srcDur falls back to
 * outSec) — ACT with real pointer drags on the block, ASSERT on store + DOM.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import type { VideoContent } from '../src/shared/project'

/** A 10s clip at t=0 with a 2s hold at source 3s → window 0..12s, selected. */
async function arrangeFrozenClip(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 0, 10, false)
    useProject.getState().addFreeze('L1', 3, 2)
    useUi.getState().selectLayer('L1')
  })
}

const layerState = (page: Page): Promise<{ startSec: number; endSec: number; c: VideoContent }> =>
  page.evaluate(() => {
    const l = window.__reelStores.useProject.getState().project!.layers[0]
    return { startSec: l.startSec, endSec: l.endSec, c: l.content as VideoContent }
  })

/** px per second of the timeline (persisted zoom; 48 on a fresh profile). */
const pps = (page: Page): Promise<number> => page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)

test('trimming the right edge of a frozen clip keeps the hold time', async ({ appPage: page }) => {
  await arrangeFrozenClip(page)
  const scale = await pps(page)
  // The timeline block (a div); the LayersPanel row carries the same title on a span.
  const block = page.locator('div[title="Video"]')
  await expect(block).toBeVisible()

  // The block spans the full 12s window (10s source + 2s hold).
  const before = await block.boundingBox()
  expect(before!.width).toBeGreaterThan(11.5 * scale)

  // Drag the right-edge trim handle 1s left.
  const handle = block.locator('div.cursor-ew-resize').last()
  const hb = (await handle.boundingBox())!
  const cx = hb.x + hb.width / 2
  const cy = hb.y + hb.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - scale, cy, { steps: 5 })
  await page.mouse.up()

  const { endSec, c } = await layerState(page)
  // 9s of source + the 2s hold — the old bug collapsed this to ~9 (hold lost).
  expect(endSec).toBeGreaterThan(10.5)
  expect(endSec).toBeLessThan(11.5)
  expect(c.outSec).toBeGreaterThan(8.5)
  expect(c.outSec).toBeLessThan(9.5)
  expect(c.freezes).toEqual([{ atSec: 3, holdSec: 2 }])
})

test('dragging a block moves it in time without changing its duration', async ({ appPage: page }) => {
  await arrangeFrozenClip(page)
  const scale = await pps(page)
  // The timeline block (a div); the LayersPanel row carries the same title on a span.
  const block = page.locator('div[title="Video"]')
  const bb = (await block.boundingBox())!

  // Grab the block body (away from the edge handles) and drag 2s right.
  const gx = bb.x + bb.width / 2
  const gy = bb.y + bb.height / 2
  await page.mouse.move(gx, gy)
  await page.mouse.down()
  await page.mouse.move(gx + 2 * scale, gy, { steps: 5 })
  await page.mouse.up()

  const { startSec, endSec } = await layerState(page)
  expect(startSec).toBeGreaterThan(1.5)
  expect(startSec).toBeLessThan(2.5)
  expect(endSec - startSec).toBeCloseTo(12, 1) // window (incl. hold) preserved
})

test('S splits the selected clip at the playhead, partitioning the hold', async ({ appPage: page }) => {
  await arrangeFrozenClip(page)
  // Playhead at 7s (after the hold: source 5s) then split via the keybind.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(7))
  await page.keyboard.press('s')

  const layers = await page.evaluate(() =>
    window.__reelStores.useProject.getState().project!.layers.map((l) => ({
      startSec: l.startSec,
      endSec: l.endSec,
      c: l.content as import('../src/shared/project').VideoContent
    }))
  )
  expect(layers).toHaveLength(2)
  const [left, right] = layers
  expect(left.endSec).toBe(7)
  expect(left.c.outSec).toBeCloseTo(5, 5) // played 7s = source 5s through the 2s hold
  expect(left.c.freezes).toEqual([{ atSec: 3, holdSec: 2 }])
  expect(right.startSec).toBe(7)
  expect(right.c.inSec).toBeCloseTo(5, 5)
  expect(right.c.freezes).toBeUndefined()
  expect(right.endSec).toBe(12)
})

/** Drag from the centre of `box` by `dxPx`, with real pointer events. */
async function dragBy(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  dxPx: number
): Promise<void> {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + dxPx, cy, { steps: 8 })
  await page.mouse.up()
}

test('a freeze shows as a box over its hold on the clip tile', async ({ appPage: page }) => {
  await arrangeFrozenClip(page)
  const scale = await pps(page)
  const block = (await page.locator('div[title="Video"]').boundingBox())!
  const overlay = (await page.getByTestId('freeze-L1-0').boundingBox())!
  // Hold at source 3s for 2s → timeline 3..5s of the clip.
  expect(Math.abs(overlay.x - (block.x + 3 * scale))).toBeLessThan(4)
  expect(Math.abs(overlay.width - 2 * scale)).toBeLessThan(4)
})

test("dragging the freeze box's right edge changes the hold; one undo step", async ({ appPage: page }) => {
  await arrangeFrozenClip(page)
  const scale = await pps(page)
  await dragBy(page, (await page.getByTestId('freeze-edge-L1-0').boundingBox())!, scale)
  let s = await layerState(page)
  expect(s.c.freezes).toHaveLength(1)
  expect(s.c.freezes![0].holdSec).toBeCloseTo(3, 1)
  expect(s.endSec).toBeCloseTo(13, 1) // only this clip's end moved
  expect(s.c.outSec).toBe(10) // the footage is untouched

  await dragBy(page, (await page.getByTestId('freeze-edge-L1-0').boundingBox())!, -2.5 * scale)
  s = await layerState(page)
  expect(s.c.freezes![0].holdSec).toBeCloseTo(0.5, 1)
  expect(s.endSec).toBeCloseTo(10.5, 1)

  await page.keyboard.press('Control+z')
  s = await layerState(page)
  expect(s.c.freezes![0].holdSec).toBeCloseTo(3, 1)
})

test('dragging the clip right edge into a freeze cuts past it, then shortens the hold', async ({ appPage: page }) => {
  await arrangeFrozenClip(page) // hold at source 3s; the clip ends at 12s
  const scale = await pps(page)
  const block = page.locator('div[title="Video"]')
  // 8s left: the 7s of footage after the hold (source 3→10), then 1s of the hold.
  await dragBy(page, (await block.locator('div.cursor-ew-resize').last().boundingBox())!, -8 * scale)
  const s = await layerState(page)
  expect(s.c.outSec).toBeCloseTo(3, 1)
  expect(s.c.freezes).toHaveLength(1)
  expect(s.c.freezes![0].holdSec).toBeCloseTo(1, 1)
  expect(s.endSec).toBeCloseTo(4, 1)
})

test('a freeze on the last frame: the clip edge shortens the hold, the box edge (just inside) lengthens it', async ({
  appPage: page
}) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 0, 10, false)
    useProject.getState().addFreeze('L1', 10, 2) // window 0..12, held on the last frame
    useUi.getState().selectLayer('L1')
  })
  const scale = await pps(page)
  const block = page.locator('div[title="Video"]')
  await dragBy(page, (await block.locator('div.cursor-ew-resize').last().boundingBox())!, -scale)
  let s = await layerState(page)
  expect(s.c.outSec).toBe(10)
  expect(s.c.freezes![0].holdSec).toBeCloseTo(1, 1)
  expect(s.endSec).toBeCloseTo(11, 1)

  await dragBy(page, (await page.getByTestId('freeze-edge-L1-0').boundingBox())!, 2 * scale)
  s = await layerState(page)
  expect(s.c.outSec).toBe(10) // the box edge never touches the footage
  expect(s.c.freezes![0].holdSec).toBeCloseTo(3, 1)
  expect(s.endSec).toBeCloseTo(13, 1)
})

test('clicking a freeze picks it; Delete and Backspace remove just that freeze', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 0, 10, false)
    useProject.getState().addFreeze('L1', 3, 2)
    useProject.getState().addFreeze('L1', 7, 1) // window 0..13
  })
  const first = page.getByTestId('freeze-L1-0')
  await first.click()
  await expect(first).toHaveAttribute('data-picked', 'true')
  await page.keyboard.press('Delete')
  let s = await layerState(page)
  expect(s.c.freezes).toEqual([{ atSec: 7, holdSec: 1 }])
  expect(s.endSec).toBeCloseTo(11, 6)

  // The remaining freeze is now index 0. A press on its EDGE picks it too, and
  // without moving it leaves the hold alone (no re-time, no snap).
  await page.getByTestId('freeze-edge-L1-0').click()
  await expect(page.getByTestId('freeze-L1-0')).toHaveAttribute('data-picked', 'true')
  expect((await layerState(page)).c.freezes).toEqual([{ atSec: 7, holdSec: 1 }])
  await page.keyboard.press('Backspace')
  s = await layerState(page)
  expect(s.c.freezes).toBeUndefined()
  expect(s.endSec).toBeCloseTo(10, 6)
  // The clip itself stayed, and each removal is its own undo step.
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.length)).toBe(1)
  await page.keyboard.press('Control+z')
  expect((await layerState(page)).c.freezes).toEqual([{ atSec: 7, holdSec: 1 }])
})

test("a linked clip's freeze is shown but can't be picked or resized", async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 0, 10, true) // lands linked to its audio
    useProject.getState().addFreeze('L1', 3, 2)
  })
  const overlay = page.getByTestId('freeze-L1-0')
  await expect(overlay).toBeVisible()
  await expect(overlay).toHaveCSS('pointer-events', 'none')
  await expect(page.getByTestId('freeze-edge-L1-0')).toHaveCount(0)
})
