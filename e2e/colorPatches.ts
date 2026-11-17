/**
 * Shared by the colour specs (colorParity, colorTable): a synthetic clip of
 * flat colour patches, the patches read back from a REAL screenshot of the
 * preview (a canvas `drawImage` decodes BT.709 video like BT.601 — FFMPEG-NOTES
 * "Clip grade"), and the same patches from ffmpeg's decode of an export.
 */
import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Page } from '@playwright/test'
import { FFMPEG } from './bin'

/** Patch colours, row-major in a 2 × 4 grid. */
export const PATCHES: [number, number, number][] = [
  [64, 64, 64],
  [128, 128, 128],
  [192, 192, 192],
  [192, 64, 32],
  [64, 128, 192],
  [200, 30, 30],
  [30, 200, 90],
  [250, 240, 10]
]
export const COLS = 2
export const ROWS = 4

const W = 1080
const H = 1920

/** The centre of patch `i` as a fraction of the frame. */
export const patchCentre = (i: number): { fx: number; fy: number } => ({
  fx: ((i % COLS) + 0.5) / COLS,
  fy: (Math.floor(i / COLS) + 0.5) / ROWS
})

/** The lavfi graph drawing the patches at `w`×`h` (RGB). */
export function patchGraph(w: number, h: number, d = 2): string {
  let vf = `color=c=black:s=${w}x${h}:r=30:d=${d},format=rgb24`
  PATCHES.forEach(([r, g, b], i) => {
    const hex = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
    vf += `,drawbox=x=${(i % COLS) * (w / COLS)}:y=${Math.floor(i / COLS) * (h / ROWS)}:w=${w / COLS}:h=${h / ROWS}:color=0x${hex}:t=fill`
  })
  return vf
}

/** The patch clip, converted to YUV with the BT.709 matrix and tagged as such, like phone footage. */
export function makePatchClip(out: string): void {
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `${patchGraph(540, 960)},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '0',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    out
  ])
}

/** A frame of `file` at `t` as a per-pixel RGB reader (ffmpeg's own decode),
 *  1080×1920 — a still of another size is scaled to it (nearest neighbour). */
export function frameAt(file: string, t: number, still = false): (x: number, y: number) => number[] {
  const buf = execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      ...(still ? [] : ['-ss', String(t)]),
      '-i',
      file,
      '-frames:v',
      '1',
      ...(still ? ['-vf', `scale=${W}:${H}:flags=neighbor`] : []),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ],
    { maxBuffer: W * H * 3 + 1024 }
  )
  return (x, y) => {
    const i = (y * W + x) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
}

/** The mean RGB of the 4×4 block around each patch centre in an exported frame. */
export const exportedPatches = (px: (x: number, y: number) => number[]): number[][] =>
  PATCHES.map((_, i) => {
    const { fx, fy } = patchCentre(i)
    const sum = [0, 0, 0]
    for (let dy = -2; dy < 2; dy++)
      for (let dx = -2; dx < 2; dx++) {
        const p = px(Math.round(fx * W) + dx, Math.round(fy * H) + dy)
        for (let c = 0; c < 3; c++) sum[c] += p[c]
      }
    return sum.map((v) => Math.round(v / 16))
  })

/** Mean RGB of 4×4 blocks of a real screenshot of the preview canvas, at frame fractions. */
export async function previewPixels(
  page: Page,
  electronApp: ElectronApplication,
  fracs: { fx: number; fy: number }[]
): Promise<number[][]> {
  const box = (await page.getByTestId('preview-canvas').boundingBox())!
  const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } })
  return electronApp.evaluate(
    ({ nativeImage }, { b64, fracs }) => {
      const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
      const { width, height } = img.getSize()
      const bgra = img.toBitmap()
      return fracs.map(({ fx, fy }) => {
        const sum = [0, 0, 0]
        for (let dy = -2; dy < 2; dy++)
          for (let dx = -2; dx < 2; dx++) {
            const i = ((Math.round(fy * height) + dy) * width + Math.round(fx * width) + dx) * 4
            sum[0] += bgra[i + 2]
            sum[1] += bgra[i + 1]
            sum[2] += bgra[i]
          }
        return sum.map((v) => Math.round(v / 16))
      })
    },
    { b64: png.toString('base64'), fracs }
  )
}

/** The preview canvas's patches, read from a real screenshot (mean of a 4×4 block). */
export const previewPatches = (page: Page, electronApp: ElectronApplication): Promise<number[][]> =>
  previewPixels(
    page,
    electronApp,
    PATCHES.map((_, i) => patchCentre(i))
  )

/** The largest per-channel difference between two patch lists. */
export function worstDiff(a: number[][], b: number[][]): number {
  let worst = 0
  a.forEach((p, i) => p.forEach((v, c) => (worst = Math.max(worst, Math.abs(v - b[i][c])))))
  return worst
}
