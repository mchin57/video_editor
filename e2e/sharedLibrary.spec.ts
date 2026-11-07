/**
 * The shared library (Insert ▸ Shared ▸ Sounds / Graphics / Video / Text /
 * Templates; docs/SHARED-LIBRARY.md): Add files… copies a file into the
 * editor-wide `<data>/shared`; Insert puts a COPY into the project's
 * `generated/` and onto the timeline at the playhead in ONE undo step, and a
 * second Insert reuses that copy; a graphic's preview is served by the
 * protocol; saved text lands exactly as it was saved; the Library's
 * right-click copies a clip in; rename and delete; a file of the wrong kind is
 * refused; Templates moved under Shared.
 *
 * ARRANGE via the stores, a real import and a stubbed native Open dialog, ACT
 * via the real menu and dialog buttons, ASSERT on store, disk and DOM.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import type { Layer } from '../src/shared/project'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

test.skip(!existsSync(FFMPEG), 'needs the staged ffmpeg (npm run collect-binaries)')

const ff = (...args: string[]): void => {
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args])
}
const beep = (out: string, freq = 880): string => {
  ff('-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=0.5`, out)
  return out
}
const png = (out: string): string => {
  ff('-f', 'lavfi', '-i', 'color=c=red:size=64x64', '-frames:v', '1', out)
  return out
}

/** Make the next native Open dialog answer `paths`. */
async function stubOpen(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog
  }, paths)
}

async function openShared(page: Page, tab: 'sound' | 'graphic' | 'video' | 'text'): Promise<void> {
  await page.getByTestId('insert-menu').click()
  await page.getByTestId('insert-shared').click()
  await page.getByTestId(`insert-shared-${tab}`).click()
  await expect(page.getByTestId('shared-dialog')).toBeVisible()
  await expect(page.getByTestId(`shared-tab-${tab}`)).toHaveAttribute('aria-selected', 'true')
}

const project = (page: Page) =>
  page.evaluate(() => {
    const p = window.__reelStores.useProject.getState().project!
    return { layers: p.layers, audioClips: p.audioClips, mediaIds: p.mediaIds }
  })

const media = (page: Page, ids: string[]): Promise<MediaAsset[]> =>
  page.evaluate((ids) => window.api.listProjectMedia(ids), ids)

const sharedIds = (page: Page): Promise<string[]> =>
  page.evaluate(async () => (await window.api.listShared()).map((i) => i.id))

test('a shared sound: Add files… copies it in; Insert copies it into the project at the playhead, once, in one undo step', async ({
  appPage: page,
  electronApp,
  scratchDir,
  projectsDir
}) => {
  const src = beep(join(scratchDir, 'Whoosh.wav'))
  await openShared(page, 'sound')
  await expect(page.getByTestId('shared-empty')).toBeVisible()

  await stubOpen(electronApp, [src])
  await page.getByTestId('shared-add').click()
  await expect(page.getByTestId('shared-note')).toHaveText('Added “Whoosh”.')
  const [id] = await sharedIds(page)
  await expect(page.getByTestId(`shared-name-${id}`)).toHaveText('Whoosh')
  // The library keeps its OWN copy, under the data dir.
  expect(readdirSync(join(scratchDir, 'data', 'shared', id)).sort()).toEqual(['Whoosh.wav', 'item.json'])

  // Adding the same file again copies nothing.
  await stubOpen(electronApp, [src])
  await page.getByTestId('shared-add').click()
  await expect(page.getByTestId('shared-note')).toHaveText('“Whoosh” is already in the shared library.')
  expect(await sharedIds(page)).toHaveLength(1)

  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2))
  await page.getByTestId(`shared-insert-${id}`).click()
  await expect(page.getByTestId('shared-dialog')).toHaveCount(0)
  let p = await project(page)
  expect(p.audioClips).toHaveLength(1)
  expect(p.audioClips[0].startSec).toBeCloseTo(2)
  expect(p.mediaIds).toEqual([p.audioClips[0].mediaId])
  const [asset] = await media(page, p.mediaIds)
  // The project's copy lives in its generated/ folder, never in the shared one.
  expect(asset.originalPath.startsWith(join(projectsDir, 'E2E', 'generated'))).toBe(true)
  expect(asset.fileName).toBe('Whoosh.wav')
  const sel = await page.evaluate(() => window.__reelStores.useUi.getState().selection)
  expect(sel).toEqual([{ kind: 'audio', id: p.audioClips[0].id }])

  // A second Insert reuses the project's copy.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(5))
  await openShared(page, 'sound')
  await page.getByTestId(`shared-insert-${id}`).click()
  await expect(page.getByTestId('shared-dialog')).toHaveCount(0)
  p = await project(page)
  expect(p.audioClips.map((a) => a.startSec)).toEqual([2, 5])
  expect(new Set(p.audioClips.map((a) => a.mediaId)).size).toBe(1)
  expect(p.mediaIds).toHaveLength(1)

  // One undo takes the second clip back off; the first stays.
  await page.keyboard.press('Control+z')
  p = await project(page)
  expect(p.audioClips.map((a) => a.startSec)).toEqual([2])

  // Deleting the shared item leaves the project's own copy alone.
  await openShared(page, 'sound')
  await page.getByTestId(`shared-delete-${id}`).click()
  await page.getByTestId(`shared-delete-confirm-${id}`).click()
  await expect(page.getByTestId('shared-note')).toHaveText('Deleted “Whoosh”. Projects that used it keep their copy.')
  expect(existsSync(join(scratchDir, 'data', 'shared', id))).toBe(false)
  expect(existsSync(asset.originalPath)).toBe(true)
  const [after] = await media(page, p.mediaIds)
  expect(after.status ?? 'ok').toBe('ok')
})

