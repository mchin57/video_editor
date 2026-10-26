/**
 * The workout graph window (docs/WORKOUT-OVERLAY.md "The graph window"):
 *  - Inspector ▸ Graph… opens the recording's lines with the tile as a range;
 *    lines toggle, the axis switches to distance, the wheel zooms down to
 *    exactly 1 s across the width and Fit shows it all again;
 *  - a press puts the cursor there; S splits the range under it, Del deletes
 *    the selected range, Ctrl+Z undoes inside the window — and none of those
 *    keys reach the editor behind it; a handle drag trims a range;
 *  - Save swaps the ranges onto the timeline as ONE undo step; Cancel changes
 *    nothing;
 *  - a range linked to a clip (a synced overlay) is shown but locked.
 *
 * ARRANGE real FIT files (Garmin's encoder), ACT with real clicks, wheel,
 * drags and keys, ASSERT on the dialog's DOM and the store.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Layer, WorkoutContent } from '../src/shared/project'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'
import { buildFitFile, loopRide } from '../src/main/services/__fixtures__/fitFile'

const importAll = (page: Page, paths: string[]): Promise<string[]> =>
  page.evaluate(async (paths) => {
    const assets = await window.api.importPaths(paths)
    window.__reelStores.useProject.getState().addMedia(assets.map((a) => a.id))
    return assets.map((a) => a.id)
  }, paths)

/** The workout tiles on the timeline: [startSec, inSec, outSec]. */
const windows = (page: Page): Promise<number[][]> =>
  page.evaluate(() =>
    window.__reelStores.useProject
      .getState()
      .project!.layers.filter((l: Layer) => l.content.kind === 'workout')
      .map((l: Layer) => {
        const c = l.content as WorkoutContent
        return [l.startSec, c.inSec, c.outSec]
      })
  )

const view = async (page: Page): Promise<{ x0: number; x1: number }> => {
  const plot = page.getByTestId('graph-plot')
  return { x0: Number(await plot.getAttribute('data-x0')), x1: Number(await plot.getAttribute('data-x1')) }
}

