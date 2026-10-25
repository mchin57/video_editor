/**
 * #11 / #19: the Library card's ＋ Playhead / ＋ End were `span role=button
 * tabindex=-1`, so the keyboard could not reach them, and read "＋ PH". They are
 * real buttons now: Tab reaches them, Enter activates them, and a clip whose
 * preview is not ready yet has them disabled. The plain label must still fit
 * the card's action column.
 *
 * ARRANGE via a real import, ACT via real Tab / Enter key presses,
 * ASSERT on focus, the DOM and the store.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const media = (page: Page, id: string): Promise<MediaAsset> =>
  page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0], id)

const videoLayers = (page: Page): Promise<{ mediaId: string; startSec: number; endSec: number }[]> =>
  page.evaluate(() =>
    window.__reelStores.useProject
      .getState()
      .project!.layers.filter((l) => l.content.kind === 'video')
      .map((l) => ({
        mediaId: (l.content as { mediaId: string }).mediaId,
        startSec: l.startSec,
        endSec: l.endSec
      }))
  )

test('the Library add buttons are reachable by Tab and work with Enter', async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const clip = join(projectsDir, 'E2E', 'kick.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568:rate=30:duration=2',
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

  const card = page.getByRole('button', { name: /^kick\.mp4 / })
  const addPh = card.getByRole('button', { name: '＋ Playhead' })
  const addEnd = card.getByRole('button', { name: '＋ End' })
  await expect(addPh).toBeEnabled()
  await expect(addPh).toHaveAttribute('type', 'button')

  // The plain label fits: the button sits inside its card and its text is not clipped.
  const cardBox = (await card.boundingBox())!
  const phBox = (await addPh.boundingBox())!
  expect(phBox.x + phBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)
  expect(await addPh.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

  // Tab from the Library's "+ Import" (the control before the cards) lands on ＋ Playhead.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(0.5))
  await page.getByRole('button', { name: '+ Import' }).focus()
  await page.keyboard.press('Tab')
  await expect(addPh).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => videoLayers(page)).toHaveLength(1)
  const [first] = await videoLayers(page)
  expect(first).toMatchObject({ mediaId: id, startSec: 0.5 })

  // The next Tab stop is ＋ End: it lands after the clip just placed.
  await page.keyboard.press('Tab')
  await expect(addEnd).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => videoLayers(page)).toHaveLength(2)
  const second = (await videoLayers(page))[1]
  expect(second.mediaId).toBe(id)
  expect(second.startSec).toBeCloseTo(first.endSec, 3)
})
