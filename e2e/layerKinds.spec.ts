/**
 * Every layer kind is named and iconed for what it is (#98: a compound clip
 * showed as "Text layer" in the Inspector and with the text icon in the Layers
 * panel). ARRANGE via store actions, ASSERT on the Inspector heading and the
 * Layers panel row.
 */
import { test, expect } from './fixtures'

test('a text layer turned into a compound clip is titled and iconed as a compound clip', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi, usePlayback } = window.__reelStores
    useProject.getState().addLayer({
      id: 'T',
      hidden: false,
      startSec: 0,
      endSec: 3,
      x: 540,
      y: 960,
      scale: 1,
      content: {
        kind: 'text',
        text: 'Hook',
        fontFamily: 'inter',
        fontSizePx: 76,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000', padPx: 0 }
      }
    })
    usePlayback.getState().setTime(1)
    useUi.getState().selectLayer('T')
  })
  const heading = page.getByTestId('inspector-kind')
  const icon = page.getByTestId('layer-kind-icon')
  await expect(heading).toHaveText('Text layer')
  await expect(icon).toHaveText('🅣')

  // Convert at the root (no entering), keep it selected.
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().convertLayerToComp('T')
    useUi.getState().selectLayer('T')
  })
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0].content.kind)).toBe(
    'compound'
  )
  await expect(heading).toHaveText('Compound clip')
  await expect(icon).toHaveText('🧩')
})
