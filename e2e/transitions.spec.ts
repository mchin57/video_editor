/**
 * Transitions on the real timeline (#64). Selecting two clips that meet and
 * choosing Add transition ▸ Cross dissolve slides the second clip, its linked
 * sound and everything after it left by the length (they overlap by it), with
 * a wedge on the edge; dragging the wedge changes the length (one undo step);
 * a fade at a clip's end comes from the Inspector or the tile's top corner;
 * the preview fades the layer box and shows a dip's plate. The rules are pinned
 * in lib/transitions.test.ts and shared/transitions.test.ts; this is the real
 * right-click, drag, field and Ctrl+Z.
 *
 * ARRANGE via store actions, ACT with real pointer / key events, ASSERT on the
 * store and the DOM.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

/** px per second of the timeline (persisted zoom; 48 on a fresh profile). */
const pps = (page: Page): Promise<number> => page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)

type Tile = { startSec: number; endSec: number; transitionIn?: unknown; transitionOut?: unknown }
const layerOf = (page: Page, id: string): Promise<Tile> =>
  page.evaluate((i) => window.__reelStores.useProject.getState().project!.layers.find((l) => l.id === i)!, id)
const historyLen = (page: Page): Promise<number> =>
  page.evaluate(() => window.__reelStores.useProject.getState().past.length)

/** Three clips that meet — A 0–4, B 4–8, C 8–12 — each with its linked sound. */
async function arrangeThree(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.addVideoLayer('A', 'no-such-media', 0, 4, true)
    s.addVideoLayer('B', 'no-such-media', 4, 4, true)
    s.addVideoLayer('C', 'no-such-media', 8, 4, true)
  })
}

/** The linked audio clip of layer `id`. */
const audioOf = (page: Page, id: string): Promise<{ startSec: number; fadeInSec: number; fadeOutSec: number }> =>
  page.evaluate((i) => {
    const p = window.__reelStores.useProject.getState().project!
    const gid = p.layers.find((l) => l.id === i)!.linkGroupId
    return p.audioClips.find((a) => a.linkGroupId === gid)!
  }, id)

/** Drag with real pointer events from the centre of `box` by `dxPx`. */
async function dragBy(page: Page, box: { x: number; y: number; width: number; height: number }, dxPx: number) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + dxPx, cy, { steps: 8 })
  await page.mouse.up()
}

test('Add transition on two clips that meet: the second slides in by the length, later tiles follow; one undo step', async ({
  appPage: page
}) => {
  await arrangeThree(page)
  const scale = await pps(page)
  const before = await historyLen(page)

  // Select A, Ctrl-add B, right-click B → Add transition ▸ Cross dissolve.
  await page.getByTestId('tile-layer-A').click({ position: { x: 90, y: 14 } })
  await page.getByTestId('tile-layer-B').click({ position: { x: 90, y: 14 }, modifiers: ['Control'] })
  await page.getByTestId('tile-layer-B').click({ button: 'right', position: { x: 90, y: 14 } })
  await page.getByTestId('ctx-add-transition').click()
  await page.getByTestId('ctx-transition-dissolve').click()
  await expect(page.getByTestId('context-menu')).toHaveCount(0)

  // B (and its sound) start 0.5 s earlier, overlapping A by the length; C follows.
  expect(await layerOf(page, 'A')).toMatchObject({
    startSec: 0,
    endSec: 4,
    transitionOut: { kind: 'dissolve', sec: 0.5 }
  })
  expect(await layerOf(page, 'B')).toMatchObject({
    startSec: 3.5,
    endSec: 7.5,
    transitionIn: { kind: 'dissolve', sec: 0.5 }
  })
  expect(await layerOf(page, 'C')).toMatchObject({ startSec: 7.5, endSec: 11.5 })
  expect(await audioOf(page, 'B')).toMatchObject({ startSec: 3.5, fadeInSec: 0.5 })
  expect(await audioOf(page, 'A')).toMatchObject({ startSec: 0, fadeOutSec: 0.5 })
  // The incoming clip is above the outgoing one.
  const order = await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.map((l) => l.id))
  expect(order.indexOf('B')).toBeGreaterThan(order.indexOf('A'))
  expect(await historyLen(page)).toBe(before + 1)

  // On the timeline: B's tile overlaps A's by 0.5 s, and the wedge covers it.
  const a = (await page.getByTestId('tile-layer-A').boundingBox())!
  const b = (await page.getByTestId('tile-layer-B').boundingBox())!
  expect(Math.abs(a.x + a.width - b.x - 0.5 * scale)).toBeLessThan(3)
  const wedge = (await page.getByTestId('transition-wedge-in-B').boundingBox())!
  expect(Math.abs(wedge.x - b.x)).toBeLessThan(2)
  expect(Math.abs(wedge.width - 0.5 * scale)).toBeLessThan(2)
  await expect(page.getByTestId('transition-wedge-out-A')).toBeVisible()

  // Ctrl+Z takes the whole apply back.
  await page.keyboard.press('Control+z')
  expect(await layerOf(page, 'B')).toMatchObject({ startSec: 4, endSec: 8 })
  expect((await layerOf(page, 'B')).transitionIn).toBeUndefined()
  expect((await layerOf(page, 'C')).startSec).toBe(8)
  expect((await audioOf(page, 'B')).fadeInSec).toBe(0)
})

