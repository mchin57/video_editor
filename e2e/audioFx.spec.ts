/**
 * Generated audio effect tracks, end to end: the Inspector's "Sound effects"
 * section renders an echo through REAL ffmpeg, imports it as a library asset,
 * and drops it on the timeline as its own clip in the FX lane.
 *
 * This is the part unit tests cannot reach — the arg builders are pinned in
 * `audioFx.test.ts`, but only running the app proves the IPC channel, the
 * render service, the store wiring and the new lane actually line up.
 *
 * ARRANGE via store + a real import, ACT via the real Inspector controls,
 * ASSERT on the store and the timeline DOM.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'

/** A hermetic 3s 8kHz mono tone — no ffmpeg needed to ARRANGE the input. */
function makeWav(path: string): void {
  const sampleRate = 8000
  const n = sampleRate * 3
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 12000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

test('adding an echo renders a wet track onto the FX lane', async ({ appPage: page }) => {
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-fx-')), 'tone.wav')
  makeWav(wav)

  // ARRANGE: a real imported audio clip, selected so the Inspector shows it.
  const sourceId = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addMedia([asset.id])
    useProject.getState().addAudioClip({
      id: 'dry-clip',
      mediaId: asset.id,
      startSec: 1,
      inSec: 0,
      outSec: 3,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'voice'
    })
    useUi.getState().selectAudio('dry-clip')
    return asset.id
  }, wav)

  // ACT: the real button in the Sound effects section (echo is the default).
  await page.getByRole('button', { name: /Add echo track/i }).click()

  // ASSERT: a second clip appears, marked as an effect track and rendered from
  // the dry clip's source over its exact window.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__reelStores.useProject.getState().project!.audioClips.length
        ),
      { timeout: 60_000 }
    )
    .toBe(2)

  const fx = await page.evaluate(
    () => window.__reelStores.useProject.getState().project!.audioClips.find((a) => a.fx)!
  )
  expect(fx.kind).toBe('fx')
  expect(fx.fx!.settings.kind).toBe('echo')
  expect(fx.fx!.fromMediaId).toBe(sourceId)
  expect(fx.fx!.fromInSec).toBe(0)
  expect(fx.fx!.fromOutSec).toBe(3)
  // It lines up with the sound it came from, and is its own asset.
  expect(fx.startSec).toBe(1)
  expect(fx.mediaId).not.toBe(sourceId)
  // An effect track is an addition, not a bed, and must not be captioned twice.
  expect(fx.duck).toBe(false)
  expect(fx.excludeFromCaptions).toBe(true)

  // The FX lane appears (it is hidden until an effect track exists) and holds
  // the new tile.
  await expect(page.getByText('FX', { exact: true })).toBeVisible()
  await expect(page.locator(`[data-testid="tile-audio-${fx.id}"]`)).toBeVisible()

  // The dry clip is untouched — an effect never modifies its source.
  const dry = await page.evaluate(
    () => window.__reelStores.useProject.getState().project!.audioClips.find((a) => !a.fx)!
  )
  expect(dry.mediaId).toBe(sourceId)
  expect(dry.gainDb).toBe(0)
})
