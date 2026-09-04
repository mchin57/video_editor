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

const fontSizeField = (page: Page): ReturnType<Page['getByLabel']> =>
  page.getByLabel('Font size')

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
