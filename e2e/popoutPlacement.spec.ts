/**
 * Regression for #14: the library hover pop-out opened over its own card's
 * ＋ Playhead / ＋ End / × buttons and the header's File / View / Format menus, so a
 * click there after lingering on the thumbnail landed on the preview video.
 * The pop-out now sits beside the whole card and below the header.
 *
 * ARRANGE via a real import, ACT via real mouse moves and a click,
 * ASSERT on what is under the cursor and on the store.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const media = (page: Page, id: string): Promise<MediaAsset> =>
  page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0], id)

const centre = async (l: Locator): Promise<{ x: number; y: number }> => {
  const b = (await l.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Is the element at `pt` inside `l` (i.e. nothing floats over it there)? */
const onTop = (l: Locator, pt: { x: number; y: number }): Promise<boolean> =>
  l.evaluate((el, { x, y }) => el.contains(document.elementFromPoint(x, y)), pt)

test('the library pop-out leaves its card buttons and the header menus clickable', async ({
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const clip = join(projectsDir, 'E2E', 'swim.mp4')
  // Tall (9:16) so the pop-out is at its largest.
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568:rate=30:duration=3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    clip
  ])
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, clip)
  await expect.poll(async () => (await media(page, id))?.proxyReady, { timeout: 30_000 }).toBe(true)

  const card = page.getByRole('button', { name: /^swim\.mp4 / })
  const thumb = card.locator('img').first()
  const addPh = card.getByTitle('Add clip at the playhead')
  const addEnd = card.getByTitle('Add clip to the end of the timeline')
  const remove = card.getByTitle(/^Remove from this project/)
  const fileMenu = page.locator('[data-app-header]').getByRole('button', { name: /^File/ }).first()

  // Linger on the thumbnail (the bug needed ~1 s) until the pop-out is up.
  await page.mouse.move(5, 5)
  const t = await centre(thumb)
  await page.mouse.move(t.x, t.y)
  await expect(page.getByTestId('preview-popout')).toBeVisible()
  await page.waitForTimeout(1200)

  // Nothing floats over the card's buttons or the header's menus.
  for (const l of [addPh, addEnd, remove, fileMenu]) {
    expect(await onTop(l, await centre(l))).toBe(true)
  }
  const pop = (await page.getByTestId('preview-popout').boundingBox())!
  const header = (await page.locator('[data-app-header]').boundingBox())!
  expect(pop.y).toBeGreaterThanOrEqual(header.y + header.height)

  // Glide from the thumbnail to ＋ Playhead: the pop-out may stay, but the click lands on the button.
  const ph = await centre(addPh)
  await page.mouse.move(ph.x, ph.y, { steps: 15 })
  await page.mouse.click(ph.x, ph.y)
  await expect.poll(() => page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.length)).toBe(1)
})
