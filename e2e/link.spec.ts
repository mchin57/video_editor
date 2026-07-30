/**
 * Linked timeline tiles, end to end: Ctrl-click builds a multi-selection, the
 * Link button ties the tiles together, and from then on they select, move, split
 * and delete as one — with relative offsets preserved. ARRANGE via store actions
 * (timeline math needs no real media), ACT with real pointer/keyboard events,
 * ASSERT on store + DOM.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import type { TimelineItemRef } from '../src/shared/project'

/** A 10s video layer at t=0 plus an audio clip 2s later (6s long), unlinked. */
async function arrangePair(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('L1', 'no-such-media', 0, 10, false)
    useProject.getState().addAudioClip({
      id: 'A1',
      mediaId: 'no-such-audio',
      startSec: 2,
      inSec: 0,
      outSec: 6,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'music'
    })
    useUi.getState().clearSelection()
  })
}

const tiles = (
  page: Page
): Promise<{
  layers: { id: string; startSec: number; endSec: number; gid?: string }[]
  audio: { id: string; startSec: number; inSec: number; outSec: number; gid?: string }[]
}> =>
  page.evaluate(() => {
    const p = window.__reelStores.useProject.getState().project!
    return {
      layers: p.layers.map((l) => ({
        id: l.id,
        startSec: l.startSec,
        endSec: l.endSec,
        gid: l.linkGroupId
      })),
      audio: p.audioClips.map((a) => ({
        id: a.id,
        startSec: a.startSec,
        inSec: a.inSec,
        outSec: a.outSec,
        gid: a.linkGroupId
      }))
    }
  })

const selection = (page: Page): Promise<TimelineItemRef[]> =>
  page.evaluate(() => window.__reelStores.useUi.getState().selection)

/** px per second of the timeline (persisted zoom; 48 on a fresh profile). */
const pps = (page: Page): Promise<number> =>
  page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)

/** Ctrl-click both tiles, then hit Link. */
async function linkPair(page: Page): Promise<void> {
  await page.getByTestId('tile-layer-L1').click({ modifiers: ['Control'] })
  await page.getByTestId('tile-audio-A1').click({ modifiers: ['Control'] })
  expect(await selection(page)).toHaveLength(2)
  await page.getByRole('button', { name: '🔗 Link' }).click()
}

/** Drag a tile horizontally by `seconds`, grabbing its middle. The track is a
 *  short scrollable box, so scroll the tile into view before reading its box —
 *  `page.mouse` does no auto-scrolling and would otherwise press the toolbar. */
async function dragTile(page: Page, testId: string, seconds: number): Promise<void> {
  const scale = await pps(page)
  const tile = page.getByTestId(testId)
  await tile.scrollIntoViewIfNeeded()
  const box = (await tile.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + seconds * scale, y, { steps: 5 })
  await page.mouse.up()
}

test('Ctrl-click + Link makes tiles move as one, keeping their offset', async ({
  appPage: page
}) => {
  await arrangePair(page)
  await linkPair(page)

  const linked = await tiles(page)
  expect(linked.layers[0].gid).toBeTruthy()
  expect(linked.audio[0].gid).toBe(linked.layers[0].gid)

  // Clicking either tile selects the whole group — there is no selecting one.
  await page.getByTestId('tile-audio-A1').click()
  expect(await selection(page)).toEqual([
    { kind: 'layer', id: 'L1' },
    { kind: 'audio', id: 'A1' }
  ])

  // Trimming can't translate across a group, so the edge handles are gone.
  await expect(page.getByTestId('tile-layer-L1').locator('div.cursor-ew-resize')).toHaveCount(0)

  // Drag the layer 3s right: the audio follows by the same delta (offset stays 2s)
  // and neither tile changes length.
  await dragTile(page, 'tile-layer-L1', 3)
  const moved = await tiles(page)
  expect(moved.layers[0].startSec).toBeCloseTo(3, 1)
  expect(moved.layers[0].endSec - moved.layers[0].startSec).toBeCloseTo(10, 1)
  expect(moved.audio[0].startSec).toBeCloseTo(5, 1)
  expect(moved.audio[0].outSec).toBe(6) // trim untouched

  // Dragging the AUDIO tile moves the group too (same delta, back to the start).
  await dragTile(page, 'tile-audio-A1', -3)
  const back = await tiles(page)
  expect(back.layers[0].startSec).toBeCloseTo(0, 1)
  expect(back.audio[0].startSec).toBeCloseTo(2, 1)
})

test('the group clamps at 0 instead of collapsing onto itself', async ({ appPage: page }) => {
  await arrangePair(page)
  await linkPair(page)
  // Move the group right first (so a no-op drag can't pass this test), then drag
  // further left than the earliest member can go.
  await dragTile(page, 'tile-audio-A1', 4)
  expect((await tiles(page)).layers[0].startSec).toBeCloseTo(4, 1)
  await dragTile(page, 'tile-audio-A1', -6)
  const t = await tiles(page)
  expect(t.layers[0].startSec).toBe(0)
  expect(t.audio[0].startSec).toBeCloseTo(2, 5) // offset preserved exactly
})

