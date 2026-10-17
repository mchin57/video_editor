/**
 * Clip descriptions (`MediaRecord.description`): hovering a library thumbnail
 * shows the preview pop-out (video, image, or nothing for audio) with the
 * description beside it, and hovering a media tile on the timeline (video,
 * image, audio) shows it above the tile. Both are editable in
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
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

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
  const id = await importClip(page, clip)
  const layers = (): Promise<number> =>
    page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.length)

  // ── Library: hover the thumbnail, travel across the video into the description.
  const thumb = page
    .getByRole('button', { name: /^swim\.mp4 / })
    .locator('img')
    .first()
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
  const reel = JSON.parse(readFileSync(join(root, 'E2E.reel'), 'utf8')) as {
    library: { id: string; description?: string }[]
  }
  expect(reel.library.find((r) => r.id === id)?.description).toBe('Wave 2 start, goggles fogged')
})

test('image and audio clips: a description panel in the library and above their timeline tiles', async ({
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  execFileSync(FFMPEG, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x480',
    '-frames:v',
    '1',
    join(root, 'finish.png')
  ])
  execFileSync(FFMPEG, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    join(root, 'horn.wav')
  ])
  const img = await importClip(page, join(root, 'finish.png'))
  const aud = await importClip(page, join(root, 'horn.wav'))

  // Library, image: the picture beside its description.
  await page.mouse.move(5, 5)
  await page
    .getByRole('button', { name: /^finish\.png / })
    .locator('img')
    .first()
    .hover()
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await expect(page.getByTestId('preview-popout')).toHaveCount(0)
  let input = page.getByTestId('library-description').getByTestId('description-input')
  await glide(
    page,
    await centre(
      page
        .getByRole('button', { name: /^finish\.png / })
        .locator('img')
        .first()
    ),
    await centre(input)
  )
  await input.click()
  await page.keyboard.type('Finish arch, wide')
  await input.press('Enter')
  await expect.poll(async () => (await media(page, img)).description).toBe('Finish arch, wide')

  // Library, audio: the description alone; clicking in it doesn't play the clip.
  await page.mouse.move(5, 5)
  await expect(page.getByTestId('library-description')).toHaveCount(0)
  const glyph = page.getByTitle('Play preview') // the audio card's ♪ glyph (its only audio card)
  await glyph.hover()
  const panel = page.getByTestId('library-description')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('preview-image')).toHaveCount(0)
  await expect(page.getByTestId('preview-popout')).toHaveCount(0)
  input = panel.getByTestId('description-input')
  await glide(page, await centre(glyph), await centre(input))
  await panel.click({ position: { x: 20, y: 8 } }) // the panel's header, outside the text box
  await input.click()
  await page.keyboard.type('Start horn')
  await input.press('Enter')
  await expect.poll(async () => (await media(page, aud)).description).toBe('Start horn')
  const paused = await page.evaluate(() => [...document.querySelectorAll('audio')].every((a) => a.paused))
  expect(paused).toBe(true)

  // Timeline: an image tile and an audio tile each show theirs above the tile.
  await page.evaluate(
    ({ img, aud }) => {
      const s = window.__reelStores.useProject.getState()
      s.addLayer({
        id: 'I1',
        hidden: false,
        startSec: 0,
        endSec: 3,
        x: 540,
        y: 960,
        scale: 0.5,
        content: { kind: 'image', mediaId: img, opacity: 1 }
      })
      s.addAudioClip({
        id: 'A1',
        mediaId: aud,
        startSec: 0,
        inSec: 0,
        outSec: 2,
        gainDb: 0,
        fadeInSec: 0,
        fadeOutSec: 0,
        duck: false,
        kind: 'audio'
      })
    },
    { img, aud }
  )
  await page.mouse.move(5, 5)
  for (const [tile, text] of [
    ['tile-layer-I1', 'Finish arch, wide'],
    ['tile-audio-A1', 'Start horn']
  ] as const) {
    await page.getByTestId(tile).hover() // scrolls the lane into view first
    const above = page.getByTestId('timeline-description')
    await expect(above).toBeVisible()
    await expect(above.getByTestId('description-input')).toHaveValue(text)
    expect((await above.boundingBox())!.y).toBeLessThan((await page.getByTestId(tile).boundingBox())!.y)
    await page.mouse.move(5, 5)
    await expect(above).toHaveCount(0)
  }
})

test('a quick pass across a tile does not open its description', async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(60_000)
  const clip = join(projectsDir, 'E2E', 'a.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x568:r=30:d=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    clip
  ])
  const id = await importClip(page, clip)
  await page.evaluate((id) => window.__reelStores.useProject.getState().addVideoLayer('L1', id, 0, 2, false), id)
  const b = (await page.getByTestId('tile-layer-L1').boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y - 40)
  await page.mouse.move(b.x + b.width / 2, b.y + b.height + 40, { steps: 4 })
  await page.waitForTimeout(600)
  await expect(page.getByTestId('timeline-description')).toHaveCount(0)
})

test('scrolling inside the timeline description box scrolls it and keeps it open', async ({
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(60_000)
  const clip = join(projectsDir, 'E2E', 'long.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x568:r=30:d=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    clip
  ])
  const id = await importClip(page, clip)
  const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long description`).join('\n')
  await page.evaluate((id) => window.__reelStores.useProject.getState().addVideoLayer('L1', id, 0, 2, false), id)

  const tile = page.getByTestId('tile-layer-L1')
  const t = await centre(tile)
  await page.mouse.move(5, 5)
  await page.mouse.move(t.x, t.y)
  const above = page.getByTestId('timeline-description')
  await expect(above).toBeVisible()
  const input = above.getByTestId('description-input')
  await glide(page, t, await centre(input))
  await input.fill(long)
  await input.press('Enter')
  await expect.poll(async () => (await media(page, id)).description).toBe(long)

  // A wheel over the box scrolls its text; the box stays.
  await input.evaluate((el) => (el.scrollTop = 0))
  // Under load one wheel event can land before the textarea is scrollable, so
  // keep wheeling (over the box) until it scrolls; the box must stay open throughout.
  await input.hover()
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 120)
      return input.evaluate((el) => el.scrollTop)
    })
    .toBeGreaterThan(0)
  await page.waitForTimeout(400)
  await expect(above).toBeVisible()

  // Leaving it closes it.
  await page.mouse.move(5, 5)
  await expect(above).toHaveCount(0)
})
