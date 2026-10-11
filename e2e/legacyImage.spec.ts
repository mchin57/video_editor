/**
 * An old project's JPEG (owner's Race clips, 2026-10-11): the old library had
 * its display PNG but never a thumbnail (every JPEG thumb failed back then).
 * After converting on Open, its library card must show the picture, not ▶.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

test('a converted project’s JPEG card shows its thumbnail', async ({ electronApp, appPage: page, scratchDir, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(90_000)
  const oldDir = join(projectsDir, 'Old')
  mkdirSync(oldDir)
  const photo = join(oldDir, 'IMG_8432.JPG')
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=1', '-frames:v', '1', photo])
  const oldId = createHash('sha1').update(readFileSync(photo)).digest('hex').slice(0, 12)

  // The app's own probe + display PNG of it, from a real import into the fixture project.
  const imported = await page.evaluate(async (p) => (await window.api.importPaths([p]))[0], photo)
  const fixtureDir = (await page.evaluate(() => window.api.getProjectDir()))!
  await expect.poll(() => existsSync(join(fixtureDir, 'cache', imported.id, 'image.png')), { timeout: 20_000 }).toBe(true)

  // The old library: record + image.png, and NO thumb.jpg (as the old app left it).
  const storeDir = join(scratchDir, 'data', 'media', oldId)
  mkdirSync(storeDir, { recursive: true })
  copyFileSync(join(fixtureDir, 'cache', imported.id, 'image.png'), join(storeDir, 'image.png'))
  writeFileSync(join(storeDir, 'asset.json'), JSON.stringify({
    id: oldId, fileName: 'IMG_8432.JPG', originalPath: photo, importedAt: '2026-08-06T00:44:00.000Z',
    probe: imported.probe, kind: 'image', proxyReady: true, transcribed: false
  }))
  const doc = JSON.parse(readFileSync(join(fixtureDir, 'E2E.reel'), 'utf8'))
  writeFileSync(join(oldDir, 'race reel.reel'), JSON.stringify({ ...doc, id: 'old', name: 'race reel', version: 16, mediaIds: [oldId], library: undefined }))

  await electronApp.evaluate(({ dialog }, reel) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [reel] })) as typeof dialog.showOpenDialog
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
  }, join(oldDir, 'race reel.reel'))
  await page.evaluate(async () => {
    window.confirm = () => true // the fixture project has an unsaved import
    await window.__reelStores.useProject.getState().openFile()
  })
  await expect.poll(() => page.evaluate(() => window.__reelStores.useProject.getState().project?.name)).toBe('Old')

  // The card's <img> loads the thumbnail (not the ▶ it falls back to on an error).
  const img = page.locator(`img[src^="reelmedia://${oldId}/thumb.jpg"]`)
  await expect(img).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  expect(existsSync(join(oldDir, 'cache', oldId, 'thumb.jpg'))).toBe(true)
})
