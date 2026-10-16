/**
 * Timeline tile titles sit in the top-left corner on every tile kind (TODO ▸
 * Timeline ▸ "Timeline tile titles go top-left"), with the badges on the same
 * row, and nothing clips on a tall lane.
 *
 * ARRANGE via the stores, ASSERT on the DOM: the title's top is within a few px of
 * the tile's top, and its left edge is near the tile's left (after any thumbnail).
 */
import { test, expect } from './fixtures'

test('tile titles are anchored top-left on layer, caption and audio tiles', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.addLayer({
      id: 'T1', hidden: false, startSec: 0, endSec: 3, x: 540, y: 960, scale: 1,
      content: { kind: 'text', text: 'HELLO', fontFamily: 'inter', fontSizePx: 90, color: '#ffffff', pill: { enabled: false, color: '#000000ff', padPx: 18 } }
    })
    s.addAudioClip({ id: 'A1', mediaId: 'media-a', startSec: 0, inSec: 0, outSec: 3, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, duck: false, kind: 'music', mute: true })
    s.addCaption({ id: 'C1', startSec: 0, endSec: 3, text: 'Hi there', words: [], enabled: true })
  })
  for (const id of ['tile-layer-T1', 'tile-audio-A1', 'tile-caption-C1']) {
    const tile = page.getByTestId(id)
    await tile.scrollIntoViewIfNeeded()
    const pos = await tile.evaluate((el) => {
      const t = el.getBoundingClientRect()
      const title = [...el.querySelectorAll('span')].find((s) => s.classList.contains('truncate'))!
      const r = title.getBoundingClientRect()
      return { dTop: r.top - t.top, dLeft: r.left - t.left, fits: r.bottom <= t.bottom + 0.5 }
    })
    expect(pos.dTop, id).toBeLessThanOrEqual(4)
    expect(pos.dLeft, id).toBeLessThanOrEqual(10)
    expect(pos.fits, id).toBe(true)
  }
  // The audio tile's 🔇 badge shares the title row.
  const row = await page.getByTestId('tile-audio-A1').evaluate((el) => {
    const t = el.getBoundingClientRect()
    const badge = el.querySelector('[title^="Muted"]')!.getBoundingClientRect()
    return badge.top - t.top
  })
  expect(row).toBeLessThanOrEqual(4)
})
