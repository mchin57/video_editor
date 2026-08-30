/**
 * Generated audio effect tracks, end to end: the Inspector's "Sound effects"
 * section renders an echo through REAL ffmpeg, imports it as a library asset,
 * and drops it on the timeline as its own clip in the FX lane.
 *
 * This is the part unit tests cannot reach — the arg builders are pinned in
 * `audioFx.test.ts`, but only running the app proves the IPC channel, the
 * render service, the store wiring and the new lane actually line up.
 *
 * ARRANGE via store + a real import, ACT via the real Inspector controls,
 * ASSERT on the store and the timeline DOM.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'

/** A hermetic 3s 8kHz mono tone — no ffmpeg needed to ARRANGE the input. */
function makeWav(path: string): void {
  const sampleRate = 8000
  const n = sampleRate * 3
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 12000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

test('adding an echo renders a wet track onto the FX lane', async ({ appPage: page }) => {
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-fx-')), 'tone.wav')
  makeWav(wav)

  // ARRANGE: a real imported audio clip, selected so the Inspector shows it.
  const sourceId = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addMedia([asset.id])
    useProject.getState().addAudioClip({
      id: 'dry-clip',
      mediaId: asset.id,
      startSec: 1,
      inSec: 0,
      outSec: 3,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'voice'
    })
    useUi.getState().selectAudio('dry-clip')
    return asset.id
  }, wav)

  // ACT: the real button in the Sound effects section (echo is the default).
  await page.getByRole('button', { name: /Add echo track/i }).click()

  // ASSERT: a second clip appears, marked as an effect track and rendered from
  // the dry clip's source over its exact window.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__reelStores.useProject.getState().project!.audioClips.length
        ),
      { timeout: 60_000 }
    )
    .toBe(2)

  const fx = await page.evaluate(
    () => window.__reelStores.useProject.getState().project!.audioClips.find((a) => a.fx)!
  )
  expect(fx.kind).toBe('fx')
  expect(fx.fx!.settings.kind).toBe('echo')
  expect(fx.fx!.fromMediaId).toBe(sourceId)
  expect(fx.fx!.fromInSec).toBe(0)
  expect(fx.fx!.fromOutSec).toBe(3)
  // It lines up with the sound it came from, and is its own asset.
  expect(fx.startSec).toBe(1)
  expect(fx.mediaId).not.toBe(sourceId)
  // An effect track is an addition, not a bed, and must not be captioned twice.
  expect(fx.duck).toBe(false)
  expect(fx.excludeFromCaptions).toBe(true)

  // The FX lane appears (it is hidden until an effect track exists) and holds
  // the new tile.
  await expect(page.getByText('FX', { exact: true })).toBeVisible()
  await expect(page.locator(`[data-testid="tile-audio-${fx.id}"]`)).toBeVisible()

  // The dry clip is untouched — an effect never modifies its source.
  const dry = await page.evaluate(
    () => window.__reelStores.useProject.getState().project!.audioClips.find((a) => !a.fx)!
  )
  expect(dry.mediaId).toBe(sourceId)
  expect(dry.gainDb).toBe(0)
})

/**
 * Regression: splitting an effect track and THEN re-rendering it used to
 * regenerate the whole effect and drop it at the piece's start, because the
 * re-render reset inSec/outSec to 0. A chorus is close enough to its source
 * that this read as "the original clip came back". The sibling piece was also
 * left pointing at the previous render.
 */
test('re-rendering a SPLIT effect track keeps every piece trimmed and in sync', async ({
  appPage: page
}) => {
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-fx-')), 'tone.wav')
  makeWav(wav)

  await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addMedia([asset.id])
    useProject.getState().addAudioClip({
      id: 'dry-clip',
      mediaId: asset.id,
      startSec: 1,
      inSec: 0,
      outSec: 3,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'voice'
    })
    useUi.getState().selectAudio('dry-clip')
  }, wav)

  await page.getByRole('button', { name: /Add echo track/i }).click()
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__reelStores.useProject.getState().project!.audioClips.length
        ),
      { timeout: 60_000 }
    )
    .toBe(2)

  // ARRANGE: cut the effect track in two, then select the first piece.
  const before = await page.evaluate(async () => {
    const { useProject, useUi } = window.__reelStores
    const p = useProject.getState().project!
    const fx = p.audioClips.find((a) => a.fx)!
    const assets = await window.api.listProjectMedia(p.mediaIds)
    const dur = assets.find((a) => a.id === fx.mediaId)!.probe.durationSec
    useProject.getState().splitAudioAt(fx.id, 2.5, dur)
    const pieces = useProject.getState().project!.audioClips.filter((a) => a.fx)
    useUi.getState().selectAudio(pieces[0].id)
    return {
      oldMediaId: fx.mediaId,
      pieces: pieces.map((a) => ({
        id: a.id,
        startSec: a.startSec,
        inSec: a.inSec,
        outSec: a.outSec
      }))
    }
  })
  expect(before.pieces).toHaveLength(2)

  // ACT: change a setting (so the render hashes differently) and re-render.
  await page.getByLabel(/Repeats/).fill('5')
  await page.getByRole('button', { name: /Re-render echo/i }).click()

  await expect
    .poll(
      () =>
        page.evaluate(
          (old) =>
            window.__reelStores.useProject
              .getState()
              .project!.audioClips.filter((a) => a.fx && a.mediaId !== old).length,
          before.oldMediaId
        ),
      { timeout: 60_000 }
    )
    .toBe(2) // BOTH pieces moved to the new render, not just the selected one

  const after = await page.evaluate(() =>
    window.__reelStores.useProject
      .getState()
      .project!.audioClips.filter((a) => a.fx)
      .map((a) => ({ id: a.id, startSec: a.startSec, inSec: a.inSec, outSec: a.outSec }))
  )

  // Still two pieces, each holding its own position AND its own trim — the
  // re-render must not expand a piece back to the whole effect.
  expect(after).toHaveLength(2)
  for (const piece of before.pieces) {
    const now = after.find((a) => a.id === piece.id)!
    expect(now.startSec).toBe(piece.startSec)
    expect(now.inSec).toBe(piece.inSec)
    expect(now.outSec).toBe(piece.outSec)
  }
  // The first piece was trimmed, so it must NOT read as "whole file".
  const first = after.find((a) => a.id === before.pieces[0].id)!
  expect(first.outSec).toBeGreaterThan(0)
})

