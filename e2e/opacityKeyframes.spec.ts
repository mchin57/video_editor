/**
 * Keyframed opacity: the Inspector's per-keyframe % input writes
 * `LayerKeyframe.opacity`, and the preview applies the interpolated value as
 * CSS opacity on the layer box (the export drives the same numbers through
 * sendcmd → colorchannelmixer). ARRANGE via store, ACT via the real input,
 * ASSERT on store + computed style.
 */
import { test, expect } from './fixtures'

test('keyframe opacity input drives the store and the preview fades', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 0, 10, false)
    useUi.getState().selectLayer('L1')
    usePlayback.getState().setTime(0)
    useProject.getState().addLayerKeyframe('L1', 0)
    useProject.getState().addLayerKeyframe('L1', 4)
  })

  // Set the SECOND keyframe to 20% via the real Inspector input.
  const opInputs = page.getByTitle('Layer opacity at this keyframe (%) — fades linearly between keyframes')
  await expect(opInputs).toHaveCount(2)
  await opInputs.nth(1).fill('20')

  const kfs = await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0].keyframes)
  expect(kfs![0].opacity).toBeUndefined() // untouched keyframe stays absent (=1)
  expect(kfs![1].opacity).toBeCloseTo(0.2, 9)

  // Halfway (t=2) the interpolated opacity is 0.6 — the preview box carries it.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2))
  const boxOpacity = await page.locator('[data-resizebox]').evaluate((el) => getComputedStyle(el).opacity)
  expect(Number(boxOpacity)).toBeCloseTo(0.6, 2)

  // At/after the last keyframe it holds 0.2.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(4))
  const endOpacity = await page.locator('[data-resizebox]').evaluate((el) => getComputedStyle(el).opacity)
  expect(Number(endOpacity)).toBeCloseTo(0.2, 2)
})