test('a shared video lands as a linked video + audio pair, selected, in one undo step, and its preview builds', async ({
  appPage: page,
  electronApp,
  scratchDir
}) => {
  const intro = join(scratchDir, 'Intro.mp4')
  ff(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568:rate=30:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:duration=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    intro
  )
  await openShared(page, 'video')
  await stubOpen(electronApp, [intro])
  await page.getByTestId('shared-add').click()
  await expect(page.getByTestId('shared-note')).toHaveText('Added “Intro”.')
  const [id] = await sharedIds(page)
  // A video gets a thumbnail made by ffmpeg, served by the protocol.
  await expect
    .poll(() => page.getByTestId(`shared-preview-${id}`).evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)

  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(3))
  await page.getByTestId(`shared-insert-${id}`).click()
  await expect(page.getByTestId('shared-dialog')).toHaveCount(0)
  const p = await project(page)
  const video = p.layers.find((l) => l.content.kind === 'video')!
  expect(video.startSec).toBeCloseTo(3)
  expect(p.audioClips).toHaveLength(1)
  expect(p.audioClips[0].linkGroupId).toBeTruthy()
  expect(p.audioClips[0].linkGroupId).toBe(video.linkGroupId)
  const sel = await page.evaluate(() => window.__reelStores.useUi.getState().selection.map((r) => `${r.kind}:${r.id}`))
  expect(sel.sort()).toEqual([`audio:${p.audioClips[0].id}`, `layer:${video.id}`].sort())
  // Placed before the project's copy had a preview; the preview still builds.
  await expect.poll(async () => (await media(page, p.mediaIds))[0]?.proxyReady, { timeout: 30_000 }).toBe(true)

  await page.keyboard.press('Control+z')
  const undone = await project(page)
  expect(undone.layers).toEqual([])
  expect(undone.audioClips).toEqual([])
})

test('a shared graphic shows its picture, refuses a file of the wrong kind, and lands as an image layer', async ({
  appPage: page,
  electronApp,
  scratchDir
}) => {
  const logo = png(join(scratchDir, 'logo.png'))
  const sound = beep(join(scratchDir, 'ding.wav'))
  await openShared(page, 'graphic')
  await stubOpen(electronApp, [logo, sound])
  await page.getByTestId('shared-add').click()
  await expect(page.getByTestId('shared-note')).toHaveText(
    "Added “logo”. Not added: ding.wav. It isn't a picture, so it belongs on the Sounds tab."
  )
  const [id] = await sharedIds(page)
  // The protocol serves the preview (it decodes to a real picture).
  const preview = page.getByTestId(`shared-preview-${id}`)
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(64)

  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1))
  await page.getByTestId(`shared-insert-${id}`).click()
  await expect(page.getByTestId('shared-dialog')).toHaveCount(0)
  const { layers } = await project(page)
  expect(layers).toHaveLength(1)
  expect(layers[0].content.kind).toBe('image')
  expect([layers[0].startSec, layers[0].endSec]).toEqual([1, 4])
  expect(await page.evaluate(() => window.__reelStores.useUi.getState().selectedLayerId)).toBe(layers[0].id)

  await page.keyboard.press('Control+z')
  expect((await project(page)).layers).toEqual([])
})