test('the graph zooms to 1 s; S, Del and handles edit ranges; Save is one undo step, Cancel nothing', async ({
  appPage: page,
  scratchDir
}) => {
  const fit = join(scratchDir, 'Loop Ride.fit')
  writeFileSync(fit, buildFitFile({ samples: loopRide(600) }))
  await importAll(page, [fit])
  await page.locator('[data-clip-card]', { hasText: 'Loop Ride.fit' }).getByRole('button', { name: '＋ End' }).click()
  await expect.poll(async () => (await windows(page)).length).toBe(1)
  // The editor's playhead inside the tile, with the tile selected: an S that
  // reached the editor would split it there.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(3))
  const playhead = (): Promise<number> => page.evaluate(() => window.__reelStores.usePlayback.getState().time)

  await page.getByTestId('workout-open-graph').click()
  const dialog = page.getByTestId('workout-graph-dialog')
  await expect(dialog).toBeVisible()
  for (const line of ['power', 'altitude', 'speed', 'heartRate']) {
    await expect(page.getByTestId(`graph-line-${line}`)).toHaveCount(1)
  }
  await expect(page.getByTestId('graph-range-0')).toHaveAttribute('data-out', '599')
  // Lines toggle.
  await page.getByTestId('graph-toggle-heartRate').getByRole('checkbox').uncheck()
  await expect(page.getByTestId('graph-line-heartRate')).toHaveCount(0)

  // The wheel zooms about the pointer, all the way down to 1 s, and no further.
  const plot = page.getByTestId('graph-plot')
  const b = (await plot.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -400)
  await expect
    .poll(async () => {
      const v = await view(page)
      return v.x1 - v.x0
    })
    .toBeCloseTo(1, 6)
  const tight = await view(page)
  expect(tight.x0).toBeGreaterThan(290)
  expect(tight.x1).toBeLessThan(310)
  // Shift+wheel pans, keeping the 1 s span; so does the bar's thumb.
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0, 300)
  await page.keyboard.up('Shift')
  await expect.poll(async () => (await view(page)).x0).toBeGreaterThan(tight.x0)
  const panned = await view(page)
  expect(panned.x1 - panned.x0).toBeCloseTo(1, 6)
  await page.getByTestId('graph-fit').click()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.wheel(0, -500)
  await expect.poll(async () => (await view(page)).x1).toBeLessThan(599)
  const zoomed = await view(page)
  const thumb = (await page.getByTestId('graph-thumb').boundingBox())!
  const bar = (await page.getByTestId('graph-scrollbar').boundingBox())!
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
  await page.mouse.down()
  await page.mouse.move(thumb.x + thumb.width / 2 + bar.width / 10, thumb.y + thumb.height / 2, { steps: 3 })
  await page.mouse.up()
  const slid = await view(page)
  expect(slid.x0 - zoomed.x0).toBeCloseTo(59.9, 0)
  expect(slid.x1 - slid.x0).toBeCloseTo(zoomed.x1 - zoomed.x0, 6)
  await page.getByTestId('graph-fit').click()
  expect(await view(page)).toEqual({ x0: 0, x1: 599 })

  // Distance axis, and back.
  await page.getByTestId('graph-axis-distance').click()
  await expect(plot).toHaveAttribute('data-axis', 'distance')
  await expect(plot.locator('text', { hasText: / mi$/ }).first()).toBeVisible()
  await page.getByTestId('graph-axis-time').click()
  await expect(plot).toHaveAttribute('data-axis', 'time')

  // Cursor half way; S splits there. Del deletes the selected (right) half;
  // Ctrl+Z brings it back. None of this reaches the timeline yet.
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
  const cursor = Number(await page.getByTestId('graph-cursor').getAttribute('data-sec'))
  expect(cursor).toBeGreaterThan(280)
  expect(cursor).toBeLessThan(320)
  // ←/→ move it 1 s, Shift 10 s — even with a line toggle (a checkbox) focused.
  await page.getByTestId('graph-toggle-heartRate').getByRole('checkbox').check()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('ArrowLeft')
  const cursorAt = (): Promise<number> =>
    page
      .getByTestId('graph-cursor')
      .getAttribute('data-sec')
      .then((v) => Number(v))
  expect(await cursorAt()).toBeCloseTo(cursor + 10, 6)
  await page.keyboard.press('Shift+ArrowLeft')
  expect(await cursorAt()).toBeCloseTo(cursor, 6)
  await page.keyboard.press('s')
  await expect(page.getByTestId('graph-range-1')).toHaveCount(1)
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('graph-range-1')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('graph-range-1')).toHaveCount(1)
  await page.keyboard.press('Control+y') // redo: deleted again
  await expect(page.getByTestId('graph-range-1')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+z') // nothing left to redo
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('graph-range-1')).toHaveCount(1)
  // A press selects the range under it.
  await page.mouse.click(b.x + b.width * 0.2, b.y + b.height / 2)
  await expect(page.getByTestId('graph-range-0')).toHaveAttribute('data-selected', 'true')
  // The window's speed field: typing "10" is ONE undo step, and Enter takes it.
  const speed = page.getByTestId('graph-speed').locator('input')
  await speed.fill('10')
  await speed.press('Enter')
  await expect(page.getByTestId('graph-range-0')).toContainText('10×')
  await page.getByTestId('graph-fit').focus()
  await page.keyboard.press('Control+z')
  // Back to the speed before the typing, not to "1": one step, not one per key.
  await expect(page.getByTestId('graph-range-0')).toContainText('75×')
  // Nothing reached the timeline or the editor's playhead.
  expect(await windows(page)).toEqual([[0, 0, 599]])
  expect(await playhead()).toBe(3)

  // Cancel: nothing changes.
  await page.getByTestId('graph-cancel').click()
  await expect(dialog).toHaveCount(0)
  expect(await windows(page)).toEqual([[0, 0, 599]])

  // Again: split, then trim the first range's end back by a sixth of the plot.
  await page.getByTestId('workout-open-graph').click()
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
  await page.getByTestId('graph-split').click()
  const handle = page.getByTestId('graph-handle-out-0')
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2 - b.width / 12, hb.y + hb.height / 2, { steps: 3 })
  await page.mouse.move(hb.x + hb.width / 2 - b.width / 6, hb.y + hb.height / 2, { steps: 3 })
  await page.mouse.up()
  const trimmedOut = Number(await page.getByTestId('graph-range-0').getAttribute('data-out'))
  expect(Math.abs(trimmedOut - (cursor - 599 / 6))).toBeLessThan(15)

  await page.getByTestId('graph-save').click()
  await expect(dialog).toHaveCount(0)
  const saved = await windows(page)
  expect(saved).toHaveLength(2)
  expect(saved[0][1]).toBe(0)
  expect(saved[0][2]).toBeCloseTo(trimmedOut, 6)
  expect(saved[1][1]).toBeCloseTo(cursor, 6)
  expect(saved[1][2]).toBe(599)
  // The right half starts where the split put it on the timeline (cursor ÷ speed).
  expect(saved[1][0]).toBeCloseTo(cursor / (599 / 8), 6)
  // ONE undo step for the whole edit.
  await page.keyboard.press('Control+z')
  await expect.poll(() => windows(page)).toEqual([[0, 0, 599]])
})

