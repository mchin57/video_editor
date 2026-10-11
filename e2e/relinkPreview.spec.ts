/**
 * After "Update path anyway" points a clip at different content, the preview
 * must PLAY the new content (2026-10-11 bug): the cut reset, but the <video>
 * and audio kept the old picture and sound, because every media URL was built
 * from the clip id alone — the same address before and after, so the players
 * never reloaded. URLs now carry the content's revision.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

const synth = (out: string, seconds: number, src: string): void => {
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `${src}=size=320x568:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    out
  ])
}

const media = (page: Page, id: string): Promise<MediaAsset> =>
  page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0], id)

/** The preview's <video> for the clip, once it has metadata: its src and duration. */
const previewVideo = (page: Page): Promise<{ src: string; duration: number } | null> =>
  page.evaluate(() => {
    const v = document.querySelector('[data-testid="preview-canvas"] video') as HTMLVideoElement | null
    return v && v.readyState >= 1 ? { src: v.currentSrc || v.src, duration: v.duration } : null
  })

test('after a forced relink the preview plays the NEW content, not the old', async ({ electronApp, appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const dir = join(projectsDir, 'E2E', 'footage')
  mkdirSync(dir)
  const original = join(dir, 'long.mp4')
  const shorter = join(dir, 'short.mp4')
  synth(original, 4, 'testsrc2')
  synth(shorter, 1, 'smptebars')

  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const s = window.__reelStores.useProject.getState()
    s.addMedia([asset.id])
    s.addVideoLayer('v1', asset.id, 0, asset.probe.durationSec, true)
    return asset.id
  }, original)
  await expect.poll(async () => (await media(page, id))?.proxyReady, { timeout: 30_000 }).toBe(true)
  await expect.poll(async () => (await previewVideo(page))?.duration ?? 0, { timeout: 15_000 }).toBeGreaterThan(3.5)
  const before = (await previewVideo(page))!.src

  // Relink the clip to the 1 s file and accept the warning.
  await electronApp.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
  }, shorter)
  await page.evaluate((id) => window.api.relinkMediaDialog(id), id).then((res) =>
    page.evaluate(
      ({ id, d }) => window.__reelStores.useProject.getState().resetMediaCuts(id, d),
      { id, d: res!.asset.probe.durationSec }
    )
  )
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange'))) // library refetch
  await expect.poll(async () => (await media(page, id))?.proxyReady, { timeout: 30_000 }).toBe(true)

  // The player plays the new proxy: the new length, from a different address
  // carrying the new content's revision.
  await expect.poll(async () => (await previewVideo(page))?.duration ?? 99, { timeout: 15_000 }).toBeLessThan(1.5)
  const { rev } = await media(page, id)
  const after = (await previewVideo(page))!.src
  expect(after).not.toBe(before)
  expect(after.endsWith(`?v=${rev}`)).toBe(true)
  // The clip's own audio (its linked audio track) follows the same address.
  await expect
    .poll(() => page.evaluate(() => (document.querySelector('[data-testid="audio-follower"]') as HTMLMediaElement | null)?.src ?? ''))
    .toContain(`?v=${rev}`)
})
