/**
 * The workout overlay as a user places and edits it (docs/WORKOUT-OVERLAY.md):
 *  - ＋ End lays the whole recording into `WHOLE_WORKOUT_SEC` in its own
 *    Workout lane, with the widgets the file has data for, drawn on the preview;
 *  - ＋ Playhead over footage filmed during the workout SYNCS: same window as
 *    the clip, real time, the matching stretch of the recording, linked;
 *  - a widget drags on the preview (one undo step), the Inspector adds a metric,
 *    greys one the file has no data for, and sets the speed;
 *  - the tile's right edge trims the ride window at the tile's speed, and S
 *    splits it into consecutive ride windows.
 *
 * ARRANGE real FIT files (Garmin's encoder) and a clip with a recording time
 * (ffmpeg's `creation_time`, the tag iPhone writes too), ACT with real clicks,
 * drags and keys, ASSERT on the store and the DOM.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Layer, WorkoutContent } from '../src/shared/project'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'
import { buildFitFile, loopRide } from '../src/main/services/__fixtures__/fitFile'

/** Import files into the project's library; their ids in order. */
const importAll = (page: Page, paths: string[]): Promise<string[]> =>
  page.evaluate(async (paths) => {
    const assets = await window.api.importPaths(paths)
    window.__reelStores.useProject.getState().addMedia(assets.map((a) => a.id))
    return assets.map((a) => a.id)
  }, paths)

const layers = (page: Page): Promise<Layer[]> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project!.layers)

const workout = async (page: Page): Promise<Layer & { content: WorkoutContent }> => {
  const w = (await layers(page)).find((l) => l.content.kind === 'workout')
  if (!w) throw new Error('no workout layer')
  return w as Layer & { content: WorkoutContent }
}

