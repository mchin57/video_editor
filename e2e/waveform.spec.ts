/**
 * Regression: the audio-block waveform <img> uses inline `width`/`left`
 * percentages > 100% to window the full-source waveform to the trimmed span.
 * Tailwind preflight's `img { max-width: 100% }` used to clamp the width while
 * the negative `left` still applied — so any trimmed/split clip (inSec > 0)
 * pushed its waveform entirely outside the block (invisible under
 * overflow-hidden). Fixed with `max-w-none`; this pins it.
 */
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'

/** Minimal 4s 8kHz mono 16-bit PCM WAV (a 440Hz-ish square wave) written from
 *  scratch — keeps the spec hermetic (no ffmpeg needed to ARRANGE). */
function makeWav(path: string): void {
  const sampleRate = 8000
  const seconds = 4
  const n = sampleRate * seconds
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const v = Math.sin((i / sampleRate) * 440 * 2 * Math.PI) > 0 ? 12000 : -12000
    data.writeInt16LE(v, i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

test('trimmed audio clip still shows its waveform inside the block', async ({ appPage: page }) => {
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-wav-')), 'tone.wav')
  makeWav(wav)

  // ARRANGE: import for real (builds the waveform PNG via ffmpeg), then place
  // a clip trimmed to the back half of the source — the split/trim case.
  const assetId = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const { useProject } = window.__reelStores
    useProject.getState().addMedia([asset.id])
    useProject.getState().addAudioClip({
      id: 'wave-audio',
      mediaId: asset.id,
      startSec: 0,
      inSec: 2,
      outSec: 4,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'music'
    })
    return asset.id
  }, wav)

  // ASSERT: the waveform image loads and (crucially) actually overlaps its
  // block — with the max-width clamp bug the overlap collapses to ~1px.
  await expect
    .poll(
      async () =>
        page.evaluate((id) => {
          const img = [...document.querySelectorAll('img')].find((i) =>
            i.src.includes(`${id}/waveform.png`)
          )
          if (!img || !img.complete || img.naturalWidth === 0) return null
          const r = img.getBoundingClientRect()
          const block = img.parentElement!.getBoundingClientRect()
          const overlap = Math.max(0, Math.min(r.right, block.right) - Math.max(r.x, block.x))
          return { overlap, blockW: block.width }
        }, assetId),
      { timeout: 15_000 }
    )
    .not.toBeNull()

  const { overlap, blockW } = (await page.evaluate((id) => {
    const img = [...document.querySelectorAll('img')].find((i) =>
      i.src.includes(`${id}/waveform.png`)
    )!
    const r = img.getBoundingClientRect()
    const block = img.parentElement!.getBoundingClientRect()
    return {
      overlap: Math.max(0, Math.min(r.right, block.right) - Math.max(r.x, block.x)),
      blockW: block.width
    }
  }, assetId))!
  expect(overlap).toBeGreaterThan(blockW * 0.9)
})
