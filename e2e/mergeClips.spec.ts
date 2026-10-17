/**
 * Merge clips (docs/MERGE-CLIPS.md): Library right-click ▸ Merge clips… picks
 * videos in play order and makes ONE new clip in the project's `generated/`;
 * Quick cut ▸ Save as one clip joins the pieces of a cut without the gaps. The
 * originals and the edit behind are untouched, and the dialog's keys never
 * reach the app's own shortcuts.
 *
 * ARRANGE via real imports, ACT via real right-clicks, clicks and keys,
 * ASSERT on the dialog DOM, the library, the store and the files (ffprobe).
 * No native dialog is involved.
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

/** A clip made by the real ffmpeg: `size` at `rate` fps for `sec` seconds, with a tone or silent. */
function synth(out: string, size: string, rate: number, sec: number, tone: boolean): void {
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=${rate}:duration=${sec}`,
    ...(tone ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-c:a', 'aac', '-shortest'] : []),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
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

const clips = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => !n.startsWith('.'))
        .sort()
    : []

const probe = (file: string): { width: number; height: number; streams: string[]; duration: number } => {
  const j = JSON.parse(
    execFileSync(FFPROBE, [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,width,height:format=duration',
      '-of',
      'json',
      file
    ]).toString()
  ) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } }
  const v = j.streams.find((s) => s.codec_type === 'video')!
  return {
    width: v.width!,
    height: v.height!,
    streams: j.streams.map((s) => s.codec_type),
    duration: Number(j.format.duration)
  }
}

const card = (page: Page, name: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')} `) })

test('Library ▸ Merge clips…: pick, reorder, merge into one clip in generated/; originals and edit untouched', async ({
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG) || !existsSync(FFPROBE), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  const a = join(root, 'IMG_A.mp4')
  const b = join(root, 'IMG_B.mp4')
  synth(a, '320x568', 30, 2, true) // portrait, with sound
  synth(b, '568x320', 60, 1, false) // landscape, silent, faster
  const idA = await importClip(page, a)

  // Only one video in the library: nothing to merge with.
  await card(page, 'IMG_A.mp4').click({ button: 'right' })
  await expect(page.getByTestId('ctx-merge')).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  const idB = await importClip(page, b)
  const beforeA = statSync(a)
  await page.evaluate((id) => {
    window.__reelStores.useProject.getState().addVideoLayer('L1', id, 0, 2, true)
    window.__reelStores.useUi.getState().selectLayer('L1')
  }, idA)
  const layers = (): Promise<string[]> =>
    page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.map((l) => l.id))

  // Escape closes without making anything.
  await card(page, 'IMG_A.mp4').click({ button: 'right' })
  await page.getByTestId('ctx-merge').click()
  await expect(page.getByTestId('merge-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('merge-dialog')).toHaveCount(0)

  await card(page, 'IMG_A.mp4').click({ button: 'right' })
  await page.getByTestId('ctx-merge').click()
  // The clip right-clicked starts the order; one clip can't be merged.
  await expect(page.getByTestId(`merge-pick-${idA}`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('merge-submit')).toBeDisabled()
  await page.getByTestId(`merge-pick-${idB}`).click()
  await expect(page.getByTestId('merge-submit')).toHaveText('Merge 2 clips')
  await expect(page.getByTestId('merge-summary')).toContainText('3.00s')
  // B plays first: move A down. Delete / Backspace inside never reach the editor.
  await page.getByTestId('merge-down-0').click()
  await expect(page.getByTestId('merge-order')).toContainText(/1\s*IMG_B\.mp4[\s\S]*2\s*IMG_A\.mp4/)
  await page.keyboard.press('Delete')
  expect(await layers()).toEqual(['L1'])

  const idsBefore = await mediaIds(page)
  await page.getByTestId('merge-submit').click()
  await expect(page.getByTestId('merge-dialog')).toHaveCount(0, { timeout: 60_000 })

  const added = (await mediaIds(page)).filter((m) => !idsBefore.includes(m))
  expect(added).toHaveLength(1)
  const [merged] = await media(page, added)
  expect(merged.fileName).toBe('IMG_B (merged).mp4')
  expect(clips(join(root, 'generated'))).toEqual(['IMG_B (merged).mp4'])
  expect(merged.originalPath).toBe(join(root, 'generated', 'IMG_B (merged).mp4'))
  // The first clip's frame (landscape); A's sound plus B's silence → an audio track.
  const p = probe(merged.originalPath)
  expect([p.width, p.height]).toEqual([568, 320])
  expect(p.streams).toEqual(['video', 'audio'])
  expect(p.duration).toBeCloseTo(3, 1)
  await expect(page.getByText('IMG_B (merged).mp4', { exact: true })).toBeVisible()
  // The new clip is selected in the library, ready to add.
  expect(await page.evaluate(() => window.__reelStores.useEditor.getState().selectedId)).toBe(merged.id)

  expect(statSync(a).mtimeMs).toBe(beforeA.mtimeMs)
  expect(await layers()).toEqual(['L1'])
})

test('Quick cut ▸ Save as one clip: cut out the middle, keep both ends as ONE clip', async ({
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG) || !existsSync(FFPROBE), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  const src = join(root, 'IMG_0003.mp4')
  synth(src, '320x568', 30, 4, true)
  await importClip(page, src)

  await card(page, 'IMG_0003.mp4').click({ button: 'right' })
  await page.getByTestId('ctx-quickcut').click()
  await expect(page.getByTestId('quickcut-dialog')).toBeVisible()
  await expect(page.getByTestId('quickcut-save-one')).toHaveCount(0) // one piece: nothing to join

  // Split at 1 s and 3 s, then delete the middle piece.
  const track = page.getByTestId('quickcut-track')
  const box = (await track.boundingBox())!
  for (const sec of [1, 3]) {
    await page.mouse.click(box.x + (box.width * sec) / 4, box.y + box.height / 2)
    await page.keyboard.press('s')
  }
  await page.getByTestId('quickcut-piece-1').click()
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-testid^="quickcut-piece-"]')).toHaveCount(2)

  const idsBefore = await mediaIds(page)
  await page.getByTestId('quickcut-save-one').click()
  await expect(page.getByTestId('quickcut-dialog')).toHaveCount(0, { timeout: 60_000 })

  const added = (await mediaIds(page)).filter((m) => !idsBefore.includes(m))
  expect(added).toHaveLength(1)
  const [one] = await media(page, added)
  expect(one.fileName).toBe('IMG_0003 (cut).mp4')
  expect(clips(join(root, 'generated'))).toEqual(['IMG_0003 (cut).mp4'])
  const p = probe(one.originalPath)
  expect([p.width, p.height]).toEqual([320, 568])
  expect(p.duration).toBeCloseTo(2, 1)
})
