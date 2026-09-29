/**
 * Text motion reaches the EXPORT the way the preview draws it
 * (`shared/motion.ts` → `AssOverlay.motion` / the raster image keyframes).
 * Pixels of a real ffmpeg export:
 *
 *  1. libass: a text layer ROTATED 30° moving 480px straight right. It must
 *     travel straight right on screen — the burn writes the move in the block's
 *     own axes (libass turns it back about the fixed \org), so a missing or
 *     wrong compensation shows up as a diagonal.
 *  2. raster: the same move on gradient text (Chromium PNG), which travels via
 *     the image keyframe path from the frame centre.
 *
 * ARRANGE via store, ACT via the real export IPC, ASSERT on output pixels.
 * Skipped without the bundled ffmpeg, like textParity.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from './fixtures'

const FFMPEG = join(resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg'), 'ffmpeg.exe')
const W = 1080
const H = 1920

function frameAt(file: string, t: number): (x: number, y: number) => number[] {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: W * H * 3 + 1024
  })
  return (x, y) => {
    const i = (y * W + x) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
}

/** Centroid of bright ink in a y band. */
function inkCentroid(px: (x: number, y: number) => number[], y0: number, y1: number): { x: number; y: number; n: number } {
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y)
      if (r > 150 && g > 150 && b > 150) {
        sx += x
        sy += y
        n++
      }
    }
  }
  return { x: sx / n, y: sy / n, n }
}

test('moving text exports along the same straight path the preview draws', async ({ appPage: page, electronApp }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(180_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-motionexport-'))
  const bg = join(dir, 'black.mp4')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', bg])

  await page.evaluate(
    async ({ bg }) => {
      const { useProject } = window.__reelStores
      const [a] = await window.api.importPaths([bg])
      const s = useProject.getState()
      s.addMedia([a.id])
      s.addVideoLayer('BG', a.id, 0, 4, false)
      const moving = (id: string, y: number, over: Record<string, unknown>) => ({
        id,
        hidden: false,
        startSec: 0,
        endSec: 4,
        x: 300,
        y,
        scale: 1,
        // 300 → 780 between t 1 and 2, holding after.
        keyframes: [
          { tSec: 1, x: 300, y, scale: 1 },
          { tSec: 2, x: 780, y, scale: 1 }
        ],
        content: {
          kind: 'text' as const,
          text: 'GO',
          fontFamily: 'inter',
          fontSizePx: 120,
          color: '#ffffff',
          pill: { enabled: false, color: '#000000cc', padPx: 18 },
          ...over
        }
      })
      s.addLayer({ ...moving('L', 500, {}), rotationDeg: 30 })
      s.addLayer(moving('G', 1300, { gradient: { from: '#ffffff', to: '#ffffff', angle: 90 } }))
    },
    { bg }
  )

  const out = join(dir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })

  for (const [label, y0, y1] of [
    ['libass, rotated', 330, 670],
    ['raster', 1150, 1450]
  ] as const) {
    const start = inkCentroid(frameAt(out, 0.5), y0, y1)
    const mid = inkCentroid(frameAt(out, 1.5), y0, y1)
    const end = inkCentroid(frameAt(out, 3), y0, y1)
    expect(start.n, `${label}: ink`).toBeGreaterThan(300)
    // Holds at the start, moves straight RIGHT (no drift in y), holds at the end.
    expect(end.x - start.x, `${label}: travel x`).toBeGreaterThan(480 - 6)
    expect(end.x - start.x, `${label}: travel x`).toBeLessThan(480 + 6)
    expect(Math.abs(end.y - start.y), `${label}: travel y`).toBeLessThan(4)
    expect(mid.x - start.x, `${label}: halfway`).toBeGreaterThan(240 - 8)
    expect(mid.x - start.x, `${label}: halfway`).toBeLessThan(240 + 8)
  }
})
