/**
 * Transitions reach the EXPORT the way the preview draws them (#64): a cross
 * dissolve is the incoming clip's opacity ramp over the outgoing one, a dip a
 * full-frame plate under the pair plus ramps, and the two clips' linked sound
 * crossfades. Pixels and samples of real ffmpeg exports of a red clip (440 Hz
 * tone) and a blue clip (660 Hz tone) that meet at 3 s:
 *
 *  1. Cross dissolve: halfway through the overlap a frame holds BOTH colours;
 *     before it is red, after it blue. The sound through the crossfade never
 *     drops out (FFMPEG-NOTES "Transitions": linear fades dip ~3 dB mid-way).
 *  2. Dip to black on the same pair: the midpoint frame is dark.
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

/** Mean RGB of the centre 200×200 of the frame shown at `t`. */
function centreRgb(file: string, t: number): number[] {
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
      `crop=200:200:${W / 2 - 100}:${H / 2 - 100}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ],
    { maxBuffer: 200 * 200 * 3 + 1024 }
  )
  const sum = [0, 0, 0]
  for (let i = 0; i < buf.length; i += 3) for (let k = 0; k < 3; k++) sum[k] += buf[i + k]
  return sum.map((v) => v / (buf.length / 3))
}

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

/** A 3 s 270×480 clip of one colour with a tone. */
function clip(dir: string, name: string, color: string, hz: number): string {
  const out = join(dir, name)
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=270x480:r=30:d=3`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${hz}:sample_rate=48000:duration=3`,
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
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

  const ok = await page.evaluate(
    async ({ red, blue }) => {
      const { useProject } = window.__reelStores
      const [r, b] = await window.api.importPaths([red, blue])
      const s = useProject.getState()
      s.addMedia([r.id, b.id])
      s.addVideoLayer('R', r.id, 0, 3, true, 270 / 480)
      s.addVideoLayer('B', b.id, 3, 3, true, 270 / 480)
      const L = (id: string) => ({ kind: 'layer' as const, id })
      return useProject.getState().applyTransition([L('R'), L('B')], 'dissolve')
    },
    { red, blue }
  )
  expect(ok).toEqual({ ok: true })
  // B now plays 2.5–5.5 over R's last half second.
  expect(
    await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.map((l) => l.startSec))
  ).toEqual([0, 2.5])

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
  // the clips on their own (linear fades: about −3 dB in the middle).
  const samples = monoSamples(dissolve)
  const alone = (rmsDb(samples, 1, 2) + rmsDb(samples, 3.5, 4.5)) / 2
  for (let t = 2.5; t < 3 - 0.02; t += 0.02) {
    expect(rmsDb(samples, t, t + 0.02) - alone, `level at ${t.toFixed(2)} s`).toBeGreaterThan(-6)
  }

  // 2. The same pair as a dip to black: the midpoint is dark, the ends are not.
  await page.evaluate(() => window.__reelStores.useProject.getState().setTransitionKind('B', 'in', 'dipBlack'))
  const dip = join(dir, 'dip.mp4')
  await exportTo(page, electronApp, dip)
  const dark = centreRgb(dip, 2.75)
  expect(Math.max(...dark), 'midpoint of the dip').toBeLessThan(30)
  expect(centreRgb(dip, 2.55)[0], 'red still fading out').toBeGreaterThan(60)
  expect(centreRgb(dip, 2.95)[2], 'blue already fading in').toBeGreaterThan(60)

  // 3. Dip to white: the plate itself shows at the midpoint (the base canvas
  // is black, so only the plate can make it white).
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
