/**
 * Regression for "freeze holds survive trim and split" plus a basic block-move
 * drag (docs/TIMELINE.md manual checklist item). ARRANGE via store actions —
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