test('Add transition is greyed with the reason when the selection is not two clips that meet', async ({
  appPage: page
}) => {
  await arrangeThree(page)
  await page.getByTestId('tile-layer-A').click({ button: 'right', position: { x: 90, y: 14 } })
  const row = page.getByTestId('ctx-add-transition')
  await expect(row).toBeDisabled()
  await expect(row).toContainText('Select two neighbouring')
  await page.keyboard.press('Escape')
})

test('dragging the wedge’s grip changes the length — the incoming clip slides with it — as one undo step', async ({
  appPage: page
}) => {
  await arrangeThree(page)
  await page.evaluate(() => {
    const L = (id: string) => ({ kind: 'layer' as const, id })
    window.__reelStores.useProject.getState().applyTransition([L('A'), L('B')], 'dissolve')
  })
  const scale = await pps(page)
  const before = await historyLen(page)

  // A pair grows to the LEFT: the incoming clip's start follows the pointer.
  await dragBy(page, (await page.getByTestId('transition-grip-in-B').boundingBox())!, -0.5 * scale)
  const b = await layerOf(page, 'B')
  expect(b.startSec).toBeCloseTo(3, 1)
  expect((b.transitionIn as { sec: number }).sec).toBeCloseTo(1, 1)
  expect(((await layerOf(page, 'A')).transitionOut as { sec: number }).sec).toBeCloseTo(1, 1)
  expect((await layerOf(page, 'C')).startSec).toBeCloseTo(7, 1)
  expect(await historyLen(page)).toBe(before + 1)
  const wedge = (await page.getByTestId('transition-wedge-in-B').boundingBox())!
  expect(Math.abs(wedge.width - scale)).toBeLessThan(4)

  await page.keyboard.press('Control+z')
  expect(await layerOf(page, 'B')).toMatchObject({ startSec: 3.5, transitionIn: { kind: 'dissolve', sec: 0.5 } })
  expect((await layerOf(page, 'C')).startSec).toBe(7.5)
})

/** Press at (`x`, `y`) px inside `testId`'s box and drag `dxPx` across. */
async function dragAt(page: Page, testId: string, x: number, y: number, dxPx: number): Promise<void> {
  const box = (await page.getByTestId(testId).boundingBox())!
  await page.mouse.move(box.x + x, box.y + y)
  await page.mouse.down()
  await page.mouse.move(box.x + x + dxPx, box.y + y, { steps: 8 })
  await page.mouse.up()
}

/** A tile's own trim handles (the edge bands without a test id). */
const trimHandle = (page: Page, id: string, edge: 'start' | 'end') => {
  const handles = page.getByTestId(`tile-layer-${id}`).locator('div.cursor-ew-resize:not([data-testid])')
  return edge === 'start' ? handles.first() : handles.last()
}

