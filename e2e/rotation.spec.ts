/**
 * Free-angle rotation on the canvas — ONE rotate handle for text, media and
 * captions (`RotateHandle` + `shared/rotation.ts`).
 *
 * The unit tests pin the angle/resize MATH; only real pointer events prove the
 * handle sits where it should (above the top-middle, turning with the box), that
 * a drag rotates with snapping and records ONE undo step, that resize handles on
 * a rotated box work along the box's own axes, and that a caption rotates by the
 * same rule it moves by.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const addText = async (page: Page, over: Record<string, unknown> = {}): Promise<void> => {
  await page.evaluate((over) => {
    const { useProject, useUi, usePlayback } = window.__reelStores
    useProject.getState().addLayer({
      id: 'T1',
      hidden: false,
      startSec: 0,
      endSec: 4,
      x: 540,
      y: 960,
      scale: 1,
      ...over,
      content: {
        kind: 'text',
        text: 'ROTATE ME',
        fontFamily: 'inter',
        fontSizePx: 90,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 }
      }
    })
    useUi.getState().selectLayer('T1')
    usePlayback.getState().setTime(1)
  }, over)
}

const center = async (page: Page, sel: string): Promise<{ x: number; y: number }> => {
  const b = (await page.locator(sel).first().boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

const layer = (
  page: Page
): Promise<{ rotationDeg?: number; x: number; y: number; stretchX?: number; content: { widthPx?: number } }> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0] as never)

/** Sweep the pointer from its start round `c` by `deg` (clockwise), in steps. */
const sweep = async (
  page: Page,
  c: { x: number; y: number },
  from: { x: number; y: number },
  deg: number
): Promise<void> => {
  const r = Math.hypot(from.x - c.x, from.y - c.y)
  const a0 = Math.atan2(from.y - c.y, from.x - c.x)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    const a = a0 + ((deg * Math.PI) / 180) * (i / 8)
    await page.mouse.move(c.x + r * Math.cos(a), c.y + r * Math.sin(a))
  }
  await page.mouse.up()
}

test('the rotate handle sits above the top-middle and turns the text, snapping, in one undo step', async ({
  appPage: page
}) => {
  await addText(page)
  const handle = page.locator('[data-handle="rotate"]')
  await expect(handle).toBeVisible()

  const c = await center(page, '[data-resizebox]')
  const h0 = await center(page, '[data-handle="rotate"]')
  // Upright: straight above the centre (and above the top edge).
  expect(Math.abs(h0.x - c.x)).toBeLessThan(2)
  expect(h0.y).toBeLessThan(c.y)

  const past = await page.evaluate(() => window.__reelStores.useProject.getState().past.length)
  // ~88° sweep: lands on 90 by the right-angle snap.
  await sweep(page, c, h0, 88)
  expect((await layer(page)).rotationDeg).toBe(90)
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().past.length)).toBe(past + 1)

  // Turned with the box: now to the RIGHT of the centre, level with it.
  const h1 = await center(page, '[data-handle="rotate"]')
  expect(h1.x).toBeGreaterThan(c.x)
  expect(Math.abs(h1.y - c.y)).toBeLessThan(3)
  // The drawn text box turned too.
  const t = await page
    .locator('[data-resizebox]')
    .evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform))
  expect(Math.round((Math.atan2(t.b, t.a) * 180) / Math.PI)).toBe(90)

  await page.evaluate(() => window.__reelStores.useProject.getState().undo())
  expect((await layer(page)).rotationDeg ?? 0).toBe(0)
})

test('a free drag keeps its angle; Shift steps by 15°', async ({ appPage: page }) => {
  await addText(page)
  const c = await center(page, '[data-resizebox]')
  await sweep(page, c, await center(page, '[data-handle="rotate"]'), 40)
  const free = (await layer(page)).rotationDeg!
  expect(free).toBeGreaterThan(36)
  expect(free).toBeLessThan(44)

  await page.keyboard.down('Shift')
  await sweep(page, c, await center(page, '[data-handle="rotate"]'), 22)
  await page.keyboard.up('Shift')
  expect((await layer(page)).rotationDeg! % 15).toBe(0)
})

test('resize handles on a rotated text box work along its own axis', async ({ appPage: page }) => {
  await addText(page, { rotationDeg: 90 })
  const c = await center(page, '[data-resizebox]')
  // At 90° the box's "e" side faces DOWN the screen.
  const e = await center(page, '[data-handle="e"]')
  expect(e.y).toBeGreaterThan(c.y + 20)
  expect(Math.abs(e.x - c.x)).toBeLessThan(3)

  const before = await layer(page)
  await page.mouse.move(e.x, e.y)
  await page.mouse.down()
  await page.mouse.move(e.x, e.y + 30)
  await page.mouse.move(e.x, e.y + 60)
  await page.mouse.up()
  const after = await layer(page)
  // Dragging down along the rotated side widened the wrap box and moved the
  // centre down (the opposite side stays put) — not sideways.
  expect(after.content.widthPx).toBeGreaterThan(0)
  expect(after.y).toBeGreaterThan(before.y + 10)
  expect(Math.abs(after.x - before.x)).toBeLessThan(1)
})

test('a rotated media box stretches along its own axis', async ({ appPage: page }) => {
  // A video layer whose media is absent still renders its (placeholder) box
  // through the same mediaBox + handles path.
  await page.evaluate(() => {
    const { useProject, useUi, usePlayback } = window.__reelStores
    useProject.getState().addLayer({
      id: 'V1',
      hidden: false,
      startSec: 0,
      endSec: 4,
      x: 540,
      y: 960,
      scale: 0.4,
      rotationDeg: 90,
      content: { kind: 'video', mediaId: 'nope', inSec: 0, outSec: 4, mute: false, gainDb: 0 }
    })
    useUi.getState().selectLayer('V1')
    usePlayback.getState().setTime(1)
  })
  const e = await center(page, '[data-handle="e"]')
  await page.mouse.move(e.x, e.y)
  await page.mouse.down()
  await page.mouse.move(e.x + 40, e.y + 50)
  await page.mouse.up()
  const l = await layer(page)
  expect(l.stretchX).toBeGreaterThan(1)
  expect(Math.abs(l.x - 540)).toBeLessThan(1) // only the down component counts at 90°
  expect(l.y).toBeGreaterThan(960 + 10) // the centre follows the rotated side down
  expect(l.rotationDeg).toBe(90)
})

test('captions get the same rotate handle; rotating one creates its override', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi, usePlayback } = window.__reelStores
    const cap = useProject.getState().project!.captions
    useProject.getState().setCaptions({
      ...cap,
      enabled: true,
      segments: [{ id: 'c0', startSec: 0, endSec: 4, text: 'a caption', words: [], enabled: true }]
    })
    useUi.getState().selectCaption('c0')
    usePlayback.getState().setTime(1)
  })
  const handle = page.locator('[data-handle="rotate"]')
  await expect(handle).toBeVisible()
  // Text-only: no resize handles on a caption.
  await expect(page.locator('[data-handle="e"]')).toHaveCount(0)

  const c = await center(page, '[data-resizebox]')
  await sweep(page, c, await center(page, '[data-handle="rotate"]'), -88)
  const caps = await page.evaluate(() => window.__reelStores.useProject.getState().project!.captions)
  expect(caps.segments[0].style?.rotationDeg).toBe(-90)
  expect(caps.style.rotationDeg).toBe(0) // the lane style is untouched
})