test('saved text lands exactly as it was saved, at the playhead', async ({ appPage: page }) => {
  const saved = await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addLayer({
      id: 'bio',
      hidden: false,
      startSec: 3,
      endSec: 5.5,
      x: 260,
      y: 1650,
      scale: 1.3,
      rotationDeg: -6,
      content: {
        kind: 'text',
        text: 'Link in bio',
        fontFamily: 'anton',
        fontSizePx: 96,
        color: '#ffcc00',
        pill: { enabled: true, color: '#000000', padPx: 24 }
      }
    })
    // A graphics tile selected with it is left out of the text piece.
    useProject.getState().addLayer({
      id: 'marks',
      hidden: false,
      startSec: 3,
      endSec: 4,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'graphics', marks: [] }
    })
    useUi.getState().selectItems(
      [
        { kind: 'layer', id: 'bio' },
        { kind: 'layer', id: 'marks' }
      ],
      { kind: 'layer', id: 'bio' }
    )
    return useProject.getState().project!.layers[0]
  })
  await openShared(page, 'text')
  await page.getByTestId('shared-text-name').fill('  Bio   line ')
  await page.getByTestId('shared-text-save').click()
  await expect(page.getByTestId('shared-note')).toHaveText(
    'Saved “Bio line”. Only text is saved, so 1 other selected piece was left out.'
  )
  const [id] = await sharedIds(page)
  await page.getByTestId('shared-close').click()

  // Gone from this edit; insert it somewhere else.
  await page.evaluate(() => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().removeItems([
      { kind: 'layer', id: 'bio' },
      { kind: 'layer', id: 'marks' }
    ])
    usePlayback.getState().setTime(10)
  })
  await openShared(page, 'text')
  await expect(page.getByTestId(`shared-name-${id}`)).toHaveText('Bio line')
  await page.getByTestId(`shared-insert-${id}`).click()
  await expect(page.getByTestId('shared-dialog')).toHaveCount(0)
  const { layers } = await project(page)
  expect(layers).toHaveLength(1)
  const got = layers[0] as Layer
  expect(got.id).not.toBe('bio')
  expect([got.startSec, got.endSec]).toEqual([10, 12.5])
  for (const k of ['x', 'y', 'scale', 'rotationDeg', 'content'] as const) expect(got[k]).toEqual(saved[k])
  // Selected, so the Inspector opens on it.
  const selId = await page.evaluate(() => window.__reelStores.useUi.getState().selectedLayerId)
  expect(selId).toBe(got.id)

  await page.keyboard.press('Control+z')
  expect((await project(page)).layers).toEqual([])
})

test("the Library's right-click copies a clip in; rename and delete; Templates moved under Shared", async ({
  appPage: page,
  scratchDir
}) => {
  const src = beep(join(scratchDir, 'IMG_0042.wav'), 440)
  const mediaId = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, src)
  await expect.poll(async () => (await media(page, [mediaId]))[0]?.proxyReady, { timeout: 30_000 }).toBe(true)

  await page.getByText('IMG_0042.wav', { exact: true }).click({ button: 'right' })
  await page.getByTestId('ctx-add-shared').click()
  await expect(page.getByTestId('shared-dialog')).toBeVisible()
  await expect(page.getByTestId('shared-tab-sound')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('shared-note')).toHaveText('Added “IMG_0042”.')
  const [id] = await sharedIds(page)

  await page.getByTestId(`shared-rename-${id}`).click()
  await page.getByTestId(`shared-rename-input-${id}`).fill('Starting gun')
  await page.getByTestId(`shared-rename-save-${id}`).click()
  await expect(page.getByTestId(`shared-name-${id}`)).toHaveText('Starting gun')

  await page.getByTestId(`shared-delete-${id}`).click()
  await page.getByTestId(`shared-delete-confirm-${id}`).click()
  await expect(page.getByTestId(`shared-item-${id}`)).toHaveCount(0)
  await expect(page.getByTestId('shared-empty')).toBeVisible()
  expect(existsSync(join(scratchDir, 'data', 'shared', id))).toBe(false)
  // The project's own clip is untouched.
  expect((await project(page)).mediaIds).toEqual([mediaId])

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('shared-dialog')).toHaveCount(0)

  await page.getByTestId('insert-menu').click()
  await page.getByTestId('insert-shared').click()
  await page.getByTestId('insert-template').click()
  await expect(page.getByTestId('templates-dialog')).toBeVisible()
})
