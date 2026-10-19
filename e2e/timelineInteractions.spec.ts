/**
 * The Timeline interactions docs/TIMELINE.md listed as MANUAL smoke tests,
 * automated before Timeline.tsx is refactored (CLAUDE.md "Don't let untested
 * behavior get refactored away"): left-edge trims, caption and audio block
 * moves + trims, scrubbing, Ctrl+wheel zoom anchored at the cursor, dropping a
 * library clip, the gutter following a vertical scroll, lane resize by the
 * bubble and by the bottom handle, collapse / expand, the caption bubble
 * selecting the lane style, and lane sizes + zoom surviving a reload.
 *
 * ARRANGE via store actions, ACT with real pointer / wheel / drag events,
 * ASSERT on the store, the DOM and localStorage.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

/** px per second of the timeline (persisted zoom; 48 on a fresh profile). */
const pps = (page: Page): Promise<number> => page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)

/** Press at the centre of `el`, move by (dx, dy) in steps, release. */
async function drag(page: Page, el: Locator, dx: number, dy = 0): Promise<void> {
  // Lanes below the panel's visible height are scrolled off: a press at their
  // box would land on whatever is drawn there (the status bar), not the tile.
  await el.scrollIntoViewIfNeeded()
  const b = (await el.boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 8 })
  await page.mouse.up()
}

const edge = (tile: Locator, side: 'left' | 'right'): Locator =>
  side === 'left' ? tile.locator('div.cursor-ew-resize').first() : tile.locator('div.cursor-ew-resize').last()

const store = <T>(page: Page, fn: () => T): Promise<T> => page.evaluate(fn)

test('a video clip trimmed from its LEFT edge keeps its end; the source in-point follows', async ({
  appPage: page
}) => {
  await page.evaluate(() => window.__reelStores.useProject.getState().addVideoLayer('V', 'no-such-media', 2, 6, false))
  const scale = await pps(page)
  const tile = page.getByTestId('tile-layer-V')
  await expect(tile).toBeVisible()
  await drag(page, edge(tile, 'left'), scale)
  const l = await store(page, () => {
    const v = window.__reelStores.useProject.getState().project!.layers[0]
    return { start: v.startSec, end: v.endSec, inSec: (v.content as { inSec: number }).inSec }
  })
  expect(l.start).toBeCloseTo(3, 0)
  expect(l.end).toBeCloseTo(8, 5)
  expect(l.inSec).toBeCloseTo(l.start - 2, 5)
})

test('a caption tile moves, and trims from either edge', async ({ appPage: page }) => {
  await page.evaluate(() =>
    window.__reelStores.useProject
      .getState()
      .addCaption({ id: 'C', startSec: 2, endSec: 5, text: 'hello there', words: [], enabled: true })
  )
  const scale = await pps(page)
  const tile = page.getByTestId('tile-caption-C')
  await expect(tile).toBeVisible()
  const seg = (): Promise<{ startSec: number; endSec: number }> =>
    store(page, () => {
      const s = window.__reelStores.useProject.getState().project!.captions.segments[0]
      return { startSec: s.startSec, endSec: s.endSec }
    })

  // Move by 1s: both edges shift, the length stays.
  await drag(page, tile.locator('span').first(), scale)
  let s = await seg()
  expect(s.startSec).toBeCloseTo(3, 0)
  expect(s.endSec - s.startSec).toBeCloseTo(3, 5)

  // Trim the right edge 1s left, then the left edge 1s right.
  await drag(page, edge(tile, 'right'), -scale)
  s = await seg()
  expect(s.endSec).toBeCloseTo(5, 0)
  await drag(page, edge(tile, 'left'), scale)
  s = await seg()
  expect(s.startSec).toBeCloseTo(4, 0)
  expect(s.endSec).toBeCloseTo(5, 0)
})

test('an audio tile moves, and trims from either edge (the source window follows)', async ({ appPage: page }) => {
  await page.evaluate(() =>
    window.__reelStores.useProject.getState().addAudioClip({
      id: 'A',
      mediaId: 'no-such-media',
      kind: 'music',
      startSec: 1,
      inSec: 0,
      outSec: 6,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false
    })
  )
  const scale = await pps(page)
  const tile = page.getByTestId('tile-audio-A')
  await expect(tile).toBeVisible()
  const clip = (): Promise<{ startSec: number; inSec: number; outSec: number }> =>
    store(page, () => {
      const a = window.__reelStores.useProject.getState().project!.audioClips[0]
      return { startSec: a.startSec, inSec: a.inSec, outSec: a.outSec }
    })

  await drag(page, tile.locator('span').first(), scale)
  let a = await clip()
  expect(a.startSec).toBeCloseTo(2, 0)
  expect([a.inSec, a.outSec]).toEqual([0, 6])

  await drag(page, edge(tile, 'right'), -scale)
  a = await clip()
  expect(a.outSec).toBeCloseTo(5, 0)

  await drag(page, edge(tile, 'left'), scale)
  a = await clip()
  expect(a.startSec).toBeCloseTo(3, 0)
  expect(a.inSec).toBeCloseTo(1, 0)
  expect(a.outSec).toBeCloseTo(5, 0)
})

