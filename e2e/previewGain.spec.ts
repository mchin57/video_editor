/**
 * Preview gain. A clip's `gainDb` must reach its preview element so the mix you
 * hear matches the one the export builds with `volume=`.
 *
 * There are TWO routes and these specs pin both. `HTMLMediaElement.volume` is
 * clamped to [0, 1], so it carries everything at or below unity; a boost above
 * 0 dB is routed through a WebAudio `GainNode` instead (`lib/mediaGain.ts`).
 * That route was impossible until `reelmedia://` became `corsEnabled` — a
 * `crossOrigin` element used to fail to load, and a plain one was tainted and
 * emitted silence.
 *
 * A boost leaves `element.volume` at 1, exactly like an unmodified unity clip,
 * so reading the DOM cannot tell "+6 dB applied" from "+6 dB silently dropped".
 * `appliedGain` (exposed via `window.__reelStores`) reads the real level off
 * the GainNode, and the crossOrigin/loading spec below guards the precondition
 * that keeps the graph audible rather than silent.
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

/** The level actually in force — the GainNode's when routed, else `volume`. */
const followerGain = async (page: import('@playwright/test').Page): Promise<number> => {
  await expect.poll(() => follower(page).count(), { timeout: 30_000 }).toBeGreaterThan(0)
  return follower(page)
    .first()
    .evaluate((el: HTMLAudioElement) => window.__reelStores.appliedGain(el))
}

test('an attenuated clip reaches the element exactly, and stays off the graph', async ({
  appPage: page
}) => {
  await placeClip(page, -6)
  // 10^(-6/20) ~= 0.5012 — the same linear gain the export's `volume=` applies.
  await expect.poll(() => followerVolume(page)).toBeCloseTo(0.5012, 3)
  // Routing is one-way per element, so only a clip that genuinely needs more
  // than unity should ever end up behind an AudioContext.
  expect(
    await follower(page)
      .first()
      .evaluate((el: HTMLAudioElement) => window.__reelStores.isRouted(el))
  ).toBe(false)
})

test('unity gain plays at unity', async ({ appPage: page }) => {
  await placeClip(page, 0)
  await expect.poll(() => followerVolume(page)).toBe(1)
})

test('a boost is realised through the GainNode, matching the export', async ({
  appPage: page
}) => {
  await placeClip(page, 6)
  // 10^(6/20) ~= 1.9953 — the same linear gain the export's `volume=` applies.
  // This is the assertion that would have caught a boost silently clamped to
  // unity, which is what the preview did before the WebAudio route existed.
  await expect.poll(() => followerGain(page)).toBeCloseTo(1.9953, 3)
  // The element itself runs wide open; all of the level lives in the node.
  await expect.poll(() => followerVolume(page)).toBe(1)
  expect(
    await follower(page)
      .first()
      .evaluate((el: HTMLAudioElement) => window.__reelStores.isRouted(el))
  ).toBe(true)
  // A routed element into a suspended context is SILENT while still reporting
  // the correct gain above — so the context has to be running for any of this
  // to be audible.
  expect(await page.evaluate(() => window.__reelStores.previewAudioState())).toBe('running')
})

test('the CORS-clean element still loads — the precondition for audible gain', async ({
  appPage: page
}) => {
  await placeClip(page, 0)
  await expect.poll(() => follower(page).count(), { timeout: 30_000 }).toBeGreaterThan(0)
  // This pair is the whole ballgame. `crossOrigin` is what keeps the element
  // un-tainted, so a GainNode on it carries signal instead of silence — but it
  // only loads at all because `reelmedia://` is `corsEnabled`
  // (main/mediaProtocol.ts). Lose that privilege and the attribute turns every
  // preview element into a failed load; drop the attribute and every boosted
  // clip goes silent. Neither failure raises anything the app would notice.
  expect(await follower(page).first().getAttribute('crossorigin')).toBe('anonymous')
  await expect
    .poll(
      () => follower(page).first().evaluate((el: HTMLAudioElement) => el.readyState),
      { timeout: 30_000 }
    )
    .toBeGreaterThanOrEqual(1)
  expect(
    await follower(page).first().evaluate((el: HTMLAudioElement) => el.error?.code ?? null)
  ).toBeNull()
})
