/**
 * Drawing on a graphics tile with real pointer events: an armed tool draws
 * into the selected tile at the playhead (drag = size, click = default mark,
 * angle = three clicks), then disarms; marks drag as a whole and by their
 * point handles (one undo step each); Escape disarms without deselecting; a
 * mark on an UNselected tile can be grabbed straight from the stage; a draw-on
 * traces in the preview over the reveal.
 *
 * ARRANGE via the stores, ACT via real pointer/keyboard events on the preview
 * canvas, ASSERT on store + DOM.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

interface Pt {
  x: number
  y: number
}
interface Mark {
  id: string
  tool: string
  points: Pt[]
  atSec: number
  reveal: string
}

/** Logical canvas px → a screen point on the preview canvas. */
async function screen(page: Page, p: Pt): Promise<Pt> {
  const r = (await page.getByTestId('preview-canvas').boundingBox())!
  return { x: r.x + (p.x / 1080) * r.width, y: r.y + (p.y / 1920) * r.height }
}
/** Logical px per screen px — the tolerance a pointer round trip can lose. */
async function slop(page: Page): Promise<number> {
  const r = (await page.getByTestId('preview-canvas').boundingBox())!
  return (1080 / r.width) * 1.5
}
async function drag(page: Page, from: Pt, to: Pt): Promise<void> {
  const a = await screen(page, from)
  const b = await screen(page, to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await page.mouse.up()
}
async function click(page: Page, p: Pt): Promise<void> {
  const s = await screen(page, p)
  await page.mouse.click(s.x, s.y)
}
const marks = (page: Page): Promise<Mark[]> =>
  page.evaluate(() => {
    const l = window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'G')!
    return (l.content as unknown as { marks: Mark[] }).marks
  })
const ui = (page: Page): Promise<{ tool: string | null; mark: string | null; layer: string | null }> =>
  page.evaluate(() => {
    const s = window.__reelStores.useUi.getState()
    return { tool: s.graphicsTool, mark: s.selectedMarkId, layer: s.selectedLayerId }
  })
const expectNear = (got: Pt, want: Pt, tol: number): void => {
  expect(Math.abs(got.x - want.x), `x ${got.x} vs ${want.x}`).toBeLessThanOrEqual(tol)
  expect(Math.abs(got.y - want.y), `y ${got.y} vs ${want.y}`).toBeLessThanOrEqual(tol)
}

/** An empty graphics tile G over 1..6s, selected, playhead at its start. */
async function arrange(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject, useUi, usePlayback } = window.__reelStores
    usePlayback.getState().setTime(1)
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
    useUi.getState().selectLayer('G')
  })
  await expect(page.getByTestId('inspector-kind')).toHaveText('Graphics layer')
}

test('an armed tool draws one mark at the playhead, then disarms with the mark selected', async ({ appPage: page }) => {
  await arrange(page)
  const tol = await slop(page)

  await page.getByTestId('graphics-tool-arrow').click()
  expect((await ui(page)).tool).toBe('arrow')
  await drag(page, { x: 200, y: 1400 }, { x: 600, y: 1000 })
  let ms = await marks(page)
  expect(ms).toHaveLength(1)
  expect(ms[0].tool).toBe('arrow')
  expectNear(ms[0].points[0], { x: 200, y: 1400 }, tol)
  expectNear(ms[0].points[1], { x: 600, y: 1000 }, tol)
  expect(ms[0].atSec).toBeCloseTo(0)
  expect(await ui(page)).toEqual({ tool: null, mark: ms[0].id, layer: 'G' })

  // A second mark drawn 1s later appears 1s into the tile; a click drops a
  // default-sized rectangle centred on it.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2))
  await page.getByTestId('graphics-tool-rect').click()
  await click(page, { x: 540, y: 600 })
  ms = await marks(page)
  expect(ms).toHaveLength(2)
  expect(ms[1].tool).toBe('rect')
  expect(ms[1].atSec).toBeCloseTo(1)
  expectNear(
    { x: (ms[1].points[0].x + ms[1].points[1].x) / 2, y: (ms[1].points[0].y + ms[1].points[1].y) / 2 },
    { x: 540, y: 600 },
    tol
  )

  // Each drawn mark was one undo step.
  await page.keyboard.press('Control+z')
  expect(await marks(page)).toHaveLength(1)
})