/** The swept chorus runs a different ffmpeg chain (vibrato, plus a primed
 *  lead-in that gets trimmed off). Only running it in the app proves the chain
 *  assembles and renders. */
test('the chorus kind renders through its own swept chain', async ({ appPage: page }) => {
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-fx-')), 'tone.wav')
  makeWav(wav)

  await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addMedia([asset.id])
    useProject.getState().addAudioClip({
      id: 'dry-clip',
      mediaId: asset.id,
      startSec: 0,
      inSec: 0,
      outSec: 3,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'voice'
    })
    useUi.getState().selectAudio('dry-clip')
  }, wav)

  await page.getByRole('button', { name: 'Chorus', exact: true }).click()
  await page.getByRole('button', { name: /Add chorus track/i }).click()

  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__reelStores.useProject.getState().project!.audioClips.length
        ),
      { timeout: 60_000 }
    )
    .toBe(2)

  const fx = await page.evaluate(
    () => window.__reelStores.useProject.getState().project!.audioClips.find((a) => a.fx)!
  )
  expect(fx.fx!.settings.kind).toBe('chorus')
  expect(fx.kind).toBe('fx')

  // The primed lead-in must be trimmed off, so the effect is not shifted late:
  // its rendered length should track the source window, not exceed it by 200ms.
  const dur = await page.evaluate(async (id) => {
    const p = window.__reelStores.useProject.getState().project!
    const assets = await window.api.listProjectMedia(p.mediaIds)
    return assets.find((a) => a.id === id)!.probe.durationSec
  }, fx.mediaId)
  expect(dur).toBeGreaterThan(2.9)
  expect(dur).toBeLessThan(3.2) // 3s source + the longest voice delay, NOT +200ms
})

test('the ensemble kind is still available under its new name', async ({ appPage: page }) => {
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-fx-')), 'tone.wav')
  makeWav(wav)
  await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addMedia([asset.id])
    useProject.getState().addAudioClip({
      id: 'dry-clip',
      mediaId: asset.id,
      startSec: 0,
      inSec: 0,
      outSec: 3,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'voice'
    })
    useUi.getState().selectAudio('dry-clip')
  }, wav)

  await page.getByRole('button', { name: 'Ensemble', exact: true }).click()
  await page.getByRole('button', { name: /Add ensemble track/i }).click()

  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__reelStores.useProject.getState().project!.audioClips.length
        ),
      { timeout: 60_000 }
    )
    .toBe(2)

  const fx = await page.evaluate(
    () => window.__reelStores.useProject.getState().project!.audioClips.find((a) => a.fx)!
  )
  expect(fx.fx!.settings.kind).toBe('ensemble')
})

/**
 * The Sound effects panel holds its controls in local component state seeded
 * from the selected clip. Selecting a DIFFERENT effect track re-renders the
 * same component instance, so without a remount the panel keeps showing the
 * previous clip's settings — and "Re-render" then applies those, or silently
 * no-ops when they happen to match what is already rendered.
 */
test('selecting a different effect track shows THAT track settings', async ({
  appPage: page
}) => {
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-fx-')), 'tone.wav')
  makeWav(wav)
  await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addMedia([asset.id])
    useProject.getState().addAudioClip({
      id: 'dry-clip',
      mediaId: asset.id,
      startSec: 0,
      inSec: 0,
      outSec: 3,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'voice'
    })
    useUi.getState().selectAudio('dry-clip')
  }, wav)

  // An echo track…
  await page.getByRole('button', { name: /Add echo track/i }).click()
  await expect
    .poll(() => page.evaluate(() => window.__reelStores.useProject.getState().project!.audioClips.length), {
      timeout: 60_000
    })
    .toBe(2)

  // …and a chorus track, from the same dry clip.
  await page.evaluate(() => window.__reelStores.useUi.getState().selectAudio('dry-clip'))
  await page.getByRole('button', { name: 'Chorus', exact: true }).click()
  await page.getByRole('button', { name: /Add chorus track/i }).click()
  await expect
    .poll(() => page.evaluate(() => window.__reelStores.useProject.getState().project!.audioClips.length), {
      timeout: 60_000
    })
    .toBe(3)

  // Select the ECHO track. The panel must follow the selection, not linger on
  // the chorus settings left over from the last thing that was edited.
  const echoId = await page.evaluate(() => {
    const fx = window.__reelStores.useProject
      .getState()
      .project!.audioClips.filter((a) => a.fx)
    const echo = fx.find((a) => a.fx!.settings.kind === 'echo')!
    window.__reelStores.useUi.getState().selectAudio(echo.id)
    return echo.id
  })
  expect(echoId).toBeTruthy()

  // Echo shows "Repeats"; chorus shows "Rate". Seeing Rate here means the panel
  // is still describing the previously selected track.
  await expect(page.getByText(/^Repeats · /)).toBeVisible()
  await expect(page.getByText(/^Rate · /)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Re-render echo/i })).toBeVisible()
})
