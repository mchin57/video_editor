/**
 * The Inspector's Font size and Padding share set_text's caps (#6).
 *
 * Regression spec for a chaos-QA bug (2026-10-16): Font size `1e999` stored
 * 1e99 (and 9999 was accepted), Padding `1e5` stored 100000 — and from ~30000
 * up the export silently dropped the layer's pill AND text. Both fields now
 * clamp to `TEXT_FONT_SIZE_MAX` / `TEXT_PILL_PAD_MAX` (shared/textStyle.ts).
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const addPillText = async (page: Page): Promise<void> => {
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
        pill: { enabled: true, color: '#000000cc', padPx: 18 }
      }
    })
    useUi.getState().selectLayer('T1')
  })
}

const style = (page: Page): Promise<{ fontSizePx: number; padPx: number }> =>
  page.evaluate(() => {
    const c = window.__reelStores.useProject.getState().project!.layers.find((l) => l.id === 'T1')!.content as {
      fontSizePx: number
      pill: { padPx: number }
    }
    return { fontSizePx: c.fontSizePx, padPx: c.pill.padPx }
  })

const typeInto = async (page: Page, name: string, text: string): Promise<void> => {
  await page.getByRole('spinbutton', { name }).click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

for (const typed of ['1e999', '9999', '1e5']) {
  test(`Font size ${typed} is capped at 1000`, async ({ appPage: page }) => {
    await addPillText(page)
    await typeInto(page, 'Font size', typed)
    const { fontSizePx } = await style(page)
    expect(fontSizePx).toBeLessThanOrEqual(1000)
    expect(fontSizePx).toBeGreaterThanOrEqual(12)
    if (typed !== '1e999') expect(fontSizePx).toBe(1000)
  })
}

for (const typed of ['1e5', '30000', '1e999']) {
  test(`Padding ${typed} is capped at 200`, async ({ appPage: page }) => {
    await addPillText(page)
    await typeInto(page, 'Padding', typed)
    const { padPx } = await style(page)
    expect(padPx).toBeLessThanOrEqual(200)
    expect(padPx).toBeGreaterThanOrEqual(0)
    if (typed !== '1e999') expect(padPx).toBe(200)
  })
}
