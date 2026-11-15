/**
 * Regression (#218): a caption dragged along the timeline must take its word
 * timings with it. A split rebuilds each half's text from the words on its side
 * of the cut; the drag used to move only the caption's start and end, so every
 * word stayed where the caption had been and both halves showed the whole text.
 * ARRANGE via store, ACT with a real drag and the S key, ASSERT on the store.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

/** px per second of the timeline (persisted zoom; 48 on a fresh profile). */
const pps = (page: Page): Promise<number> => page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)

test('a caption dragged to a new time splits between its words', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    const s = useProject.getState()
    s.addVideoLayer('L1', 'no-such-media', 0, 12, false)
    s.setCaptions({
      ...useProject.getState().project!.captions,
      enabled: true,
      segments: [
        {
          id: 'c1',
          startSec: 0,
          endSec: 4,
          text: 'one two three four',
          words: ['one', 'two', 'three', 'four'].map((text, i) => ({ text, startSec: i, endSec: i + 1 })),
          enabled: true
        }
      ]
    })
    useUi.getState().clearSelection()
  })
  const scale = await pps(page)
  const tile = page.getByTestId('tile-caption-c1')
  await expect(tile).toBeVisible()

  // Drag the caption 5 s to the right by its body. (A lane below the panel's
  // visible height is scrolled off: bring the tile under the pointer first.)
  await tile.scrollIntoViewIfNeeded()
  const b = (await tile.boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 5 * scale, y, { steps: 8 })
  await page.mouse.up()

  const caption = (): Promise<{ startSec: number; endSec: number; text: string; words: { startSec: number }[] }[]> =>
    page.evaluate(() =>
      window.__reelStores.useProject.getState().project!.captions.segments.map((c) => ({
        startSec: c.startSec,
        endSec: c.endSec,
        text: c.text,
        words: c.words
      }))
    )
  const [moved] = await caption()
  expect(moved.startSec).toBeGreaterThan(4) // well clear of where the words used to be
  expect(moved.endSec - moved.startSec).toBeCloseTo(4, 5)
  // Each word is still one second after the last, counted from the new start.
  moved.words.forEach((w, i) => expect(w.startSec).toBeCloseTo(moved.startSec + i, 5))

  // The drag left the caption selected: cut it between "two" and "three".
  await page.evaluate((t) => window.__reelStores.usePlayback.getState().setTime(t), moved.startSec + 2)
  await page.keyboard.press('s')
  expect((await caption()).map((c) => c.text)).toEqual(['one two', 'three four'])
})
