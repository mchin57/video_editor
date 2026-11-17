/**
 * The selected graphics mark's keyframes as diamonds on a SELECTED graphics
 * tile: placed at tSec x pxPerSec, click = move the playhead, drag = retime
 * (one undo step; a no-op drag records none; a neighbour is never crossed), click +
 * Delete = remove just that keyframe, double-click = remove, edge keyframes at 0 /
 * the tile end are grabbable,
 * the rest of the tile still moves it, and no selected mark = no diamonds.
 *
 * ARRANGE via `window.__reelStores`, ACT via real pointer/keyboard events,
 * ASSERT on store + DOM.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const kf = (tSec: number): Record<string, unknown> => ({
  tSec,
  dx: 0,
  dy: 0,
  scale: 1,
  rotationDeg: 0,
  opacity: 1,
  drawn: 1,
  color: '#ffd60a',
  widthPx: 8,
  easing: 'linear'
})

/** Tile G over 1..6s with mark M keyframed at 1 / 2.5 / 4 s; tile and mark selected. */
async function arrange(page: Page, kfTimes: number[] = [1, 2.5, 4]): Promise<void> {
  await page.evaluate((kfs) => {
    const { useProject, useUi, usePlayback } = window.__reelStores
    usePlayback.getState().setTime(0)
    useProject.getState().addLayer({
      id: 'G',
      hidden: false,
      startSec: 1,
      endSec: 6,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'graphics', marks: [] }
    })
    useProject.getState().updateGraphicsMarks('G', () => [
      {
        id: 'M',
        tool: 'rect',
        points: [
          { x: 200, y: 600 },
          { x: 600, y: 1000 }
        ],
        color: '#ffd60a',
        widthPx: 8,
        atSec: 0,
        entrance: { kind: 'instant', sec: 0.4 },
        keyframes: kfs
      } as never
    ])
    useUi.getState().selectLayer('G')
    useUi.getState().selectMark('M')
  }, kfTimes.map(kf))
  const tile = page.getByTestId('tile-layer-G')
  await expect(tile).toBeVisible()
  await tile.scrollIntoViewIfNeeded()
}

const times = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const l = window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'G')!
    const m = (l.content as unknown as { marks: { keyframes: { tSec: number }[] }[] }).marks[0]
    return m.keyframes.map((k) => k.tSec)
  })
const startSec = (page: Page): Promise<number> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'G')!.startSec)
const pastLen = (page: Page): Promise<number> =>
  page.evaluate(() => window.__reelStores.useProject.getState().past.length)
const pickedKf = (page: Page): Promise<number | null> =>
  page.evaluate(() => window.__reelStores.useUi.getState().selectedMarkKeyframe?.tSec ?? null)
const playhead = (page: Page): Promise<number> => page.evaluate(() => window.__reelStores.usePlayback.getState().time)

async function center(page: Page, i: number): Promise<{ x: number; y: number }> {
  const b = (await page.getByTestId(`mark-kf-diamond-${i}`).boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
async function dragDiamond(page: Page, i: number, dx: number): Promise<void> {
  const c = await center(page, i)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + dx, c.y, { steps: 10 })
  await page.mouse.up()
}

test('diamonds sit at tSec x pxPerSec, only with the tile and a keyframed mark selected', async ({ appPage: page }) => {
  await arrange(page)
  const tile = (await page.getByTestId('tile-layer-G').boundingBox())!
  const pps = tile.width / 5
  for (const [i, t] of [1, 2.5, 4].entries()) {
    const c = await center(page, i)
    expect(Math.abs(c.x - (tile.x + t * pps)), `diamond ${i}`).toBeLessThan(2.5)
  }
  await expect(page.getByTestId('mark-kf-diamond-3')).toHaveCount(0)

  await page.evaluate(() => window.__reelStores.useUi.getState().selectMark(null))
  await expect(page.getByTestId('mark-kf-diamond-0')).toHaveCount(0)
})

test('click moves the playhead to the keyframe; the diamond at the playhead is highlighted', async ({
  appPage: page
}) => {
  await arrange(page)
  const c = await center(page, 1)
  await page.mouse.click(c.x, c.y)
  expect(await playhead(page)).toBeCloseTo(3.5, 5)
  await expect(page.getByTestId('mark-kf-diamond-1')).toHaveAttribute('data-at-playhead', 'true')
  await expect(page.getByTestId('mark-kf-diamond-0')).not.toHaveAttribute('data-at-playhead', 'true')
})

test('dragging a diamond retimes it as ONE undo step; Ctrl+Z restores it', async ({ appPage: page }) => {
  await arrange(page)
  const tile = (await page.getByTestId('tile-layer-G').boundingBox())!
  const pps = tile.width / 5
  await dragDiamond(page, 0, 0.5 * pps)
  expect((await times(page))[0]).toBeCloseTo(1.5, 2)
  expect(await startSec(page)).toBe(1)
  await page.keyboard.press('Control+z')
  expect(await times(page)).toEqual([1, 2.5, 4])
})

test('a drag ACROSS a neighbour in one big move stops short of it, on its own side', async ({ appPage: page }) => {
  await arrange(page)
  const tile = (await page.getByTestId('tile-layer-G').boundingBox())!
  const pps = tile.width / 5
  const c = await center(page, 0)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + 2.25 * pps, c.y) // straight to 3.25 s: past the 2.5 s neighbour
  await page.mouse.up()
  const ts = await times(page)
  expect(ts).toHaveLength(3)
  expect(ts[0]).toBeLessThan(ts[1])
  expect(ts[1] - ts[0]).toBeGreaterThanOrEqual(0.02)
  expect(ts[1]).toBeCloseTo(2.5, 5)
  expect(ts[2]).toBeCloseTo(4, 5)
})