test('an angle is three clicks — joint, then each limb — and shows its degrees', async ({ appPage: page }) => {
  await arrange(page)
  await page.getByTestId('graphics-tool-angle').click()
  await click(page, { x: 540, y: 900 })
  await click(page, { x: 840, y: 900 })
  expect(await marks(page)).toHaveLength(0) // still placing
  await click(page, { x: 540, y: 600 })
  const ms = await marks(page)
  expect(ms).toHaveLength(1)
  expect(ms[0].tool).toBe('angle')
  await expect(page.getByTestId('graphics-layer').locator('text')).toHaveText('90°')
  await expect(page.getByTestId('graphics-marks')).toContainText('Angle 90°')
})

test('marks drag whole and by their point handles, one undo step each; Escape disarms only', async ({
  appPage: page
}) => {
  await arrange(page)
  const tol = await slop(page)
  await page.getByTestId('graphics-tool-line').click()
  await drag(page, { x: 200, y: 960 }, { x: 800, y: 960 })
  const [line] = await marks(page)

  // Grab the middle of the line and move it.
  await drag(page, { x: 500, y: 960 }, { x: 600, y: 1060 })
  let [moved] = await marks(page)
  expectNear(moved.points[0], { x: line.points[0].x + 100, y: line.points[0].y + 100 }, tol)
  expectNear(moved.points[1], { x: line.points[1].x + 100, y: line.points[1].y + 100 }, tol)
  await page.keyboard.press('Control+z')
  ;[moved] = await marks(page)
  expect(moved.points).toEqual(line.points)

  // The selected mark's end handle moves just that end.
  const h = (await page.getByTestId('mark-point-1').boundingBox())!
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await page.mouse.down()
  const to = await screen(page, { x: 800, y: 1300 })
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  ;[moved] = await marks(page)
  expect(moved.points[0]).toEqual(line.points[0])
  expectNear(moved.points[1], { x: 800, y: 1300 }, tol)
  await page.keyboard.press('Control+z')
  ;[moved] = await marks(page)
  expect(moved.points).toEqual(line.points)

  // Escape disarms an armed tool but keeps the tile selected.
  await page.getByTestId('graphics-tool-ellipse').click()
  await page.keyboard.press('Escape')
  expect(await ui(page)).toMatchObject({ tool: null, layer: 'G' })
  // A press with nothing armed draws nothing.
  await click(page, { x: 300, y: 300 })
  expect(await marks(page)).toHaveLength(1)
})

test('a mark on an unselected tile is grabbed straight from the stage', async ({ appPage: page }) => {
  await arrange(page)
  await page.getByTestId('graphics-tool-line').click()
  await drag(page, { x: 200, y: 700 }, { x: 800, y: 700 })
  await page.evaluate(() => window.__reelStores.useUi.getState().clearSelection())
  await click(page, { x: 500, y: 700 })
  const s = await ui(page)
  expect(s.layer).toBe('G')
  expect(s.mark).toBe((await marks(page))[0].id)
})