test('a range linked to its clip is shown but locked', async ({ appPage: page, scratchDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
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
  const [clipId] = await importAll(page, [clip, fit])
  await page.evaluate((id) => {
    window.__reelStores.useProject.getState().addVideoLayer('V', id, 0, 4, false)
    window.__reelStores.usePlayback.getState().setTime(1)
  }, clipId)
  await page.locator('[data-clip-card]', { hasText: 'Ride.fit' }).getByRole('button', { name: '＋ Playhead' }).click()
  await expect.poll(() => windows(page)).toEqual([[0, 30, 34]])

  await page.getByTestId('workout-open-graph').click()
  await expect(page.getByTestId('graph-locked')).toContainText('Linked to a clip')
  // Drawn dashed, marked 🔗.
  await expect(page.getByTestId('graph-range-0')).toContainText('🔗')
  await expect(page.getByTestId('graph-range-0').locator('rect').first()).toHaveAttribute('stroke-dasharray', '4 3')
  await expect(page.getByTestId('graph-delete')).toBeDisabled()
  await expect(page.getByTestId('graph-handle-in-0')).toHaveCount(0)
  // A cursor inside it still can't split it.
  const r = (await page.getByTestId('graph-range-0').boundingBox())!
  await page.mouse.click(r.x + r.width / 2, r.y + 60)
  await expect(page.getByTestId('graph-split')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workout-graph-dialog')).toHaveCount(0)
  expect(await windows(page)).toEqual([[0, 30, 34]])
})

test('lines and the distance axis a file has no data for are greyed out; laps and pauses show', async ({
  appPage: page,
  scratchDir
}) => {
  // Power only (an indoor trainer ride): no heart rate, speed, elevation or distance.
  const fit = join(scratchDir, 'Trainer.fit')
  writeFileSync(
    fit,
    buildFitFile({
      samples: Array.from({ length: 300 }, (_, i) => ({ sec: i, powerW: 150 + (i % 20) })),
      laps: [0, 100, 200],
      pauses: [[120, 150]]
    })
  )
  await importAll(page, [fit])
  await page.locator('[data-clip-card]', { hasText: 'Trainer.fit' }).getByRole('button', { name: '＋ End' }).click()
  await page.getByTestId('workout-open-graph').click()
  await expect(page.getByTestId('graph-line-power')).toHaveCount(1)
  for (const line of ['altitude', 'speed', 'heartRate']) {
    await expect(page.getByTestId(`graph-toggle-${line}`).getByRole('checkbox')).toBeDisabled()
    await expect(page.getByTestId(`graph-line-${line}`)).toHaveCount(0)
  }
  await expect(page.getByTestId('graph-axis-distance')).toBeDisabled()
  // Two lap starts after the first, one pause.
  await expect(page.getByTestId('graph-lap')).toHaveCount(2)
  await expect(page.getByTestId('graph-pause')).toHaveCount(1)
})

test('an unreadable recording still closes (Escape or Close), and keys stay inside', async ({
  appPage: page,
  electronApp,
  scratchDir
}) => {
  const fit = join(scratchDir, 'Broken.fit')
  writeFileSync(fit, buildFitFile({ samples: loopRide(60) }))
  await importAll(page, [fit])
  // Main can't read it from here on.
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('media:workout')
    ipcMain.handle('media:workout', () => {
      throw new Error('unreadable')
    })
  })
  await page.locator('[data-clip-card]', { hasText: 'Broken.fit' }).getByRole('button', { name: '＋ End' }).click()
  await expect.poll(async () => (await windows(page)).length).toBe(1)
  await page.getByTestId('workout-open-graph').click()
  await expect(page.getByTestId('graph-status')).toContainText("Couldn't read")
  // Delete doesn't reach the editor's selected tile behind the window.
  await page.keyboard.press('Delete')
  expect(await windows(page)).toHaveLength(1)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workout-graph-dialog')).toHaveCount(0)
  await page.getByTestId('workout-open-graph').click()
  await page.getByTestId('graph-cancel').click()
  await expect(page.getByTestId('workout-graph-dialog')).toHaveCount(0)
})
