/**
 * Simple straight-line motion (`shared/motion.ts`): the Inspector's "Add
 * motion" starts a two-keyframe move AT THE PLAYHEAD from where the layer is;
 * the canvas draws the path with a dot at each end; dragging a dot moves that
 * end only; dragging the layer itself moves the WHOLE path (it never grows a
 * third keyframe); text follows it in the preview.
 *
 * The unit tests pin the math and the ASS strings; only real pointer events
 * prove the canvas side.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

type Kf = { tSec: number; x: number; y: number; scale: number }

const addText = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const { useProject, useUi, usePlayback } = window.__reelStores
    useProject.getState().addLayer({
      id: 'T1',
      hidden: false,
      startSec: 0,
      endSec: 4,
      x: 540,
      y: 960,
      scale: 1,
      content: {
        kind: 'text',
        text: 'MOVE ME',
        fontFamily: 'inter',
        fontSizePx: 80,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 }
      }
    })
    useUi.getState().selectLayer('T1')
    usePlayback.getState().setTime(1)
  })
}

const layer0 = (page: Page): Promise<{ x: number; y: number; keyframes?: Kf[] }> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0] as never)

/** Screen centre of a locator. */
const centre = async (page: Page, sel: string): Promise<{ x: number; y: number }> => {
  const b = (await page.locator(sel).first().boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Screen px → logical px of the canonical canvas. */
const logicalPerPx = async (page: Page): Promise<number> => {
  const b = (await page.getByTestId('preview-canvas').boundingBox())!
  return 1080 / b.width
}

const drag = async (page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2)
  await page.mouse.move(from.x + dx, from.y + dy)
  await page.mouse.up()
}

test('Add motion starts a move at the playhead from where the text is; the text follows it', async ({ appPage: page }) => {
  await addText(page)
  await page.getByRole('button', { name: /Add motion/ }).click()

  const l = await layer0(page)
  expect(l.keyframes).toHaveLength(2)
  const [a, b] = [...l.keyframes!].sort((p, q) => p.tSec - q.tSec)
  expect(a).toMatchObject({ tSec: 1, x: 540, y: 960 })
  expect(b.tSec).toBeCloseTo(2, 6) // default 1s
  expect(b.x).toBe(810) // a quarter frame to the right
  await expect(page.getByTestId('motion-path')).toBeVisible()
  await expect(page.locator('[data-motion="start"]')).toBeVisible()
  await expect(page.locator('[data-motion="end"]')).toBeVisible()

  // Halfway through the move the text is halfway along it.
  const k = await logicalPerPx(page)
  const canvas = (await page.getByTestId('preview-canvas').boundingBox())!
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1.5))
  await expect
    .poll(async () => ((await centre(page, '[data-resizebox]')).x - canvas.x) * k)
    .toBeGreaterThan(670)
  expect(((await centre(page, '[data-resizebox]')).x - canvas.x) * k).toBeLessThan(680)
})

test('dragging an end dot moves only that end, in one undo step', async ({ appPage: page }) => {
  await addText(page)
  await page.getByRole('button', { name: /Add motion/ }).click()
  const k = await logicalPerPx(page)
  const past = await page.evaluate(() => window.__reelStores.useProject.getState().past.length)

  await drag(page, await centre(page, '[data-motion="end"]'), 0, 100)
  const [a, b] = [...(await layer0(page)).keyframes!].sort((p, q) => p.tSec - q.tSec)
  expect(a).toMatchObject({ x: 540, y: 960 })
  expect(b.x).toBeCloseTo(810, 0)
  expect(b.y).toBeGreaterThan(960 + 100 * k - 3)
  expect(b.y).toBeLessThan(960 + 100 * k + 3)
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().past.length)).toBe(past + 1)
})

test('dragging the layer moves the whole path — it never grows a keyframe', async ({ appPage: page }) => {
  await addText(page)
  await page.getByRole('button', { name: /Add motion/ }).click()
  const k = await logicalPerPx(page)

  // Grab the text off-centre: at the playhead it sits ON its start point, and
  // the (small) start dot is drawn above it so it stays grabbable.
  const c = await centre(page, '[data-resizebox]')
  await drag(page, { x: c.x - 40, y: c.y }, -60, 40)
  const l = await layer0(page)
  expect(l.keyframes).toHaveLength(2)
  const [a, b] = [...l.keyframes!].sort((p, q) => p.tSec - q.tSec)
  expect(a.x).toBeCloseTo(540 - 60 * k, 0)
  expect(b.x).toBeCloseTo(810 - 60 * k, 0)
  expect(a.y).toBeCloseTo(960 + 40 * k, 0)
  expect(b.y).toBeCloseTo(960 + 40 * k, 0)
})

test('a media layer on a path moves whole too (not a keyframe at the playhead)', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi, usePlayback } = window.__reelStores
    useProject.getState().addLayer({
      id: 'V1',
      hidden: false,
      startSec: 0,
      endSec: 4,
      x: 400,
      y: 900,
      scale: 0.4,
      keyframes: [
        { tSec: 1, x: 400, y: 900, scale: 0.4 },
        { tSec: 3, x: 700, y: 900, scale: 0.4 }
      ],
      content: { kind: 'video', mediaId: 'nope', inSec: 0, outSec: 4, mute: false, gainDb: 0 }
    })
    useUi.getState().selectLayer('V1')
    usePlayback.getState().setTime(2)
  })
  const k = await logicalPerPx(page)
  await drag(page, await centre(page, '[data-resizebox]'), 0, 50)
  const l = await layer0(page)
  expect(l.keyframes).toHaveLength(2)
  const ys = l.keyframes!.map((f) => f.y)
  for (const y of ys) expect(y).toBeCloseTo(900 + 50 * k, 0)
})

test('Remove motion clears it and leaves the text where the move started', async ({ appPage: page }) => {
  await addText(page)
  await page.getByRole('button', { name: /Add motion/ }).click()
  await drag(page, await centre(page, '[data-motion="start"]'), 30, 0)
  const start = [...(await layer0(page)).keyframes!].sort((p, q) => p.tSec - q.tSec)[0]
  await page.getByRole('button', { name: 'Remove motion' }).click()
  const l = await layer0(page)
  expect(l.keyframes ?? []).toHaveLength(0)
  expect(l.x).toBeCloseTo(start.x, 6)
  await expect(page.getByTestId('motion-path')).toHaveCount(0)
})
