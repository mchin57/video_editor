/**
 * A clip's pose overlay reaches the EXPORT where the preview draws it, at the
 * clip's SOURCE time: pixels of a real ffmpeg export (the skeleton rasterised
 * frame by frame by the export's Chromium, encoded to qtrle, composited over
 * the clip). The detection is a written pose file — the same file the
 * detection job saves — so this needs no models.
 *
 *  - A person's left upper arm is a vertical line moving right 5px per pose
 *    frame (10 fps). The clip plays source 2–6s from timeline 0, so at
 *    timeline 1s (source 3s) the arm is at x 450, at 3s (source 5s) at x 550.
 *  - The preview's own SVG path at timeline 1s is that same line.
 *
 * Skipped without the bundled ffmpeg, like the other export pixel specs.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const W = 1080
const H = 1920

function frameAt(file: string, t: number): (x: number, y: number) => number[] {
  const buf = execFileSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: W * H * 3 + 1024 }
  )
  return (x, y) => {
    const i = (Math.round(y) * W + Math.round(x)) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
}

/** A pose file: one person whose left shoulder→elbow is a vertical line at
 *  x = 300 + 5·frame (y 500→900), everything else unsure (hidden). */
function writePose(projectDir: string, mediaId: string): void {
  const frames = Array.from({ length: 80 }, (_, f) => {
    const k = Array.from({ length: 26 }, () => [0, 0, 0]).flat()
    k.splice(5 * 3, 3, 300 + 5 * f, 500, 0.95) // leftShoulder
    k.splice(7 * 3, 3, 300 + 5 * f, 900, 0.95) // leftElbow
    return k
  })
  const data = {
    version: 1,
    mediaId,
    startSec: 0,
    durationSec: 8,
    fps: 10,
    frameCount: 80,
    width: W,
    height: H,
    model: 'e2e fixture',
    tracks: [{ id: 1, first: 0, frames, weight: 1 }]
  }
  mkdirSync(join(projectDir, 'pose'), { recursive: true })
  writeFileSync(join(projectDir, 'pose', `${mediaId}.json`), JSON.stringify(data))
}

test('a pose overlay exports at the clip’s source time, where the preview draws it', async ({
  appPage: page,
  electronApp,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(180_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-poseexport-'))
  const bg = join(dir, 'black.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${W}x${H}:r=30:d=8`,
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    bg
  ])
  const mediaId = await page.evaluate(async (bg) => {
    const { useProject } = window.__reelStores
    const [a] = await window.api.importPaths([bg])
    useProject.getState().addMedia([a.id])
    return a.id
  }, bg)
  writePose(join(projectsDir, 'E2E'), mediaId)
  await page.evaluate((id) => {
    const s = window.__reelStores.useProject.getState()
    s.addVideoLayer('V', id, 0, 4, false)
    s.updateLayerContent('V', {
      inSec: 2,
      outSec: 6,
      pose: { show: true, people: [{ tracks: [1], color: '#ff00ff' }], angles: [], widthPx: 12 }
    })
    window.__reelStores.usePlayback.getState().setTime(1)
  }, mediaId)

  // The preview draws the arm at x 450 (source 3s = pose frame 30) at timeline 1s.
  await expect(page.getByTestId('pose-overlay').locator('path').first()).toHaveAttribute('d', 'M450 500 L450 900')

  const out = join(dir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })

  const magenta = (p: number[]): boolean => p[0] > 180 && p[1] < 80 && p[2] > 180
  const white = (p: number[]): boolean => p[0] > 200 && p[1] > 200 && p[2] > 200
  const t1 = frameAt(out, 1)
  expect(magenta(t1(450, 700)), 'arm at source 3s').toBe(true)
  expect(magenta(t1(550, 700)), 'not yet at source 5s').toBe(false)
  expect(white(t1(450, 500)), 'shoulder dot').toBe(true)
  const t3 = frameAt(out, 3)
  expect(magenta(t3(550, 700)), 'arm at source 5s').toBe(true)
  expect(magenta(t3(450, 700)), 'moved on').toBe(false)
  // Hidden keypoints draw nothing: the rest of the frame stays black.
  expect(t1(800, 1400)[0], 'nothing else drawn').toBeLessThan(30)
})
