/**
 * Opening an OLD project (docs/MEDIA-POINTERS.md "Migration"): a schema-23
 * `.reel` whose media lives in the old shared library
 * (`<data>/media/<id>/asset.json`, id = first 12 hex of the WHOLE file's sha1)
 * is converted before it opens — in place when it sits alone in its folder —
 * into a project folder whose library points at the original where it is.
 *
 * ARRANGE the old project + old library on disk exactly as the old app left
 * them (the probe comes from a real import, so it is the app's own shape),
 * ACT via the store's openFile with the Open dialog and the Convert question
 * stubbed, ASSERT on disk + main's library answers + the store + the DOM.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { MediaAsset, MediaRecord } from '../src/shared/media'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

const media = (page: Page, ids: string[]): Promise<MediaAsset[]> =>
  page.evaluate((ids) => window.api.listProjectMedia(ids), ids)

test('opening an old project converts it in place, keeping its clip id and pointing at the untouched original', async ({
  electronApp,
  appPage: page,
  scratchDir,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)

  // The footage, alone with its project in its own folder (the owner's habit).
  const oldDir = join(projectsDir, 'Old')
  mkdirSync(oldDir)
  const clip = join(oldDir, 'clip.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    clip
  ])
  const oldId = createHash('sha1').update(readFileSync(clip)).digest('hex').slice(0, 12)

  // The app's own probe of it (a real import into the fixture project, which
  // the old document never mentions).
  const probe = await page.evaluate(async (p) => (await window.api.importPaths([p]))[0].probe, clip)
  expect(probe.durationSec).toBeCloseTo(2, 1)

  // The old shared library's record, as the old app wrote it.
  const storeDir = join(scratchDir, 'data', 'media', oldId)
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(
    join(storeDir, 'asset.json'),
    JSON.stringify(
      {
        id: oldId,
        fileName: 'clip.mp4',
        originalPath: clip,
        importedAt: '2026-01-02T03:04:05.000Z',
        probe,
        kind: 'video',
        proxyReady: false,
        transcribed: false
      },
      null,
      2
    )
  )

  // The old document: schema 23, the clip in mediaIds and on the timeline. Its
  // shape is the store's own (built here, then undone), with no `library`.
  const oldDoc = await page.evaluate(
    ({ oldId, durationSec }) => {
      const s = window.__reelStores.useProject.getState()
      s.addMedia([oldId])
      s.addVideoLayer('v-old', oldId, 0, durationSec, false)
      const doc = { ...window.__reelStores.useProject.getState().project!, version: 23, name: 'old' }
      s.undo()
      s.undo()
      return doc
    },
    { oldId, durationSec: probe.durationSec }
  )
  expect(oldDoc.mediaIds).toEqual([oldId])
  expect('library' in oldDoc).toBe(false)
  const oldReel = join(oldDir, 'old.reel')
  writeFileSync(oldReel, JSON.stringify(oldDoc, null, 2))
  const clipBefore = statSync(clip)

  // Open it: the picker answers old.reel, the Convert question answers Convert
  // (every box is recorded; a "some media was not found" box would show here).
  await electronApp.evaluate(({ dialog }, reel) => {
    const g = globalThis as unknown as { __boxes: unknown[] }
    g.__boxes = []
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [reel] })) as typeof dialog.showOpenDialog
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const box = args.find((a) => !!a && typeof a === 'object' && 'message' in a) as Electron.MessageBoxOptions
      g.__boxes.push(box.message)
      return { response: 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, oldReel)
  // The fixture project has an unsaved import; discard it.
  await page.evaluate(async () => {
    window.confirm = () => true
    await window.__reelStores.useProject.getState().openFile()
  })
  expect(await electronApp.evaluate(() => (globalThis as unknown as { __boxes: string[] }).__boxes)).toEqual([
    'Convert this old project?'
  ])

  // Converted IN PLACE: Old/ is now the project folder, opened.
  const reel = join(oldDir, 'Old.reel')
  const opened = await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    return { name: s.project!.name, filePath: s.filePath, layers: s.project!.layers.map((l) => l.content) }
  })
  expect(opened.name).toBe('Old')
  expect(opened.filePath).toBe(reel)
  expect(opened.layers).toEqual([expect.objectContaining({ kind: 'video', mediaId: oldId })])
  await expect(page.getByText('Old.reel', { exact: true })).toBeVisible()

  // On disk: the new .reel (current schema) keeps the OLD id and points at the
  // clip by relative path; the old file is kept as .reel-legacy.
  // (Names compared exactly: on Windows `old.reel` and `Old.reel` are one path.)
  const names = readdirSync(oldDir)
  expect(names).toContain('Old.reel')
  expect(names).toContain('old.reel-legacy')
  expect(names).not.toContain('old.reel')
  expect(JSON.parse(readFileSync(`${oldReel}-legacy`, 'utf8'))).toEqual(oldDoc)
  const saved = JSON.parse(readFileSync(reel, 'utf8')) as { version: number; mediaIds: string[]; library: MediaRecord[] }
  expect(saved.version).toBe(26)
  expect(saved.mediaIds).toEqual([oldId])
  expect(saved.library).toHaveLength(1)
  expect(saved.library[0]).toMatchObject({ id: oldId, fileName: 'clip.mp4', relativePath: 'clip.mp4', absolutePath: clip })
  expect(saved.library[0].fingerprint.size).toBe(clipBefore.size)
  for (const dir of ['generated', 'transcripts', 'cache']) expect(statSync(join(oldDir, dir)).isDirectory()).toBe(true)

  // The footage itself was never touched (not moved, rewritten or linked).
  const clipAfter = statSync(clip)
  expect(clipAfter.size).toBe(clipBefore.size)
  expect(clipAfter.mtimeMs).toBe(clipBefore.mtimeMs)
  expect(clipAfter.nlink).toBe(1)

  // It is usable: found, and its preview builds into the project's cache.
  await expect(page.getByTestId('media-missing')).toHaveCount(0)
  expect((await media(page, [oldId]))[0]).toMatchObject({ status: 'ok', originalPath: clip })
  await expect.poll(async () => (await media(page, [oldId]))[0].proxyReady, { timeout: 30_000 }).toBe(true)
  expect(existsSync(join(oldDir, 'cache', oldId))).toBe(true)
})
