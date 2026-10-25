/**
 * Templates (Insert ▸ Template… / Save selection as template…): the gallery
 * lists the built-in starters; Insert drops one at the playhead as ONE linked,
 * selected, undoable edit; "We'll be right back" holds the frame under the
 * playhead (zoomed, tinted, silent) and moves the rest of the edit later by the
 * hold; with no clip under the playhead only its text lands, with a note; the
 * selection saves as a template you can insert and delete; a built-in's sound
 * slot makes your copy; the share file round-trips; and a tinted clip's
 * PREVIEW shows the colours the ffmpeg tint was verified to produce
 * (FFMPEG-NOTES "Clip tint").
 *
 * ARRANGE via the stores (and a stubbed native dialog), ACT via the real menu
 * and dialog buttons, ASSERT on store + DOM (+ preview pixels).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { Layer, VideoContent } from '../src/shared/project'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const RIGHT_BACK = 'builtin-right-back'

const project = (page: Page) =>
  page.evaluate(() => {
    const p = window.__reelStores.useProject.getState().project!
    return { layers: p.layers, audioClips: p.audioClips, mediaIds: p.mediaIds }
  })

async function openGallery(page: Page): Promise<void> {
  await page.getByTestId('insert-menu').click()
  await page.getByTestId('insert-template').click()
  await expect(page.getByTestId('templates-dialog')).toBeVisible()
}

/** Make the next native Open/Save dialog answer `path`. */
async function stubDialog(app: ElectronApplication, kind: 'open' | 'save', path: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, { kind, path }) => {
      if (kind === 'open') {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
      } else {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
      }
    },
    { kind, path }
  )
}

test('the gallery lists the starters; Insert drops one at the playhead, linked and selected, in one undo step', async ({
  appPage: page
}) => {
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2))
  await openGallery(page)
  for (const id of [
    RIGHT_BACK,
    'builtin-follow',
    'builtin-link-in-bio',
    'builtin-lower-third',
    'builtin-before-after'
  ]) {
    await expect(page.getByTestId(`template-${id}`)).toBeVisible()
  }
  await expect(page.getByTestId(`template-summary-${RIGHT_BACK}`)).toHaveText(
    'Freeze 3s · zoom · tint · 1 text · sting: none'
  )
  // Built-ins can't be deleted.
  await expect(page.getByTestId(`template-delete-${RIGHT_BACK}`)).toHaveCount(0)

  await page.getByTestId('template-insert-builtin-follow').click()
  await expect(page.getByTestId('templates-dialog')).toHaveCount(0)
  const { layers } = await project(page)
  expect(layers.map((l) => [l.content.kind, l.startSec])).toEqual([
    ['text', 2],
    ['text', 2.3]
  ])
  expect(layers[0].linkGroupId).toBeTruthy()
  expect(layers[1].linkGroupId).toBe(layers[0].linkGroupId)
  const sel = await page.evaluate(() => window.__reelStores.useUi.getState().selection.map((r) => r.id))
  expect(sel.sort()).toEqual(layers.map((l) => l.id).sort())

  await page.keyboard.press('Control+z')
  expect((await project(page)).layers).toEqual([])
})

