/**
 * Numeric Inspector fields must not fight the user mid-typing.
 *
 * Regression spec for the font-size field: it clamped on every keystroke, so the
 * field could never be emptied and any intermediate value below the minimum
 * snapped back instantly (clearing "90" to type "120" jumped to 12 and the caret
 * fought back). The shared `NumberInput` holds a draft string while focused and
 * clamps only on commit. jsdom can't express this — it is entirely about what
 * real keystrokes do to a controlled input.
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

const fontSizeInDoc = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const l = window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'T1')!
    return (l.content as { fontSizePx: number }).fontSizePx
  })

// The number field, not its paired slider (both are named "Font size").
const fontSizeField = (page: Page): ReturnType<Page['getByRole']> =>
  page.getByRole('spinbutton', { name: 'Font size' })

test('the field can be cleared while typing without snapping to the minimum', async ({
  appPage: page
}) => {
  await addTextLayer(page)
  const field = fontSizeField(page)
  await field.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')

  // THE BUG: this used to read "12" (the clamp firing on the empty string).
  await expect(field).toHaveValue('')
  // An empty field is a typing state, not an edit — the document is untouched.
  expect(await fontSizeInDoc(page)).toBe(90)
})

test('an intermediate value below the minimum survives until commit', async ({
  appPage: page
}) => {
  await addTextLayer(page)
  const field = fontSizeField(page)
  await field.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('120')

  // "1" and "12" pass through on the way to "120"; the field must show what was
  // typed at every step rather than clamping "1" up to "12".
  await expect(field).toHaveValue('120')
  expect(await fontSizeInDoc(page)).toBe(120)
})

test('an in-range value commits live, so the preview follows each keystroke', async ({
  appPage: page
}) => {
  await addTextLayer(page)
  const field = fontSizeField(page)
  await field.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('64')
  // Still focused — no blur yet.
  expect(await fontSizeInDoc(page)).toBe(64)
})

test('blur clamps a below-minimum value up to the minimum', async ({ appPage: page }) => {
  await addTextLayer(page)
  const field = fontSizeField(page)
  await field.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('3')
  expect(await fontSizeInDoc(page)).toBe(90) // 3 < 12: held in the draft, not committed
  await field.blur()
  await expect(field).toHaveValue('12')
  expect(await fontSizeInDoc(page)).toBe(12)
})

test('blurring an emptied field reverts to the last good value', async ({ appPage: page }) => {
  await addTextLayer(page)
  const field = fontSizeField(page)
  await field.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await field.blur()
  await expect(field).toHaveValue('90')
  expect(await fontSizeInDoc(page)).toBe(90)
})

test('Escape abandons the draft', async ({ appPage: page }) => {
  await addTextLayer(page)
  const field = fontSizeField(page)
  await field.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('7')
  await page.keyboard.press('Escape')
  await expect(field).toHaveValue('90')
  expect(await fontSizeInDoc(page)).toBe(90)
})

test('Enter commits and clamps', async ({ appPage: page }) => {
  await addTextLayer(page)
  const field = fontSizeField(page)
  await field.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('5')
  await page.keyboard.press('Enter')
  expect(await fontSizeInDoc(page)).toBe(12)
})

test('Start (s) cannot be set past End (s) — the layer never inverts', async ({ appPage: page }) => {
  // Regression (chaos QA 2026-10-15): with End = 4, typing Start = 50 stored start 50 / end 4.
  await addTextLayer(page)
  const start = page.getByRole('spinbutton', { name: 'Start (s)' })
  await start.fill('50')
  await start.press('Enter')
  const l = await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'T1')!)
  expect(l.endSec).toBe(4)
  expect(l.startSec).toBeLessThan(l.endSec)
  expect(l.startSec).toBeCloseTo(3.8)
})

// Regressions for #13 (chaos QA 2026-10-15).
const layerT1 = (page: Page): Promise<{ y: number; startSec: number }> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'T1')!)

test('letters in Position Y are not read as 0 — the text stays put', async ({ appPage: page }) => {
  // THE BUG: "abc" set y to 0, jumping the text to the top edge.
  await addTextLayer(page)
  const before = (await layerT1(page)).y
  const field = page.getByRole('spinbutton', { name: 'Position Y' })
  await field.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('abc')
  expect((await layerT1(page)).y).toBe(before)
  await field.blur()
  expect((await layerT1(page)).y).toBe(before)
  await expect(field).not.toHaveValue('0')
})

test('a decimal comma reads as a decimal point ("3,5" is 3.5, not 35)', async ({ appPage: page }) => {
  // THE BUG: Chromium's number input reads "," as a thousands separator, so "3,0" became 30.
  await addTextLayer(page)
  await page.evaluate(() => window.__reelStores.useProject.getState().updateLayer('T1', { endSec: 40 }))
  const start = page.getByRole('spinbutton', { name: 'Start (s)' })
  await start.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('3,5')
  await start.press('Enter')
  expect((await layerT1(page)).startSec).toBe(3.5)
})
