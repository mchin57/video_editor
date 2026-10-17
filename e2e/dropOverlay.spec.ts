/**
 * Regression for the Bug-List item "drop overlay never goes away": the
 * depth-counted useDragDepth must clear the OS-file import overlay when the
 * drag leaves without a drop — including via child-element boundaries, which
 * is what broke the old currentTarget===target check.
 */
import { test, expect } from './fixtures'
import type { JSHandle } from '@playwright/test'

async function fileDataTransfer(page: import('@playwright/test').Page): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
    return dt
  })
}

test('OS-file drag overlay clears when the drag leaves without a drop', async ({ appPage: page }) => {
  const root = page.locator('#root > div').first()
  const overlay = page.getByText('Drop video files to import')
  const dt = await fileDataTransfer(page)

  await root.dispatchEvent('dragenter', { dataTransfer: dt })
  await expect(overlay).toBeVisible()
  await root.dispatchEvent('dragleave', { dataTransfer: dt })
  await expect(overlay).toBeHidden()
})

test('overlay survives child-element boundaries and clears only on the final leave', async ({ appPage: page }) => {
  const root = page.locator('#root > div').first()
  const header = page.locator('header')
  const overlay = page.getByText('Drop video files to import')
  const dt = await fileDataTransfer(page)

  await root.dispatchEvent('dragenter', { dataTransfer: dt }) // depth 1
  await header.dispatchEvent('dragenter', { dataTransfer: dt }) // bubbles → depth 2
  await header.dispatchEvent('dragleave', { dataTransfer: dt }) // depth 1 — still inside
  await expect(overlay).toBeVisible()
  await root.dispatchEvent('dragleave', { dataTransfer: dt }) // depth 0 — gone
  await expect(overlay).toBeHidden()
})