test('＋ End lays the whole workout in; widgets drag, the Inspector edits, edges trim, S splits', async ({
  appPage: page,
  scratchDir
}) => {
  // 600 one-second samples: power 150…240 W, heart rate, speed, distance, a loop.
  const fit = join(scratchDir, 'Loop Ride.fit')
  writeFileSync(fit, buildFitFile({ samples: loopRide(600) }))
  await importAll(page, [fit])

  const card = page.locator('[data-clip-card]', { hasText: 'Loop Ride.fit' })
  await card.getByRole('button', { name: '＋ End' }).click()
  await expect.poll(async () => (await layers(page)).length).toBe(1)
  let w = await workout(page)
  // The whole 599 s recording in 8 s.
  expect([w.startSec, w.content.inSec, w.content.outSec]).toEqual([0, 0, 599])
  expect(w.content.speed).toBeCloseTo(599 / 8, 6)
  expect(w.endSec).toBeCloseTo(8, 6)
  expect(w.content.widgets.map((x) => x.metric)).toEqual(['power', 'speed', 'heartRate', 'liveMap'])

  // Its own lane, with its speed on the tile; drawn on the preview.
  await expect(page.getByTestId(`tile-layer-${w.id}`)).toContainText('75×')
  await expect(page.getByTestId('timeline-gutter')).toContainText('Workout')
  const svg = page.getByTestId('workout-layer')
  await expect(svg.locator('text', { hasText: /^W$/ })).toHaveCount(1)
  await expect(svg.locator('text', { hasText: /^BPM$/ })).toHaveCount(1)
  await expect(svg.locator('text', { hasText: /^MPH$/ })).toHaveCount(1)

  // Drag the power readout 120 screen px right and 60 down: it moves by that
  // many canonical px at the preview's scale, in ONE undo step.
  const before = w.content.widgets[0]
  const hit = page.getByTestId('workout-widget-power')
  const box = (await hit.boundingBox())!
  const canvas = (await page.getByTestId('preview-canvas').boundingBox())!
  const k = 1080 / canvas.width
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 4 })
  await page.mouse.up()
  w = await workout(page)
  expect(w.content.widgets[0].x - before.x).toBeCloseTo(120 * k, -1)
  expect(w.content.widgets[0].y - before.y).toBeCloseTo(60 * k, -1)
  await page.keyboard.press('Control+z')
  w = await workout(page)
  expect([w.content.widgets[0].x, w.content.widgets[0].y]).toEqual([before.x, before.y])

  // The Inspector: add Average power; set the speed (the tile's end follows).
  await page.getByTestId('workout-metric-avgPower').getByRole('checkbox').check()
  w = await workout(page)
  expect(w.content.widgets.map((x) => x.metric)).toContain('avgPower')
  // Size and colour of one widget; then a metric off again.
  const powerRow = page.getByTestId('workout-metric-power')
  await powerRow.getByRole('slider', { name: 'Power size' }).fill('200')
  await powerRow.getByLabel('Power colour').fill('#ff0000')
  w = await workout(page)
  expect(w.content.widgets.find((x) => x.metric === 'power')).toMatchObject({ sizePx: 200, color: '#ff0000' })
  await page.getByTestId('workout-metric-avgPower').getByRole('checkbox').uncheck()
  w = await workout(page)
  expect(w.content.widgets.map((x) => x.metric)).not.toContain('avgPower')
  // Units: kilometres turn the ride's speed into km/h.
  await page.getByRole('combobox').filter({ hasText: 'Miles' }).selectOption('metric')
  await expect(svg.locator('text', { hasText: /^KM\/H$/ })).toHaveCount(1)
  const speed = page.getByRole('spinbutton').first()
  await speed.fill('100')
  await speed.press('Enter')
  await expect.poll(async () => (await workout(page)).endSec).toBeCloseTo(5.99, 6)

  // Trim the right edge 100 px left: the ride window ends that many timeline
  // seconds × 100 earlier.
  const tile = page.getByTestId(`tile-layer-${w.id}`)
  // The Workout lane sits under Clips / Text / Image: bring it into the timeline's view.
  await tile.scrollIntoViewIfNeeded()
  const tb = (await tile.boundingBox())!
  const pxPerSec = tb.width / 5.99
  await page.mouse.move(tb.x + tb.width - 2, tb.y + tb.height / 2)
  await page.mouse.down()
  await page.mouse.move(tb.x + tb.width - 52, tb.y + tb.height / 2, { steps: 3 })
  await page.mouse.move(tb.x + tb.width - 102, tb.y + tb.height / 2, { steps: 3 })
  await page.mouse.up()
  w = await workout(page)
  const cut = 100 / pxPerSec
  // Within a frame's worth of pointer rounding (1 px ≈ 100 / pxPerSec ride s).
  expect(Math.abs(w.content.outSec - (599 - cut * 100))).toBeLessThan(200 / pxPerSec)
  expect(w.endSec - w.startSec).toBeCloseTo((w.content.outSec - w.content.inSec) / 100, 6)

  // S at the playhead splits it into consecutive ride windows.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2))
  await page.keyboard.press('s')
  await expect.poll(async () => (await layers(page)).length).toBe(2)
  const halves = (await layers(page)).map((l) => {
    const c = l.content as WorkoutContent
    return [l.startSec, l.endSec, c.inSec, c.outSec]
  })
  expect(halves[0]).toEqual([0, 2, 0, 200])
  expect(halves[1][0]).toBe(2)
  expect(halves[1][2]).toBe(200)
  expect(halves[1][3]).toBeCloseTo(w.content.outSec, 6)
})

