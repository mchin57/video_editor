/**
 * The font-size slider (shared `Slider` in components/ui.tsx): a real pointer
 * drag resizes the text live, and the WHOLE drag is one undo step — the store
 * gesture (`beginGesture`/`endGesture`) swallows the per-tick history entries a
 * plain `onPatch` would otherwise record. jsdom can't drive a native range
 * input's drag, so this lives here.
 */
import { test, expect } from './fixtures'

test('dragging the font size slider resizes the text and undoes in one step', async ({ appPage: page }) => {
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
        text: 'BIG TEXT',
        fontFamily: 'inter',
        fontSizePx: 90,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 }
      }
    })
    useUi.getState().selectLayer('T1')
    usePlayback.getState().setTime(0)
  })

  const fontSize = (): Promise<number> =>
    page.evaluate(
      () => (window.__reelStores.useProject.getState().project!.layers[0].content as { fontSizePx: number }).fontSizePx
    )
  const historyLen = (): Promise<number> => page.evaluate(() => window.__reelStores.useProject.getState().past.length)

  const slider = page.getByRole('slider', { name: 'Font size' })
  await slider.scrollIntoViewIfNeeded()
  const box = (await slider.boundingBox())!
  const pastBefore = await historyLen()

  // ACT: a real multi-step drag along the track.
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * 0.2, y)
  await page.mouse.down()
  for (const f of [0.3, 0.4, 0.5, 0.6]) await page.mouse.move(box.x + box.width * f, y)
  await page.mouse.up()

  const after = await fontSize()
  expect(after).toBeGreaterThan(150)
  // The paired number field follows the slider.
  await expect(slider.locator('xpath=following-sibling::input[@type="number"]')).toHaveValue(String(after))
  expect(await historyLen()).toBe(pastBefore + 1)

  // One undo restores the pre-drag size.
  await page.evaluate(() => window.__reelStores.useProject.getState().undo())
  expect(await fontSize()).toBe(90)
})