test('a transition’s wedge never blocks the tile: the edge trims, the wedge body moves, only the grip resizes', async ({
  appPage: page
}) => {
  await arrangeThree(page)
  // A dissolve between A and B, and a fade in on C (the corner fade).
  await page.evaluate(() => {
    const L = (id: string) => ({ kind: 'layer' as const, id })
    const s = window.__reelStores.useProject.getState()
    s.applyTransition([L('A'), L('B')], 'dissolve')
    s.setLayerFade('C', 'in', 0.6)
  })
  const scale = await pps(page)
  const dissolve = { kind: 'dissolve', sec: 0.5 }
  const fade = { kind: 'fade', sec: 0.6 }

  // 1. The trim handle wins at the edge, under the wedge: the window changes,
  // the transition stays on the tile. B's start (in-wedge), A's end
  // (out-wedge), C's start (fade-in wedge).
  for (const [id, edge, dx, field, tr] of [
    ['B', 'start', 0.25, 'transitionIn', dissolve],
    ['A', 'end', -0.25, 'transitionOut', dissolve],
    ['C', 'start', 0.25, 'transitionIn', fade]
  ] as const) {
    const t0 = await layerOf(page, id)
    const before = await historyLen(page)
    await dragBy(page, (await trimHandle(page, id, edge).boundingBox())!, dx * scale)
    const t1 = await layerOf(page, id)
    if (edge === 'start') {
      expect(t1.startSec - t0.startSec, `${id} start trimmed`).toBeCloseTo(dx, 1)
      expect(t1.endSec).toBe(t0.endSec)
    } else {
      expect(t1.endSec - t0.endSec, `${id} end trimmed`).toBeCloseTo(dx, 1)
      expect(t1.startSec).toBe(t0.startSec)
    }
    expect(t1[field], `${id} keeps its transition`).toEqual(tr)
    expect(await historyLen(page)).toBe(before + 1)
    await page.keyboard.press('Control+z')
    expect(await layerOf(page, id)).toMatchObject({ startSec: t0.startSec, endSec: t0.endSec })
  }

  // 2. Pressing the wedge body (inside the triangle, clear of the trim band and
  // the grip) moves the tile like the rest of it; the length is untouched.
  for (const [id, tr] of [
    ['B', dissolve],
    ['C', fade]
  ] as const) {
    const t0 = await layerOf(page, id)
    await dragAt(page, `tile-layer-${id}`, 11, 4, 1 * scale)
    const t1 = await layerOf(page, id)
    expect(t1.startSec - t0.startSec, `${id} moved`).toBeCloseTo(1, 1)
    expect(t1.endSec - t1.startSec).toBeCloseTo(t0.endSec - t0.startSec, 6)
    expect(t1.transitionIn, `${id} length unchanged`).toEqual(tr)
    await page.keyboard.press('Control+z')
    expect((await layerOf(page, id)).startSec).toBe(t0.startSec)
  }

  // 3. The grip on the wedge's inner tip changes the length, one undo step.
  // A fade in grows to the right with the pointer.
  const grip = page.getByTestId('transition-grip-in-C')
  await expect(grip).toHaveAttribute('title', /drag to change the length/)
  expect(await grip.evaluate((el) => getComputedStyle(el).cursor)).toBe('ew-resize')
  const before = await historyLen(page)
  const c0 = await layerOf(page, 'C')
  await dragBy(page, (await grip.boundingBox())!, 0.4 * scale)
  const c = await layerOf(page, 'C')
  expect(c).toMatchObject({ startSec: c0.startSec, endSec: c0.endSec })
  expect((c.transitionIn as { kind: string; sec: number }).kind).toBe('fade')
  expect((c.transitionIn as { sec: number }).sec).toBeCloseTo(1, 1)
  expect(await historyLen(page)).toBe(before + 1)
  // A pair's grip grows it LEFT (the incoming clip slides in).
  await dragBy(page, (await page.getByTestId('transition-grip-in-B').boundingBox())!, -0.25 * scale)
  expect(((await layerOf(page, 'B')).transitionIn as { sec: number }).sec).toBeCloseTo(0.75, 1)
  expect(await historyLen(page)).toBe(before + 2)
})