test('＋ Playhead over footage filmed during the workout syncs to it and links', async ({
  appPage: page,
  scratchDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  // The ride starts 13:00:00 UTC; the clip was filmed from 13:00:30 for 4 s.
  const fit = join(scratchDir, 'Ride.fit')
  writeFileSync(fit, buildFitFile({ start: new Date('2026-05-24T13:00:00Z'), samples: loopRide(600) }))
  const clip = join(scratchDir, 'IMG_0001.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x568:r=30:d=4',
    '-pix_fmt',
    'yuv420p',
    '-metadata',
    'creation_time=2026-05-24T13:00:30Z',
    clip
  ])
  const [clipId, fitId] = await importAll(page, [clip, fit])
  await page.evaluate((id) => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addVideoLayer('V', id, 0, 4, false)
    usePlayback.getState().setTime(1)
  }, clipId)

  const card = page.locator('[data-clip-card]', { hasText: 'Ride.fit' })
  await card.getByRole('button', { name: '＋ Playhead' }).click()
  await expect.poll(async () => (await layers(page)).length).toBe(2)
  const w = await workout(page)
  const video = (await layers(page)).find((l) => l.id === 'V')!
  // The clip's window, at real time, showing ride 30–34 s; linked to the clip.
  expect([w.startSec, w.endSec, w.content.inSec, w.content.outSec, w.content.speed]).toEqual([0, 4, 30, 34, 1])
  expect(w.linkGroupId).toBeTruthy()
  expect(w.linkGroupId).toBe(video.linkGroupId)
  // At timeline 1 s the readout shows ride 31 s: loopRide's power is 150 + (s % 10) × 10.
  await expect(page.getByTestId('workout-layer').locator('text', { hasText: /^160$/ })).toHaveCount(1)
  // Linked: its speed and length are locked, like Start/End on any linked tile.
  await expect(page.getByRole('spinbutton').first()).toBeDisabled()

  // Undo, then DROP the card on the timeline at 2 s: over the clip, it syncs the same way.
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await layers(page)).length).toBe(1)
  const pps = await page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)
  const scroll = page.getByTestId('timeline-scroll')
  const b = (await scroll.boundingBox())!
  const dt = await page.evaluateHandle((assetId) => {
    const d = new DataTransfer()
    d.setData('application/x-reel-asset', assetId)
    return d
  }, fitId)
  const at = { clientX: b.x + 2 * pps, clientY: b.y + 40 }
  await scroll.dispatchEvent('dragenter', { dataTransfer: dt, ...at })
  await scroll.dispatchEvent('dragover', { dataTransfer: dt, ...at })
  await scroll.dispatchEvent('drop', { dataTransfer: dt, ...at })
  await expect.poll(async () => (await layers(page)).length).toBe(2)
  const dropped = await workout(page)
  expect([dropped.startSec, dropped.content.inSec, dropped.content.outSec, dropped.content.speed]).toEqual([
    0, 30, 34, 1
  ])
  expect(dropped.linkGroupId).toBeTruthy()
  expect(dropped.linkGroupId).toBe((await layers(page)).find((l) => l.id === 'V')!.linkGroupId)
})

test('a metric the file has no data for is greyed out; a stale cached recording is decoded again', async ({
  appPage: page,
  scratchDir,
  projectsDir
}) => {
  const fit = join(scratchDir, 'Run no power.fit')
  writeFileSync(
    fit,
    buildFitFile({ sport: 'running', samples: loopRide(60).map(({ powerW: _p, ...s }) => ({ ...s, speedMps: 3.5 })) })
  )
  const [id] = await importAll(page, [fit])
  // A cache from another parser version (the overlay hasn't read it yet).
  const cached = join(projectsDir, 'E2E', 'cache', id, 'workout.json')
  writeFileSync(cached, JSON.stringify({ version: 0, t: [] }))
  // ＋ Playhead with no footage there: the whole recording, as ＋ End.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(3))
  await page
    .locator('[data-clip-card]', { hasText: 'Run no power.fit' })
    .getByRole('button', { name: '＋ Playhead' })
    .click()
  await expect.poll(async () => (await layers(page)).length).toBe(1)
  const w = await workout(page)
  expect([w.startSec, w.content.inSec, w.content.outSec]).toEqual([3, 0, 59])
  expect(w.endSec).toBeCloseTo(11, 6)
  const power = page.getByTestId('workout-metric-power')
  await expect(power.getByRole('checkbox')).toBeDisabled()
  await expect(power).toContainText('This file has no power.')
  // A run reads its speed as pace — drawn from the recording decoded again,
  // which replaced the stale cache.
  await expect(page.getByTestId('workout-layer').locator('text', { hasText: /^\/MI$/ })).toHaveCount(1)
  const rebuilt = JSON.parse(readFileSync(cached, 'utf8')) as { version: number; t: number[] }
  expect(rebuilt.version).toBeGreaterThan(0)
  expect(rebuilt.t).toHaveLength(60)
})