test('S splits every linked tile the playhead crosses, and only those', async ({
  appPage: page
}) => {
  await arrangePair(page)
  await linkPair(page)

  // Playhead at 5s: inside the layer (0..10) AND inside the audio (2..8).
  await page.getByTestId('tile-layer-L1').click()
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(5))
  await page.keyboard.press('s')

  const cut = await tiles(page)
  expect(cut.layers.map((l) => [l.startSec, l.endSec])).toEqual([
    [0, 5],
    [5, 10]
  ])
  expect(cut.audio).toHaveLength(2)
  expect(cut.audio[0]).toMatchObject({ startSec: 2, inSec: 0, outSec: 3 })
  expect(cut.audio[1]).toMatchObject({ startSec: 5, inSec: 3, outSec: 6 })
  // Each side is its own group now, so the halves can be edited independently.
  expect(cut.layers[0].gid).toBe(cut.audio[0].gid)
  expect(cut.layers[1].gid).toBe(cut.audio[1].gid)
  expect(cut.layers[0].gid).not.toBe(cut.layers[1].gid)
})

test('a linked tile the playhead misses is left whole', async ({ appPage: page }) => {
  await arrangePair(page)
  await linkPair(page)

  // Playhead at 1s: inside the layer, but before the audio clip starts (2s).
  await page.getByTestId('tile-layer-L1').click()
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1))
  await page.getByRole('button', { name: '✂ Split' }).click()

  const cut = await tiles(page)
  expect(cut.layers.map((l) => [l.startSec, l.endSec])).toEqual([
    [0, 1],
    [1, 10]
  ])
  expect(cut.audio).toHaveLength(1)
  expect(cut.audio[0]).toMatchObject({ startSec: 2, inSec: 0, outSec: 6 })
})

/**
 * Regression: a group of a clip + a TEXT tile used to split only the clip —
 * text/image layers and captions had no split op at all, so the group silently
 * cut one member and left the other spanning both halves.
 */
test('a linked text tile splits at the playhead like everything else', async ({
  appPage: page
}) => {
  await page.evaluate(() => {
    window.__reelStores.useProject.getState().addVideoLayer('L1', 'no-such-media', 0, 10, false)
    window.__reelStores.useUi.getState().clearSelection()
  })
  await page.keyboard.press('t') // text layer over 0..3s at the playhead, selected
  const textId = await page.evaluate(
    () =>
      window.__reelStores.useProject
        .getState()
        .project!.layers.find((l) => l.content.kind === 'text')!.id
  )
  // The text tile is already selected, so Ctrl-click only the clip to add it.
  await page.getByTestId('tile-layer-L1').click({ modifiers: ['Control'] })
  await page.getByRole('button', { name: '🔗 Link' }).click()

  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1.5))
  await page.keyboard.press('s')

  const kinds = await page.evaluate(() =>
    window.__reelStores.useProject
      .getState()
      .project!.layers.map((l) => [l.content.kind, l.startSec, l.endSec, l.linkGroupId])
  )
  // Both tiles cut at the playhead, each keeping its own length either side.
  expect(kinds).toEqual([
    ['video', 0, 1.5, kinds[0][3]],
    ['video', 1.5, 10, kinds[1][3]],
    ['text', 0, 1.5, kinds[0][3]],
    ['text', 1.5, 3, kinds[1][3]]
  ])
  expect(kinds[0][3]).toBeTruthy()
  expect(kinds[0][3]).not.toBe(kinds[1][3]) // the two sides are separate groups
  expect(textId).toBeTruthy()
})

test('Unlink hands the tiles back their independence', async ({ appPage: page }) => {
  await arrangePair(page)
  await linkPair(page)

  await page.getByTestId('tile-layer-L1').click()
  await page.getByRole('button', { name: '⛓ Unlink' }).click()
  const unlinked = await tiles(page)
  expect(unlinked.layers[0].gid).toBeUndefined()
  expect(unlinked.audio[0].gid).toBeUndefined()

  // Both tiles are still selected; clicking one (without dragging) narrows the
  // selection back to it, which is what makes them independently draggable again.
  await page.getByTestId('tile-layer-L1').click()
  expect(await selection(page)).toEqual([{ kind: 'layer', id: 'L1' }])

  // Now dragging the layer leaves the audio where it was — and its trim handles
  // are back.
  await expect(page.getByTestId('tile-layer-L1').locator('div.cursor-ew-resize')).toHaveCount(2)
  await dragTile(page, 'tile-layer-L1', 3)
  const moved = await tiles(page)
  expect(moved.layers[0].startSec).toBeCloseTo(3, 1)
  expect(moved.audio[0].startSec).toBe(2)
})

test('Delete removes the whole group in one undo step', async ({ appPage: page }) => {
  await arrangePair(page)
  await linkPair(page)

  await page.getByTestId('tile-audio-A1').click()
  await page.keyboard.press('Delete')
  const gone = await tiles(page)
  expect(gone.layers).toHaveLength(0)
  expect(gone.audio).toHaveLength(0)

  await page.keyboard.press('Control+z')
  const restored = await tiles(page)
  expect(restored.layers).toHaveLength(1)
  expect(restored.audio).toHaveLength(1)
  expect(restored.layers[0].gid).toBe(restored.audio[0].gid)
})
