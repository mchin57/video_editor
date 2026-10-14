/**
 * Clip descriptions (`MediaRecord.description`): hovering a library thumbnail
 * shows the preview pop-out with the description beside it, and hovering a
 * video tile on the timeline shows it above the tile. Both are editable in
 * place, both stay open while the cursor travels from the thumbnail / tile
 * into them (and while their text box has focus), and both show the same
 * per-file text. Typing never reaches the app's shortcuts; the text is saved
 * with the project.
 *
 * ARRANGE via a real import, ACT via real mouse moves, clicks and typing,
 * ASSERT on the DOM, main's library and the saved `.reel`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

const media = (page: Page, id: string): Promise<MediaAsset> =>
  page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0], id)

async function importClip(page: Page, path: string): Promise<string> {
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, path)
  await expect.poll(async () => (await media(page, id))?.proxyReady, { timeout: 30_000 }).toBe(true)
  return id
}

const centre = async (l: Locator): Promise<{ x: number; y: number }> => {
  const b = (await l.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Glide the real mouse from where it is to `to` in small steps (hover events fire along the way). */
async function glide(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.move(to.x, to.y, { steps: 25 })
}

test('library pop-out and timeline tile show the same editable description; it saves with the project', async ({
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  const clip = join(root, 'swim.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip
  ])
  const id = await importClip(page, clip)
  const layers = (): Promise<number> => page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.length)

  // ── Library: hover the thumbnail, travel across the video into the description.
  const thumb = page.getByRole('button', { name: /^swim\.mp4 / }).locator('img').first()
  await page.mouse.move(5, 5)
  const start = await centre(thumb)
  await page.mouse.move(start.x, start.y)
  const panel = page.getByTestId('library-description')
  await expect(panel).toBeVisible()
  const box = panel.getByTestId('description-input')
  await expect(box).toHaveValue('')
  await glide(page, start, await centre(box))
  await page.waitForTimeout(400) // past the grace period: still open
  await expect(panel).toBeVisible()

  // Type (an "s" and a "t" must not split or add a text layer), then Enter saves.
  await box.click()
  await page.keyboard.type('Swim start, wave 2')
  // Focus pins it: the cursor can wander off while typing.
  await page.mouse.move(5, 5)
  await page.waitForTimeout(400)
  await expect(panel).toBeVisible()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await media(page, id)).description).toBe('Swim start, wave 2')
  await expect(panel).toHaveCount(0) // unpinned with the cursor away: closes
  expect(await layers()).toBe(0)
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().dirty)).toBe(true)

  // ── Timeline: the same text above the tile, after the hover delay.
  await page.evaluate((id) => window.__reelStores.useProject.getState().addVideoLayer('L1', id, 0, 3, false), id)
  const tile = page.getByTestId('tile-layer-L1')
  const t = await centre(tile)
  await page.mouse.move(t.x, t.y)
  const above = page.getByTestId('timeline-description')
  await expect(above).toBeVisible()
  const tileBox = (await tile.boundingBox())!
  expect((await above.boundingBox())!.y + (await above.boundingBox())!.height).toBeLessThanOrEqual(tileBox.y)
  const input = above.getByTestId('description-input')
  await expect(input).toHaveValue('Swim start, wave 2')

  // Straight up from the tile into the box: it stays.
  await glide(page, t, await centre(input))
  await page.waitForTimeout(400)
  await expect(above).toBeVisible()
  await input.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Wave 2 start, goggles fogged')
  await input.press('Enter')
  await expect.poll(async () => (await media(page, id)).description).toBe('Wave 2 start, goggles fogged')
  expect(await layers()).toBe(1) // typing reached no shortcut

  // Escape puts the saved text back.
  await input.click()
  await page.keyboard.type(' (scratch)')
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('Wave 2 start, goggles fogged')
  expect((await media(page, id)).description).toBe('Wave 2 start, goggles fogged')

  // Pressing on the tile (a drag or a select) closes it.
  await page.mouse.move(t.x, t.y)
  await page.mouse.down()
  await expect(above).toHaveCount(0)
  await page.mouse.up()

  // The library shows the timeline's edit (one description per file).
  await page.mouse.move(5, 5)
  await page.mouse.move(start.x, start.y)
  await expect(page.getByTestId('library-description').getByTestId('description-input')).toHaveValue(
    'Wave 2 start, goggles fogged'
  )

  // Saved into the .reel's library record.
  await page.evaluate(() => window.__reelStores.useProject.getState().save())
  const reel = JSON.parse(readFileSync(join(root, 'E2E.reel'), 'utf8')) as { library: { id: string; description?: string }[] }
  expect(reel.library.find((r) => r.id === id)?.description).toBe('Wave 2 start, goggles fogged')
})

test('a quick pass across a tile does not open its description', async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(60_000)
  const clip = join(projectsDir, 'E2E', 'a.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x568:r=30:d=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip
  ])
  const id = await importClip(page, clip)
  await page.evaluate((id) => window.__reelStores.useProject.getState().addVideoLayer('L1', id, 0, 2, false), id)
  const b = (await page.getByTestId('tile-layer-L1').boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y - 40)
  await page.mouse.move(b.x + b.width / 2, b.y + b.height + 40, { steps: 4 })
  await page.waitForTimeout(600)
  await expect(page.getByTestId('timeline-description')).toHaveCount(0)
})
