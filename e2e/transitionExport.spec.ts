/**
 * Transitions reach the EXPORT the way the preview draws them (#64): a cross
 * dissolve is the incoming clip's opacity ramp over the outgoing one, a dip a
 * colour card behind the pair plus ramps, and the two clips' linked sound
 * crossfades. Pixels and samples of real ffmpeg exports of a red clip (440 Hz
 * tone) and a blue clip (660 Hz tone) that meet at 3 s, over a silent green
 * backdrop:
 *
 *  1. Cross dissolve: halfway through the overlap a frame holds BOTH colours;
 *     before it is red, after it blue. The sound through the crossfade never
 *     drops out nor doubles up (FFMPEG-NOTES "Transitions": linear fades dip
 *     ~3 dB mid-way).
 *  2. Dip to black / white on the same pair: the midpoint frame is the card's
 *     colour, not the backdrop's.
 *  3. The card sits only behind the clips: a letterboxed and a
 *     picture-in-picture dip leave the pixels outside the clips' boxes alone.
 *
 * ARRANGE via store actions, ACT via the real export IPC, ASSERT on output
 * pixels and samples. Skipped without the bundled ffmpeg.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const W = 1080
const H = 1920

/** Mean RGB of the `w`×`h` region at (`x`, `y`) of the frame shown at `t`. */
function regionRgb(file: string, t: number, x: number, y: number, w: number, h: number): number[] {
  const buf = execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-ss',
      String(t),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `crop=${w}:${h}:${x}:${y}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ],
    { maxBuffer: w * h * 3 + 1024 }
  )
  const sum = [0, 0, 0]
  for (let i = 0; i < buf.length; i += 3) for (let k = 0; k < 3; k++) sum[k] += buf[i + k]
  return sum.map((v) => v / (buf.length / 3))
}

/** Mean RGB of the centre 200×200 of the frame shown at `t`. */
const centreRgb = (file: string, t: number): number[] => regionRgb(file, t, W / 2 - 100, H / 2 - 100, 200, 200)

/** RMS level (dBFS) of the export's sound over [t0, t1). */
function rmsDb(samples: Float32Array, t0: number, t1: number): number {
  let s = 0
  let n = 0
  for (let i = Math.round(t0 * 48000); i < Math.round(t1 * 48000) && i < samples.length; i++) {
    s += samples[i] * samples[i]
    n++
  }
  return 10 * Math.log10(s / Math.max(1, n))
}

function monoSamples(file: string): Float32Array {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], {
    maxBuffer: 1 << 28
  })
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)
}

/** A 3 s clip of one colour with a tone (270×480 unless `size` says otherwise);
 *  `hz` null makes it silent (no audio track). */
function clip(dir: string, name: string, color: string, hz: number | null, size = '270x480', sec = 3): string {
  const out = join(dir, name)
  const tone = hz === null ? [] : ['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${sec}`]
  const audio = hz === null ? [] : ['-c:a', 'aac', '-shortest']
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${size}:r=30:d=${sec}`,
    ...tone,
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    ...audio,
    out
  ])
  return out
}

async function exportTo(page: Page, app: ElectronApplication, out: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })
}

test('a cross dissolve and a dip export as the preview draws them; the sound crossfades without dropping out', async ({
  appPage: page,
  electronApp
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(240_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-transition-'))
  const red = clip(dir, 'red.mp4', '0xC82828', 440)
  const blue = clip(dir, 'blue.mp4', '0x2828C8', 660)
  // A bright, SILENT backdrop under the pair: neither black nor white, so only
  // the dip's card can turn the midpoint black or white (the base canvas is
  // black, which would pass a dip to black with no card at all).
  const green = clip(dir, 'green.mp4', '0x20C020', null, '270x480', 6)

  const ok = await page.evaluate(
    async ({ red, blue, green }) => {
      const { useProject } = window.__reelStores
      const [r, b, g] = await window.api.importPaths([red, blue, green])
      const s = useProject.getState()
      s.addMedia([r.id, b.id, g.id])
      s.addVideoLayer('G', g.id, 0, 6, false, 270 / 480)
      s.addVideoLayer('R', r.id, 0, 3, true, 270 / 480)
      s.addVideoLayer('B', b.id, 3, 3, true, 270 / 480)
      const L = (id: string) => ({ kind: 'layer' as const, id })
      return useProject.getState().applyTransition([L('R'), L('B')], 'dissolve')
    },
    { red, blue, green }
  )
  expect(ok).toEqual({ ok: true })
  // B now plays 2.5–5.5 over R's last half second; the backdrop stays at 0.
  expect(
    await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.map((l) => [l.id, l.startSec]))
  ).toEqual([
    ['G', 0],
    ['R', 0],
    ['B', 2.5]
  ])

  // 1. Cross dissolve.
  const dissolve = join(dir, 'dissolve.mp4')
  await exportTo(page, electronApp, dissolve)
  const before = centreRgb(dissolve, 1.5)
  const after = centreRgb(dissolve, 4)
  const mid = centreRgb(dissolve, 2.75)
  expect(before[0], 'red before').toBeGreaterThan(150)
  expect(before[2], 'no blue before').toBeLessThan(70)
  expect(after[2], 'blue after').toBeGreaterThan(150)
  expect(after[0], 'no red after').toBeLessThan(70)
  // Both clips show halfway through (each about half its own level).
  for (const k of [0, 2]) {
    const lo = Math.min(before[k], after[k])
    const hi = Math.max(before[k], after[k])
    expect(mid[k], `channel ${k} mid-dissolve`).toBeGreaterThan(lo + 0.3 * (hi - lo))
    expect(mid[k], `channel ${k} mid-dissolve`).toBeLessThan(lo + 0.7 * (hi - lo))
  }

  // The crossfade: no 20 ms stretch of the overlap drops more than 6 dB under
  // the clips on their own, nor rises over them; the middle 100 ms sits about
  // 3 dB down (linear fades of two different tones, FFMPEG-NOTES
  // "Transitions"). Without the fades both tones play in full there: about
  // +3 dB, which both upper bounds refuse.
  const samples = monoSamples(dissolve)
  const alone = (rmsDb(samples, 1, 2) + rmsDb(samples, 3.5, 4.5)) / 2
  for (let t = 2.5; t < 3 - 0.02; t += 0.02) {
    const level = rmsDb(samples, t, t + 0.02) - alone
    expect(level, `level at ${t.toFixed(2)} s`).toBeGreaterThan(-6)
    expect(level, `level at ${t.toFixed(2)} s`).toBeLessThan(1)
  }
  const middle = rmsDb(samples, 2.7, 2.8) - alone
  expect(middle, 'the middle of the crossfade').toBeGreaterThan(-4.5)
  expect(middle, 'the middle of the crossfade').toBeLessThan(-1.5)

  // 2. The same pair as a dip to black: the midpoint is dark (over the green
  // backdrop, so only the card can make it so), the ends are not.
  await page.evaluate(() => window.__reelStores.useProject.getState().setTransitionKind('B', 'in', 'dipBlack'))
  const dip = join(dir, 'dip.mp4')
  await exportTo(page, electronApp, dip)
  const dark = centreRgb(dip, 2.75)
  expect(Math.max(...dark), 'midpoint of the dip').toBeLessThan(30)
  expect(centreRgb(dip, 2.55)[0], 'red still fading out').toBeGreaterThan(60)
  expect(centreRgb(dip, 2.95)[2], 'blue already fading in').toBeGreaterThan(60)

  // 3. Dip to white: the card itself shows at the midpoint (over a black base
  // canvas and a green backdrop, only the card can make it white).
  await page.evaluate(() => window.__reelStores.useProject.getState().setTransitionKind('B', 'in', 'dipWhite'))
  const white = join(dir, 'white.mp4')
  await exportTo(page, electronApp, white)
  expect(Math.min(...centreRgb(white, 2.75)), 'midpoint of the dip to white').toBeGreaterThan(225)
  console.log(
    `[transitionExport] before ${before.map(Math.round)} mid ${mid.map(Math.round)} after ${after.map(Math.round)}; ` +
      `dip black ${dark.map(Math.round)}; dip white ${centreRgb(white, 2.75).map(Math.round)}; ` +
      `crossfade middle ${(rmsDb(samples, 2.7, 2.8) - alone).toFixed(2)} dB`
  )
})

test('a dip’s colour card sits only behind the clips: letterbox bars and the main video under a picture-in-picture stay', async ({
  appPage: page,
  electronApp
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(240_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-dipcard-'))
  const green = clip(dir, 'green.mp4', '0x20C020', 330, '270x480', 6)
  const red = clip(dir, 'red.mp4', '0xC82828', 440, '480x270')
  const blue = clip(dir, 'blue.mp4', '0x2828C8', 660, '480x270')

  // A full-frame green backdrop G under two 16:9 clips at scale 1 — letterboxed
  // to a 1080×608 band across the middle — joined by a dip to white.
  const ok = await page.evaluate(
    async ({ green, red, blue }) => {
      const { useProject } = window.__reelStores
      const [g, r, b] = await window.api.importPaths([green, red, blue])
      const s = useProject.getState()
      s.addMedia([g.id, r.id, b.id])
      s.addVideoLayer('G', g.id, 0, 6, false, 270 / 480)
      s.addVideoLayer('R', r.id, 0, 3, false)
      s.addVideoLayer('B', b.id, 3, 3, false)
      const L = (id: string) => ({ kind: 'layer' as const, id })
      return useProject.getState().applyTransition([L('R'), L('B')], 'dipWhite')
    },
    { green, red, blue }
  )
  expect(ok).toEqual({ ok: true })

  // Regions (output px): above and below the band, inside it, and the band's
  // centre — at the dip's midpoint (2.75 s) and before it (1.5 s).
  const TOP = [440, 200, 200, 200] as const
  const BOTTOM = [440, 1500, 200, 200] as const
  const MIDDLE = [440, 860, 200, 200] as const
  const at = (f: string, t: number, r: readonly [number, number, number, number]): number[] => regionRgb(f, t, ...r)
  const same = (a: number[], b: number[], what: string): void => {
    for (let k = 0; k < 3; k++) expect(Math.abs(a[k] - b[k]), `${what} channel ${k}`).toBeLessThan(12)
  }

  const letterbox = join(dir, 'letterbox.mp4')
  await exportTo(page, electronApp, letterbox)
  for (const [name, r] of [
    ['above the band', TOP],
    ['below the band', BOTTOM]
  ] as const) {
    const before = at(letterbox, 1.5, r)
    expect(before[1], `${name} is the green backdrop`).toBeGreaterThan(150)
    same(at(letterbox, 2.75, r), before, `${name} unchanged mid-dip`)
  }
  expect(Math.min(...at(letterbox, 2.75, MIDDLE)), 'the card inside the band').toBeGreaterThan(225)

  // The same two clips as a picture-in-picture (scale 0.4, top right: a
  // 432×243 box around (756, 480)) dipping to black over G as the main video.
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.updateLayer('R', { x: 756, y: 480, scale: 0.4 })
    s.updateLayer('B', { x: 756, y: 480, scale: 0.4 })
    s.setTransitionKind('B', 'in', 'dipBlack')
  })
  const pip = join(dir, 'pip.mp4')
  await exportTo(page, electronApp, pip)
  expect(Math.max(...at(pip, 2.75, [706, 430, 100, 100])), 'the card inside the PiP box').toBeLessThan(30)
  for (const [name, r] of [
    ['the main video mid-frame', MIDDLE],
    ['the main video above the PiP', [656, 200, 200, 100] as const],
    ['the main video below', BOTTOM]
  ] as const) {
    const before = at(pip, 1.5, r)
    expect(before[1], `${name} is green`).toBeGreaterThan(150)
    same(at(pip, 2.75, r), before, `${name} unchanged mid-dip`)
  }
  console.log(
    `[transitionExport] card: letterbox band ${at(letterbox, 2.75, MIDDLE).map(Math.round)} bars ${at(letterbox, 2.75, TOP).map(Math.round)}; ` +
      `PiP box ${at(pip, 2.75, [706, 430, 100, 100]).map(Math.round)} main ${at(pip, 2.75, MIDDLE).map(Math.round)}`
  )
})
