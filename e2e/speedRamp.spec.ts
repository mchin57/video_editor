/**
 * Speed ramp (keyframed variable speed): the Inspector's ramp editor drives the
 * store, the timeline block reflects the nonlinear duration + shows the ramp
 * badge, and a real trim drag keeps the window invariant
 * `endSec − startSec = playedBetween(in, out) + Σ holds`. ARRANGE via store
 * actions (a video layer needs no real media for timeline math), ACT with real
 * clicks/typing/drags, ASSERT on store + DOM.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import type { VideoContent } from '../src/shared/project'

/** A plain 10s clip at t=0, selected (Inspector shows the video sections). */
async function arrangeClip(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 0, 10, false)
    useUi.getState().selectLayer('L1')
  })
}

const layerState = (page: Page): Promise<{ startSec: number; endSec: number; c: VideoContent }> =>
  page.evaluate(() => {
    const l = window.__reelStores.useProject.getState().project!.layers[0]
    return { startSec: l.startSec, endSec: l.endSec, c: l.content as VideoContent }
  })

test('Inspector builds a ramp: keyframes at the playhead, duration follows the integral', async ({ appPage: page }) => {
  await arrangeClip(page)
  const addKf = page.getByTitle('Keyframe the playback speed at the playhead — speed ramps linearly between keyframes')

  // Keyframe 1 at t=2 (source 2, seeded with the current 1× speed).
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2))
  await addKf.click()
  let s = await layerState(page)
  expect(s.c.speedRamp).toEqual([{ atSec: 2, speed: 1 }])
  expect(s.endSec).toBeCloseTo(10, 5) // seeding at the current speed changes nothing

  // Slow that keyframe to 0.5× → constant 0.5 profile → 20s window.
  const speedInput = page.getByTitle('Playback speed at this source point').first()
  await speedInput.fill('0.5')
  s = await layerState(page)
  expect(s.c.speedRamp).toEqual([{ atSec: 2, speed: 0.5 }])
  expect(s.endSec).toBeCloseTo(20, 5)

  // Keyframe 2 at t=10 → source 5 at the (constant 0.5) profile; then speed it
  // up to 2× there. Profile: flat 0.5 to s=2, ramp 0.5→2 over s=2..5, flat 2
  // after → played = 4 + ln(4)/0.5 + 2.5 ≈ 9.2726.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(10))
  await addKf.click()
  s = await layerState(page)
  expect(s.c.speedRamp).toHaveLength(2)
  expect(s.c.speedRamp![1].atSec).toBeCloseTo(5, 5)
  await page.getByTitle('Playback speed at this source point').nth(1).fill('2')
  s = await layerState(page)
  expect(s.endSec).toBeGreaterThan(9.2)
  expect(s.endSec).toBeLessThan(9.35)

  // The timeline block shows the ramp badge; the constant-speed field disables.
  await expect(page.locator('div[title="Video"] span', { hasText: '×~' })).toBeVisible()
})

test('trim drag on a ramped clip keeps the window invariant', async ({ appPage: page }) => {
  await arrangeClip(page)
  // Ramp 0.5× (source 2) → 2× (source 5), built directly via store actions.
  await page.evaluate(() => {
    const { useProject, usePlayback } = window.__reelStores
    usePlayback.getState().setTime(2)
    useProject.getState().addSpeedKeyframe('L1', 2)
    useProject.getState().updateSpeedKeyframe('L1', 0, 0.5)
    useProject.getState().addSpeedKeyframe('L1', 10) // source 5 on the 0.5 profile
    useProject.getState().updateSpeedKeyframe('L1', 1, 2)
  })
  const before = await layerState(page)
  expect(before.endSec).toBeGreaterThan(9.2)
  expect(before.endSec).toBeLessThan(9.35)

  const scale = await page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)
  const block = page.locator('div[title="Video"]')
  await expect(block).toBeVisible()

  // Drag the right-edge trim handle 1 played-second left. The tail plays at
  // 2×, so the source out-point moves back ~2s (10 → ~8).
  const handle = block.locator('div.cursor-ew-resize').last()
  const hb = (await handle.boundingBox())!
  const cx = hb.x + hb.width / 2
  const cy = hb.y + hb.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - scale, cy, { steps: 5 })
  await page.mouse.up()

  const { startSec, endSec, c } = await layerState(page)
  expect(c.outSec).toBeGreaterThan(7.5)
  expect(c.outSec).toBeLessThan(8.5)
  expect(c.speedRamp).toHaveLength(2) // ramp survives the trim
  // Window invariant: recompute the integral in-page with the shared helper.
  const played = await page.evaluate(() => {
    const l = window.__reelStores.useProject.getState().project!.layers[0]
    return window.__reelStores.playedVideoDuration(l.content as import('../src/shared/project').VideoContent)
  })
  expect(endSec - startSec).toBeCloseTo(played, 5)
})
