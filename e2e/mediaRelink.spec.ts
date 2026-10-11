/**
 * Relink (docs/MEDIA-POINTERS.md "Relink"): a Missing clip's Relink… picks a
 * file; one that doesn't match the clip's fingerprint needs "Update path
 * anyway" (a different length then resets the clip's cuts, one undo step); and
 * afterwards the picked file's folder reconnects the project's other missing
 * clips ("relink one, fix the rest").
 *
 * ARRANGE via real imports into the fixture's project, ACT via the Library's
 * Relink… button with the native dialogs stubbed (every message box is
 * RECORDED, so the spec asserts what the user was asked), ASSERT on main's
 * library answers + the store + the DOM.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import type { VideoContent } from '../src/shared/project'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

const media = (page: Page, ids: string[]): Promise<MediaAsset[]> =>
  page.evaluate((ids) => window.api.listProjectMedia(ids), ids)

/** A tiny H.264 clip; `pattern` + `duration` make files with different bytes. */
const synth = (out: string, duration: number, pattern = 'testsrc2'): void => {
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `${pattern}=size=320x568:rate=30:duration=${duration}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    out
  ])
}

/** Import `path`, place it as video layer `layerId`, and wait for its proxy. */
async function importClip(page: Page, path: string, layerId: string): Promise<string> {
  const id = await page.evaluate(
    async ({ p, layerId }) => {
      const [asset] = await window.api.importPaths([p])
      const s = window.__reelStores.useProject.getState()
      s.addMedia([asset.id])
      s.addVideoLayer(layerId, asset.id, 0, asset.probe.durationSec, false)
      return asset.id
    },
    { p: path, layerId }
  )
  await expect.poll(async () => (await media(page, [id]))[0]?.proxyReady, { timeout: 30_000 }).toBe(true)
  return id
}

const save = (page: Page): Promise<void> => page.evaluate(() => window.__reelStores.useProject.getState().save())

const videoContent = (page: Page, layerId: string): Promise<VideoContent> =>
  page.evaluate((layerId) => {
    const layer = window.__reelStores.useProject.getState().project!.layers.find((l) => l.id === layerId)!
    return layer.content as VideoContent
  }, layerId)

interface Box {
  type?: string
  message: string
  detail?: string
}

/** Answer the Relink file picker with `filePath`, and every message box by
 *  `answer(box)` — recording each box into `globalThis.__boxes` (main). */
async function stubRelink(
  app: ElectronApplication,
  filePath: string,
  answers: { warning: 'accept' | 'cancel' }
): Promise<void> {
  await app.evaluate(
    ({ dialog }, { filePath, accept }) => {
      const g = globalThis as unknown as { __boxes: unknown[] }
      g.__boxes = []
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const box = args.find((a) => !!a && typeof a === 'object' && 'message' in a) as Electron.MessageBoxOptions
        g.__boxes.push({ type: box.type, message: box.message, detail: box.detail })
        const response = box.type === 'warning' && !accept ? (box.cancelId ?? 1) : 0
        return { response, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    },
    { filePath, accept: answers.warning === 'accept' }
  )
}

const boxes = (app: ElectronApplication): Promise<Box[]> =>
  app.evaluate(() => (globalThis as unknown as { __boxes: Box[] }).__boxes)

/**
 * Shared ARRANGE for the mismatch cases: a 2 s clip placed with a 0.5→1.5 cut,
 * saved; then a DIFFERENT 3 s file written over it at the same path, and the
 * library re-checked (the user coming back from Explorer) → Missing.
 */
async function arrangeMismatch(page: Page, projectsDir: string): Promise<{ id: string; source: string; before: MediaAsset }> {
  const root = join(projectsDir, 'E2E')
  mkdirSync(join(root, 'footage'))
  const source = join(root, 'footage', 'IMG_0010.mp4')
  synth(source, 2)
  const id = await importClip(page, source, 'v1')
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.updateLayerContent('v1', { inSec: 0.5, outSec: 1.5 })
    s.updateLayer('v1', { endSec: 1 })
  })
  expect(await videoContent(page, 'v1')).toMatchObject({ inSec: 0.5, outSec: 1.5 })
  await save(page)
  const [before] = await media(page, [id])
  expect(before.status).toBe('ok')

  synth(source, 3, 'smptebars') // same name, different footage
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByTestId('media-missing')).toBeVisible()
  expect((await media(page, [id]))[0].status).toBe('missing')
  return { id, source, before }
}

test('a mismatched file: the warning names the fields, Update anyway re-points it and resets a different-length cut (one undo)', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const { id, source, before } = await arrangeMismatch(page, projectsDir)

  await stubRelink(electronApp, source, { warning: 'accept' })
  await page.getByTestId('media-missing').getByRole('button', { name: 'Relink…' }).click()
  await expect(page.getByTestId('media-missing')).toHaveCount(0)

  // The user was warned, in the design's words, with the differing fields.
  const asked = await boxes(electronApp)
  expect(asked).toHaveLength(1) // no "also reconnected" box: nothing else was missing
  expect(asked[0].type).toBe('warning')
  expect(asked[0].message).toContain('These fields do not match')
  expect(asked[0].detail).toContain('File size')

  // The clip now IS the new file: fingerprint + probe follow it.
  const [after] = await media(page, [id])
  expect(after).toMatchObject({ status: 'ok', originalPath: source })
  expect(after.fingerprint).not.toEqual(before.fingerprint)
  expect(after.probe.durationSec).toBeCloseTo(3, 1)

  // Different length → the placement resets to the whole new file…
  await expect.poll(async () => (await videoContent(page, 'v1')).inSec).toBe(0)
  expect((await videoContent(page, 'v1')).outSec).toBeCloseTo(3, 1)
  // …its preview rebuilds (the old cache described the old content)…
  await expect.poll(async () => (await media(page, [id]))[0].proxyReady, { timeout: 30_000 }).toBe(true)
  // …and ONE undo brings the old cut back.
  await page.evaluate(() => window.__reelStores.useProject.getState().undo())
  expect(await videoContent(page, 'v1')).toMatchObject({ inSec: 0.5, outSec: 1.5 })
})

test('a mismatched file answered Cancel changes nothing: the clip stays Missing', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const { id, before } = await arrangeMismatch(page, projectsDir)
  const doc = await page.evaluate(() => window.__reelStores.useProject.getState().project)

  await stubRelink(electronApp, before.originalPath, { warning: 'cancel' })
  const relink = page.getByTestId('media-missing').getByRole('button', { name: 'Relink…' })
  await relink.click()
  await expect.poll(async () => (await boxes(electronApp)).length).toBe(1)
  await expect(relink).toBeEnabled() // the relink finished (canceled)

  expect((await boxes(electronApp))[0].message).toContain('These fields do not match')
  await expect(page.getByTestId('media-missing')).toBeVisible()
  const [after] = await media(page, [id])
  expect(after.status).toBe('missing')
  expect(after.fingerprint).toEqual(before.fingerprint)
  expect(after.probe.durationSec).toBeCloseTo(before.probe.durationSec, 3)
  expect(await videoContent(page, 'v1')).toMatchObject({ inSec: 0.5, outSec: 1.5 })
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project)).toEqual(doc)
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().dirty)).toBe(false)
})

test('relink one, fix the rest: the other missing clip in the picked folder reconnects too', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  mkdirSync(join(root, 'footage'))
  const a = join(root, 'footage', 'A.mp4')
  const b = join(root, 'footage', 'B.mp4')
  synth(a, 2)
  synth(b, 1, 'smptebars')
  const idA = await importClip(page, a, 'va')
  const idB = await importClip(page, b, 'vb')
  await save(page)

  renameSync(join(root, 'footage'), join(root, 'footage2'))
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByTestId('media-missing')).toHaveCount(2)

  // A mismatch would mean the wrong card was relinked: the stub cancels it.
  const movedA = join(root, 'footage2', 'A.mp4')
  await stubRelink(electronApp, movedA, { warning: 'cancel' })
  await page
    .getByTestId('media-missing')
    .filter({ hasText: 'A.mp4' })
    .getByRole('button', { name: 'Relink…' })
    .click()
  await expect(page.getByTestId('media-missing')).toHaveCount(0)

  const asked = await boxes(electronApp)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({
    type: 'info',
    message: 'Also reconnected 1 other missing clip found in that folder.',
    detail: 'B.mp4'
  })
  const byId = new Map((await media(page, [idA, idB])).map((m) => [m.id, m]))
  expect(byId.get(idA)).toMatchObject({ status: 'ok', originalPath: movedA, relativePath: 'footage2/A.mp4' })
  expect(byId.get(idB)).toMatchObject({
    status: 'ok',
    originalPath: join(root, 'footage2', 'B.mp4'),
    relativePath: 'footage2/B.mp4'
  })
})
