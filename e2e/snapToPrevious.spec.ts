/**
 * Snap-to-previous, end to end: the ⇤ Snap button and the N keybind butt the
 * selection against the previous tile in its lane. ARRANGE via store actions
 * (timeline math needs no real media), ACT with real clicks/keys, ASSERT on
 * store + DOM.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/** Two video layers in the Clips lane with a gap between them. */
async function arrangeGap(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 0, 4, false)
    useProject.getState().addVideoLayer('L2', 'no-such-media', 10, 3, false)
    useUi.getState().clearSelection()
  })
}

const layerAt = (page: Page, id: string): Promise<{ startSec: number; endSec: number }> =>
  page.evaluate((lid) => {
    const l = window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === lid)!
    return { startSec: l.startSec, endSec: l.endSec }
  }, id)

const snapButton = (page: Page): ReturnType<Page['getByRole']> =>
  page.getByRole('button', { name: '⇤ Snap' })

test('the Snap button closes the gap to the previous clip, keeping duration', async ({
  appPage: page
}) => {
  await arrangeGap(page)
  await page.getByTestId('tile-layer-L2').click()
  await snapButton(page).click()

  const l2 = await layerAt(page, 'L2')
  expect(l2.startSec).toBeCloseTo(4)
  expect(l2.endSec).toBeCloseTo(7) // 3s long, unchanged
  // The tile really moved on screen, not just in the store.
  const box = await page.getByTestId('tile-layer-L2').boundingBox()
  const ruler = await page.getByTestId('tile-layer-L1').boundingBox()
  expect(box!.x).toBeCloseTo(ruler!.x + ruler!.width, 0)
})

test('the N keybind does the same as the button', async ({ appPage: page }) => {
  await arrangeGap(page)
  await page.getByTestId('tile-layer-L2').click()
  await page.keyboard.press('n')
  expect((await layerAt(page, 'L2')).startSec).toBeCloseTo(4)
})

test('N is ignored while a text field has focus', async ({ appPage: page }) => {
  await arrangeGap(page)
  await page.getByTestId('tile-layer-L2').click()
  // The Inspector's Start field is a real input — typing "n" there must not
  // fire the shortcut (the global handler bails on INPUT/TEXTAREA).
  const start = page.getByLabel('Start (s)').first()
  await start.click()
  await page.keyboard.press('n')
  expect((await layerAt(page, 'L2')).startSec).toBeCloseTo(10)
})

test('the button disables when the selection is already flush', async ({ appPage: page }) => {
  await arrangeGap(page)
  await page.getByTestId('tile-layer-L2').click()
  await snapButton(page).click()
  await expect(snapButton(page)).toBeDisabled()
})

test('with nothing before it, the clip snaps to the start of the timeline', async ({
  appPage: page
}) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 8, 2, false)
    useUi.getState().clearSelection()
  })
  await page.getByTestId('tile-layer-L1').click()
  await snapButton(page).click()
  expect((await layerAt(page, 'L1')).startSec).toBeCloseTo(0)
})

test('a snap is one undo step', async ({ appPage: page }) => {
  await arrangeGap(page)
  await page.getByTestId('tile-layer-L2').click()
  await snapButton(page).click()
  expect((await layerAt(page, 'L2')).startSec).toBeCloseTo(4)
  await page.keyboard.press('Control+z')
  expect((await layerAt(page, 'L2')).startSec).toBeCloseTo(10)
})

test('a linked pair snaps as one, preserving the offset between them', async ({
  appPage: page
}) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('P0', 'no-such-media', 0, 4, false)
    useProject.getState().addVideoLayer('L1', 'no-such-media', 10, 10, false)
    useProject.getState().addAudioClip({
      id: 'A1',
      mediaId: 'no-such-audio',
      startSec: 12,
      inSec: 0,
      outSec: 6,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'music'
    })
    useUi.getState().clearSelection()
  })
  await page.getByTestId('tile-layer-L1').click({ modifiers: ['Control'] })
  await page.getByTestId('tile-audio-A1').click({ modifiers: ['Control'] })
  await page.getByRole('button', { name: '🔗 Link' }).click()
  await page.getByTestId('tile-layer-L1').click()
  await snapButton(page).click()

  // Anchor (the earliest member, L1) lands on P0's end; A1 keeps its +2 offset.
  expect((await layerAt(page, 'L1')).startSec).toBeCloseTo(4)
  const a1 = await page.evaluate(
    () => window.__reelStores.useProject.getState().project!.audioClips[0].startSec
  )
  expect(a1).toBeCloseTo(6)
})
