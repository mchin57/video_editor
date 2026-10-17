/**
 * #7: emoji in a text layer or caption export in colour, the way the preview
 * draws them. libass (the burn path) has no colour-glyph support: it drew 😀🔥❤️
 * as white outlines, split a ZWJ family 👨‍👩‍👧 into three faces, and with its
 * own emoji advances pushed "Hi" against the pill's left edge. A block holding
 * colour emoji now rasterises through Chromium (`hasColorEmoji`).
 *
 * ARRANGE via store on a flat grey clip, ACT via the real export IPC (Save
 * dialog stubbed), ASSERT on pixels of the real ffmpeg output.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const W = 1080
const H = 1920
type Px = (x: number, y: number) => number[]

function frameAt(file: string, t: number): Px {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: W * H * 3 + 1024
  })
  return (x, y) => {
    const i = (y * W + x) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
}

/** Pixels in rows y0..y1 that are strongly coloured (emoji), not grey/white/black text or pill. */
function colourful(px: Px, y0: number, y1: number): number {
  let n = 0
  for (let y = y0; y <= y1; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = px(x, y)
    if (Math.max(r, g, b) - Math.min(r, g, b) > 120) n++
  }
  return n
}

/** Horizontal extent of pixels matching `hit` in rows y0..y1. */
function extent(px: Px, y0: number, y1: number, hit: (p: number[]) => boolean): { x0: number; x1: number } {
  let x0 = W
  let x1 = -1
  for (let y = y0; y <= y1; y++) for (let x = 0; x < W; x++) if (hit(px(x, y))) ((x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)))
  return { x0, x1 }
}

const grey = (p: number[]): boolean => p.every((c) => Math.abs(c - 128) <= 12)
const dark = (p: number[]): boolean => p.every((c) => c < 50) // the #000000cc pill over grey (~26)

test('emoji in text layers and captions export in colour, centred, with ZWJ sequences joined', async ({
  appPage: page,
  electronApp
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-emoji-'))
  const clip = join(dir, 'gray.mp4')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=1080x1920:r=30:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip])

  await page.evaluate(async (clip) => {
    const { useProject } = window.__reelStores
    const [asset] = await window.api.importPaths([clip])
    const s = useProject.getState()
    s.addMedia([asset.id])
    s.addVideoLayer('BG', asset.id, 0, 2, false)
    const text = (id: string, t0: number, value: string, y: number, pill: boolean): void =>
      useProject.getState().addLayer({
        id, hidden: false, startSec: t0, endSec: t0 + 1, x: 540, y, scale: 1,
        content: { kind: 'text', text: value, fontFamily: 'montserrat-extrabold', fontSizePx: 90, color: '#ffffff', pill: { enabled: pill, color: '#000000cc', padPx: 18 } }
      })
    text('HI', 0, 'Hi 😀🔥❤️', 500, true)
    // A ZWJ family (t 0–1) and a single face (t 1–2) at the same size and place.
    text('FAM', 0, '👨‍👩‍👧', 1000, false)
    text('ONE', 1, '😀', 1000, false)
    const cap = useProject.getState().project!.captions
    useProject.getState().setCaptions({
      ...cap,
      enabled: true,
      style: { ...cap.style, y: 1500 },
      segments: [{ id: 'c0', startSec: 0, endSec: 2, text: 'race day 🏊‍♂️💪', words: [], enabled: true }]
    })
  }, clip)

  const out = join(dir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })
  const f0 = frameAt(out, 0.5)
  const f1 = frameAt(out, 1.5)

  // Colour, not white outlines: the text layer's and the caption's emoji.
  expect(colourful(f0, 400, 600)).toBeGreaterThan(1500)
  expect(colourful(f0, 1400, 1600)).toBeGreaterThan(1500)

  // "Hi 😀🔥❤️" sits inside its pill with the padding on both sides. With
  // libass's own emoji advances the line overflowed the pill's left edge
  // (measured: −8 px left / 6 px right; now ≈25 / 35, the rest glyph bearings).
  const pill = extent(f0, 470, 530, dark)
  // Ink = the white text or the emoji colour (not the pill's anti-aliased corners).
  const ink = extent(f0, 470, 530, (p) => Math.min(...p) > 200 || Math.max(...p) - Math.min(...p) > 120)
  expect(pill.x1).toBeGreaterThan(pill.x0)
  const left = ink.x0 - pill.x0
  const right = pill.x1 - ink.x1
  expect(left).toBeGreaterThanOrEqual(12)
  expect(right).toBeGreaterThanOrEqual(12)
  expect(Math.abs(left - right)).toBeLessThanOrEqual(16)
  expect(Math.abs((pill.x0 + pill.x1) / 2 - W / 2)).toBeLessThanOrEqual(4)

  // The ZWJ family is ONE glyph: about as wide as a single face, not three.
  const fam = extent(f0, 900, 1100, (p) => !grey(p))
  const one = extent(f1, 900, 1100, (p) => !grey(p))
  expect(one.x1).toBeGreaterThan(one.x0)
  expect(fam.x1 - fam.x0).toBeLessThan(1.6 * (one.x1 - one.x0))
})

test('the preview agrees: an emoji text layer does not animate, and its Animation controls say why', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addLayer({
      id: 'T1', hidden: false, startSec: 0, endSec: 4, x: 540, y: 960, scale: 1,
      content: {
        kind: 'text', text: 'Hi 🔥', fontFamily: 'montserrat-extrabold', fontSizePx: 90, color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 },
        animation: { in: 'fadeIn', inSec: 1, out: 'none', outSec: 0.3 }
      }
    })
    useUi.getState().selectLayer('T1')
  })
  await expect(page.getByText(/Not available on text with emoji/)).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Entrance' })).toBeDisabled()
  // Mid-fade-in, the preview's text is fully opaque (no animation), as the export burns it.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(0.2))
  const opacity = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="preview-canvas"]')!
    const span = [...canvas.querySelectorAll('span')].find((el) => el.textContent === 'Hi 🔥')!
    let o = 1
    for (let el: Element | null = span; el && el !== canvas; el = el.parentElement) o *= Number(getComputedStyle(el).opacity)
    return o
  })
  expect(opacity).toBe(1)
})
