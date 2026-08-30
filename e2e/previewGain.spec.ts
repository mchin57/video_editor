/**
 * Preview gain. A clip's `gainDb` must reach its preview element so the mix you
 * hear matches the one the export builds with `volume=`.
 *
 * These specs also PIN THE KNOWN CEILING: `HTMLMediaElement.volume` is clamped
 * to [0, 1], so a boost above 0 dB cannot be reproduced in the preview. The
 * WebAudio route that would lift it is blocked in this app — the renderer runs
 * from `file://`, so a `reelmedia://` element either fails to load (with
 * `crossOrigin`) or is tainted and emits silence (without it). Both were
 * measured against the real app; see `lib/mediaGain.ts` for the details and the
 * prerequisite. The clamp is asserted here deliberately, so that if someone
 * later gives the renderer a real origin and wires up a GainNode, this test
 * fails and tells them to finish the job.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'

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

async function placeClip(page: import('@playwright/test').Page, gainDb: number): Promise<void> {
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-gain-')), 'tone.wav')
  makeWav(wav)
  await page.evaluate(
    async ({ p, gain }) => {
      const [asset] = await window.api.importPaths([p])
      const { useProject } = window.__reelStores
      useProject.getState().addMedia([asset.id])
      useProject.getState().addAudioClip({
        id: 'gain-clip',
        mediaId: asset.id,
        startSec: 0,
        inSec: 0,
        outSec: 3,
        gainDb: gain,
        fadeInSec: 0,
        fadeOutSec: 0,
        duck: false,
        kind: 'voice'
      })
    },
    { p: wav, gain: gainDb }
  )
}

/** The preview MIX follower — not the library card's own preview player, which
 *  is a separate <audio> on the same source. */
const follower = (page: import('@playwright/test').Page): ReturnType<
  import('@playwright/test').Page['getByTestId']
> => page.getByTestId('audio-follower')

const followerVolume = async (page: import('@playwright/test').Page): Promise<number> => {
  await expect.poll(() => follower(page).count(), { timeout: 30_000 }).toBeGreaterThan(0)
  return follower(page).first().evaluate((el: HTMLAudioElement) => el.volume)
}

test('an attenuated clip reaches the preview element exactly', async ({ appPage: page }) => {
  await placeClip(page, -6)
  // 10^(-6/20) ~= 0.5012 — the same linear gain the export's `volume=` applies.
  await expect.poll(() => followerVolume(page)).toBeCloseTo(0.5012, 3)
})

test('unity gain plays at unity', async ({ appPage: page }) => {
  await placeClip(page, 0)
  await expect.poll(() => followerVolume(page)).toBe(1)
})

test('a boost clamps at unity — the documented preview ceiling', async ({ appPage: page }) => {
  await placeClip(page, 6)
  // The export WILL apply +6 dB. If this ever reads above 1, the WebAudio route
  // has been unblocked — remove the ceiling note in lib/mediaGain.ts.
  await expect.poll(() => followerVolume(page)).toBe(1)
})

test('the media element keeps loading — no CORS opt-in that would break it', async ({
  appPage: page
}) => {
  await placeClip(page, 0)
  await expect.poll(() => follower(page).count(), { timeout: 30_000 }).toBeGreaterThan(0)
  // crossOrigin="anonymous" makes a reelmedia:// element fail with
  // MEDIA_ELEMENT_ERROR from a file:// page. It must stay off.
  expect(await follower(page).first().getAttribute('crossorigin')).toBeNull()
  await expect
    .poll(
      () => follower(page).first().evaluate((el: HTMLAudioElement) => el.readyState),
      { timeout: 30_000 }
    )
    .toBeGreaterThanOrEqual(1)
})
