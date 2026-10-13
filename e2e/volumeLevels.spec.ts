/**
 * Volume levels end to end (docs/superpowers/plans/2026-10-13-captions-export-
 * rename-volume.md, Feature 4B; shared/volumeLevels.ts). Clips in a level are
 * each matched to the level's loudness — in the preview (the follower's real
 * applied gain) and in the export (ffmpeg ebur128 on the rendered file) — and
 * both resolve through the same `clipGain`.
 *
 * Sources are synthesized with lavfi; the reference numbers come from the real
 * binary inside the spec. Every native dialog is cancelled by the fixture
 * except the export's Save dialog, which is stubbed to a temp file.
 *
 * ARRANGE via `window.__reelStores`, ACT via real pointer/keyboard events,
 * ASSERT on store + DOM + output audio.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { AudioClip } from '../src/shared/project'
import type { LoudnessSeries } from '../src/shared/loudness'
import { clipGain } from '../src/shared/volumeLevels'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

/** A mono 48 kHz WAV from a lavfi source (+ an optional filter). */
function synth(out: string, src: string, af?: string): void {
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', src,
    ...(af ? ['-af', af] : []),
    '-ac', '1', '-c:a', 'pcm_s16le', out
  ])
}

/** ffmpeg's integrated loudness (LUFS) of `[a, b)` of a file's audio. */
function measure(file: string, a: number, b: number): number {
  const run = spawnSync(
    FFMPEG,
    ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-vn',
      '-af', `atrim=${a}:${b},asetpts=N/SR/TB,ebur128=framelog=quiet`, '-f', 'null', '-'],
    { encoding: 'utf8' }
  )
  const m = /^\s+I:\s+(-?[\d.]+) LUFS/m.exec(run.stderr)
  if (run.status !== 0 || !m) throw new Error(`ebur128 failed: ${run.stderr.slice(-400)}`)
  return Number(m[1])
}

/** The sample peak (dBFS) of `[a, b)` of a file's audio, across channels. */
function peakOf(file: string, a: number, b: number): number {
  const run = spawnSync(
    FFMPEG,
    ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-vn',
      '-af', `atrim=${a}:${b},astats=measure_perchannel=none:measure_overall=Peak_level`, '-f', 'null', '-'],
    { encoding: 'utf8' }
  )
  const m = /Peak level dB:\s*(-?[\d.]+)/.exec(run.stderr)
  if (run.status !== 0 || !m) throw new Error(`astats failed: ${run.stderr.slice(-400)}`)
  return Number(m[1])
}

/** A 1 kHz tone at lavfi's 1/8 full scale (−18 dBFS peak, ≈ −21.8 LUFS). */
const TONE = (sec: number): string => `sine=frequency=1000:sample_rate=48000:duration=${sec}`

/** Import `paths` into the project; returns ids by file name. */
async function importAll(page: Page, paths: string[]): Promise<Record<string, string>> {
  const assets = await page.evaluate(async (ps) => {
    const list = await window.api.importPaths(ps)
    window.__reelStores.useProject.getState().addMedia(list.map((a) => a.id))
    return list.map((a) => [a.fileName, a.id] as const)
  }, paths)
  return Object.fromEntries(assets)
}

const audioClip = (over: Partial<AudioClip> & Pick<AudioClip, 'id' | 'mediaId' | 'startSec' | 'outSec'>): AudioClip => ({
  inSec: 0,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  kind: 'voice',
  ...over
})

async function addClips(page: Page, clips: AudioClip[]): Promise<void> {
  await page.evaluate((cs) => {
    const s = window.__reelStores.useProject.getState()
    for (const c of cs) s.addAudioClip(c)
  }, clips)
}

const clipOf = (page: Page, id: string): Promise<AudioClip | undefined> =>
  page.evaluate((cid) => window.__reelStores.useProject.getState().project?.audioClips.find((a) => a.id === cid), id)

/** The level (dB) actually in force on a clip's preview follower. */
async function previewDb(page: Page, id: string): Promise<number> {
  const el = page.locator(`[data-testid="audio-follower"][data-clip-id="${id}"]`)
  await expect(el).toHaveCount(1, { timeout: 30_000 })
  return el.evaluate((a: HTMLAudioElement) => 20 * Math.log10(window.__reelStores.appliedGain(a)))
}

