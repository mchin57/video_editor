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

  // Grab the line off its middle (the selected mark's pivot handle sits there) and move it.
  await drag(page, { x: 350, y: 960 }, { x: 450, y: 1060 })
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

  // S at 4s splits it; the right half keeps the arrow's moment (3s, before its start).
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
  expect(halves[1].marks[0].atSec).toBeCloseTo(-1)
  expect(halves[1].marks[0].id).not.toBe(halves[0].marks[0].id)
})

test('a connected line is a click per point, finished by a double-click or Enter; Escape drops it', async ({
  appPage: page
}) => {
  await arrange(page)
  const tol = await slop(page)
  const pts = [
    { x: 200, y: 600 },
    { x: 500, y: 900 },
    { x: 300, y: 1200 },
    { x: 800, y: 1300 }
  ]

  // Three clicks, then a double-click on the fourth point: one mark, no duplicate.
  await page.getByTestId('graphics-tool-polyline').click()
  for (const p of pts.slice(0, 3)) await click(page, p)
  expect(await marks(page)).toHaveLength(0) // still placing
  const last = await screen(page, pts[3])
  await page.mouse.dblclick(last.x, last.y)
  let ms = await marks(page)
  expect(ms).toHaveLength(1)
  expect(ms[0].tool).toBe('polyline')
  expect(ms[0].points).toHaveLength(4)
  ms[0].points.forEach((p, i) => expectNear(p, pts[i], tol))
  expect(await ui(page)).toEqual({ tool: null, mark: ms[0].id, layer: 'G' })
  for (let i = 0; i < 4; i++) await expect(page.getByTestId(`mark-point-${i}`)).toBeVisible()
  await expect(page.getByTestId('mark-point-4')).toHaveCount(0)

  // Two clicks and Enter: a two-point mark.
  await page.getByTestId('graphics-tool-polyline').click()
  await click(page, { x: 100, y: 300 })
  await click(page, { x: 600, y: 300 })
  await page.keyboard.press('Enter')
  ms = await marks(page)
  expect(ms).toHaveLength(2)
  expect(ms[1].points).toHaveLength(2)
  expect((await ui(page)).tool).toBeNull()

  // Escape mid-line drops what was placed.
  await page.getByTestId('graphics-tool-polyline').click()
  await click(page, { x: 100, y: 400 })
  await click(page, { x: 600, y: 400 })
  await page.keyboard.press('Escape')
  expect(await ui(page)).toMatchObject({ tool: null, layer: 'G' })
  expect(await marks(page)).toHaveLength(2)
  // Re-arming starts clean: one new point and Enter is still too few to finish
  // (leftover points from before the Escape would make it a line).
  await page.getByTestId('graphics-tool-polyline').click()
  await click(page, { x: 100, y: 500 })
  await page.keyboard.press('Enter')
  expect(await marks(page)).toHaveLength(2)
  expect((await ui(page)).tool).toBe('polyline')
})

test('a teardrop is dragged tip to round end; its fill and width are in the Inspector', async ({ appPage: page }) => {
  await arrange(page)
  const tol = await slop(page)
  await page.getByTestId('graphics-tool-teardrop').click()
  await drag(page, { x: 540, y: 500 }, { x: 540, y: 1000 })
  const [m] = await marks(page)
  expect(m.tool).toBe('teardrop')
  expect(m.points).toHaveLength(2)
  expectNear(m.points[0], { x: 540, y: 500 }, tol)
  expectNear(m.points[1], { x: 540, y: 1000 }, tol)

  const path = page.getByTestId('graphics-layer').locator(`[data-mark-id="${m.id}"] path`)
  await expect(path).toHaveAttribute('fill', 'none')
  await page.getByLabel('Fill', { exact: true }).check()
  await expect(path).not.toHaveAttribute('fill', 'none')

  await page.getByLabel('Drop width').fill('90')
  const dropWidth = await page.evaluate(() => {
    const l = window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'G')!
    return (l.content as unknown as { marks: { dropWidth?: number }[] }).marks[0].dropWidth
  })
  expect(dropWidth).toBeCloseTo(0.9)
})

