/**
 * The Pose section and the preview picker, against a written pose file (two
 * people, the second walking in later) — no models needed:
 *  - without the models the section says what's missing, yet a detected pose
 *    still has its controls;
 *  - "Pick on preview" draws everyone as numbered boxes; clicking one shows
 *    that person (in the next colour), clicking again hides them;
 *  - the Inspector's people list toggles and re-joins a person whose track
 *    broke ("Same as…"); presets set the angles; the tile gets a pose badge;
 *  - "Convert to drawing" copies the skeleton into a graphics tile.
 *
 * ARRANGE via the stores (+ the pose file), ACT via real clicks, ASSERT on store + DOM.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const W = 1080
const H = 1920

/** A standing body (every keypoint confident) centred at x, offset by i·10px down the list. */
const body = (x: number): number[] =>
  Array.from({ length: 26 }, (_, i) => [x + ((i % 4) - 2) * 40, 400 + i * 40, 0.9]).flat()

function writePose(projectDir: string, mediaId: string): void {
  const data = {
    version: 1,
    mediaId,
    startSec: 0,
    durationSec: 4,
    fps: 10,
    frameCount: 40,
    width: W,
    height: H,
    model: 'e2e fixture',
    tracks: [
      { id: 1, first: 0, frames: Array.from({ length: 40 }, () => body(300)), weight: 2 },
      { id: 2, first: 0, frames: Array.from({ length: 40 }, () => body(800)), weight: 1 },
      // Person 1 again, after tracking lost them (a separate track).
      { id: 3, first: 20, frames: Array.from({ length: 20 }, () => body(320)), weight: 0.5 }
    ]
  }
  mkdirSync(join(projectDir, 'pose'), { recursive: true })
  writeFileSync(join(projectDir, 'pose', `${mediaId}.json`), JSON.stringify(data))
}

const pose = (page: Page): Promise<{ people: { tracks: number[]; color: string }[]; angles: string[] } | null> =>
  page.evaluate(() => {
    const l = window.__reelStores.useProject.getState().project!.layers.find((x) => x.id === 'V')!
    return ((l.content as unknown as { pose?: unknown }).pose ?? null) as never
  })

test('pick people on the preview and in the Inspector, re-join a lost track, convert to a drawing', async ({
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  const dir = mkdtempSync(join(tmpdir(), 'reel-pose-'))
  const clip = join(dir, 'clip.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${W}x${H}:r=30:d=4`,
    '-pix_fmt',
    'yuv420p',
    clip
  ])
  const mediaId = await page.evaluate(async (clip) => {
    const [a] = await window.api.importPaths([clip])
    window.__reelStores.useProject.getState().addMedia([a.id])
    return a.id
  }, clip)
  writePose(join(projectsDir, 'E2E'), mediaId)
  await page.evaluate((id) => {
    const { useProject, useUi, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('V', id, 0, 4, false)
    useUi.getState().selectLayer('V')
    usePlayback.getState().setTime(1)
  }, mediaId)
  await expect(page.getByTestId('pose-overlay')).toHaveCount(0) // nothing to draw yet

  // With no models installed (the usual test machine) the section says what's
  // missing instead of offering Detect…
  await expect(page.getByTestId('pose-missing').or(page.getByTestId('pose-detect'))).toBeVisible()
  if (await page.getByTestId('pose-missing').count()) {
    await expect(page.getByTestId('pose-missing')).toContainText('yolox')
  }
  // …and either way the detected pose (the file) can be shown.
  await page.getByRole('button', { name: 'Show pose on this clip' }).click()
  expect(await pose(page)).toMatchObject({ people: [] })

  // Pick on the preview: two people at 1s, numbered boxes; click person 2.
  await page.getByTestId('pose-pick').click()
  await expect(page.getByTestId('pose-pick-1')).toBeVisible()
  await expect(page.getByTestId('pose-pick-2')).toBeVisible()
  await expect(page.getByTestId('pose-pick-3')).toHaveCount(0) // not seen until 2s
  await page.getByTestId('pose-pick-2').click()
  expect((await pose(page))!.people).toEqual([{ tracks: [2], color: '#FFD60A' }])
  // Its skeleton draws in its colour.
  await expect(page.getByTestId('pose-overlay').locator('path[stroke="#FFD60A"]')).toHaveCount(1)
  await page.getByTestId('pose-pick-2').click() // and off again
  expect((await pose(page))!.people).toEqual([])

  // The Inspector list: person 1 on, then person 3 joined to them.
  await page.getByTestId('pose-person-1').check()
  await page.getByLabel('Person 3 is also').selectOption('0')
  expect((await pose(page))!.people).toEqual([{ tracks: [1, 3], color: '#FFD60A' }])
  // At 3s (track 1 still there) and after it: the same person carries on.
  await page.getByTestId('pose-preset-bike').click()
  expect((await pose(page))!.angles).toEqual([
    'leftKnee',
    'rightKnee',
    'leftHip',
    'rightHip',
    'leftAnkle',
    'rightAnkle'
  ])
  await expect(page.getByTestId('tile-pose-V')).toBeVisible()

  // Convert to drawing: a graphics tile at the playhead with the skeleton's lines.
  await page.getByTestId('pose-to-drawing').click()
  const tile = await page.evaluate(() => {
    const layers = window.__reelStores.useProject.getState().project!.layers
    const g = layers[layers.length - 1]
    return {
      kind: g.content.kind,
      start: g.startSec,
      marks: (g.content as unknown as { marks: { tool: string; color: string }[] }).marks
    }
  })
  expect(tile.kind).toBe('graphics')
  expect(tile.start).toBeCloseTo(1)
  expect(tile.marks.filter((m) => m.tool === 'line').length).toBeGreaterThan(10)
  expect(tile.marks.filter((m) => m.tool === 'angle')).toHaveLength(6)
  expect(new Set(tile.marks.map((m) => m.color))).toEqual(new Set(['#FFD60A']))
})
