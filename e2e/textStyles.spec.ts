/**
 * #45: saved text styles. "＋ Save style" names a text layer's look (font,
 * size, colours, pill, outline, shadow, gradient + its animation) and keeps it
 * editor-wide in settings.json; clicking the chip applies it to another text
 * layer — or a caption — in ONE undo step. Saving under an existing name
 * overwrites it; × deletes it.
 *
 * ARRANGE via store actions, ACT via real clicks/typing in the Inspector,
 * ASSERT on the store and main's settings.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const text = (id: string, over: Record<string, unknown>): Record<string, unknown> => ({
  id, hidden: false, startSec: 0, endSec: 4, x: 540, y: 960, scale: 1,
  content: {
    kind: 'text', text: id, fontFamily: 'montserrat-extrabold', fontSizePx: 70, color: '#ffffff',
    pill: { enabled: false, color: '#000000cc', padPx: 18 }, ...over
  }
})

const content = (page: Page, id: string): Promise<Record<string, unknown>> =>
  page.evaluate((id) => window.__reelStores.useProject.getState().project!.layers.find((l) => l.id === id)!.content as never, id)

const saved = (page: Page): Promise<{ name: string; style: Record<string, unknown>; animation?: unknown }[]> =>
  page.evaluate(async () => (await window.api.getSettings()).textStyles as never)

test('save a text layer look as a style, apply it to another layer and a caption in one click', async ({ appPage: page }) => {
  await page.evaluate(
    ([hook, plain]) => {
      const { useProject, useUi } = window.__reelStores
      useProject.getState().addLayer(hook as never)
      useProject.getState().addLayer(plain as never)
      useUi.getState().selectLayer('HOOK')
    },
    [
      text('HOOK', {
        fontFamily: 'anton', fontSizePx: 120, color: '#FFE600',
        pill: { enabled: true, color: '#000000cc', padPx: 24 },
        animation: { in: 'bounce', inSec: 0.4, out: 'fadeOut', outSec: 0.3 }
      }),
      text('PLAIN', { stroke: { widthPx: 8, color: '#000000' } })
    ]
  )

  // Save it as "Hook".
  const picker = page.getByTestId('text-style-picker')
  await picker.getByRole('button', { name: '＋ Save style' }).click()
  await picker.getByRole('textbox', { name: 'Style name' }).fill('Hook')
  await page.keyboard.press('Enter')
  await expect(picker.getByRole('button', { name: 'Hook', exact: true })).toBeVisible()
  await expect.poll(async () => (await saved(page)).map((s) => s.name)).toEqual(['Hook'])
  const [hookStyle] = await saved(page)
  expect(hookStyle.style).toMatchObject({ fontFamily: 'anton', fontSizePx: 120, color: '#FFE600' })
  expect(hookStyle.animation).toMatchObject({ in: 'bounce', out: 'fadeOut' })

  // Apply it to PLAIN: its look (and animation) becomes Hook's, its outline goes, its text stays — one undo step.
  await page.evaluate(() => window.__reelStores.useUi.getState().selectLayer('PLAIN'))
  const past = await page.evaluate(() => window.__reelStores.useProject.getState().past.length)
  await page.getByTestId('text-style-picker').getByRole('button', { name: 'Hook', exact: true }).click()
  const plain = await content(page, 'PLAIN')
  expect(plain).toMatchObject({
    text: 'PLAIN', fontFamily: 'anton', fontSizePx: 120, color: '#FFE600',
    pill: { enabled: true, color: '#000000cc', padPx: 24 },
    animation: { in: 'bounce', out: 'fadeOut' }
  })
  expect(plain.stroke ?? null).toBeNull()
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().past.length)).toBe(past + 1)

  // A caption takes the look too (captions don't animate; nothing else changes).
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    const cap = useProject.getState().project!.captions
    useProject.getState().setCaptions({
      ...cap, enabled: true, segments: [{ id: 'c0', startSec: 0, endSec: 2, text: 'go', words: [], enabled: true }]
    })
    useUi.getState().selectCaptionsGlobal()
  })
  await page.getByTestId('text-style-picker').getByRole('button', { name: 'Hook', exact: true }).click()
  const lane = await page.evaluate(() => window.__reelStores.useProject.getState().project!.captions.style)
  expect(lane).toMatchObject({ fontFamily: 'anton', fontSizePx: 120, color: '#FFE600' })

  // Saving under the same name overwrites; × deletes.
  await page.evaluate(() => {
    window.__reelStores.useUi.getState().selectLayer('PLAIN')
    const s = window.__reelStores.useProject.getState()
    const l = s.project!.layers.find((x) => x.id === 'PLAIN')!
    s.updateLayer('PLAIN', { content: { ...l.content, color: '#FF3B30' } as never })
  })
  const p2 = page.getByTestId('text-style-picker')
  await p2.getByRole('button', { name: '＋ Save style' }).click()
  await p2.getByRole('textbox', { name: 'Style name' }).fill('hook')
  await p2.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await saved(page)).map((s) => [s.name, s.style.color])).toEqual([['hook', '#FF3B30']])
  await p2.getByRole('button', { name: 'Delete style hook' }).click()
  await expect.poll(async () => (await saved(page)).length).toBe(0)
  await expect(p2.getByRole('button', { name: 'hook', exact: true })).toHaveCount(0)
})