test("a filled shape's border can go to 0; turning the fill off restores a visible border", async ({
  appPage: page
}) => {
  await arrange(page)
  await page.getByTestId('graphics-tool-rect').click()
  await drag(page, { x: 200, y: 600 }, { x: 700, y: 1000 })
  const [m] = await marks(page)
  const path = page.getByTestId('graphics-layer').locator(`[data-mark-id="${m.id}"] path`)

  await expect(page.getByText('Border · 8px')).toBeVisible()
  // Without a fill the border can't go below 2.
  await expect(page.getByLabel('Border width')).toHaveAttribute('min', '2')
  await page.getByLabel('Fill', { exact: true }).check()
  await expect(page.getByLabel('Border width')).toHaveAttribute('min', '0')
  await page.getByLabel('Border width').fill('0')
  await expect(page.getByText('Border · 0px')).toBeVisible()
  await expect(path).toHaveAttribute('stroke', 'none')

  // A fully see-through fill can't go borderless either: the border comes back.
  await page.getByLabel('Fill opacity').fill('0')
  await expect(page.getByText('Border · 8px')).toBeVisible()
  await expect(page.getByLabel('Border width')).toHaveAttribute('min', '2')
  await page.getByLabel('Fill opacity').fill('40')
  await page.getByLabel('Border width').fill('0')
  await expect(page.getByText('Border · 0px')).toBeVisible()

  await page.getByLabel('Fill', { exact: true }).uncheck()
  await expect(page.getByText('Border · 8px')).toBeVisible()
  await expect(path).not.toHaveAttribute('stroke', 'none')
})

// --- Per-mark animation (keyframes, pivot) ---------------------------------------

interface AnimMark extends Mark {
  color: string
  keyframes?: {
    tSec: number
    dx: number
    dy: number
    rotationDeg: number
    scale: number
    color: string
    easing: string
  }[]
  pivot?: Pt
}
const animMarks = (page: Page): Promise<AnimMark[]> => marks(page) as unknown as Promise<AnimMark[]>
const kf = (tSec: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tSec,
  dx: 0,
  dy: 0,
  scale: 1,
  rotationDeg: 0,
  opacity: 1,
  drawn: 1,
  color: '#ffd60a',
  widthPx: 8,
  easing: 'linear',
  ...extra
})

/** Tile G over 1..6s holding one rectangle M (200,600)–(600,1000), selected, playhead at `time`. */
async function arrangeRect(page: Page, extra: Record<string, unknown>, time: number): Promise<void> {
  await arrange(page)
  await page.evaluate(
    ({ extra, time }) => {
      const { useProject, useUi, usePlayback } = window.__reelStores
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
          reveal: 'pop',
          ...extra
        } as never
      ])
      useUi.getState().selectMark('M')
      usePlayback.getState().setTime(time)
    },
    { extra, time }
  )
}
const markGroupTransform = (page: Page): Promise<string | null> =>
  page.getByTestId('graphics-layer').locator('[data-mark-id="M"] > g').getAttribute('transform')

test('keyframes added in the Inspector animate the shape: the preview eases between them', async ({
  appPage: page
}) => {
  await arrangeRect(page, {}, 1)
  // A keyframe at the tile start (as drawn), then rotate 90° and double the size 2s later.
  await page.getByTestId('mark-add-keyframe').click()
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(3))
  await page.getByLabel('Mark rotation').fill('90')
  await page.getByLabel('Mark rotation').press('Enter')
  await page.getByLabel('Mark size %').fill('200')
  await page.getByLabel('Mark size %').press('Enter')
  const ks = (await animMarks(page))[0].keyframes!
  expect(ks).toHaveLength(2)
  expect(ks[0].tSec).toBeCloseTo(0)
  expect(ks[1].tSec).toBeCloseTo(2)
  expect(ks[1].rotationDeg).toBe(90)
  expect(ks[1].scale).toBeCloseTo(2)

  // At the start it is as drawn; at the end turned and doubled.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1))
  expect(await markGroupTransform(page)).toBeNull()
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(3))
  expect(await markGroupTransform(page)).toContain('rotate(90) scale(2)')
  // Halfway (ease-in-out → 0.5): 45° and 150%.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2))
  expect(await markGroupTransform(page)).toContain('rotate(45) scale(1.5)')
  // A quarter of the way the ease has barely moved: 90 × 0.0625.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1.5))
  expect(await markGroupTransform(page)).toContain('rotate(5.63)')
  // The fields follow the playhead.
  await expect(page.getByLabel('Mark rotation')).toHaveValue('6')
  // The easing is editable per keyframe.
  await page.getByTestId('mark-kf-easing-0').selectOption('linear')
  expect((await animMarks(page))[0].keyframes![0].easing).toBe('linear')
})

