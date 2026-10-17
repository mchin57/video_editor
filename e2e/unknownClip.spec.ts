/**
 * A clip the project uses but nothing describes (an old project converted
 * while the old media library was missing) gets a library card — "Missing,
 * unknown clip" — and Relink fills it in WITHOUT resetting its cuts (there is
 * no known old length to compare). docs/MEDIA-POINTERS.md "Unknown clips".
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const ID = 'cccccccccccc'

test('an unknown clip shows a Missing card, and Relink fills it in keeping the cut', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(90_000)

  // A converted project (schema 25) whose one clip has no library record. The
  // fixture's own fresh .reel is the template for a valid document.
  const dir = join(projectsDir, 'Converted')
  mkdirSync(join(dir, 'footage'), { recursive: true })
  const doc = JSON.parse(readFileSync(join(projectsDir, 'E2E', 'E2E.reel'), 'utf8'))
  doc.id = 'converted'
  doc.name = 'Converted'
  doc.mediaIds = []
  doc.library = []
  doc.layers = [
    {
      id: 'v1',
      hidden: false,
      startSec: 0,
      endSec: 1,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'video', mediaId: ID, inSec: 0.5, outSec: 1.5, mute: false, gainDb: 0 }
    }
  ]
  writeFileSync(join(dir, 'Converted.reel'), JSON.stringify(doc))
  const clip = join(dir, 'footage', 'IMG_9000.mp4')
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

  await electronApp.evaluate(
    ({ dialog }, reel) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [reel] })) as typeof dialog.showOpenDialog
    },
    join(dir, 'Converted.reel')
  )
  await page.evaluate(() => window.__reelStores.useProject.getState().openFile())

  // The card is there, marked unknown.
  await expect(page.getByTestId('media-unknown')).toBeVisible()
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.mediaIds)).toContain(ID)

  // Relink: pick the file, accept the warning (it can't be checked), record what was asked.
  await electronApp.evaluate(({ dialog }, file) => {
    const g = globalThis as unknown as { asked: { message: string; detail?: string }[] }
    g.asked = []
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const box = args.find((a) => !!a && typeof a === 'object' && 'message' in a) as {
        message: string
        detail?: string
      }
      g.asked.push({ message: box.message, detail: box.detail })
      return { response: 0, checkboxChecked: false } // "Update path anyway"
    }) as typeof dialog.showMessageBox
  }, clip)
  await page.getByTestId('media-missing').getByRole('button', { name: 'Relink…' }).click()
  await expect(page.getByTestId('media-missing')).toHaveCount(0)

  const asked = await electronApp.evaluate(
    () => (globalThis as unknown as { asked: { message: string; detail?: string }[] }).asked
  )
  expect(asked[0].message).toContain('These fields do not match')
  expect(asked[0].detail).toContain('Nothing records which file this clip was')

  const [asset] = (await page.evaluate((ids) => window.api.listProjectMedia(ids), [ID])) as MediaAsset[]
  expect(asset).toMatchObject({
    status: 'ok',
    fileName: 'IMG_9000.mp4',
    kind: 'video',
    relativePath: 'footage/IMG_9000.mp4'
  })
  // The cut survives the relink.
  const content = await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0].content)
  expect(content).toMatchObject({ mediaId: ID, inSec: 0.5, outSec: 1.5 })
})