test('pressing the track scrubs the playhead there, and it follows a drag', async ({ appPage: page }) => {
  await page.evaluate(() => window.__reelStores.useProject.getState().addVideoLayer('V', 'no-such-media', 0, 20, false))
  const scale = await pps(page)
  const scroll = page.getByTestId('timeline-scroll')
  const b = (await scroll.boundingBox())!
  // The ruler band at the top of the track (above the lanes).
  const y = b.y + 8
  await page.mouse.move(b.x + 4 * scale, y)
  await page.mouse.down()
  await expect.poll(() => store(page, () => window.__reelStores.usePlayback.getState().time)).toBeCloseTo(4, 0)
  await page.mouse.move(b.x + 7 * scale, y, { steps: 5 })
  await page.mouse.up()
  expect(await store(page, () => window.__reelStores.usePlayback.getState().time)).toBeCloseTo(7, 0)
  expect(await store(page, () => window.__reelStores.usePlayback.getState().playing)).toBe(false)
})

test('Ctrl+wheel zooms the timeline, anchored at the cursor', async ({ appPage: page }) => {
  await page.evaluate(() =>
    window.__reelStores.useProject.getState().addVideoLayer('V', 'no-such-media', 0, 120, false)
  )
  const scroll = page.getByTestId('timeline-scroll')
  const b = (await scroll.boundingBox())!
  const cursorX = b.x + b.width / 2
  const timeAtCursor = async (): Promise<number> =>
    page.evaluate(
      ([cx, left]) => {
        const el = document.querySelector('[data-testid="timeline-scroll"]') as HTMLElement
        return (el.scrollLeft + (cx - left)) / (Number(localStorage.getItem('timelinePps')) || 48)
      },
      [cursorX, b.x] as const
    )
  const before = await pps(page)
  const t0 = await timeAtCursor()
  await page.mouse.move(cursorX, b.y + b.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100) // wheel up = zoom in
  await page.keyboard.up('Control')
  await expect.poll(() => pps(page)).toBeGreaterThan(before)
  // The second under the cursor stays under it (within a few px of rounding).
  await expect.poll(timeAtCursor).toBeCloseTo(t0, 0)
})

test('the lane gutter follows the track when it scrolls vertically', async ({ appPage: page }) => {
  // Enough overlapping clips to stack rows past the panel's height.
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    for (let i = 0; i < 14; i++) s.addVideoLayer(`V${i}`, 'no-such-media', 0, 5, false)
  })
  const scroll = page.getByTestId('timeline-scroll')
  await expect(page.getByTestId('tile-layer-V13')).toBeAttached()
  const scrolled = await scroll.evaluate((el) => {
    el.scrollTop = 60
    return el.scrollTop
  })
  expect(scrolled).toBeGreaterThan(0)
  await expect(page.getByTestId('timeline-gutter')).toHaveCSS('transform', `matrix(1, 0, 0, 1, 0, ${-scrolled})`)
})

test('a lane resizes from its header bubble and from its bottom handle, and blocks scale with it', async ({
  appPage: page
}) => {
  await page.evaluate(() => window.__reelStores.useProject.getState().addVideoLayer('V', 'no-such-media', 0, 5, false))
  const tile = page.getByTestId('tile-layer-V')
  const h0 = (await tile.boundingBox())!.height

  await drag(page, page.getByTestId('lane-clips').locator('span').last(), 0, 20)
  const h1 = (await tile.boundingBox())!.height
  expect(h1).toBeGreaterThan(h0 + 10)

  await drag(page, page.getByTestId('lane-resize-clips'), 0, -12)
  const h2 = (await tile.boundingBox())!.height
  expect(h2).toBeLessThan(h1 - 6)

  const view = await page.evaluate(() => JSON.parse(localStorage.getItem('timelineView') ?? '{}'))
  expect(view.clips.rowH).toBeGreaterThan(0)
})