test('a grip or corner handle selects like the tile: right-press keeps the selection (Add transition works), Ctrl toggles', async ({
  appPage: page
}) => {
  await arrangeThree(page)
  await page.evaluate(() => {
    const L = (id: string) => ({ kind: 'layer' as const, id })
    window.__reelStores.useProject.getState().applyTransition([L('A'), L('B')], 'dissolve')
  })
  const selectedLayers = (): Promise<string[]> =>
    page.evaluate(() =>
      window.__reelStores.useUi
        .getState()
        .selection.filter((r) => r.kind === 'layer')
        .map((r) => r.id)
        .sort()
    )
  const before = await historyLen(page)

  // Ctrl/Cmd-click on B's grip adds B to the selection, as on the tile body.
  await page.getByTestId('tile-layer-A').click({ position: { x: 90, y: 14 } })
  await page.getByTestId('transition-grip-in-B').click({ modifiers: ['Control'] })
  expect(await selectedLayers()).toEqual(['A', 'B'])

  // A right-press on it, even one that moves, keeps that selection and never drags.
  const g = (await page.getByTestId('transition-grip-in-B').boundingBox())!
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(g.x + g.width / 2 - 30, g.y + g.height / 2, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  expect(await selectedLayers()).toEqual(['A', 'B'])
  expect((await layerOf(page, 'B')).transitionIn).toEqual({ kind: 'dissolve', sec: 0.5 })
  expect(await historyLen(page)).toBe(before)
  // (Close a context menu if the release opened one; Escape with none open deselects.)
  if ((await page.getByTestId('context-menu').count()) > 0) await page.keyboard.press('Escape')

  // Ctrl-select B and C, right-click C's top-left fade handle: the menu's
  // Add transition acts on the pair (the press did not narrow the selection).
  await page.getByTestId('tile-layer-B').click({ position: { x: 90, y: 14 } })
  await page.getByTestId('tile-layer-C').click({ position: { x: 90, y: 14 }, modifiers: ['Control'] })
  await page.getByTestId('tile-layer-C').hover({ position: { x: 90, y: 14 } })
  await page.getByTestId('fade-handle-in-C').click({ button: 'right' })
  expect(await selectedLayers()).toEqual(['B', 'C'])
  await page.getByTestId('ctx-add-transition').click()
  await page.getByTestId('ctx-transition-dipBlack').click()
  expect((await layerOf(page, 'B')).transitionOut).toEqual({ kind: 'dipBlack', sec: 0.5 })
  expect((await layerOf(page, 'C')).transitionIn).toEqual({ kind: 'dipBlack', sec: 0.5 })
})

test('a fade at a clip’s end: the Inspector field, and the tile’s top corner (one undo step); the preview fades', async ({
  appPage: page
}) => {
  await arrangeThree(page)
  const scale = await pps(page)

  // Inspector: C fades out over its last second.
  await page.getByTestId('tile-layer-C').click({ position: { x: 90, y: 14 } })
  const out = page.getByLabel('Fade out seconds')
  await out.fill('1')
  await out.press('Enter')
  expect((await layerOf(page, 'C')).transitionOut).toEqual({ kind: 'fade', sec: 1 })

  // Corner: drag C's top-left handle 0.6 s right → a 0.6 s fade in.
  const before = await historyLen(page)
  const tile = page.getByTestId('tile-layer-C')
  await tile.hover({ position: { x: 90, y: 14 } })
  await dragBy(page, (await page.getByTestId('fade-handle-in-C').boundingBox())!, 0.6 * scale)
  const fadeIn = (await layerOf(page, 'C')).transitionIn as { kind: string; sec: number }
  expect(fadeIn.kind).toBe('fade')
  expect(fadeIn.sec).toBeCloseTo(0.6, 1)
  expect(await historyLen(page)).toBe(before + 1)
  await expect(page.getByTestId('transition-wedge-in-C')).toBeVisible()

  // The preview: halfway through the fade in, C's box is at half opacity.
  await page.evaluate((t) => window.__reelStores.usePlayback.getState().setTime(t), 8 + fadeIn.sec / 2)
  const half = await page.locator('[data-resizebox]').evaluate((el) => Number(getComputedStyle(el).opacity))
  expect(half).toBeCloseTo(0.5, 1)
  // Halfway through the fade out: half again.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(11.5))
  const late = await page.locator('[data-resizebox]').evaluate((el) => Number(getComputedStyle(el).opacity))
  expect(late).toBeCloseTo(0.5, 1)
})

test('a dip shows its colour card in the preview while neither clip does — behind the two clips’ boxes only', async ({
  appPage: page
}) => {
  await arrangeThree(page)
  await page.evaluate(() => {
    const L = (id: string) => ({ kind: 'layer' as const, id })
    const s = window.__reelStores.useProject.getState()
    // Two picture-in-picture clips in different places (B also rotated).
    s.updateLayer('A', { x: 300, y: 400, scale: 0.3 })
    s.updateLayer('B', { x: 700, y: 1400, scale: 0.3, rotationDeg: 20 })
    s.applyTransition([L('A'), L('B')], 'dipWhite')
    window.__reelStores.usePlayback.getState().setTime(3.75) // the middle of the 3.5–4 window
  })
  const plate = page.getByTestId('dip-plate')
  await expect(plate).toHaveCount(1)
  const boxes = page.getByTestId('dip-plate-box')
  await expect(boxes).toHaveCount(2)
  for (const id of ['A', 'B']) {
    const card = page.locator(`[data-testid="dip-plate-box"][data-cover="${id}"]`)
    expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
    // The card's box IS the clip's box (select the clip to tag its preview box).
    await page.evaluate((i) => {
      const ref = { kind: 'layer' as const, id: i }
      window.__reelStores.useUi.getState().selectItems([ref], ref)
    }, id)
    const clip = (await page.locator('[data-resizebox]').boundingBox())!
    const c = (await card.boundingBox())!
    for (const k of ['x', 'y', 'width', 'height'] as const)
      expect(Math.abs(c[k] - clip[k]), `${id} ${k}`).toBeLessThan(1)
  }
  // Not a full-frame plate: each box is a small part of the stage.
  const stage = (await page.getByTestId('preview-stage').boundingBox())!
  for (const b of await boxes.all()) {
    const r = (await b.boundingBox())!
    expect(r.width * r.height).toBeLessThan(0.2 * stage.width * stage.height)
  }
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(4.5))
  await expect(plate).toHaveCount(0)
})

