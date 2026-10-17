/**
 * Playhead follow modes: while playing, the timeline scroll optionally tracks
 * the playhead — Off (stay put), Page (jump a page when the playhead exits the
 * view), Center (playhead pinned to the middle). The mode is a view preference
 * toggled from the timeline toolbar and persisted in localStorage.
 */
import { test, expect } from './fixtures'

/** ARRANGE: a long text layer so the track is much wider than the viewport. */
async function arrangeLongTimeline(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject, usePlayback } = window.__reelStores
    useProject.getState().addLayer({
      id: 'follow-text',
      hidden: false,
      startSec: 0,
      endSec: 600,
      x: 540,
      y: 600,
      scale: 1,
      content: {
        kind: 'text',
        text: 'follow me',
        fontFamily: 'montserrat-extrabold',
        fontSizePx: 76,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 }
      }
    })
    usePlayback.getState().setTime(0)
  })
}

/** One atomic snapshot of playback time vs. track scroll (avoids racing the
 *  wall-clock master that advances `time` every frame while playing). */
function scrollSnapshot(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="timeline-scroll"]') as HTMLElement
    const time = window.__reelStores.usePlayback.getState().time
    const pps = Number(localStorage.getItem('timelinePps')) || 48
    return {
      time,
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      playheadX: time * pps
    }
  })
}

test('centered follow keeps the playhead mid-view; Off leaves the scroll alone', async ({ appPage: page }) => {
  await arrangeLongTimeline(page)

  // ACT: pick Center with a real click, then play from 100s.
  await page.getByRole('button', { name: 'Center', exact: true }).click()
  await page.evaluate(() => {
    const { usePlayback } = window.__reelStores
    usePlayback.getState().setTime(100)
    usePlayback.getState().setPlaying(true)
  })
  await page.waitForTimeout(400)

  // ASSERT: playhead sits at (about) the middle of the viewport.
  const s = await scrollSnapshot(page)
  expect(Math.abs(s.playheadX - s.scrollLeft - s.clientWidth / 2)).toBeLessThan(40)

  // Mode persists as a view preference.
  expect(await page.evaluate(() => localStorage.getItem('timelineFollow'))).toBe('centered')

  // ACT: switch to Off — the scroll must stop tracking while time advances.
  await page.getByRole('button', { name: 'Off', exact: true }).click()
  const before = await scrollSnapshot(page)
  await page.waitForTimeout(400)
  const after = await scrollSnapshot(page)
  expect(after.time).toBeGreaterThan(before.time) // still playing
  expect(after.scrollLeft).toBe(before.scrollLeft) // but the view stayed put
})

test('page follow jumps the view when the playhead exits it', async ({ appPage: page }) => {
  await arrangeLongTimeline(page)
  await page.getByRole('button', { name: 'Page', exact: true }).click()

  // Playhead far right of the initial view (scrollLeft 0) → the next playback
  // tick must page the view forward to put the playhead back at the left edge.
  await page.evaluate(() => {
    const { usePlayback } = window.__reelStores
    usePlayback.getState().setTime(200)
    usePlayback.getState().setPlaying(true)
  })
  await page.waitForTimeout(300)
  const s = await scrollSnapshot(page)
  // In view, near the left edge (it advanced a little since the jump).
  expect(s.playheadX).toBeGreaterThanOrEqual(s.scrollLeft)
  expect(s.playheadX - s.scrollLeft).toBeLessThan(s.clientWidth / 3)

  // While the playhead stays inside the view, Page mode must NOT creep-scroll.
  const before = await scrollSnapshot(page)
  await page.waitForTimeout(300)
  const after = await scrollSnapshot(page)
  expect(after.scrollLeft).toBe(before.scrollLeft)
})
