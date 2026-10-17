/**
 * #52: "✂ Split on silence" on an audio clip LINKED to its video. It used to be
 * disabled while linked; now the whole group is cut at the same timeline
 * seconds, the speech slices stay linked pairwise (audio N ↔ video N), the
 * audio's silent slices are dropped, the video keeps every frame, and it is one
 * undo step.
 *
 * ARRANGE via a real lavfi clip (tone at 1–2.5 s and 4–5.5 s, silence between)
 * imported and placed as a linked pair; ACT via the real Inspector button;
 * ASSERT on the store.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

test('split on silence cuts a linked clip and its audio together, pairing the speech slices', async ({
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const clip = join(projectsDir, 'E2E', 'talk.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568:rate=30:duration=6',
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='if(between(t,1,2.5)+between(t,4,5.5),0.5*sin(2*PI*440*t),0)':s=48000:d=6",
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    clip
  ])
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, clip)
  await expect
    .poll(
      async () => ((await page.evaluate((i) => window.api.listProjectMedia([i]), id)) as MediaAsset[])[0]?.proxyReady,
      {
        timeout: 30_000
      }
    )
    .toBe(true)

  // Placed as a linked pair (the video muted, its audio on the audio lane).
  const audioId = await page.evaluate((id) => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('L1', id, 0, 6, true)
    const a = useProject.getState().project!.audioClips[0]
    useUi.getState().selectAudio(a.id)
    return a.id
  }, id)
  const read = (): Promise<{
    layers: { id: string; startSec: number; endSec: number; g?: string }[]
    audio: { id: string; startSec: number; inSec: number; outSec: number; g?: string }[]
    past: number
  }> =>
    page.evaluate(() => {
      const s = window.__reelStores.useProject.getState()
      return {
        layers: s.project!.layers.map((l) => ({ id: l.id, startSec: l.startSec, endSec: l.endSec, g: l.linkGroupId })),
        audio: s.project!.audioClips.map((a) => ({
          id: a.id,
          startSec: a.startSec,
          inSec: a.inSec,
          outSec: a.outSec,
          g: a.linkGroupId
        })),
        past: s.past.length
      }
    })
  const before = await read()
  expect(before.audio[0].g).toBeDefined()
  expect(before.layers[0].g).toBe(before.audio[0].g)

  const split = page.getByRole('button', { name: /Split on silence/ })
  await expect(split).toBeEnabled() // THE BUG: disabled while linked
  await split.click()
  await expect.poll(async () => (await read()).audio.length, { timeout: 20_000 }).toBe(2)
  const after = await read()
  expect(after.past).toBe(before.past + 1) // one undo step
  expect(audioId).toBeTruthy()

  // The audio keeps only its two speech slices (≈1–2.5 s and ≈4–5.5 s).
  const [a1, a2] = [...after.audio].sort((x, y) => x.startSec - y.startSec)
  expect(a1.startSec).toBeCloseTo(1, 0)
  expect(a2.startSec).toBeCloseTo(4, 0)
  // The video is cut at every boundary and keeps every frame: slices tile 0–6 with no gap.
  const v = [...after.layers].sort((x, y) => x.startSec - y.startSec)
  expect(v.length).toBe(5)
  expect(v[0].startSec).toBe(0)
  expect(v[v.length - 1].endSec).toBeCloseTo(6, 1)
  for (let i = 1; i < v.length; i++) expect(v[i].startSec).toBeCloseTo(v[i - 1].endSec, 3)
  // Each speech slice of the audio is linked to the video slice under it, and only to it.
  for (const a of [a1, a2]) {
    expect(a.g).toBeDefined()
    const partner = v.find((l) => Math.abs(l.startSec - a.startSec) < 1e-3)!
    expect(partner.g).toBe(a.g)
  }
  expect(a1.g).not.toBe(a2.g)

  // One Undo puts the linked pair back whole.
  await page.evaluate(() => window.__reelStores.useProject.getState().undo())
  const undone = await read()
  expect(undone.layers).toHaveLength(1)
  expect(undone.audio).toHaveLength(1)
  expect(undone.layers[0].g).toBe(undone.audio[0].g)
})
