/**
 * A JPEG in the library gets a real thumbnail (2026-10-11 bug): the thumb
 * command seeked the input (`-ss 0`), which drops a JPEG's only frame — ffmpeg
 * exited 0 having written nothing, the rename of `thumb.part.jpg` failed with
 * ENOENT on every library refresh, and the card showed the ▶ placeholder.
 * docs/FFMPEG-NOTES.md "Stills: no input seek".
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

test('an imported JPEG gets its thumbnail and the card shows it', async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(60_000)
  const still = join(projectsDir, 'E2E', 'photo.jpg')
  // A lavfi-made JPEG reproduces the iPhone failure (verified).
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=1', '-frames:v', '1', still])

  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, still)

  const thumb = join(projectsDir, 'E2E', 'cache', id, 'thumb.jpg')
  await expect.poll(() => existsSync(thumb), { timeout: 20_000 }).toBe(true)
  // The card's <img> really loads (not the ▶ placeholder it falls back to).
  const img = page.locator(`img[src="reelmedia://${id}/thumb.jpg"]`)
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
})
