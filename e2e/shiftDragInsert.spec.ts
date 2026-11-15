/**
 * Shift-drag inserts an existing tile (#215): while Shift is held during a
 * tile drag the insert caret shows on the seam under the pointer, and
 * releasing there lifts the dragged set (its whole link group) out, closes the
 * hole it left and inserts it at the seam — ONE undo step. A plain drag, and a
 * Shift-drag released away from a seam, are the ordinary move. The rules are
 * pinned in lib/ripple.test.ts (`moveToSeam`); this is the real pointer, the
 * real Shift key and Ctrl+Z.
 *
 * ARRANGE via store actions, ACT with real pointer / key events, ASSERT on the
 * store and the DOM.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

/** px per second of the timeline (persisted zoom; 48 on a fresh profile). */
const pps = (page: Page): Promise<number> => page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)

/** Three clips end to end, each with its linked sound; a script line on the second. */
async function arrangeCut(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    const s = useProject.getState()
    s.addVideoLayer('V1', 'no-such-media', 0, 4, true)
    s.addVideoLayer('V2', 'no-such-media', 4, 2, true)
    s.addVideoLayer('V3', 'no-such-media', 6, 4, true)
    s.addScriptLine(5)
    useUi.getState().clearSelection()
  })
  await expect(page.getByTestId('tile-layer-V3')).toBeVisible()
}

interface Snapshot {
  /** Each clip's start, and its linked sound's as `<clip id>.audio`. */
  starts: Record<string, number>
  script: (number | null)[]
  past: number
  doc: string
}

const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    const p = s.project!
    const starts: Record<string, number> = {}
    for (const l of p.layers) starts[l.id] = l.startSec
    for (const a of p.audioClips) {
      starts[`${p.layers.find((l) => l.linkGroupId === a.linkGroupId)!.id}.audio`] = a.startSec
    }
    return { starts, script: p.script.map((l) => l.atSec), past: s.past.length, doc: JSON.stringify(p) }
  })

/** Where the timeline's 0 s is on the page, and the vertical middle of the Clips lane. */
async function origin(page: Page): Promise<{ x0: number; y: number }> {
  const b = (await page.getByTestId('tile-layer-V1').boundingBox())!
  const start = await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0].startSec)
  return { x0: b.x - start * (await pps(page)), y: b.y + b.height / 2 }
}

/**
 * Press the middle of tile `id`, drag the pointer to page x `toX` (holding
 * Shift from just after the press when `shift`), and release. Returns whether
 * the insert caret was showing just before the release, and where (page x).
 */
async function dragTile(page: Page, id: string, toX: number, shift: boolean): Promise<number | null> {
  const b = (await page.getByTestId(`tile-layer-${id}`).boundingBox())!
  const y = b.y + b.height / 2
  await page.mouse.move(b.x + b.width / 2, y)
  await page.mouse.down()
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.move(toX, y, { steps: 10 })
  const caret = page.getByTestId('insert-caret')
  const box = (await caret.count()) ? await caret.boundingBox() : null
  await page.mouse.up()
  if (shift) await page.keyboard.up('Shift')
  await expect(caret).toHaveCount(0) // the release always clears it
  return box ? box.x + box.width / 2 : null
}

test('Shift-drag onto the timeline start moves a clip to the front, closing the hole it left', async ({
  appPage: page
}) => {
  await arrangeCut(page)
  const before = await snapshot(page)
  const { x0 } = await origin(page)

  const caretX = await dragTile(page, 'V2', x0 + 3, true)
  expect(caretX).not.toBeNull()
  expect(Math.abs(caretX! - x0)).toBeLessThan(2) // the caret sat on the start

  // V1 V2 V3 → V2 V1 V3: the clip and its sound lead, the first clip follows,
  // the third never moves; the script line pinned on V2 went with it.
  const after = await snapshot(page)
  expect(after.starts).toEqual({ V2: 0, 'V2.audio': 0, V1: 2, 'V1.audio': 2, V3: 6, 'V3.audio': 6 })
  expect(after.script).toEqual([1])
  expect(after.past).toBe(before.past + 1)

  await page.keyboard.press('Control+z')
  expect((await snapshot(page)).doc).toBe(before.doc)
})

test('Shift-drag onto a later seam moves a clip back in the order', async ({ appPage: page }) => {
  await arrangeCut(page)
  const before = await snapshot(page)
  const { x0 } = await origin(page)
  const scale = await pps(page)

  // The seam at 6 s, where the second clip ends and the third begins.
  const caretX = await dragTile(page, 'V1', x0 + 6 * scale - 3, true)
  expect(caretX).not.toBeNull()
  expect(Math.abs(caretX! - (x0 + 6 * scale))).toBeLessThan(2)

  // V1 V2 V3 → V2 V1 V3, reached from the other side.
  const after = await snapshot(page)
  expect(after.starts).toEqual({ V2: 0, 'V2.audio': 0, V1: 2, 'V1.audio': 2, V3: 6, 'V3.audio': 6 })
  expect(after.past).toBe(before.past + 1)

  await page.keyboard.press('Control+z')
  expect((await snapshot(page)).doc).toBe(before.doc)
})

test('a Shift-drag released away from a seam is the ordinary move', async ({ appPage: page }) => {
  await arrangeCut(page)
  const before = await snapshot(page)
  const { x0 } = await origin(page)
  const scale = await pps(page)

  // Grabbed at its middle (8 s) and dragged 3 s right: past the end of the cut.
  expect(await dragTile(page, 'V3', x0 + 11 * scale, true)).toBeNull()
  const after = await snapshot(page)
  expect(after.starts.V3).toBeCloseTo(9, 1)
  expect(after.starts['V3.audio']).toBe(after.starts.V3)
  for (const id of ['V1', 'V1.audio', 'V2', 'V2.audio']) expect(after.starts[id]).toBe(before.starts[id])
  expect(after.script).toEqual(before.script)
  expect(after.past).toBe(before.past + 1)
})

test('a plain drag onto a seam is the ordinary move: no caret, nothing else moves', async ({ appPage: page }) => {
  await arrangeCut(page)
  const before = await snapshot(page)
  const { x0 } = await origin(page)
  const scale = await pps(page)

  // The pointer ends on the seam at 4 s (first clip | second clip).
  expect(await dragTile(page, 'V3', x0 + 4 * scale + 2, false)).toBeNull()
  const after = await snapshot(page)
  expect(after.starts.V3).toBeCloseTo(2, 1) // dragged 4 s left, on top of the others
  expect(after.starts['V3.audio']).toBe(after.starts.V3)
  for (const id of ['V1', 'V1.audio', 'V2', 'V2.audio']) expect(after.starts[id]).toBe(before.starts[id])
  expect(after.script).toEqual(before.script)
})
