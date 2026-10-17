/**
 * Library right-click ▸ Quick cut… (docs/QUICK-CUT.md): trim a piece by its
 * handle, split at the playhead (S), delete down to one piece (never zero),
 * undo, then Save — one new clip per piece in the project's `generated/`, added
 * to the library; the original file and the edit behind are untouched, and the
 * dialog's keys never reach the app's own shortcuts.
 *
 * ARRANGE via a real import, ACT via a real right-click, pointer drags and
 * keys, ASSERT on the dialog DOM, the library, the store and the files
 * (ffprobe). No native dialog is involved.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'
import { FFMPEG, FFPROBE } from './bin'

const media = (page: Page, ids: string[]): Promise<MediaAsset[]> =>
  page.evaluate((ids) => window.api.listProjectMedia(ids), ids)
const mediaIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project!.mediaIds)

/** A 4 s 320×568 clip with a tone, made by the real ffmpeg. */
function synth(out: string): void {
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568:rate=30:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    out
  ])
}

async function importClip(page: Page, path: string): Promise<string> {
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, path)
  await expect.poll(async () => (await media(page, [id]))[0]?.proxyReady, { timeout: 30_000 }).toBe(true)
  return id
}

/** A folder's media files, sorted (the `.reel-editor` marker left out). */
const clips = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => !n.startsWith('.'))
        .sort()
    : []

const duration = (file: string): number =>
  Number(
    execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim()
  )

const pieces = (page: Page): Promise<{ in: number; out: number }[]> =>
  page
    .locator('[data-testid^="quickcut-piece-"]')
    .evaluateAll((els) =>
      els.map((e) => ({ in: Number(e.getAttribute('data-in')), out: Number(e.getAttribute('data-out')) }))
    )

/** The track x for source second `sec` (the clip is 4 s). */
async function xAt(track: Locator, sec: number): Promise<{ x: number; y: number }> {
  const b = (await track.boundingBox())!
  return { x: b.x + (b.width * sec) / 4, y: b.y + b.height / 2 }
}

async function openQuickCut(page: Page, cardName: string): Promise<void> {
  // The library card (the name also shows on the timeline tile and in the inspector).
  await page.getByRole('button', { name: new RegExp(`^${cardName.replace('.', '\\.')} `) }).click({ button: 'right' })
  await page.getByTestId('ctx-quickcut').click()
  await expect(page.getByTestId('quickcut-dialog')).toBeVisible()
}

test('trim, split, delete to one, undo, save: new clips in generated/, original and edit untouched', async ({
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG) || !existsSync(FFPROBE), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  const src = join(root, 'IMG_0001.mp4')
  synth(src)
  const before = statSync(src)
  const id = await importClip(page, src)

  // The clip is also on the timeline and selected: the dialog's S / Delete must not touch it.
  const layerId = await page.evaluate((id) => {
    const s = window.__reelStores.useProject.getState()
    s.addVideoLayer('L1', id, 0, 4, true)
    window.__reelStores.useUi.getState().selectLayer('L1')
    return 'L1'
  }, id)
  const layers = (): Promise<string[]> =>
    page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.map((l) => l.id))

  await openQuickCut(page, 'IMG_0001.mp4')
  await expect(page.getByTestId('quickcut-save')).toBeDisabled() // nothing cut yet
  const track = page.getByTestId('quickcut-track')

  // Trim the front to ~0.5 s by dragging the start handle.
  const handle = (await page.getByTestId('quickcut-handle-in-0').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  const to = await xAt(track, 0.5)
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  let p = await pieces(page)
  expect(p).toHaveLength(1)
  expect(p[0].in).toBeCloseTo(0.5, 1)
  expect(p[0].out).toBe(4)

  // Click at 2 s, S splits there.
  const at2 = await xAt(track, 2)
  await page.mouse.click(at2.x, at2.y)
  await page.keyboard.press('s')
  p = await pieces(page)
  expect(p).toHaveLength(2)
  expect(p[0].out).toBeCloseTo(2, 1)
  expect(p[1].in).toBe(p[0].out)
  await expect(page.getByTestId('quickcut-piece-1')).toHaveAttribute('data-selected', 'true')

  // Delete the second piece, then try to delete the last one: it stays.
  await page.keyboard.press('Delete')
  expect(await pieces(page)).toHaveLength(1)
  await expect(page.getByTestId('quickcut-delete')).toBeDisabled()
  await page.keyboard.press('Delete')
  expect(await pieces(page)).toHaveLength(1)
  // Undo brings it back.
  await page.keyboard.press('Control+z')
  p = await pieces(page)
  expect(p).toHaveLength(2)
  expect(await layers()).toEqual([layerId]) // the edit behind never saw S / Delete / Ctrl+Z

  const idsBefore = await mediaIds(page)
  await expect(page.getByTestId('quickcut-save')).toHaveText('Save 2 clips')
  await page.getByTestId('quickcut-save').click()
  await expect(page.getByTestId('quickcut-dialog')).toHaveCount(0, { timeout: 60_000 })

  const added = (await mediaIds(page)).filter((m) => !idsBefore.includes(m))
  expect(added).toHaveLength(2)
  const assets = await media(page, added)
  const byName = Object.fromEntries(assets.map((a) => [a.fileName, a]))
  expect(Object.keys(byName).sort()).toEqual(['IMG_0001 (cut 1).mp4', 'IMG_0001 (cut 2).mp4'])
  const one = byName['IMG_0001 (cut 1).mp4']
  const two = byName['IMG_0001 (cut 2).mp4']
  expect(clips(join(root, 'generated'))).toEqual(['IMG_0001 (cut 1).mp4', 'IMG_0001 (cut 2).mp4'])
  expect(one.originalPath).toBe(join(root, 'generated', 'IMG_0001 (cut 1).mp4'))
  expect(duration(one.originalPath)).toBeCloseTo(p[0].out - p[0].in, 1)
  expect(duration(two.originalPath)).toBeCloseTo(4 - p[1].in, 1)
  expect(one.probe.audio).not.toBeNull()
  await expect(page.getByText('IMG_0001 (cut 2).mp4', { exact: true })).toBeVisible()

  // The original file and the edit are as they were.
  expect(statSync(src).size).toBe(before.size)
  expect(statSync(src).mtimeMs).toBe(before.mtimeMs)
  expect(await layers()).toEqual([layerId])
})

test('Escape and Cancel close without making anything; Quick cut is greyed for audio', async ({
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(90_000)
  const root = join(projectsDir, 'E2E')
  synth(join(root, 'IMG_0002.mp4'))
  await importClip(page, join(root, 'IMG_0002.mp4'))
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', join(root, 'tone.wav')])
  await importClip(page, join(root, 'tone.wav'))
  const idsBefore = await mediaIds(page)

  await openQuickCut(page, 'IMG_0002.mp4')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('quickcut-dialog')).toHaveCount(0)
  await openQuickCut(page, 'IMG_0002.mp4')
  const at = await xAt(page.getByTestId('quickcut-track'), 1)
  await page.mouse.click(at.x, at.y)
  await page.keyboard.press('s')
  expect(await pieces(page)).toHaveLength(2)
  await page.getByTestId('quickcut-cancel').click()
  await expect(page.getByTestId('quickcut-dialog')).toHaveCount(0)
  expect(await mediaIds(page)).toEqual(idsBefore)
  expect(clips(join(root, 'generated'))).toEqual([])

  await page.getByText('tone.wav', { exact: true }).click({ button: 'right' })
  await expect(page.getByTestId('ctx-quickcut')).toHaveAttribute('aria-disabled', 'true')
})
