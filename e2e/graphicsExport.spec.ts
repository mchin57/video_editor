/**
 * Graphics marks reach the EXPORT the way the preview draws and reveals them:
 * pixels of a real ffmpeg export of marks the export's Chromium rasterised.
 *
 *  1. A POP line is there from its time, where it was drawn, and nowhere else.
 *  2. A FADE line is about half-opaque halfway through its 0.4s fade.
 *  3. A DRAW-ON line reaches about its middle halfway through, then is whole.
 *  4. The layer's position keyframes carry its marks (a line moves with it).
 *  5. An angle mark's arms and its degree label are burned.
 *  6. A filled teardrop shows its fill inside; a connected line follows its segments.
 *
 * ARRANGE via store, ACT via the real export IPC (Save dialog stubbed), ASSERT
 * on output pixels. Skipped without the bundled ffmpeg, like rotationExport.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
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

test('graphics marks export where the preview draws them, with their reveals and the layer motion', async ({
  appPage: page,
  electronApp
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(180_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-graphicsexport-'))
  const bg = join(dir, 'black.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=1080x1920:r=30:d=4',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    bg
  ])

  await page.evaluate(async (bg) => {
    const { useProject } = window.__reelStores
    const [bgA] = await window.api.importPaths([bg])
    const s = useProject.getState()
    s.addMedia([bgA.id])
    s.addVideoLayer('BG', bgA.id, 0, 4, false)
    const line = (id: string, y: number, color: string, atSec: number, reveal: string) => ({
      id,
      tool: 'line',
      points: [
        { x: 100, y },
        { x: 980, y }
      ],
      color,
      widthPx: 20,
      atSec,
      reveal
    })
    const layer = (id: string, marks: unknown[], extra: Record<string, unknown> = {}) => ({
      id,
      hidden: false,
      startSec: 0,
      endSec: 4,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'graphics' as const, marks },
      ...extra
    })
    s.addLayer(
      layer('G', [
        line('pop', 300, '#ff0000', 0, 'pop'),
        line('fade', 600, '#00ff00', 1, 'fade'),
        line('draw', 900, '#0000ff', 2, 'draw'),
        {
          id: 'ang',
          tool: 'angle',
          points: [
            { x: 300, y: 1500 },
            { x: 700, y: 1500 },
            { x: 300, y: 1100 }
          ],
          color: '#ffff00',
          widthPx: 12,
          atSec: 0,
          reveal: 'pop'
        },
        {
          id: 'drop',
          tool: 'teardrop',
          points: [
            { x: 850, y: 1100 },
            { x: 850, y: 1500 }
          ],
          color: '#ff00ff',
          fill: '#00ffff',
          widthPx: 10,
          atSec: 0,
          reveal: 'pop'
        },
        {
          id: 'poly',
          tool: 'polyline',
          points: [
            { x: 100, y: 1550 },
            { x: 400, y: 1550 },
            { x: 400, y: 1850 }
          ],
          color: '#ff8000',
          widthPx: 20,
          atSec: 0,
          reveal: 'pop'
        }
      ]) as never
    )
    // A vertical white line, its layer moving 200px right over the 4s.
    s.addLayer(
      layer(
        'M',
        [
          {
            id: 'v',
            tool: 'line',
            points: [
              { x: 540, y: 1650 },
              { x: 540, y: 1850 }
            ],
            color: '#ffffff',
            widthPx: 16,
            atSec: 0,
            reveal: 'pop'
          }
        ],
        {
          keyframes: [
            { tSec: 0, x: 540, y: 960, scale: 1 },
            { tSec: 4, x: 740, y: 960, scale: 1 }
          ]
        }
      ) as never
    )
  }, bg)

  const out = join(dir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })

  const red = (p: number[]): boolean => p[0] > 180 && p[1] < 70 && p[2] < 70
  const blue = (p: number[]): boolean => p[2] > 180 && p[0] < 70 && p[1] < 70
  const white = (p: number[]): boolean => p[0] > 200 && p[1] > 200 && p[2] > 200
  const cyan = (p: number[]): boolean => p[0] < 70 && p[1] > 180 && p[2] > 180
  const orange = (p: number[]): boolean => p[0] > 200 && p[1] > 80 && p[1] < 180 && p[2] < 70
  const yellow = (p: number[]): boolean => p[0] > 180 && p[1] > 180 && p[2] < 90

  // 1. Pop: on from 0, where drawn (the stroke's round caps reach 10px past each end).
  const f05 = frameAt(out, 0.5)
  expect(red(f05(540, 300)), 'pop line drawn').toBe(true)
  expect(red(f05(150, 300)), 'pop line start').toBe(true)
  expect(red(f05(60, 300)), 'nothing past the cap').toBe(false)
  expect(red(f05(540, 340)), 'nothing off the stroke').toBe(false)
  // 2. Not yet on: the fade (t=1) and the draw-on (t=2).
  expect(f05(540, 600)[1], 'fade not yet').toBeLessThan(30)
  expect(f05(540, 900)[2], 'draw-on not yet').toBeLessThan(30)

  // 2. Fade: halfway through (t = 1 + 0.2) the green is about half on.
  const g = frameAt(out, 1.2)(540, 600)[1]
  expect(g, 'half-faded green').toBeGreaterThan(70)
  expect(g, 'half-faded green').toBeLessThan(190)
  expect(frameAt(out, 1.8)(540, 600)[1], 'fully faded in').toBeGreaterThan(200)

  // 3. Draw-on: halfway (t = 2 + 0.2) the tip is near x = 540; later it is whole.
  const mid = frameAt(out, 2.2)
  expect(blue(mid(350, 900)), 'drawn part').toBe(true)
  expect(blue(mid(800, 900)), 'not yet drawn').toBe(false)
  expect(blue(frameAt(out, 3)(950, 900)), 'whole line').toBe(true)

  // 4. The moving layer: at t=2 the line has moved 100px right.
  const f2 = frameAt(out, 2)
  expect(white(f2(640, 1750)), 'line moved with its layer').toBe(true)
  expect(white(f2(540, 1750)), 'not left behind').toBe(false)

  // 5. Angle: both arms, and yellow label ink on the bisector past the arc —
  //    counted in a ring around the joint that clears the arc (r = 120) and
  //    the arms (at 0° and −90°), so only the "90°" glyphs can light it.
  expect(yellow(f05(500, 1500)), 'arm A').toBe(true)
  expect(yellow(f05(300, 1300)), 'arm B').toBe(true)
  let labelInk = 0
  for (let y = 1250; y < 1500; y += 2) {
    for (let x = 300; x < 560; x += 2) {
      const r = Math.hypot(x - 300, y - 1500)
      const deg = (Math.atan2(y - 1500, x - 300) * 180) / Math.PI
      if (r > 145 && r < 220 && deg > -80 && deg < -10 && yellow(f05(x, y))) labelInk++
    }
  }
  expect(labelInk, 'degree label burned').toBeGreaterThan(40)

  // 6. Teardrop: its fill inside, nothing outside it; connected line: both segments, not the corner's inside.
  expect(cyan(f05(850, 1300)), 'teardrop filled').toBe(true)
  expect(cyan(f05(1040, 1300)), 'nothing outside the drop').toBe(false)
  expect(orange(f05(250, 1550)), 'first segment').toBe(true)
  expect(orange(f05(400, 1700)), 'second segment').toBe(true)
  expect(orange(f05(250, 1700)), 'not inside the corner').toBe(false)
})

test('an animated mark exports frame by frame where the preview draws it; a static rotation lands too', async ({
  appPage: page,
  electronApp
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(180_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-markanim-'))
  const bg = join(dir, 'black.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=1080x1920:r=30:d=3',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    bg
  ])

  await page.evaluate(async (bg) => {
    const { useProject } = window.__reelStores
    const [bgA] = await window.api.importPaths([bg])
    const s = useProject.getState()
    s.addMedia([bgA.id])
    s.addVideoLayer('BG', bgA.id, 0, 3, false)
    const kf = (tSec: number, dx: number) => ({
      tSec,
      dx,
      dy: 0,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
      drawn: 1,
      color: '#00ff00',
      widthPx: 8,
      easing: 'linear'
    })
    s.addLayer({
      id: 'A',
      hidden: false,
      startSec: 0,
      endSec: 3,
      x: 540,
      y: 960,
      scale: 1,
      content: {
        kind: 'graphics' as const,
        marks: [
          // A filled green box moving 600px right over the first second.
          {
            id: 'box',
            tool: 'rect',
            points: [
              { x: 100, y: 300 },
              { x: 260, y: 460 }
            ],
            color: '#00ff00',
            fill: '#00ff00',
            widthPx: 8,
            atSec: 0,
            reveal: 'pop',
            keyframes: [kf(0, 0), kf(1, 600)]
          },
          // A horizontal white line turned a quarter about its centre: vertical at x = 300.
          {
            id: 'rot',
            tool: 'line',
            points: [
              { x: 100, y: 1000 },
              { x: 500, y: 1000 }
            ],
            color: '#ffffff',
            widthPx: 20,
            atSec: 0,
            reveal: 'pop',
            rotationDeg: 90
          }
        ]
      }
    } as never)
  }, bg)

  const out = join(dir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })

  const green = (p: number[]): boolean => p[1] > 180 && p[0] < 70 && p[2] < 70
  const white = (p: number[]): boolean => p[0] > 200 && p[1] > 200 && p[2] > 200

  // The box at the start of its move (0.1s: 60px along), halfway (0.5s: 300px) and after it (held at 600px).
  const start = frameAt(out, 0.1)
  expect(green(start(240, 380)), 'box near its start').toBe(true)
  expect(green(start(780, 380)), 'not at the end yet').toBe(false)
  const mid = frameAt(out, 0.5)
  expect(green(mid(480, 380)), 'box halfway').toBe(true)
  expect(green(mid(180, 380)), 'left its start').toBe(false)
  const end = frameAt(out, 1.5)
  expect(green(end(780, 380)), 'box at its end').toBe(true)
  expect(green(end(240, 380)), 'nothing left behind').toBe(false)

  // The statically rotated line is vertical through x = 300 and gone from where it was drawn.
  const f = frameAt(out, 0.5)
  expect(white(f(300, 850)), 'rotated line top').toBe(true)
  expect(white(f(300, 1150)), 'rotated line bottom').toBe(true)
  expect(white(f(150, 1000)), 'not where it was drawn').toBe(false)
})