/** Select an audio clip the way a person does: press its timeline tile. */
async function selectTile(page: Page, id: string): Promise<void> {
  await page.getByTestId(`tile-audio-${id}`).click({ position: { x: 30, y: 8 } })
  await expect.poll(() => page.evaluate(() => window.__reelStores.useUi.getState().selectedAudioId)).toBe(id)
}

test('a level matches two clips 15 dB apart; its slider moves them, not another level; the own slider locks and comes back', async ({
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-levels-'))
  const loud = join(dir, 'loud.wav')
  const quiet = join(dir, 'quiet.wav')
  synth(loud, TONE(6))
  synth(quiet, TONE(6), 'volume=-15dB')
  const ids = await importAll(page, [loud, quiet])

  await addClips(page, [
    audioClip({ id: 'A', mediaId: ids['loud.wav'], startSec: 0, outSec: 6, gainDb: -6 }),
    audioClip({ id: 'B', mediaId: ids['quiet.wav'], startSec: 6, outSec: 6 }),
    audioClip({ id: 'C', mediaId: ids['loud.wav'], startSec: 12, outSec: 6 })
  ])
  // C goes in a second level (the store action the New level dialog calls).
  await page.evaluate(() => window.__reelStores.useProject.getState().createVolumeLevel('Music', ['C']))
  await expect.poll(() => previewDb(page, 'A')).toBeCloseTo(-6, 1) // own gain before joining

  // A joins Default from the Inspector picker…
  await selectTile(page, 'A')
  await page.getByTestId('volume-level-select').selectOption('default')
  // A right-button drag never moves a tile (it only selects, for the menu).
  const bBox = (await page.getByTestId('tile-audio-B').boundingBox())!
  await page.mouse.move(bBox.x + 30, bBox.y + 8)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(bBox.x + 130, bBox.y + 8, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
  expect((await clipOf(page, 'B'))?.startSec).toBe(6)

  // …and B from the timeline's right-click "Add to volume level ▸".
  await page.getByTestId('tile-audio-B').click({ button: 'right', position: { x: 30, y: 8 } })
  await page.getByTestId('ctx-volume-level').click()
  await page.getByTestId('ctx-level-default').click()
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
  expect((await clipOf(page, 'A'))?.volumeLevelId).toBe('default')
  expect((await clipOf(page, 'B'))?.volumeLevelId).toBe('default')
  await expect(page.getByTestId('tile-level-B')).toContainText('Default')
  await selectTile(page, 'A') // the right-click selected B

  // Both land on −16 LUFS, so the quiet one gets ~15 dB more.
  await expect.poll(async () => (await previewDb(page, 'B')) - (await previewDb(page, 'A')), { timeout: 30_000 }).toBeCloseTo(15, 0)
  const a0 = await previewDb(page, 'A')
  const b0 = await previewDb(page, 'B')
  const c0 = await previewDb(page, 'C')
  expect(a0).toBeGreaterThan(4) // −21.8 → −16: about +5.8 dB, not its own −6
  await expect(page.getByTestId('level-status')).toContainText('Matched')

  // The own slider is locked (value kept) while A is in a level.
  const own = page.getByRole('slider', { name: 'Clip volume' })
  await expect(own).toBeDisabled()
  await expect(own).toHaveValue('-6')

  // Move Default's loudness 4 LU up with the keyboard: A and B follow, C (Music) doesn't.
  const levelSlider = page.getByRole('slider', { name: 'Level loudness' })
  await levelSlider.focus()
  for (let i = 0; i < 4; i++) await levelSlider.press('ArrowRight')
  await expect
    .poll(() => page.evaluate(() => window.__reelStores.useProject.getState().project?.volumeLevels[0].targetLufs))
    .toBe(-12)
  await expect.poll(() => previewDb(page, 'A')).toBeCloseTo(a0 + 4, 1)
  await expect.poll(() => previewDb(page, 'B')).toBeCloseTo(b0 + 4, 1)
  expect(await previewDb(page, 'C')).toBeCloseTo(c0, 2)

  // Leave the level: the own slider unlocks and its −6 dB is back in force.
  await page.getByTestId('volume-level-select').selectOption('')
  await expect(own).toBeEnabled()
  await expect.poll(() => previewDb(page, 'A')).toBeCloseTo(-6, 1)
  expect((await clipOf(page, 'A'))?.gainDb).toBe(-6)

  rmSync(dir, { recursive: true, force: true })
})

test('File ▸ Volume levels: Default can’t be deleted or renamed; create, set loudness, delete (one undo step)', async ({
  appPage: page
}) => {
  await addClips(page, [audioClip({ id: 'X', mediaId: 'no-media', startSec: 0, outSec: 3 })])
  const openLevels = async (): Promise<void> => {
    await page.getByRole('button', { name: 'File ▾' }).click()
    await page.getByTestId('file-volume-levels').click()
    await expect(page.getByTestId('context-menu')).toBeVisible()
  }
  const levels = (): Promise<{ id: string; name: string; targetLufs: number }[]> =>
    page.evaluate(() => window.__reelStores.useProject.getState().project!.volumeLevels)

  // Default: Rename and Delete are greyed out.
  await openLevels()
  await page.getByTestId('level-menu-default').click()
  await expect(page.getByTestId('level-delete')).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('level-rename')).toHaveAttribute('aria-disabled', 'true')
  await page.getByTestId('level-delete').click({ force: true })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
  expect((await levels()).map((l) => l.id)).toEqual(['default'])

  // Create new level… is an in-app modal asking for the name.
  await openLevels()
  await page.getByTestId('level-create').click()
  await expect(page.getByTestId('level-dialog')).toBeVisible()
  await page.getByTestId('level-name').fill('default') // taken (names are case-insensitive)
  await expect(page.getByTestId('level-name-reason')).toContainText('already exists')
  await expect(page.getByTestId('level-submit')).toBeDisabled()
  await page.getByTestId('level-name').fill('Voice')
  await page.getByTestId('level-submit').click()
  await expect(page.getByTestId('level-dialog')).toHaveCount(0)
  const voice = (await levels()).find((l) => l.name === 'Voice')!
  expect(voice).toMatchObject({ targetLufs: -16 })

  // Set loudness… on Default (allowed) through the dialog's exact field.
  await openLevels()
  await page.getByTestId('level-menu-default').click()
  await page.getByTestId('level-set-loudness').click()
  await page.getByLabel('Level loudness (LUFS)').fill('-14')
  await page.getByLabel('Level loudness (LUFS)').press('Enter')
  await page.getByTestId('level-submit').click()
  expect((await levels())[0]).toEqual({ id: 'default', name: 'Default', targetLufs: -14 })

  // Delete Voice with a clip in it: the clip returns to its own volume, and
  // ONE undo brings back both the level and the membership.
  await page.evaluate((id) => window.__reelStores.useProject.getState().setClipsVolumeLevel(['X'], id), voice.id)
  await openLevels()
  await page.getByTestId(`level-menu-${voice.id}`).click()
  await page.getByTestId('level-delete').click()
  expect((await levels()).map((l) => l.name)).toEqual(['Default'])
  expect((await clipOf(page, 'X'))?.volumeLevelId).toBeUndefined()
  await page.keyboard.press('Control+z')
  expect((await levels()).map((l) => l.name)).toEqual(['Default', 'Voice'])
  expect((await clipOf(page, 'X'))?.volumeLevelId).toBe(voice.id)
})

test('auto-join setting: off → a new extracted clip joins no level; on → it joins Default', async ({ appPage: page }) => {
  const openSettings = async (): Promise<void> => {
    await page.getByTitle('Settings', { exact: true }).click()
  }
  const box = page.getByRole('checkbox', { name: /auto-join new clips/i })
  const extractedFor = (layerId: string): Promise<AudioClip | undefined> =>
    page.evaluate((lid) => {
      const p = window.__reelStores.useProject.getState().project!
      const g = p.layers.find((l) => l.id === lid)?.linkGroupId
      return p.audioClips.find((a) => a.linkGroupId === g && a.kind === 'extracted')
    }, layerId)
  // The drop / Library ＋ path: a clip with audio lands with its audio linked.
  const dropVideo = (id: string, at: number): Promise<void> =>
    page.evaluate(([lid, t]) => window.__reelStores.useProject.getState().addVideoLayer(lid as string, 'no-media', t as number, 3, true, 9 / 16), [id, at] as const)

  await openSettings()
  await expect(box).toBeChecked() // on by default
  await box.uncheck()
  await page.getByRole('button', { name: 'Done' }).click()
  expect(await page.evaluate(() => window.api.getSettings().then((s) => s.autoJoinDefaultLevel))).toBe(false)
  await dropVideo('V1', 0)
  expect((await extractedFor('V1'))?.volumeLevelId).toBeUndefined()

  await openSettings()
  await box.check()
  await page.getByRole('button', { name: 'Done' }).click()
  await dropVideo('V2', 3)
  expect((await extractedFor('V2'))?.volumeLevelId).toBe('default')

  // Turning it off again leaves the clip already in Default where it is.
  await openSettings()
  await box.uncheck()
  await page.getByRole('button', { name: 'Done' }).click()
  expect((await extractedFor('V2'))?.volumeLevelId).toBe('default')
})

test('export: each levelled clip measures within 1 LU of the target, or short exactly as the peak cap predicts', async ({
  appPage: page,
  electronApp
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(180_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-levels-export-'))
  const bg = join(dir, 'black.mp4')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', bg])
  const loud = join(dir, 'loud.wav')
  const quiet = join(dir, 'quiet.wav')
  const pulses = join(dir, 'pulses.wav')
  synth(loud, TONE(4)) // ≈ −21.8 LUFS, −18 dBFS peak
  synth(quiet, TONE(4), 'volume=-18dB') // ≈ −39.8 LUFS, −36 dBFS peak
  // 10 ms bursts at −12 dBFS every 0.4 s: quiet overall (≈ −31 LUFS) with a
  // high peak, so reaching −16 would clip — the cap holds it ~4 dB short.
  synth(pulses, "aevalsrc='0.25*sin(2*PI*1000*t)*lt(mod(t\\,0.4)\\,0.01)':s=48000:d=4")
  const ids = await importAll(page, [bg, loud, quiet, pulses])

  await page.evaluate((bgId) => window.__reelStores.useProject.getState().addVideoLayer('BG', bgId, 0, 12, false), ids['black.mp4'])
  const clips = [
    audioClip({ id: 'L', mediaId: ids['loud.wav'], startSec: 0, outSec: 4, gainDb: -10, volumeLevelId: 'default' }),
    audioClip({ id: 'Q', mediaId: ids['quiet.wav'], startSec: 4, outSec: 4, volumeLevelId: 'default' }),
    audioClip({ id: 'P', mediaId: ids['pulses.wav'], startSec: 8, outSec: 4, volumeLevelId: 'default' })
  ]
  await addClips(page, clips)

  // What the helper predicts from each clip's measured series.
  const series: Record<string, LoudnessSeries | null> = {}
  for (const c of clips) series[c.mediaId] = await page.evaluate((id) => window.api.getLoudness(id), c.mediaId)
  const levels = await page.evaluate(() => window.__reelStores.useProject.getState().project!.volumeLevels)
  const predict = (c: AudioClip) =>
    clipGain(c, clips, { levels, seriesOf: (id) => series[id], durationOf: () => 4 })
  expect(predict(clips[0]).status.kind).toBe('matched')
  expect(predict(clips[1]).status.kind).toBe('matched')
  const capped = predict(clips[2])
  expect(capped.status.kind).toBe('short')

  // The preview applies exactly the predicted gains (same helper)…
  for (const c of clips) await expect.poll(() => previewDb(page, c.id), { timeout: 30_000 }).toBeCloseTo(predict(c).gainDb, 1)
  // …and the Inspector says the pulses are short.
  await selectTile(page, 'P')
  await expect(page.getByTestId('level-status')).toContainText('Short by')

  const out = join(dir, 'out.mp4')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: false })
  })
  expect(existsSync(out)).toBe(true)

  // Each clip's own stretch of the output (trimmed 0.2 s in from each edge).
  const got = { L: measure(out, 0.2, 3.8), Q: measure(out, 4.2, 7.8), P: measure(out, 8.2, 11.8) }
  const src = { P: measure(pulses, 0.2, 3.8) }
  const peakP = peakOf(out, 8, 12)
  console.log('[volumeLevels] export LUFS', JSON.stringify(got), 'pulses source', src.P, 'cap gain', capped.gainDb, capped.status, 'pulses peak out', peakP)
  expect(Math.abs(got.L - -16)).toBeLessThanOrEqual(1)
  expect(Math.abs(got.Q - -16)).toBeLessThanOrEqual(1)
  // Capped: the source's loudness plus the capped gain — short of −16 by the predicted amount.
  if (capped.status.kind !== 'short') throw new Error('unreachable')
  expect(capped.status.byDb).toBeGreaterThan(2)
  expect(Math.abs(got.P - (src.P + capped.gainDb))).toBeLessThanOrEqual(0.5)
  expect(Math.abs(-16 - got.P - capped.status.byDb)).toBeLessThanOrEqual(0.5)
  expect(peakP).toBeLessThanOrEqual(-1) // the cap's whole point: no clipping

  rmSync(dir, { recursive: true, force: true })
})