test('with keyframes, dragging the shape writes a keyframe at the playhead — one undo step', async ({
  appPage: page
}) => {
  const tol = await slop(page)
  await arrangeRect(page, { keyframes: [kf(0), kf(2, { dx: 200 })] }, 2) // local 1: 100px along
  const before = (await animMarks(page))[0]
  // At local 1 the rectangle's left edge is at x = 300. Grab it there, well off the pivot.
  await drag(page, { x: 300, y: 800 }, { x: 300, y: 900 })
  const after = (await animMarks(page))[0]
  expect(after.points).toEqual(before.points)
  expect(after.keyframes).toHaveLength(3)
  const mid = after.keyframes![1]
  expect(mid.tSec).toBeCloseTo(1)
  expect(Math.abs(mid.dx - 100)).toBeLessThanOrEqual(tol)
  expect(Math.abs(mid.dy - 100)).toBeLessThanOrEqual(tol)
  await page.keyboard.press('Control+z')
  expect((await animMarks(page))[0].keyframes).toEqual(before.keyframes)
})

test('the pivot handle drags and sets the mark’s pivot — one undo step; Centre pivot clears it', async ({
  appPage: page
}) => {
  const tol = await slop(page)
  await arrangeRect(page, {}, 1)
  const pivot = page.getByTestId('mark-pivot')
  await expect(pivot).toBeVisible()
  // It sits at the centre of the rectangle: (400, 800).
  const c = await screen(page, { x: 400, y: 800 })
  const b = (await pivot.boundingBox())!
  expect(Math.abs(b.x + b.width / 2 - c.x)).toBeLessThan(3)
  expect(Math.abs(b.y + b.height / 2 - c.y)).toBeLessThan(3)
  await drag(page, { x: 400, y: 800 }, { x: 250, y: 650 })
  expectNear((await animMarks(page))[0].pivot!, { x: 250, y: 650 }, tol)
  await page.keyboard.press('Control+z')
  expect((await animMarks(page))[0].pivot).toBeUndefined()

  // On a mark with a static rotation, moving the pivot must not move the drawing.
  await page.getByLabel('Mark rotation').fill('90')
  await page.getByLabel('Mark rotation').press('Enter')
  const drawnPts = async (): Promise<Pt[]> => {
    const m = (await animMarks(page))[0] as AnimMark & { rotationDeg?: number; points: Pt[] }
    const p = m.pivot ?? { x: 400, y: 800 }
    const r = ((m.rotationDeg ?? 0) * Math.PI) / 180
    return m.points.map((q) => ({
      x: p.x + (q.x - p.x) * Math.cos(r) - (q.y - p.y) * Math.sin(r),
      y: p.y + (q.x - p.x) * Math.sin(r) + (q.y - p.y) * Math.cos(r)
    }))
  }
  const drawnBefore = await drawnPts()
  await drag(page, { x: 400, y: 800 }, { x: 250, y: 650 })
  expectNear((await animMarks(page))[0].pivot!, { x: 250, y: 650 }, tol)
  const drawnAfter = await drawnPts()
  expectNear(drawnAfter[0], drawnBefore[0], tol)
  expectNear(drawnAfter[1], drawnBefore[1], tol)
  await page.keyboard.press('Control+z')
  expect((await animMarks(page))[0].pivot).toBeUndefined()
  await drag(page, { x: 400, y: 800 }, { x: 250, y: 650 })
  await page.getByTestId('mark-centre-pivot').click()
  expect((await animMarks(page))[0].pivot).toBeUndefined()
})

test('editing Border color on a keyframed shape writes the keyframe, not the base', async ({ appPage: page }) => {
  await arrangeRect(page, { keyframes: [kf(0), kf(2, { dx: 200 })] }, 3) // local 2: on the last keyframe
  await page.getByTestId('mark-color').fill('#ff0000')
  const m = (await animMarks(page))[0]
  expect(m.color).toBe('#ffd60a')
  expect(m.keyframes).toHaveLength(2)
  expect(m.keyframes![1].color).toBe('#ff0000')
  expect(m.keyframes![0].color).toBe('#ffd60a')
  // Between keyframes a colour edit adds one there.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2))
  await page.getByTestId('mark-color').fill('#00ff00')
  expect((await animMarks(page))[0].keyframes).toHaveLength(3)
})