test("'We'll be right back' holds the frame under the playhead and the rest of the edit resumes after the hold", async ({
  appPage: page
}) => {
  await page.evaluate(() => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('V', 'no-such-media', 0, 10, false)
    useProject.getState().addLayer({
      id: 'later',
      hidden: false,
      startSec: 8,
      endSec: 9,
      x: 540,
      y: 600,
      scale: 1,
      content: {
        kind: 'text',
        text: 'Later',
        fontFamily: 'anton',
        fontSizePx: 80,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000', padPx: 0 }
      }
    })
    usePlayback.getState().setTime(4)
  })
  await openGallery(page)
  await page.getByTestId(`template-insert-${RIGHT_BACK}`).click()
  await expect(page.getByTestId('templates-dialog')).toHaveCount(0)

  const { layers } = await project(page)
  const videos = layers.filter((l) => l.content.kind === 'video') as (Layer & { content: VideoContent })[]
  expect(videos).toHaveLength(3)
  const [left, held, rest] = [...videos].sort((a, b) => a.startSec - b.startSec)
  expect([left.startSec, left.endSec]).toEqual([0, 4])
  expect(held.startSec).toBe(4)
  expect(held.endSec - held.startSec).toBeCloseTo(3 + 2 / 30, 3) // two source frames at the 30 fps fallback
  expect(held.content.mute).toBe(true)
  expect(held.content.tint).toEqual({ color: '#e8c290', amount: 0.65 })
  expect(held.keyframes?.at(-1)?.scale).toBeCloseTo(1.3, 3)
  expect(rest.startSec).toBeCloseTo(7 + 2 / 30, 3)
  expect(rest.content.tint ?? null).toBeNull()
  // Moved later by exactly the hold.
  expect(layers.find((l) => l.id === 'later')!.startSec).toBeCloseTo(11, 3)
  // The title rides on top, linked with the held frame; the empty sting slot added nothing.
  const title = layers.at(-1)!
  expect(title.content.kind === 'text' && title.content.text).toBe("We'll be right back")
  expect(title.linkGroupId).toBe(held.linkGroupId)
  expect((await project(page)).audioClips).toEqual([])
})

test('with no clip under the playhead only the overlays land, and the dialog says why', async ({ appPage: page }) => {
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1))
  await openGallery(page)
  await page.getByTestId(`template-insert-${RIGHT_BACK}`).click()
  await expect(page.getByTestId('templates-note')).toContainText('no clip under the playhead')
  const { layers } = await project(page)
  expect(layers.map((l) => l.content.kind)).toEqual(['text'])
})

test('the selection saves as a template you can insert again and delete', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addLayer({
      id: 'hook',
      hidden: false,
      startSec: 5,
      endSec: 7,
      x: 540,
      y: 500,
      scale: 1,
      content: {
        kind: 'text',
        text: 'Wait for it',
        fontFamily: 'bebas-neue',
        fontSizePx: 120,
        color: '#ffd60a',
        pill: { enabled: false, color: '#000000', padPx: 0 }
      }
    })
    useUi.getState().selectLayer('hook')
  })
  await page.getByTestId('insert-menu').click()
  await page.getByTestId('insert-save-template').click()
  await expect(page.getByTestId('template-name')).toBeFocused()
  await page.keyboard.type('Wait for it')
  await page.getByTestId('template-save').click()
  await expect(page.getByTestId('templates-note')).toHaveText('Saved “Wait for it”.')
  const card = page.getByTestId('templates-list').locator('li', { hasText: 'Wait for it' })
  await expect(card).toContainText('Yours')
  await expect(card).toContainText('1 text')

  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(10))
  await card.getByRole('button', { name: 'Insert' }).click()
  await expect(page.getByTestId('templates-dialog')).toHaveCount(0)
  const { layers } = await project(page)
  expect(layers).toHaveLength(2)
  const copy = layers[1]
  expect([copy.startSec, copy.endSec]).toEqual([10, 12])
  expect(copy.content).toEqual(layers[0].content)

  await openGallery(page)
  await card.getByRole('button', { name: 'Delete' }).click()
  await card.getByRole('button', { name: 'Delete for good' }).click()
  await expect(page.getByTestId('templates-list').locator('li', { hasText: 'Wait for it' })).toHaveCount(0)
})

