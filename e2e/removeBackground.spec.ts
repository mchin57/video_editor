/**
 * "Remove background" end to end through the built app, with the REAL model:
 *
 *  1. Regression for "processes the whole source file": a layer cut out of a
 *     longer clip gets a matte of ONLY its own window, swapped in place — same
 *     start and end on the timeline, trim rebased to 0..window, the matte is
 *     transparent and carries the segment's audio, and Undo restores the
 *     original in one step.
 *  2. Cancel: the header's job indicator shows the running job, Cancel stops it,
 *     and nothing is left behind — no swap, no library asset, no partial file.
 *
 * The RVM model is not part of the repo; it is copied into this test's
 * throwaway data dir (<data>/bin/models, which discovery re-checks per call).
 * The spec skips when no model is found (MATTE_MODEL, resources/models, or the
 * developer's own <Documents>/VideoEditor/bin/models).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { VideoContent } from '../src/shared/project'
import { test, expect } from './fixtures'

const root = resolve(__dirname, '..')
const FFMPEG = join(root, 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

function findModel(): string | null {
  const dirs = [join(root, 'resources', 'models'), join(homedir(), 'Documents', 'VideoEditor', 'bin', 'models')]
  if (process.env.MATTE_MODEL && existsSync(process.env.MATTE_MODEL)) return process.env.MATTE_MODEL
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const f = readdirSync(dir).find((n) => n.toLowerCase().startsWith('rvm') && n.endsWith('.onnx'))
    if (f) return join(dir, f)
  }
  return null
}
const MODEL = findModel()

/** Copy the model into the app's data dir and import a synthesized clip as an
 *  unlinked, audible video layer 'V'. Returns the source asset id + data dir. */
async function arrange(
  page: Page,
  clip: { sec: number; w: number; h: number }
): Promise<{ sourceId: string; dataDir: string }> {
  const dataDir = await page.evaluate(() => window.api.getDataDir())
  mkdirSync(join(dataDir, 'bin', 'models'), { recursive: true })
  copyFileSync(MODEL!, join(dataDir, 'bin', 'models', 'rvm_mobilenetv3_fp32.onnx'))

  const mp4 = join(mkdtempSync(join(tmpdir(), 'reel-matte-')), 'clip.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=duration=${clip.sec}:size=${clip.w}x${clip.h}:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${clip.sec}`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest',
    mp4
  ])
  const sourceId = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, mp4)
  await expect
    .poll(() => page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0]?.proxyReady, sourceId), {
      timeout: 60_000
    })
    .toBe(true)
  return { sourceId, dataDir }
}

const layerV = (page: Page): Promise<{ startSec: number; endSec: number; content: VideoContent } | null> =>
  page.evaluate(() => {
    const l = window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'V')
    return l ? { startSec: l.startSec, endSec: l.endSec, content: l.content as VideoContent } : null
  })

test.describe('remove background', () => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.skip(!MODEL, 'RVM model not found (set MATTE_MODEL or place it in <Documents>/VideoEditor/bin/models)')

  test('mattes only the layer window and swaps the result in place', async ({ appPage: page }) => {
    test.setTimeout(180_000)
    const { sourceId } = await arrange(page, { sec: 8, w: 270, h: 480 })

    // A piece cut out of the middle of the 8s source: source 3..5 at timeline 10..12.
    await page.evaluate((id) => {
      const { useProject, useUi } = window.__reelStores
      const s = useProject.getState()
      s.addVideoLayer('V', id, 10, 8, false, 270 / 480)
      s.updateLayerContent('V', { inSec: 3, outSec: 5 })
      s.updateLayer('V', { endSec: 12 })
      useUi.getState().selectLayer('V')
    }, sourceId)
    const before = (await layerV(page))!
    expect(before).toMatchObject({ startSec: 10, endSec: 12, content: { mediaId: sourceId, inSec: 3, outSec: 5 } })

    await page.getByRole('button', { name: /Remove background/ }).click()
    // While it runs, the header indicator names the job.
    await expect(page.getByTestId('jobs-indicator')).toContainText('Remove background')

    await expect.poll(async () => (await layerV(page))?.content.mediaId, { timeout: 150_000 }).not.toBe(sourceId)
    const after = (await layerV(page))!
    // Same place and length on the timeline; trim rebased onto the 2s matte.
    expect(after.startSec).toBe(10)
    expect(after.endSec).toBe(12)
    expect(after.content.inSec).toBe(0)
    expect(after.content.outSec).toBeCloseTo(2, 6)

    // The matte covers ONLY the window (not the 8s source), is transparent, and
    // kept the segment's audio; it is in the project's library.
    const matte = await page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0], after.content.mediaId)
    expect(matte.probe.video?.hasAlpha).toBe(true)
    expect(matte.probe.durationSec).toBeGreaterThan(1.9)
    expect(matte.probe.durationSec).toBeLessThan(2.1)
    expect(matte.probe.audio).toBeTruthy()
    expect(matte.proxyReady).toBe(true)
    const mediaIds = await page.evaluate(() => window.__reelStores.useProject.getState().project!.mediaIds)
    expect(mediaIds).toContain(after.content.mediaId)

    // One undo step back to the original clip and trim.
    await page.evaluate(() => window.__reelStores.useProject.getState().undo())
    expect(await layerV(page)).toMatchObject({ startSec: 10, endSec: 12, content: { mediaId: sourceId, inSec: 3, outSec: 5 } })
  })

  test('Cancel stops the job and leaves nothing behind', async ({ appPage: page }) => {
    test.setTimeout(180_000)
    // Long + large enough that the job is still running when Cancel lands.
    const { sourceId, dataDir } = await arrange(page, { sec: 30, w: 1080, h: 1920 })
    await page.evaluate((id) => {
      const { useProject, useUi } = window.__reelStores
      useProject.getState().addVideoLayer('V', id, 0, 30, false, 1080 / 1920)
      useUi.getState().selectLayer('V')
    }, sourceId)
    const mediaIdsBefore = await page.evaluate(() => [...window.__reelStores.useProject.getState().project!.mediaIds])

    await page.getByRole('button', { name: /Remove background/ }).click()
    // Wait for real progress, then cancel from the always-visible header pill.
    await expect(page.getByTestId('matte-progress')).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Object.values(window.__reelStores.useEditor.getState().jobs).some((j) => j.type === 'matte' && j.progress > 0)
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    await page.getByTestId('jobs-indicator').getByRole('button', { name: /^Cancel/ }).click()

    await expect
      .poll(
        () =>
          page.evaluate(() => Object.values(window.__reelStores.useEditor.getState().jobs).find((j) => j.type === 'matte')?.status),
        { timeout: 30_000 }
      )
      .toBe('canceled')
    await expect(page.getByText('Canceled — the clip is unchanged.')).toBeVisible()
    await expect(page.getByTestId('jobs-indicator')).toHaveCount(0) // nothing running, nothing failed

    // Nothing changed or leaked: same clip, no new library asset, no partial WebM.
    expect((await layerV(page))!.content.mediaId).toBe(sourceId)
    expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.mediaIds)).toEqual(mediaIdsBefore)
    const tmp = join(dataDir, 'tmp')
    const leftovers = existsSync(tmp) ? readdirSync(tmp).filter((f) => f.startsWith('nobg-')) : []
    expect(leftovers).toEqual([])
  })
})
