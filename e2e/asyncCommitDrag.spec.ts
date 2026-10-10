/**
 * A long-running job that commits when it finishes (split on silence here; Remove
 * background, auto-captions, imports, Extract audio, audio FX and stills share the
 * same `await idle()` guard) must not land mid-drag: the drag recomputes from its
 * pointerdown snapshot, so the result used to be overwritten by the next move.
 * Regression for that — the job's commit waits for the release (lib/interaction.ts).
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from './fixtures'

const FFMPEG = join(resolve(__dirname, '..'), 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

/** 4 s mono WAV: tone, 1 s of silence at 1.5–2.5 s, tone — two speech pieces. */
function makeGappedWav(path: string): void {
  const rate = 8000
  const n = rate * 4
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const v = t >= 1.5 && t < 2.5 ? 0 : Math.round(Math.sin(t * 440 * 2 * Math.PI) * 12000)
    data.writeInt16LE(v, i * 2)
  }
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

test('a split-on-silence result that arrives mid-drag waits for the release', async ({ appPage: page }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged')
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-async-')), 'gapped.wav')
  makeGappedWav(wav)
  await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addMedia([asset.id])
    useProject.getState().addAudioClip({
      id: 'gap-clip',
      mediaId: asset.id,
      startSec: 0,
      inSec: 0,
      outSec: 4,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'voice'
    })
    useUi.getState().selectAudio('gap-clip')
  }, wav)
  const read = (): Promise<{ clips: { startSec: number }[]; past: number }> =>
    page.evaluate(() => {
      const s = window.__reelStores.useProject.getState()
      return { clips: s.project!.audioClips.map((a) => ({ startSec: a.startSec })), past: s.past.length }
    })
  const before = await read()
  const split = page.getByRole('button', { name: /Split on silence/ })
  await expect(split).toBeVisible()

  // Hold a real move drag on the clip, then start the job without the mouse.
  const tile = page.getByTestId('tile-audio-gap-clip')
  await tile.scrollIntoViewIfNeeded() // the audio lane can sit below the fold
  const box = (await tile.boundingBox())!
  const y = box.y + box.height / 2
  // The press must land ON the tile (not the footer) or this would test nothing.
  expect(
    await page.evaluate(([x, yy]) => !!document.elementFromPoint(x, yy)?.closest('[data-testid="tile-audio-gap-clip"]'), [
      box.x + box.width / 2,
      y
    ])
  ).toBe(true)
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, y, { steps: 4 })
  await split.evaluate((b) => (b as HTMLButtonElement).click())
  await expect(page.getByRole('button', { name: /Detecting/ })).toBeVisible()
  await page.waitForTimeout(1500) // ample for ffmpeg on 4 s of audio
  await page.mouse.move(box.x + box.width / 2 + 100, y, { steps: 2 })
  expect((await read()).clips).toHaveLength(1) // held: not split, and not overwritten either
  await page.mouse.up()

  // After release: the drag is recorded, THEN the split lands on the moved clip.
  await expect.poll(async () => (await read()).clips.length, { timeout: 10_000 }).toBe(2)
  const after = await read()
  expect(after.past).toBe(before.past + 2)
  const first = Math.min(...after.clips.map((c) => c.startSec))
  expect(first).toBeGreaterThan(0) // the pieces sit where the drag put the clip
})
