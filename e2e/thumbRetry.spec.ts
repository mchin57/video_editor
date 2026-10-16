/**
 * A library card whose thumbnail didn't exist when it first rendered shows it
 * once it does. Here: a project opens with its image missing (no thumb can be
 * built), then the file comes back and the library re-check builds the thumb.
 *
 * (The owner's 2026-10-11 Race clips JPEG — a card stuck on ▶ because it was
 * drawn ~250 ms before its thumb existed — is a timing this spec can't force;
 * ClipCard.test.tsx covers that deterministically. This path passes either
 * way: Missing → OK remounts the card.)
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

/** The app's fingerprint of a small file (≤ 3 samples: hashed whole) and its id. */
function fingerprintOf(path: string): { fp: { size: number; start: string; middle: string; end: string }; id: string } {
  const h = createHash('sha1').update(readFileSync(path)).digest('hex')
  const fp = { size: statSync(path).size, start: h, middle: h, end: h }
  const id = createHash('sha1').update(`${fp.size}:${fp.start}:${fp.middle}:${fp.end}`).digest('hex').slice(0, 12)
  return { fp, id }
}

test('a card whose thumbnail was missing when it rendered shows it once it exists', async ({ electronApp, appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(90_000)
  const synth = (out: string, src: string): void =>
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `${src}=size=640x480:rate=1`, '-frames:v', '1', out])

  // A real probe for a 640x480 JPEG, from an import into the fixture project.
  const probeSrc = join(projectsDir, 'probe.jpg')
  synth(probeSrc, 'testsrc2')
  const probe = await page.evaluate(async (p) => (await window.api.importPaths([p]))[0].probe, probeSrc)

  // Project "Later": its one image is NOT where it says yet (never loaded, no cache).
  const dir = join(projectsDir, 'Later')
  mkdirSync(join(dir, 'photos'), { recursive: true })
  const staged = join(projectsDir, 'photo.jpg')
  synth(staged, 'smptebars') // different content from the probe source
  const { fp, id } = fingerprintOf(staged)
  const doc = JSON.parse(readFileSync(join(projectsDir, 'E2E', 'E2E.reel'), 'utf8'))
  const target = join(dir, 'photos', 'photo.jpg')
  writeFileSync(join(dir, 'Later.reel'), JSON.stringify({
    ...doc, id: 'later', name: 'Later', mediaIds: [id],
    library: [{ id, fileName: 'photo.jpg', relativePath: 'photos/photo.jpg', absolutePath: target, fingerprint: fp, importedAt: new Date().toISOString(), probe, kind: 'image' }]
  }))
  await electronApp.evaluate(({ dialog }, reel) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [reel] })) as typeof dialog.showOpenDialog
  }, join(dir, 'Later.reel'))
  await page.evaluate(async () => {
    window.confirm = () => true // the fixture project has an unsaved import
    await window.__reelStores.useProject.getState().openFile()
  })
  await expect(page.getByTestId('media-missing')).toBeVisible() // rendered without a thumbnail

  // The file comes back; returning to the app re-checks and builds the thumb.
  copyFileSync(staged, target)
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByTestId('media-missing')).toHaveCount(0)
  await expect.poll(() => existsSync(join(dir, 'cache', id, 'thumb.jpg')), { timeout: 20_000 }).toBe(true)

  // …and the card shows it, instead of the ▶ it fell back to on the first try.
  const img = page.locator(`img[src^="reelmedia://${id}/thumb.jpg"]`)
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth).catch(() => 0), { timeout: 15_000 })
    .toBeGreaterThan(0)
})
