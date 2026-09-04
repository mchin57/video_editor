/**
 * Per-clip audio mute. Silencing a clip has to survive the round trip through
 * the real Inspector control into the document and back out to the preview
 * element — and it has to be REVERSIBLE, which is the whole reason mute is its
 * own flag rather than "drag the gain slider to the bottom".
 *
 * The preview and the export deliberately reach silence by different means (the
 * preview holds the clip at gain 0 so it keeps tracking the playhead; the export
 * drops it from the mix so it never decodes a source contributing nothing), both
 * off the shared `audioClipAudible`. This spec owns the preview half; the export
 * half is pinned by that shared predicate's unit tests.
 *
 * A muted clip leaves `element.volume` untouched once it is routed through the
 * WebAudio graph, so assertions go through `appliedGain` — @see previewGain.spec.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'

function makeWav(path: string): void {
  const sampleRate = 8000
  const n = sampleRate * 4
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

type Page = import('@playwright/test').Page

/** Place one audio clip at `gainDb` and select it, so the Inspector shows it. */
async function placeAndSelect(page: Page, gainDb: number): Promise<void> {
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-mute-')), 'tone.wav')
  makeWav(wav)
  await page.evaluate(
    async ({ p, gain }) => {
      const [asset] = await window.api.importPaths([p])
      const { useProject, useUi } = window.__reelStores
      useProject.getState().addMedia([asset.id])
      useProject.getState().addAudioClip({
        id: 'mute-clip',
        mediaId: asset.id,
        startSec: 0,
        inSec: 0,
        outSec: 4,
        gainDb: gain,
        fadeInSec: 0,
        fadeOutSec: 0,
        duck: false,
        kind: 'voice'
      })
      useUi.getState().selectAudio('mute-clip')
    },
    { p: wav, gain: gainDb }
  )
}

const follower = (page: Page): ReturnType<Page['getByTestId']> =>
  page.getByTestId('audio-follower')

const gain = async (page: Page): Promise<number> => {
  await expect.poll(() => follower(page).count(), { timeout: 30_000 }).toBeGreaterThan(0)
  return follower(page)
    .first()
    .evaluate((el: HTMLAudioElement) => window.__reelStores.appliedGain(el))
}

const muteBox = (page: Page): ReturnType<Page['getByRole']> =>
  page.getByRole('checkbox', { name: /mute this clip/i })

const clipMute = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(
    () =>
      window.__reelStores
        .useProject.getState()
        .project?.audioClips.find((a) => a.id === 'mute-clip')?.mute
  )

test('the Inspector toggle silences the preview and restores the level', async ({
  appPage: page
}) => {
  await placeAndSelect(page, -6)
  await expect.poll(() => gain(page)).toBeCloseTo(0.5012, 3)

  await muteBox(page).check()
  expect(await clipMute(page)).toBe(true)
  await expect.poll(() => gain(page)).toBe(0)

  // Unmuting must bring back the level that was set, not unity — a clip's
  // gain has to survive being silenced or mute is just a destructive slider.
  await muteBox(page).uncheck()
  expect(await clipMute(page)).toBe(false)
  await expect.poll(() => gain(page)).toBeCloseTo(0.5012, 3)
})

test('a muted boost is silent, not merely clamped', async ({ appPage: page }) => {
  // +6 dB routes the element through the WebAudio graph, where "muted" means a
  // GainNode at 0 rather than element.volume at 0 — a genuinely different code
  // path from the attenuated case above, and the one that could silently leak
  // audio if mute were applied only to `volume`.
  await placeAndSelect(page, 6)
  await expect.poll(() => gain(page)).toBeCloseTo(1.9953, 3)

  await muteBox(page).check()
  await expect.poll(() => gain(page)).toBe(0)
  expect(
    await follower(page)
      .first()
      .evaluate((el: HTMLAudioElement) => window.__reelStores.isRouted(el))
  ).toBe(true)
})

test('the volume slider is disabled while muted', async ({ appPage: page }) => {
  await placeAndSelect(page, 0)
  const slider = page.getByRole('slider').first()
  await expect(slider).toBeEnabled()
  await muteBox(page).check()
  await expect(slider).toBeDisabled()
  await muteBox(page).uncheck()
  await expect(slider).toBeEnabled()
})

test('a muted clip is marked on its timeline tile', async ({ appPage: page }) => {
  await placeAndSelect(page, 0)
  const tile = page.getByTestId('tile-audio-mute-clip')
  await expect(tile).toBeVisible()
  await expect(tile).not.toContainText('🔇')
  await muteBox(page).check()
  await expect(tile).toContainText('🔇')
})