test("a built-in's sound makes your copy; inserting it adds the sound to the project; the share file round-trips", async ({
  appPage: page,
  electronApp,
  scratchDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const sting = join(scratchDir, 'sting.wav')
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=880:d=1', sting])

  await openGallery(page)
  await stubDialog(electronApp, 'open', sting)
  await page.getByTestId(`template-sound-${RIGHT_BACK}-0`).click()
  await expect(page.getByTestId('templates-note')).toContainText('Sound set')
  // The built-in is replaced in the list by your copy, which has the sound.
  await expect(page.getByTestId(`template-${RIGHT_BACK}`)).toHaveCount(0)
  const mine = page.getByTestId('templates-list').locator('li', { hasText: "We'll be right back" })
  await expect(mine).toContainText('Yours (from a built-in)')
  await expect(mine).toContainText('sting: set')

  // Insert it: the sound is copied into the project's library and placed.
  await mine.getByRole('button', { name: 'Insert' }).click()
  await expect(page.getByTestId('templates-note')).toContainText('no clip under the playhead')
  const { audioClips, mediaIds } = await project(page)
  expect(audioClips).toHaveLength(1)
  expect(mediaIds).toContain(audioClips[0].mediaId)

  // Export the copy, then import it back: a second one, renamed.
  const file = join(scratchDir, 'wbrb.reeltemplate')
  await stubDialog(electronApp, 'save', file)
  await mine.getByRole('button', { name: 'Export…' }).click()
  await expect(page.getByTestId('templates-note')).toContainText('Exported to')
  expect(statSync(file).size).toBeGreaterThan(1000) // the sound is inside
  await stubDialog(electronApp, 'open', file)
  await page.getByTestId('templates-import').click()
  await expect(page.getByTestId('templates-note')).toHaveText('Template imported.')
  await expect(page.getByTestId('templates-list').locator('li', { hasText: "We'll be right back (2)" })).toContainText(
    'sting: set'
  )

  // Resetting the copy brings the built-in back.
  await mine.first().getByRole('button', { name: 'Reset' }).click()
  await mine.first().getByRole('button', { name: 'Reset to built-in' }).click()
  await expect(page.getByTestId(`template-${RIGHT_BACK}`)).toBeVisible()
})

test("a tinted clip's preview shows the tint ffmpeg was verified to produce", async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const clip = join(projectsDir, 'E2E', 'blue.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x4080C0:s=540x960:r=30:d=2',
    '-pix_fmt',
    'yuv420p',
    clip
  ])
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, clip)
  await expect
    .poll(async () => page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0]?.proxyReady, id), {
      timeout: 30_000
    })
    .toBe(true)
  await page.evaluate((id) => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('V', id, 0, 2, false, 540 / 960)
    usePlayback.getState().setTime(1)
  }, id)

  /** The preview's centre pixel (RGB), read from a real screenshot. */
  const centrePixel = async (): Promise<number[]> => {
    const box = (await page.getByTestId('preview-canvas').boundingBox())!
    const png = await page.screenshot({
      clip: { x: box.x + box.width / 2 - 2, y: box.y + box.height / 2 - 2, width: 4, height: 4 }
    })
    return electronApp.evaluate(({ nativeImage }, b64) => {
      const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
      const { width, height } = img.getSize()
      const bgra = img.toBitmap()
      const i = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
      return [bgra[i + 2], bgra[i + 1], bgra[i]]
    }, png.toString('base64'))
  }
  /** 'ok' once the centre pixel is within `tol` of `want`, else the pixel (so a failure shows it). */
  const near = (want: number[], tol: number) => async (): Promise<string> => {
    const px = await centrePixel()
    return px.every((v, i) => Math.abs(v - want[i]) <= tol) ? 'ok' : px.join(',')
  }

  // Untinted: the source colour (through the proxy's YUV round trip).
  await expect.poll(near([64, 128, 192], 8), { timeout: 15_000 }).toBe('ok')

  // Full-strength tint toward #ffd999: ffmpeg's colorchannelmixer gave
  // (117, 99, 69) for this colour; the preview's feColorMatrix must agree.
  await page.evaluate(() =>
    window.__reelStores.useProject.getState().updateLayerContent('V', { tint: { color: '#ffd999', amount: 1 } })
  )
  await expect.poll(near([117, 99, 69], 8), { timeout: 15_000 }).toBe('ok')

  // The Inspector's Color section shows the clip's tint.
  await page.evaluate(() => window.__reelStores.useUi.getState().selectLayer('V'))
  await expect(page.getByTestId('tint-color')).toHaveValue('#ffd999')
})
