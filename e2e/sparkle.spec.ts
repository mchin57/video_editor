/**
 * Text effects: the Inspector's Sparkles toggle drives `TextContent.effects`,
 * and the preview draws playhead-driven sparkles above the glyphs.
 *
 * The unit tests pin the sparkle MATH and the ASS event strings; only the app
 * proves the toggle reaches the document and that the preview actually paints
 * them — and that they are driven by the playhead rather than by wall-clock CSS
 * animation, which is what keeps scrubbing exact and the burn in step.
 */
import { test, expect } from './fixtures'

const addTextLayer = async (page: import('@playwright/test').Page): Promise<void> => {
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
        text: 'SPARKLE TIME',
        fontFamily: 'inter',
        fontSizePx: 90,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 }
      }
    })
    useUi.getState().selectLayer('T1')
    usePlayback.getState().setTime(0)
  })
}

const sparkleCount = (page: import('@playwright/test').Page): Promise<number> =>
  page.locator('[data-sparkle]').count()

test('the Sparkles toggle writes the document and paints the preview', async ({
  appPage: page
}) => {
  await addTextLayer(page)

  // Off by default — nothing painted.
  expect(await sparkleCount(page)).toBe(0)

  // ACT: the real Inspector checkbox.
  await page.getByText('✧ Sparkles').click()

  const effects = await page.evaluate(
    () =>
      (
        window.__reelStores.useProject.getState().project!.layers[0].content as {
          effects?: { sparkle?: { density: number; color: string } | null }
        }
      ).effects
  )
  expect(effects?.sparkle?.density).toBeGreaterThan(0)

  // The preview paints sparkles somewhere across the layer's window. Sparkles
  // are born over time, so scan rather than assume any one instant is busy.
  let sawSparkles = false
  for (const t of [0.4, 0.9, 1.4, 1.9, 2.4, 2.9, 3.4]) {
    await page.evaluate((time) => window.__reelStores.usePlayback.getState().setTime(time), t)
    if ((await sparkleCount(page)) > 0) {
      sawSparkles = true
      break
    }
  }
  expect(sawSparkles).toBe(true)
})

test('sparkles follow the playhead rather than wall-clock animation', async ({
  appPage: page
}) => {
  await addTextLayer(page)
  await page.getByText('✧ Sparkles').click()

  // Scrubbing to the same time twice must give the identical picture — a CSS
  // animation would drift with elapsed time instead.
  const shotAt = async (t: number): Promise<string> => {
    await page.evaluate((time) => window.__reelStores.usePlayback.getState().setTime(time), t)
    return page.evaluate(() =>
      [...document.querySelectorAll('[data-sparkle]')]
        .map((el) => (el as HTMLElement).style.transform + '|' + (el as HTMLElement).style.opacity)
        .join(';')
    )
  }

  const first = await shotAt(1.5)
  await shotAt(3.2) // scrub away
  const again = await shotAt(1.5) // and back
  expect(again).toBe(first)

  // A different time genuinely looks different (the effect is animating).
  const elsewhere = await shotAt(2.6)
  expect(elsewhere).not.toBe(first)
})

test('sparkles are removed from the document when toggled back off', async ({
  appPage: page
}) => {
  await addTextLayer(page)
  const toggle = page.getByText('✧ Sparkles')
  await toggle.click()
  await toggle.click()

  const sparkle = await page.evaluate(
    () =>
      (
        window.__reelStores.useProject.getState().project!.layers[0].content as {
          effects?: { sparkle?: unknown }
        }
      ).effects?.sparkle
  )
  expect(sparkle).toBeNull()
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1.5))
  expect(await sparkleCount(page)).toBe(0)
})
