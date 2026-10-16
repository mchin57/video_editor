/**
 * Burned text matches the preview — for text layers AND captions, which share
 * one path. The regression this pins: libass sized every face by its Windows
 * line height instead of its em (Montserrat burned at 0.64x), spaced lines by
 * the same metric (1.3–1.9x the size vs the preview's 1.25), wrapped on its own
 * glyph widths, drew square opaque pills, and captions wrapped at half the
 * frame in the preview. Now Chromium lays each block out with the preview's
 * CSS and libass burns every line exactly there.
 *
 * Method: the SAME block burns twice in one export — plainly (libass, t 0–1)
 * and as a white→white "gradient" (t 1–2), which forces the Chromium
 * rasteriser: the preview's own CSS at output resolution. Their ink must match
 * line for line. ARRANGE via store, ACT via the real export IPC (native Save
 * dialog stubbed), ASSERT on pixels of the real ffmpeg output + the preview DOM.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const W = 1080
const H = 1920

type Line = { x0: number; x1: number; y0: number; y1: number }

/** White-ink lines (rows of glyph pixels, runs split by blank rows) in a band. */
function inkLines(px: (x: number, y: number) => number[], y0: number, y1: number): Line[] {
  const white = (p: number[]): boolean => p[0] > 200 && p[1] > 200 && p[2] > 200
  const runs: Line[] = []
  for (let y = y0; y <= y1; y++) {
    let a = W
    let b = -1
    for (let x = 0; x < W; x++) if (white(px(x, y))) ((a = Math.min(a, x)), (b = Math.max(b, x)))
    if (b < 0) continue
    const run = runs[runs.length - 1]
    if (run && y - run.y1 <= 3) Object.assign(run, { y1: y, x0: Math.min(run.x0, a), x1: Math.max(run.x1, b) })
    else runs.push({ x0: a, x1: b, y0: y, y1: y })
  }
  return runs
}

function frameAt(file: string, t: number): (x: number, y: number) => number[] {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: W * H * 3 + 1024
  })
  return (x, y) => {
    const i = (y * W + x) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
}

function expectSameLines(burned: Line[], preview: Line[]): void {
  expect(burned.length).toBe(preview.length)
  burned.forEach((b, i) => {
    const p = preview[i]
    expect(Math.abs(b.y0 - p.y0), `line ${i} top`).toBeLessThanOrEqual(3)
    expect(Math.abs(b.y1 - p.y1), `line ${i} bottom`).toBeLessThanOrEqual(3)
    expect(Math.abs((b.x0 + b.x1) / 2 - (p.x0 + p.x1) / 2), `line ${i} centre`).toBeLessThanOrEqual(3)
    expect((b.x1 - b.x0) / (p.x1 - p.x0), `line ${i} width`).toBeGreaterThan(0.97)
    expect((b.x1 - b.x0) / (p.x1 - p.x0), `line ${i} width`).toBeLessThan(1.03)
  })
}

test('burned text and captions land exactly where the preview draws them', async ({ appPage: page, electronApp }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-textparity-'))
  const clip = join(dir, 'gray.mp4')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=1080x1920:r=30:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip])

  const CAPTION = 'a caption long enough to wrap across the whole frame width'
  await page.evaluate(
    async ({ clip, CAPTION }) => {
      const { useProject, usePlayback } = window.__reelStores
      const [asset] = await window.api.importPaths([clip])
      const s = useProject.getState()
      s.addMedia([asset.id])
      s.addVideoLayer('BG', asset.id, 0, 2, false)
      const WHITE = { from: '#ffffff', to: '#ffffff', angle: 90 }
      // Poppins: a face whose text box (1.40em) is TALLER than the leading, so
      // wrapped lines' boxes overlap — the case that once merged into one line.
      for (const [k, t0] of [[0, 0], [1, 1]] as const) {
        s.addLayer({
          id: `P${k}`,
          hidden: false,
          startSec: t0,
          endSec: t0 + 1,
          x: 540,
          y: 700,
          scale: 1,
          content: {
            kind: 'text',
            text: 'this hook is long enough to wrap onto more lines',
            fontFamily: 'poppins-extrabold',
            fontSizePx: 64,
            color: '#ffffff',
            pill: { enabled: true, color: '#000000cc', padPx: 18 },
            ...(k === 1 ? { gradient: WHITE } : {})
          }
        })
      }
      const cap = useProject.getState().project!.captions
      const style = { ...cap.style, y: 1500 }
      useProject.getState().setCaptions({
        ...cap,
        enabled: true,
        style,
        segments: [
          { id: 'c0', startSec: 0, endSec: 1, text: CAPTION, words: [], enabled: true },
          { id: 'c1', startSec: 1, endSec: 2, text: CAPTION, words: [], enabled: true, style: { ...style, gradient: WHITE } }
        ]
      })
      usePlayback.getState().setTime(0.5)
    },
    { clip, CAPTION }
  )

  // The PREVIEW wraps the caption onto 3 lines too (it used to wrap at half the
  // frame, because the box was placed by `left:` instead of transform).
  // (Polled: the bundled face loads on first use; until it does the box is
  // laid out in the fallback font.)
  const previewLines = (): Promise<number> =>
    page.evaluate(async (text) => {
      await document.fonts.ready
      const canvas = document.querySelector('[data-testid="preview-canvas"]')!
      const span = [...canvas.querySelectorAll('span')].find((el) => el.textContent === text && el.children.length === 0)!
      const box = span.closest('div')!
      return Math.round(box.getBoundingClientRect().height / (parseFloat(getComputedStyle(box).fontSize) * 1.25))
    }, CAPTION)
  await expect.poll(previewLines).toBe(3)

  const out = join(dir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })

  const burned = frameAt(out, 0.5)
  const chromium = frameAt(out, 1.5)
  const pillLines = inkLines(burned, 560, 860)
  expect(pillLines).toHaveLength(2)
  expectSameLines(pillLines, inkLines(chromium, 560, 860))
  const capLines = inkLines(burned, 1380, 1640)
  expect(capLines).toHaveLength(3)
  expectSameLines(capLines, inkLines(chromium, 1380, 1640))

  // The pill keeps its alpha: #000000cc over mid-grey is ~26, not solid black.
  const pad = burned(pillLines[0].x0 - 9, Math.round((pillLines[0].y0 + pillLines[0].y1) / 2))
  expect(pad[0]).toBeGreaterThan(15)
  expect(pad[0]).toBeLessThan(40)
})