test('a lane collapses and expands from its chevron and by double-clicking its bubble', async ({ appPage: page }) => {
  await page.evaluate(() => window.__reelStores.useProject.getState().addVideoLayer('V', 'no-such-media', 0, 5, false))
  const lane = page.getByTestId('lane-clips')
  const tile = page.getByTestId('tile-layer-V')
  await expect(tile).toBeVisible()

  await lane.getByTitle('Collapse lane').click()
  await expect(tile).toHaveCount(0)
  await expect(page.getByTestId('lane-resize-clips')).toHaveCount(0)
  await lane.getByTitle('Expand lane').click()
  await expect(tile).toBeVisible()

  await lane.locator('span').last().dblclick()
  await expect(tile).toHaveCount(0)
  await lane.locator('span').last().dblclick()
  await expect(tile).toBeVisible()
})

test('the Captions lane bubble selects the lane-wide caption style', async ({ appPage: page }) => {
  await page.evaluate(() =>
    window.__reelStores.useProject
      .getState()
      .addCaption({ id: 'C', startSec: 0, endSec: 2, text: 'hi', words: [], enabled: true })
  )
  await page.getByTestId('lane-caption').locator('span').nth(1).click()
  expect(await store(page, () => window.__reelStores.useUi.getState().captionsGlobalSelected)).toBe(true)
})

test('lane sizes and zoom survive a reload', async ({ appPage: page }) => {
  await page.evaluate(() => window.__reelStores.useProject.getState().addVideoLayer('V', 'no-such-media', 0, 5, false))
  await page.getByTitle('Zoom in').click()
  const zoomed = await pps(page)
  await drag(page, page.getByTestId('lane-clips').locator('span').last(), 0, 24)
  const tileH = (await page.getByTestId('tile-layer-V').boundingBox())!.height
  const tileW = (await page.getByTestId('tile-layer-V').boundingBox())!.width

  // The edit must be in the working copy the reload restores (autosave is debounced).
  await page.evaluate(() => window.__reelStores.useProject.getState().flushSave())
  await page.reload()
  await expect(page.getByTestId('tile-layer-V')).toBeVisible()
  expect(await pps(page)).toBe(zoomed)
  const after = (await page.getByTestId('tile-layer-V').boundingBox())!
  expect(after.height).toBeCloseTo(tileH, 0)
  expect(after.width).toBeCloseTo(tileW, 0)
})

test('dropping a library clip on the track adds it at the drop point', async ({ appPage: page }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(60_000)
  const mp4 = join(mkdtempSync(join(tmpdir(), 'reel-drop-')), 'drop.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=3:size=270x480:rate=30',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    mp4
  ])
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    await window.api.ensureProxy(asset.id)
    return asset.id
  }, mp4)
  // The Library has refetched once its card can be added (proxy ready).
  await expect(page.getByTitle('Add clip at the playhead')).toHaveCSS('pointer-events', 'auto')

  const scale = await pps(page)
  const scroll = page.getByTestId('timeline-scroll')
  const b = (await scroll.boundingBox())!
  const dt = await page.evaluateHandle((assetId) => {
    const d = new DataTransfer()
    d.setData('application/x-reel-asset', assetId)
    return d
  }, id)
  const at = { clientX: b.x + 6 * scale, clientY: b.y + 40 }
  await scroll.dispatchEvent('dragenter', { dataTransfer: dt, ...at })
  await scroll.dispatchEvent('dragover', { dataTransfer: dt, ...at })
  await scroll.dispatchEvent('drop', { dataTransfer: dt, ...at })

  await expect.poll(() => store(page, () => window.__reelStores.useProject.getState().project!.layers.length)).toBe(1)
  const layer = await store(page, () => window.__reelStores.useProject.getState().project!.layers[0])
  expect(layer.content.kind).toBe('video')
  expect(layer.startSec).toBeCloseTo(6, 0)
})

test('Space toggles playback', async ({ appPage: page }) => {
  await page.evaluate(() => window.__reelStores.useProject.getState().addVideoLayer('V', 'no-such-media', 0, 20, false))
  const playing = (): Promise<boolean> => store(page, () => window.__reelStores.usePlayback.getState().playing)
  await page.getByTestId('timeline-scroll').click({ position: { x: 4, y: 8 } }) // focus the app, not a field
  await page.keyboard.press('Space')
  await expect.poll(playing).toBe(true)
  await page.keyboard.press('Space')
  await expect.poll(playing).toBe(false)
})