test('keyframes at tSec 0 and at the tile end are grabbable: drag (no trim) and click', async ({ appPage: page }) => {
  await arrange(page, [0, 2.5, 5])
  const tile = (await page.getByTestId('tile-layer-G').boundingBox())!
  const pps = tile.width / 5
  // Fully on the tile, not clipped.
  for (const i of [0, 2]) {
    const b = (await page.getByTestId(`mark-kf-diamond-${i}`).boundingBox())!
    expect(b.x).toBeGreaterThanOrEqual(tile.x)
    expect(b.x + b.width).toBeLessThanOrEqual(tile.x + tile.width)
  }
  // Click the first: picked, playhead on it.
  const c0 = await center(page, 0)
  await page.mouse.click(c0.x, c0.y)
  expect(await playhead(page)).toBeCloseTo(1, 5)
  expect(await pickedKf(page)).toBe(0)
  // Drag each inwards: a retime, never a trim.
  await dragDiamond(page, 0, 0.5 * pps)
  expect((await times(page))[0]).toBeCloseTo(0.5, 2)
  await dragDiamond(page, 2, -0.5 * pps)
  expect((await times(page))[2]).toBeCloseTo(4.5, 2)
  const l = await page.evaluate(() => {
    const x = window.__reelStores.useProject.getState().project!.layers.find((y) => y.id === 'G')!
    return [x.startSec, x.endSec]
  })
  expect(l).toEqual([1, 6])
  // And the end one can be clicked.
  const c2 = await center(page, 2)
  await page.mouse.click(c2.x, c2.y)
  expect(await pickedKf(page)).toBe(4.5)
})

test('a drag that ends where it began records no undo step', async ({ appPage: page }) => {
  await arrange(page)
  const tile = (await page.getByTestId('tile-layer-G').boundingBox())!
  const pps = tile.width / 5
  await dragDiamond(page, 0, 0.5 * pps) // a real edit first: 1 -> 1.5
  const past = await pastLen(page)
  const c = await center(page, 1) // 2.5 s
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + 40, c.y, { steps: 5 })
  await page.mouse.move(c.x, c.y, { steps: 5 })
  await page.mouse.up()
  expect(await times(page)).toEqual([1.5, 2.5, 4])
  expect(await pastLen(page)).toBe(past)
  await page.keyboard.press('Control+z') // undoes the drag BEFORE, not a no-op
  expect(await times(page)).toEqual([1, 2.5, 4])
})

test('click a diamond then Delete removes only that keyframe (one undo step)', async ({ appPage: page }) => {
  await arrange(page)
  const c = await center(page, 1)
  await page.mouse.click(c.x, c.y)
  await expect(page.getByTestId('mark-kf-diamond-1')).toHaveAttribute('data-picked', 'true')
  await page.keyboard.press('Delete')
  expect(await times(page)).toEqual([1, 4])
  const marks = await page.evaluate(
    () =>
      (
        window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'G')!.content as unknown as {
          marks: unknown[]
        }
      ).marks.length
  )
  expect(marks).toBe(1)
  await page.keyboard.press('Control+z')
  expect(await times(page)).toEqual([1, 2.5, 4])
  expect(
    await page.evaluate(
      () =>
        (
          window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'G')!.content as unknown as {
            marks: unknown[]
          }
        ).marks.length
    )
  ).toBe(1)
})

test('double-click removes a keyframe (one undo step)', async ({ appPage: page }) => {
  await arrange(page)
  const c = await center(page, 1)
  await page.mouse.dblclick(c.x, c.y)
  expect(await times(page)).toEqual([1, 4])
  await page.keyboard.press('Control+z')
  expect(await times(page)).toEqual([1, 2.5, 4])
})

test('a drag that starts away from the diamonds still moves the tile', async ({ appPage: page }) => {
  await arrange(page)
  const tile = (await page.getByTestId('tile-layer-G').boundingBox())!
  const pps = tile.width / 5
  await page.mouse.move(tile.x + 0.5 * pps, tile.y + 4)
  await page.mouse.down()
  await page.mouse.move(tile.x + 1.5 * pps, tile.y + 4, { steps: 8 })
  await page.mouse.up()
  expect(await startSec(page)).toBeGreaterThan(1.5)
  // The mark's keyframes ride along in layer time.
  expect(await times(page)).toEqual([1, 2.5, 4])
})
