/**
 * #18: double-clicking text on the preview edits it IN PLACE. Before, it did
 * nothing, so a first-time user typing a title there (focus still on a button)
 * fired the single-key shortcuts: S split, T a new text layer, Space play.
 * Now the keys go into the text; the whole session is one undo step.
 *
 * ARRANGE via store actions, ACT via a real double-click and real typing on the
 * preview, ASSERT on the store and DOM.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const addText = (page: Page, text = 'HELLO'): Promise<void> =>
  page.evaluate((text) => {
    const { useProject } = window.__reelStores
    useProject.getState().addLayer({
      id: 'T1', hidden: false, startSec: 0, endSec: 4, x: 540, y: 960, scale: 1,
      content: { kind: 'text', text, fontFamily: 'montserrat-extrabold', fontSizePx: 90, color: '#ffffff', pill: { enabled: false, color: '#000000cc', padPx: 18 } }
    })
  }, text)

const state = (page: Page): Promise<{ text: string; layers: number; past: number; playing: boolean }> =>
  page.evaluate(() => {
    const { useProject, usePlayback } = window.__reelStores
    const s = useProject.getState()
    return {
      text: (s.project!.layers.find((l) => l.id === 'T1')!.content as { text: string }).text,
      layers: s.project!.layers.length,
      past: s.past.length,
      playing: usePlayback.getState().playing
    }
  })

/** The preview's text block for `text` (the box the double-click lands on). */
const previewText = (page: Page, text: string): ReturnType<Page['locator']> =>
  page.getByTestId('preview-canvas').getByText(text, { exact: true }).first()

test('double-click the preview text, type a title: it edits the text and fires no shortcut', async ({ appPage: page }) => {
  await addText(page)
  const before = await state(page)
  await previewText(page, 'HELLO').dblclick()
  const editor = page.getByTestId('inline-text-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toBeFocused()

  // The old text is selected, so typing replaces it. "s", "t" and " " are all shortcuts.
  await page.keyboard.type('Swim start, test set')
  expect(await state(page)).toMatchObject({ text: 'Swim start, test set', layers: before.layers, playing: false })
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect(previewText(page, 'Swim start, test set')).toBeVisible()

  // One undo step for the whole session.
  const after = await state(page)
  expect(after.past).toBe(before.past + 1)
  await page.keyboard.press('Control+z')
  expect((await state(page)).text).toBe('HELLO')
})

test('Enter makes a new line; clicking away finishes; an unchanged session records nothing', async ({ appPage: page }) => {
  await addText(page, 'TOP')
  await previewText(page, 'TOP').dblclick()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('BOTTOM')
  expect((await state(page)).text).toBe('TOP\nBOTTOM')
  await page.mouse.click(5, 5) // off the editor: blur finishes
  await expect(page.getByTestId('inline-text-editor')).toHaveCount(0)

  const past = (await state(page)).past
  await page.getByTestId('preview-canvas').getByText(/BOTTOM/).first().dblclick()
  await expect(page.getByTestId('inline-text-editor')).toBeFocused()
  await page.keyboard.press('Escape')
  expect((await state(page)).past).toBe(past)
})
