/**
 * Library hover-preview popout: the popout is interactive — the cursor can
 * travel from the card onto it (shared hover group + close delay + gap bridge)
 * without dismissing it, the scrub bar seeks the preview, and leaving both
 * card and popout closes it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

test('popout survives cursor travel and its scrub bar seeks', async ({ appPage: page }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')

  // ARRANGE: synthesize a tiny 4s clip and import it for real (proxy + thumb).
  const mp4 = join(mkdtempSync(join(tmpdir(), 'reel-clip-')), 'test.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=270x480:rate=30',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
    mp4
  ])
  const assetId = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, mp4)

  // Wait for the proxy to land (main-process truth; the proxy-done job event
  // invalidates the renderer's library query so the card catches up).
  await expect
    .poll(
      () =>
        page.evaluate(
          async (id) => (await window.api.listProjectMedia([id]))[0]?.proxyReady,
          assetId
        ),
      { timeout: 30_000 }
    )
    .toBe(true)

  // ACT: hover the card THUMBNAIL (the hover group lives on the thumb, not the
  // whole row) → popout appears.
  const thumb = page.locator(`img[src*="${assetId}/thumb.jpg"]`)
  await expect(thumb).toBeVisible()
  await thumb.hover()
  const popout = page.getByTestId('preview-popout')
  await expect(popout).toBeVisible()

  // Travel from card onto the popout — it must stay open (the old
  // pointer-events-none design dismissed the moment the cursor left the card).
  const box = (await popout.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
  await page.waitForTimeout(350) // longer than the close delay
  await expect(popout).toBeVisible()

  // Scrub: press at ~80% of the bar → currentTime jumps to ~80% of duration.
  const bar = page.getByTestId('popout-scrub')
  const barBox = (await bar.boundingBox())!
  await page.mouse.move(barBox.x + barBox.width * 0.8, barBox.y + barBox.height / 2)
  await page.mouse.down()
  const seeked = await page.evaluate(() => {
    const v = document.querySelector('[data-testid="preview-popout"] video') as HTMLVideoElement
    return { t: v.currentTime, d: v.duration, paused: v.paused }
  })
  expect(seeked.paused).toBe(true) // loop pauses while scrubbing
  expect(Math.abs(seeked.t - seeked.d * 0.8)).toBeLessThan(seeked.d * 0.08)

  // Drag to ~20% → follows the pointer.
  await page.mouse.move(barBox.x + barBox.width * 0.2, barBox.y + barBox.height / 2, { steps: 5 })
  const dragged = await page.evaluate(() => {
    const v = document.querySelector('[data-testid="preview-popout"] video') as HTMLVideoElement
    return { t: v.currentTime, d: v.duration }
  })
  expect(Math.abs(dragged.t - dragged.d * 0.2)).toBeLessThan(dragged.d * 0.08)
  await page.mouse.up()

  // Release inside the popout resumes playback.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const v = document.querySelector('[data-testid="preview-popout"] video') as HTMLVideoElement
        return v?.paused
      })
    )
    .toBe(false)

  // Leave both card and popout → closes after the grace delay.
  await page.mouse.move(10, 10, { steps: 8 })
  await expect(popout).toHaveCount(0)
})
