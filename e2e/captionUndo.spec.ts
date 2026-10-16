/**
 * Undoing while "Caption audio" runs keeps the redo history (#5).
 *
 * Regression spec for a chaos-QA data-loss bug (2026-10-16): undo back past the
 * audio clip while whisper is still transcribing, and when the job finished it
 * committed `captions.enabled: true` onto the emptied project — which cleared
 * the redo stack holding the import and the placed clip. Now a job whose clips
 * are no longer on the timeline as it saw them commits nothing.
 *
 * Main's transcribe handler is stubbed so the test decides when "whisper"
 * finishes; nothing waits on a person or a real model.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

const FFMPEG = join(resolve(__dirname, '..'), 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

/** A 3 s 16-bit mono sine WAV. */
function makeWav(path: string): void {
  const rate = 16000
  const n = rate * 3
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 12000), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

/** Replace main's transcribe handler with one that answers only when `release` is called. */
async function holdTranscription(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __release?: () => void }
    ipcMain.removeHandler('whisper:transcribe')
    ipcMain.handle('whisper:transcribe', async (_e, mediaId: string) => {
      await new Promise<void>((r) => (g.__release = r))
      return {
        mediaId,
        model: 'stub',
        createdAt: new Date().toISOString(),
        words: [
          { text: 'hello', startSec: 0.2, endSec: 0.6 },
          { text: 'there', startSec: 0.7, endSec: 1.1 }
        ]
      }
    })
  })
}

const release = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => (globalThis as unknown as { __release?: () => void }).__release?.())

const history = (page: Page): Promise<{ past: number; future: number; clips: number; captionsOn: boolean }> =>
  page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    return { past: s.past.length, future: s.future.length, clips: s.project!.audioClips.length, captionsOn: s.project!.captions.enabled }
  })

const captionButton = (page: Page): ReturnType<Page['getByRole']> => page.getByRole('button', { name: /Caption audio|Captioning/ })

async function arrange(page: Page): Promise<void> {
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-capundo-')), 'voice.wav')
  makeWav(wav)
  await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const { useProject } = window.__reelStores
    useProject.getState().addMedia([asset.id])
    useProject.getState().addAudioClip({
      id: 'voice-clip',
      mediaId: asset.id,
      startSec: 0,
      inSec: 0,
      outSec: 3,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'voice'
    })
  }, wav)
}

test('undoing past the clip while captioning runs keeps redo, and redo brings the work back', async ({
  electronApp,
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged')
  await holdTranscription(electronApp)
  await arrange(page)
  await expect(captionButton(page)).toBeVisible({ timeout: 15_000 })
  const arranged = await history(page)
  expect(arranged.clips).toBe(1)

  await captionButton(page).click()
  await expect(page.getByRole('button', { name: 'Captioning…' })).toBeVisible()
  // Undo the clip and the import, as Ctrl+Z ×N would.
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    while (window.__reelStores.useProject.getState().past.length > 0) s.undo()
  })
  const undone = await history(page)
  expect(undone.clips).toBe(0)
  expect(undone.future).toBe(arranged.past)

  await release(electronApp)
  await page.waitForTimeout(500) // the job's commit would land right after the stub answers
  const after = await history(page)
  expect(after).toEqual(undone) // nothing committed: redo intact, captions still off
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    while (window.__reelStores.useProject.getState().future.length > 0) s.redo()
  })
  expect((await history(page)).clips).toBe(1)
})

test('a caption run whose clips are unchanged still commits its captions', async ({ electronApp, appPage: page }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged')
  await holdTranscription(electronApp)
  await arrange(page)
  await expect(captionButton(page)).toBeVisible({ timeout: 15_000 })
  await captionButton(page).click()
  await expect(page.getByRole('button', { name: 'Captioning…' })).toBeVisible()
  await release(electronApp)
  await expect.poll(async () => (await history(page)).captionsOn).toBe(true)
  const segs = await page.evaluate(() => window.__reelStores.useProject.getState().project!.captions.segments.length)
  expect(segs).toBeGreaterThan(0)
})