test('a draw-on traces in over the reveal; the Inspector deletes a mark', async ({ appPage: page }) => {
  await arrange(page)
  await page.getByTestId('graphics-tool-line').click()
  await drag(page, { x: 100, y: 960 }, { x: 900, y: 960 })
  await page.getByTestId('mark-reveal').selectOption('draw')
  const [m] = await marks(page)
  expect(m.reveal).toBe('draw')
  const d = (): Promise<string | null> =>
    page.getByTestId('graphics-layer').locator(`[data-mark-id="${m.id}"] path`).getAttribute('d')
  // Halfway through the 0.4s reveal the line reaches its middle…
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1.2))
  const half = (await d())!
  const tipX = Number(half.split('L')[1].trim().split(' ')[0])
  expect(tipX).toBeGreaterThan(m.points[0].x + (m.points[1].x - m.points[0].x) * 0.45)
  expect(tipX).toBeLessThan(m.points[0].x + (m.points[1].x - m.points[0].x) * 0.55)
  // …and it's whole once the reveal is over.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2))
  expect(Number((await d())!.split('L')[1].trim().split(' ')[0])).toBeCloseTo(m.points[1].x, 0)

  await page.getByTestId('mark-delete-0').click()
  expect(await marks(page)).toHaveLength(0)
})

test('arming a tool with the playhead outside the tile brings it in, so the pen works', async ({ appPage: page }) => {
  await arrange(page)
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(8)) // past the tile
  await page.getByTestId('graphics-tool-line').click()
  expect(await page.evaluate(() => window.__reelStores.usePlayback.getState().time)).toBeCloseTo(1)
  await drag(page, { x: 200, y: 500 }, { x: 700, y: 500 })
  expect(await marks(page)).toHaveLength(1)
})

test('Delete removes just the selected mark; the tile stays', async ({ appPage: page }) => {
  await arrange(page)
  for (const y of [500, 900]) {
    await page.getByTestId('graphics-tool-line').click()
    await drag(page, { x: 200, y }, { x: 700, y })
  }
  const [first, second] = await marks(page)
  expect((await ui(page)).mark).toBe(second.id)
  await page.keyboard.press('Delete')
  expect((await marks(page)).map((m) => m.id)).toEqual([first.id])
  expect((await ui(page)).layer).toBe('G')
  // With no mark selected, Delete takes the tile as before.
  await page.keyboard.press('Delete')
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.length)).toBe(0)
})

test('trimming the tile start and splitting it keep every mark at its moment', async ({ appPage: page }) => {
  await arrange(page) // G over 1..6s
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(3))
  await page.getByTestId('graphics-tool-arrow').click()
  await drag(page, { x: 200, y: 1400 }, { x: 600, y: 1000 })
  const absolute = async (): Promise<number> =>
    page.evaluate(() => {
      const l = window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'G')!
      return l.startSec + (l.content as unknown as { marks: Mark[] }).marks[0].atSec
    })
  expect(await absolute()).toBeCloseTo(3)

  // Drag the tile's left edge ~1s later (a lone tile: the single-tile trim path).
  const tile = page.getByTestId('tile-layer-G')
  await tile.scrollIntoViewIfNeeded()
  const box = (await tile.boundingBox())!
  const pxPerSec = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tile-layer-G"]') as HTMLElement
    return el.getBoundingClientRect().width / 5
  })
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 2 + pxPerSec, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  const start = await page.evaluate(
    () => window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'G')!.startSec
  )
  expect(start).toBeGreaterThan(1.5)
  expect(await absolute()).toBeCloseTo(3, 1)

  // S at 4s splits it; the right half's copy of the arrow is already on screen.
  await page.evaluate(() => {
    window.__reelStores.useUi.getState().selectLayer('G')
    window.__reelStores.usePlayback.getState().setTime(4)
  })
  await page.keyboard.press('s')
  const halves = await page.evaluate(() =>
    window.__reelStores.useProject
      .getState()
      .project!.layers.map((l) => ({ start: l.startSec, marks: (l.content as unknown as { marks: Mark[] }).marks }))
  )
  expect(halves).toHaveLength(2)
  expect(halves[1].start).toBeCloseTo(4)
  expect(halves[1].marks[0]).toMatchObject({ atSec: 0, reveal: 'pop' })
  expect(halves[1].marks[0].id).not.toBe(halves[0].marks[0].id)
})
