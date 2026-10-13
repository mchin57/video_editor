/**
 * The loudness engine end to end (Feature 4A; docs/FFMPEG-NOTES.md "Loudness
 * series"): importing media writes `cache/<id>/loudness.json` in the
 * background, the `getLoudness` IPC serves it (re-measuring when the cache
 * lost it), and windows of the series agree with ffmpeg measuring the same
 * file directly with `ebur128` — including a one-sided stereo file, which the
 * series must hear mono-folded (≈3 LU louder than the raw file), as the mix does.
 *
 * Sources are synthesized with lavfi; the reference numbers come from the real
 * binary inside the spec. No dialogs are involved (the fixture cancels any).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { windowLoudness, type LoudnessSeries } from '../src/shared/loudness'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

/** A 6 s 1 kHz tone at 44.1 kHz: full level (−18 dBFS peak) for 3 s, then 14 dB down. */
const TONE = 'sine=frequency=1000:sample_rate=44100:duration=6'
const STEP = "volume='if(lt(t,3),1,0.2)':eval=frame"

function synth(out: string, extraFilter = ''): void {
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', TONE,
    '-af', STEP + extraFilter,
    '-c:a', 'pcm_s16le', out
  ])
}

/** ffmpeg's own integrated loudness (LUFS) of `[inSec, outSec)` of a file. */
function measureDirect(file: string, inSec: number, outSec: number, pre = 'anull'): number {
  const run = spawnSync(
    FFMPEG,
    [
      '-hide_banner', '-nostdin', '-nostats', '-i', file,
      '-af', `${pre},aresample=48000,atrim=${inSec}:${outSec},asetpts=N/SR/TB,ebur128=framelog=quiet`,
      '-f', 'null', '-'
    ],
    { encoding: 'utf8' }
  )
  const m = /^\s+I:\s+(-?[\d.]+) LUFS/m.exec(run.stderr)
  if (run.status !== 0 || !m) throw new Error(`ebur128 run failed: ${run.stderr.slice(-400)}`)
  return Number(m[1])
}

test('import measures a loudness series that matches ffmpeg on the same windows', async ({ appPage: page }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(90_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-loud-'))
  const tone = join(dir, 'tone.wav')
  synth(tone)
  // The same tone on the RIGHT channel only (left digitally silent): import
  // detects the dead side, and the series must measure the folded signal.
  const side = join(dir, 'side.wav')
  synth(side, ',pan=stereo|c0=0*c0|c1=c0')

  const projectDir = (await page.evaluate(() => window.api.getProjectDir()))!
  const ids = await page.evaluate(async (paths) => {
    const assets = await window.api.importPaths(paths)
    window.__reelStores.useProject.getState().addMedia(assets.map((a) => a.id))
    return assets.map((a) => ({ id: a.id, name: a.fileName, fold: a.probe.audio?.monoFoldChannel ?? null }))
  }, [tone, side])
  expect(ids).toHaveLength(2)
  const byName = (n: string): { id: string; fold: number | null } => ids.find((a) => a.name === n)!
  const [toneId, sideId] = [byName('tone.wav').id, byName('side.wav').id]
  expect(byName('side.wav').fold).toBe(1)

  // Written in the background on import, no IPC needed.
  const file = (id: string): string => join(projectDir, 'cache', id, 'loudness.json')
  await expect.poll(() => existsSync(file(toneId)) && existsSync(file(sideId)), { timeout: 20_000 }).toBe(true)
  const onDisk = JSON.parse(readFileSync(file(toneId), 'utf8')) as LoudnessSeries
  expect(onDisk).toMatchObject({ version: 1, stepSec: 0.1, startSec: 0 })
  expect(onDisk.momentary).toHaveLength(60)
  expect(onDisk.peak).toHaveLength(60)

  const series = (await page.evaluate((id) => window.api.getLoudness(id), toneId))!
  expect(series).toEqual(onDisk)

  const lufs = (s: LoudnessSeries, a: number, b: number): number => {
    const w = windowLoudness(s, a, b)
    if (w.status !== 'ok' || w.lufs == null) throw new Error(`no measurement for ${a}–${b}: ${JSON.stringify(w)}`)
    return w.lufs
  }
  for (const [a, b] of [[0, 6], [1, 4], [3.5, 6]]) {
    expect(Math.abs(lufs(series, a, b) - measureDirect(tone, a, b))).toBeLessThanOrEqual(0.1)
  }
  const w = windowLoudness(series, 0, 6)
  expect(w.status === 'ok' && w.peakDb).toBeCloseTo(-18.06, 1)

  // The one-sided file: matches ffmpeg measuring it FOLDED, ~3 LU above raw.
  const sideSeries = (await page.evaluate((id) => window.api.getLoudness(id), sideId))!
  const folded = measureDirect(side, 0, 6, 'pan=stereo|c0=c1|c1=c1')
  expect(Math.abs(lufs(sideSeries, 0, 6) - folded)).toBeLessThanOrEqual(0.1)
  expect(folded - measureDirect(side, 0, 6)).toBeGreaterThan(2.5)

  // The cache is disposable: delete it and the IPC measures it again.
  rmSync(file(toneId))
  const again = await page.evaluate((id) => window.api.getLoudness(id), toneId)
  expect(again).toEqual(onDisk)
  expect(existsSync(file(toneId))).toBe(true)
  expect(existsSync(join(projectDir, 'cache', toneId, 'loudness.print.txt'))).toBe(false)

  rmSync(dir, { recursive: true, force: true })
})
