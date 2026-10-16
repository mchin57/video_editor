/**
 * ＋ Caption (timeline toolbar, next to ＋ Text) adds a caption at the playhead
 * that behaves like every other caption: lane style (no override), in the
 * caption lane, selected, one undo step, and it splits with S.
 *
 * ARRANGE via the stores, ACT via the real button and keys, ASSERT on store + DOM.
 */
import { test, expect } from './fixtures'

test('＋ Caption adds a lane-styled caption at the playhead; undo removes it; S splits it', async ({ appPage: page }) => {
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1.5))
  const read = (): Promise<{ enabled: boolean; segs: { id: string; startSec: number; endSec: number; text: string; style?: unknown }[]; sel: string | null }> =>
    page.evaluate(() => {
      const p = window.__reelStores.useProject.getState().project!
      return { enabled: p.captions.enabled, segs: p.captions.segments, sel: window.__reelStores.useUi.getState().selectedCaptionId }
    })
  expect((await read()).segs).toHaveLength(0)

  await page.getByRole('button', { name: '＋ Caption' }).click()
  const after = await read()
  expect(after.enabled).toBe(true)
  expect(after.segs).toHaveLength(1)
  const seg = after.segs[0]
  expect(seg.text).toBe('Your caption here')
  expect(seg.style ?? null).toBeNull()
  expect(after.sel).toBe(seg.id)
  const t0 = await page.evaluate(() => window.__reelStores.usePlayback.getState().time)
  expect(seg.startSec).toBeCloseTo(t0)
  await expect(page.getByTestId(`tile-caption-${seg.id}`)).toBeVisible()

  // Splits like any caption: playhead into it, S.
  await page.evaluate((t) => window.__reelStores.usePlayback.getState().setTime(t), seg.startSec + 1)
  await page.keyboard.press('s')
  expect((await read()).segs).toHaveLength(2)

  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  expect((await read()).segs).toHaveLength(0)
})
