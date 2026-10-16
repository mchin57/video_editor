/**
 * A huge End (s) must not crash or freeze the app.
 *
 * Regression specs for two chaos-QA bugs (2026-10-15): typing `1e999` into a
 * text layer's End (s) stored a 1e9 s End, `scaleTicks` threw "Invalid array
 * length", and with no error boundary the window went blank — and the autosaved
 * all-panels-closed layout came back on every restart. Typing `300000` froze the
 * app for minutes. Three fixes, each covered here:
 *  - the Inspector bounds End (s) by the assistant's rule (`maxItemEndSec`:
 *    edit duration + 60 s);
 *  - `scaleTicks` caps its tick count (unit-tested in `timescale.test.ts`; here,
 *    an End that bypasses the Inspector still draws);
 *  - each dock panel has its own error boundary.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const addTextLayer = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
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
        text: 'HELLO',
        fontFamily: 'inter',
        fontSizePx: 90,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 }
      }
    })
    useUi.getState().selectLayer('T1')
  })
}

const layerEnd = (page: Page): Promise<number> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.find((l) => l.id === 'T1')!.endSec)

/** Type into End (s) key by key, as a person (or a stuck key) would, then Enter. */
const typeEnd = async (page: Page, text: string): Promise<void> => {
  const end = page.getByRole('spinbutton', { name: 'End (s)' })
  await end.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** The window is still drawn and still answers: every panel is up, none crashed,
 *  and a real button still works. */
const expectUsable = async (page: Page): Promise<void> => {
  await expect(page.getByText('All panels closed')).toHaveCount(0)
  await expect(page.getByTestId('panel-error')).toHaveCount(0)
  await expect(page.getByTestId('timeline-scroll')).toBeVisible()
  const before = await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.length)
  await page.getByRole('button', { name: '＋ Text' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.length))
    .toBe(before + 1)
}

for (const typed of ['1e999', '300000']) {
  test(`typing End (s) = ${typed} on a layer keeps the app usable`, async ({ appPage: page }) => {
    await addTextLayer(page)
    await typeEnd(page, typed)
    // The rest of the edit is empty, so End may reach 0 + 60 s. 1e999 parses as
    // Infinity and reverts to the last live-committed keystroke ("1"); its
    // "1e9"/"1e99" prefixes must not land.
    const end = await layerEnd(page)
    expect(end).toBeLessThanOrEqual(60)
    expect(end).toBeGreaterThan(0)
    if (typed === '300000') expect(end).toBe(60)
    await expectUsable(page)
  })

  test(`typing End (s) = ${typed} on a caption keeps the app usable`, async ({ appPage: page }) => {
    await page.getByRole('button', { name: '＋ Caption' }).click()
    await typeEnd(page, typed)
    // No layers or audio: the edit is 0 s long (captions don't count, same as
    // set_text's measure), so End may reach 60 s.
    const seg = await page.evaluate(() => window.__reelStores.useProject.getState().project!.captions.segments[0])
    expect(seg.endSec).toBeLessThanOrEqual(60)
    expect(seg.endSec).toBeGreaterThan(seg.startSec)
    if (typed === '300000') expect(seg.endSec).toBe(60)
    await expectUsable(page)
  })
}

test('an End that bypasses the Inspector (old autosave, store) still draws the timeline', async ({ appPage: page }) => {
  await addTextLayer(page)
  const t0 = Date.now()
  await page.evaluate(() => window.__reelStores.useProject.getState().updateLayer('T1', { endSec: 1e9 }))
  await expectUsable(page)
  expect(Date.now() - t0).toBeLessThan(20_000)
})

test("one panel's render error stays in that panel and clears on undo", async ({ appPage: page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // A text layer missing its pill: the panels that draw text (preview,
  // Inspector) throw on it; the store accepts it.
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addLayer({
      id: 'BAD', hidden: false, startSec: 0, endSec: 2, x: 540, y: 960, scale: 1,
      content: { kind: 'text', text: 'X', fontFamily: 'inter', fontSizePx: 90, color: '#ffffff' }
    } as never)
    useUi.getState().selectLayer('BAD')
  })
  await expect(page.getByTestId('panel-error').first()).toBeVisible()
  await expect(page.getByText('All panels closed')).toHaveCount(0)
  // The other panels keep drawing.
  await expect(page.getByTestId('timeline-scroll')).toBeVisible()
  await expect(page.getByTestId('tile-layer-BAD')).toBeVisible()
  // The header (outside the dock) still answers.
  await expect(page.getByRole('button', { name: /File/ }).first()).toBeVisible()

  // Undo removes the bad layer; the project change retries the crashed panels.
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('panel-error')).toHaveCount(0)
  await expectUsable(page)
  // Caught by the boundaries, so nothing reached the window as uncaught.
  expect(errors).toEqual([])
})
