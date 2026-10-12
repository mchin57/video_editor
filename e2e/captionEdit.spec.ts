/**
 * Regression: a caption's text typed into the Inspector must survive a split.
 * Splitting rebuilds each half's text from the caption's WORD timings, and the
 * text box used to change only `text` — so the next split brought the old
 * (mis-transcribed) words back. ARRANGE via store, ACT with real clicks/typing/
 * the S key, ASSERT on the store.
 */
import { test, expect } from './fixtures'

test('a caption fixed in the Inspector keeps the fix when it is split', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    const s = useProject.getState()
    s.addVideoLayer('L1', 'no-such-media', 0, 10, false)
    s.setCaptions({
      ...useProject.getState().project!.captions,
      enabled: true,
      segments: [
        {
          id: 'c1',
          startSec: 2,
          endSec: 4,
          text: 'helo wrld',
          words: [
            { text: 'helo', startSec: 2, endSec: 2.8 },
            { text: 'wrld', startSec: 3, endSec: 3.8 }
          ],
          enabled: true
        }
      ]
    })
    useUi.getState().clearSelection()
  })

  await page.getByTestId('tile-caption-c1').click()
  const box = page.getByRole('textbox', { name: 'Text', exact: true })
  await box.click()
  await page.keyboard.press('Control+A')
  // Real keystrokes: the half-typed states ("h", "hello ") have a different word
  // count and must not wear down the original timings.
  await page.keyboard.type('hello world')
  await expect(box).toHaveValue('hello world')

  // Leave the text box (a tile click keeps focus where it was), caption still selected.
  await box.blur()
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2.9))
  await page.keyboard.press('s')

  const segs = await page.evaluate(() =>
    window.__reelStores.useProject.getState().project!.captions.segments.map((c) => ({ text: c.text, words: c.words }))
  )
  expect(segs.map((c) => c.text)).toEqual(['hello', 'world'])
  // The original word timings survived the typing.
  expect(segs[0].words).toEqual([{ text: 'hello', startSec: 2, endSec: 2.8 }])
  expect(segs[1].words).toEqual([{ text: 'world', startSec: 3, endSec: 3.8 }])
})