test('a clip trimmed shorter than its fades keeps them; the Inspector warns and the field takes a length above its usual max', async ({
  appPage: page
}) => {
  await arrangeThree(page)
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.setLayerFade('C', 'in', 1)
    s.setLayerFade('C', 'out', 1)
  })
  const scale = await pps(page)
  await page.getByTestId('tile-layer-C').click({ position: { x: 90, y: 14 } })
  const warning = page.getByTestId('transition-too-short')
  await expect(page.getByTestId('transition-section')).toBeVisible()
  await expect(warning).toHaveCount(0)

  // Trim C's end 2.5 s in with the real handle: 1.5 s left for 2 s of fades.
  await dragBy(page, (await trimHandle(page, 'C', 'end').boundingBox())!, -2.5 * scale)
  const c = await layerOf(page, 'C')
  expect(c.endSec - c.startSec).toBeCloseTo(1.5, 1)
  expect(c.transitionIn).toEqual({ kind: 'fade', sec: 1 })
  expect(c.transitionOut).toEqual({ kind: 'fade', sec: 1 })
  await expect(warning).toBeVisible()
  await expect(warning).toContainText('never reaches full opacity')

  // The fields hold the stored lengths as valid values, above the usual
  // maximum (half the clip, 0.75 s) — and accept an edit that stays above it.
  for (const side of ['in', 'out']) {
    const f = page.getByLabel(`Fade ${side} seconds`)
    await expect(f).toHaveValue('1.00')
    expect(await f.evaluate((el) => (el as HTMLInputElement).validity.valid)).toBe(true)
  }
  const fadeIn = page.getByLabel('Fade in seconds')
  await fadeIn.fill('0.9')
  await fadeIn.press('Enter')
  expect((await layerOf(page, 'C')).transitionIn).toEqual({ kind: 'fade', sec: 0.9 })
  await expect(warning).toBeVisible() // 1.9 s of fades in 1.5 s
  // Shortened until they fit, the warning goes.
  const fadeOut = page.getByLabel('Fade out seconds')
  await fadeOut.fill('0.5')
  await fadeOut.press('Enter')
  await expect(warning).toHaveCount(0)
})
