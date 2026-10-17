/**
 * A portrait phone photo keeps its shape (2026-10-14 bug). An iPhone JPEG is
 * stored landscape with an EXIF orientation; ffprobe shows that only as FRAME
 * side data (a display matrix, rotation -90), never on the stream. The probe
 * read the stream alone, so the library thought the photo was 4:3 while ffmpeg
 * decodes it upright (3:4): the layer box, the thumbnail and the export were
 * all squashed. docs/FFMPEG-NOTES.md "EXIF orientation".
 *
 * The fixture is a 640×480 lavfi JPEG with an APP1 EXIF block carrying
 * Orientation = 6 (rotate 90° clockwise), the tag an iPhone writes for an
 * upright portrait shot.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { MediaAsset, MediaRecord } from '../src/shared/media'
import { test, expect } from './fixtures'
import { FFMPEG, FFPROBE } from './bin'

const W = 1080
const H = 1920

/** A red 640×480 JPEG tagged EXIF Orientation `o` (big-endian TIFF, one IFD entry). */
function orientedJpeg(out: string, o: number): void {
  const plain = `${out}.plain.jpg`
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x480', '-frames:v', '1', plain])
  const jpeg = readFileSync(plain)
  const tiff = Buffer.from([
    0x4d,
    0x4d,
    0,
    0x2a,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    o,
    0,
    0,
    0,
    0,
    0,
    0
  ])
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff])
  const len = payload.length + 2
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]), payload])
  writeFileSync(out, Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]))
}

const dims = (file: string): { w: number; h: number } => {
  const [w, h] = execFileSync(FFPROBE, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    file
  ])
    .toString()
    .trim()
    .split(',')
    .map(Number)
  return { w, h }
}

/** Bounding box of red pixels in one exported frame. */
function redBox(file: string, t: number): { w: number; h: number } {
  const buf = execFileSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    {
      maxBuffer: W * H * 3 + 1024
    }
  )
  let x0 = W,
    x1 = -1,
    y0 = H,
    y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      if (buf[i] > 150 && buf[i + 1] < 80 && buf[i + 2] < 80) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    }
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

const media = (page: Page, ids: string[]): Promise<MediaAsset[]> =>
  page.evaluate((ids) => window.api.listProjectMedia(ids), ids)

test('a portrait JPEG (EXIF orientation 6) is probed, previewed and exported portrait', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const photo = join(projectsDir, 'E2E', 'portrait.jpg')
  orientedJpeg(photo, 6)

  const asset = await page.evaluate(async (p) => {
    const [a] = await window.api.importPaths([p])
    const s = window.__reelStores.useProject.getState()
    s.addMedia([a.id])
    // The image layer as the library drops it: centred, half the frame.
    s.addLayer({
      id: 'I',
      hidden: false,
      startSec: 0,
      endSec: 2,
      x: 540,
      y: 960,
      scale: 0.5,
      content: { kind: 'image', mediaId: a.id, opacity: 1 }
    })
    return a
  }, photo)
  const v = asset.probe.video!
  expect
    .soft({ w: v.displayWidth, h: v.displayHeight, rot: v.rotationDeg }, 'probe')
    .toEqual({ w: 480, h: 640, rot: 270 })
  expect.soft({ w: v.width, h: v.height }, 'stored size is unchanged').toEqual({ w: 640, h: 480 })

  // Thumbnail: the decoded (upright) picture at the probe's size — 270×360.
  const thumb = join(projectsDir, 'E2E', 'cache', asset.id, 'thumb.jpg')
  await expect.poll(() => existsSync(thumb), { timeout: 20_000 }).toBe(true)
  expect.soft(dims(thumb), 'thumb').toEqual({ w: 270, h: 360 })

  // Preview: the layer box is portrait.
  const img = page.locator(`img[src^="reelmedia://${asset.id}/image.png"]`)
  await expect(img).toBeVisible()
  const box = await img.evaluate((el) => el.parentElement!.parentElement!.getBoundingClientRect().toJSON() as DOMRect)
  expect.soft(box.width / box.height, 'preview box aspect').toBeCloseTo(0.75, 2)

  // Export: the red photo lands as a 3:4 rectangle.
  const out = join(projectsDir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })
  const red = redBox(out, 1)
  expect(red.w / red.h, `export red box ${red.w}×${red.h}`).toBeCloseTo(0.75, 1)
})

test('an image record probed before orientation was read is re-probed on open, keeping its id', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  mkdirSync(join(root, 'photos'))
  const photo = join(root, 'photos', 'IMG_8432.jpg')
  orientedJpeg(photo, 6)
  const id = await page.evaluate(async (p) => {
    const [a] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([a.id])
    return a.id
  }, photo)
  await page.evaluate(() => window.__reelStores.useProject.getState().save())

  // A copy of the project whose record carries the old, landscape probe (as
  // saved before the fix: no probe version) and a squashed cached thumb.
  const moved = join(projectsDir, 'Old', 'E2E')
  cpSync(root, moved, { recursive: true })
  const reel = join(moved, 'E2E.reel')
  const doc = JSON.parse(readFileSync(reel, 'utf8')) as { library: MediaRecord[] }
  const before = doc.library[0]
  const { version: _v, ...probe } = before.probe as MediaRecord['probe'] & { version?: number }
  doc.library[0] = {
    ...before,
    probe: { ...probe, video: { ...probe.video!, displayWidth: 640, displayHeight: 480, rotationDeg: 0 } }
  }
  writeFileSync(reel, JSON.stringify(doc))
  const staleThumb = join(moved, 'cache', id, 'thumb.jpg')
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=360x270',
    '-frames:v',
    '1',
    staleThumb
  ])

  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog
  }, reel)
  await page.evaluate(() => window.__reelStores.useProject.getState().openFile())

  const [asset] = await media(page, [id])
  expect(asset.id).toBe(id)
  expect(asset.fingerprint).toEqual(before.fingerprint)
  expect({ w: asset.probe.video!.displayWidth, h: asset.probe.video!.displayHeight }).toEqual({ w: 480, h: 640 })
  // The squashed thumb was dropped and rebuilt from the corrected probe.
  await expect.poll(() => existsSync(staleThumb) && dims(staleThumb).w, { timeout: 20_000 }).toBe(270)
  // Corrected in memory; Save writes it.
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().dirty)).toBe(true)
  await page.evaluate(() => window.__reelStores.useProject.getState().save())
  const saved = (JSON.parse(readFileSync(reel, 'utf8')) as { library: MediaRecord[] }).library[0]
  expect(saved.probe.video!.displayHeight).toBe(640)
})
