/**
 * Regression: dragging the RIGHTMOST tile leftwards used to accelerate.
 *
 * The track's width is derived from the project's total duration, so moving the
 * last tile left shrinks the scrollable area mid-drag. The browser then clamps
 * `scrollLeft` down to the new maximum, that clamp feeds into the drag's `dx`
 * (which adds the live `scrollLeft`), the tile jumps further left, and the width
 * shrinks again — a runaway that reads as the edge auto-scroll speeding up even
 * though its rate is flat. `dragFloorW` pins the width for the drag's lifetime.
 *
 * The assertion is the invariant rather than a scroll RATE: rate sampling would
 * be timing-dependent and flaky, while "the scrollable width never shrinks
 * during a horizontal drag" is exactly what breaks the feedback loop, and it is
 * deterministic. The vertical twin (`resizeFloorH`) has guarded lane resizes
 * this way for a while; this is the horizontal case catching up.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const scrollWidth = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelector('[data-testid="timeline-scroll"]')!.scrollWidth)

const scrollLeftOf = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelector('[data-testid="timeline-scroll"]')!.scrollLeft)

const startOf = (page: Page, id: string): Promise<number> =>
  page.evaluate(
    (lid) => window.__reelStores.useProject.getState().project!.layers.find((l) => l.id === lid)!.startSec,
    id
  )

/** One clip far out on the timeline, so the track is much wider than the pane
 *  and the clip is the only thing defining the total duration. */
async function arrangeFarOutClip(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 60, 8, false)
    useUi.getState().clearSelection()
  })
}

test('the scrollable width never shrinks while dragging a tile leftwards', async ({ appPage: page }) => {
  await arrangeFarOutClip(page)

  // Scroll out to the clip and grab it.
  await page.getByTestId('tile-layer-L1').scrollIntoViewIfNeeded()
  const tile = page.getByTestId('tile-layer-L1')
  const box = (await tile.boundingBox())!
  const widthAtGrab = await scrollWidth(page)
  expect(widthAtGrab).toBeGreaterThan(0)

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()

  // Walk the pointer left in steps, sampling the scrollable width each time.
  // Before the fix this shrank on every step and the clip ran away leftwards.
  const widths: number[] = []
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width / 2 - i * 40, box.y + box.height / 2)
    widths.push(await scrollWidth(page))
  }
  await page.mouse.up()

  for (const w of widths) expect(w).toBeGreaterThanOrEqual(widthAtGrab)
})

test('reversing mid-drag (right, then left without releasing) still never shrinks', async ({ appPage: page }) => {
  // Owner-reported after the first fix: pinning the width ONCE at grab time
  // leaves a stale floor. Dragging right grows the natural width past it, so
  // dragging back left is free to shrink through that band and the runaway
  // returns. The floor has to ratchet with the drag.
  await arrangeFarOutClip(page)
  await page.getByTestId('tile-layer-L1').scrollIntoViewIfNeeded()
  const box = (await page.getByTestId('tile-layer-L1').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  await page.mouse.move(cx, cy)
  await page.mouse.down()

  // Out to the right first — this is what grows the track past the grab width.
  for (let i = 1; i <= 5; i++) await page.mouse.move(cx + i * 40, cy)
  const peak = await scrollWidth(page)

  // ...then all the way back left, still holding.
  const widths: number[] = []
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(cx + 200 - i * 40, cy)
    widths.push(await scrollWidth(page))
  }
  await page.mouse.up()

  // Every sample on the way back must hold at the peak the drag reached.
  for (const w of widths) expect(w).toBeGreaterThanOrEqual(peak)
})

test('the width is released after the drag, so the track settles to its content', async ({ appPage: page }) => {
  await arrangeFarOutClip(page)
  await page.getByTestId('tile-layer-L1').scrollIntoViewIfNeeded()
  const tile = page.getByTestId('tile-layer-L1')
  const box = (await tile.boundingBox())!
  const before = await scrollWidth(page)

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 300, box.y + box.height / 2)
  await page.mouse.up()

  // The clip really moved left...
  expect(await startOf(page, 'L1')).toBeLessThan(60)
  // ...and the pin is gone, so the track is narrower than it was pinned at.
  await expect.poll(() => scrollWidth(page)).toBeLessThan(before)
})

test('a leftward drag moves the tile by the pointer distance, not a runaway multiple', async ({ appPage: page }) => {
  await arrangeFarOutClip(page)
  await page.getByTestId('tile-layer-L1').scrollIntoViewIfNeeded()
  const tile = page.getByTestId('tile-layer-L1')
  const box = (await tile.boundingBox())!
  const pps = await page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)
  const scrollBefore = await scrollLeftOf(page)

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  // Stay well inside the pane so the edge auto-scroller never engages: this
  // isolates the feedback loop from the (separate, intended) edge scrolling.
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2)

  // Sampled DURING the drag: after release the pin lifts and the track settles,
  // which legitimately clamps scrollLeft — that is the intended behaviour, not
  // the bug, so measuring it afterwards would test the wrong moment.
  const scrollDuring = await scrollLeftOf(page)
  const movedDuring = await startOf(page, 'L1')
  await page.mouse.up()

  // The pin holds the width, so nothing clamps the scroll out from under the
  // drag...
  expect(scrollDuring).toBe(scrollBefore)
  // ...and the tile moves by exactly the pointer distance. The runaway showed
  // up here as a move of several times 200px worth.
  expect(movedDuring).toBeCloseTo(60 - 200 / pps, 1)
})
