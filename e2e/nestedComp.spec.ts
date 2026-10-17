/**
 * Nested compositions Stage 1: converting a layout cell to a comp, ENTERING it
 * (the whole editor re-targets — timeline shows the nested doc), editing inside
 * (real keybind), the breadcrumb exiting back out, and undo revalidating the
 * edit path instead of dangling. ARRANGE via store actions, ACT with real
 * keys/clicks, ASSERT on store + DOM.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import type { Composition, LayoutContent } from '../src/shared/project'
import { FFMPEG } from './bin'

/** Root: one Split L|R layout at t=0 whose cell 0 holds a (fake) clip. */
async function arrangeLayoutWithCell(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject } = window.__reelStores
    const s = useProject.getState()
    s.addLayoutLayer('LAY', 'split-lr', 0)
    s.updateLayoutCell('LAY', 0, { mediaId: 'no-such-media', inSec: 1, outSec: 5 })
  })
}

const rootState = (page: Page): Promise<{ layers: number; cell0: unknown; editPath: unknown[] }> =>
  page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    const lay = s.project!.layers.find((l) => l.id === 'LAY')!
    return {
      layers: s.project!.layers.length,
      cell0: (lay.content as LayoutContent).cells[0],
      editPath: s.editPath
    }
  })

test('convert a cell to a comp, enter it, edit inside, breadcrumb exits', async ({ appPage: page }) => {
  await arrangeLayoutWithCell(page)

  // Convert + enter through the real store actions (the Stage-4 UI wraps these).
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.convertCellToComp('LAY', 0)
    s.enterComposition({ layerId: 'LAY', cellIndex: 0 })
  })

  // The editor re-targeted: the timeline now shows the seeded clip (a video
  // block over 0..4s from the cell's 1..5s trim), NOT the layout block.
  await expect(page.getByTestId('comp-breadcrumb')).toBeVisible()
  await expect(page.getByTestId('comp-breadcrumb')).toContainText('Cell 1')
  await expect(page.locator('div[title="Video"]')).toBeVisible()
  await expect(page.locator('div[title="Layout"]')).toHaveCount(0)

  // Edit INSIDE with a real keybind: T adds a text layer — to the comp.
  await page.keyboard.press('t')
  const nested = await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    const lay = s.project!.layers.find((l) => l.id === 'LAY')!
    const comp = (lay.content as LayoutContent).cells[0].comp as Composition
    return { compLayers: comp.layers.map((l) => l.content.kind), rootLayers: s.project!.layers.length }
  })
  expect(nested.compLayers).toEqual(['video', 'text']) // landed in the comp…
  expect(nested.rootLayers).toBe(1) // …not the root

  // The breadcrumb's "Timeline" hop exits back to the root: layout block again,
  // breadcrumb gone, selection cleared.
  await page.getByTestId('comp-breadcrumb').getByRole('button', { name: 'Timeline' }).click()
  await expect(page.getByTestId('comp-breadcrumb')).toHaveCount(0)
  await expect(page.locator('div[title="Layout"]')).toBeVisible()
  expect((await rootState(page)).editPath).toEqual([])
})

test('an un-entered cell comp renders inside its panel in the preview', async ({ appPage: page }) => {
  await arrangeLayoutWithCell(page)
  // Convert the cell WITHOUT entering it, then add a text layer inside the comp
  // (enter → edit → exit), so the comp has something with visible DOM.
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.convertCellToComp('LAY', 0)
    s.enterComposition({ layerId: 'LAY', cellIndex: 0 })
  })
  await page.keyboard.press('t')
  await page.evaluate(() => window.__reelStores.useProject.getState().exitComposition())
  await expect(page.getByTestId('comp-breadcrumb')).toHaveCount(0)

  // Back at the root with the playhead inside the layout window, the cell's
  // comp renders through CompFill — its own stack composited into the panel.
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1))
  const fill = page.getByTestId('comp-fill')
  await expect(fill).toHaveCount(1)
  // The nested text layer really renders (the comp's stack, not a placeholder).
  await expect(fill.getByText('Your hook here')).toBeVisible()

  // Past the comp's span the panel empties again (lower layers show through).
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(4.5))
  await expect(page.getByTestId('comp-fill')).toHaveCount(0)
})

test('the cell Edit button converts + enters in one click (real UI)', async ({ appPage: page }) => {
  await arrangeLayoutWithCell(page)
  // Select the layout so the Inspector shows its Layout section.
  await page.evaluate(() => window.__reelStores.useUi.getState().selectLayer('LAY'))

  // One click on the cell's ✎ Edit: converts the single clip to a composition
  // and steps in (the two store actions the Stage-1 e2e drove by hand).
  await page.getByTestId('layout-cell-0').getByRole('button', { name: '✎ Edit' }).click()

  await expect(page.getByTestId('comp-breadcrumb')).toContainText('Cell 1')
  await expect(page.locator('div[title="Video"]')).toBeVisible() // the seeded clip
  const s = await page.evaluate(() => {
    const st = window.__reelStores.useProject.getState()
    const lay = st.project!.layers.find((l) => l.id === 'LAY')!
    const cell = (lay.content as LayoutContent).cells[0]
    return { hasComp: !!cell.comp, mediaId: cell.mediaId, editPath: st.editPath }
  })
  expect(s.hasComp).toBe(true)
  expect(s.mediaId).toBeNull() // the comp took over the cell
  expect(s.editPath).toHaveLength(1)
})

test('a timeline clip converts to a compound clip and opens (real UI)', async ({ appPage: page }) => {
  // A plain clip with NO audio, so it isn't linked (linked tiles are excluded).
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('V1', 'no-such-media', 0, 6, false)
    useUi.getState().selectLayer('V1')
  })

  await page.getByRole('button', { name: '🧩 Edit as compound clip' }).click()

  // We're inside the new comp, and the clip moved in (zero-based).
  await expect(page.getByTestId('comp-breadcrumb')).toContainText('Compound clip')
  const inside = await page.evaluate(() => {
    const st = window.__reelStores.useProject.getState()
    const l = st.project!.layers[0]
    const comp = (l.content as { kind: string; comp?: Composition }).comp!
    return {
      rootKind: l.content.kind,
      rootWindow: [l.startSec, l.endSec],
      innerKinds: comp.layers.map((x) => x.content.kind),
      innerWindow: [comp.layers[0].startSec, comp.layers[0].endSec]
    }
  })
  expect(inside.rootKind).toBe('compound')
  expect(inside.rootWindow).toEqual([0, 6]) // parent block keeps its window
  expect(inside.innerKinds).toEqual(['video'])
  expect(inside.innerWindow).toEqual([0, 6]) // the clip is zero-based inside

  // Exit, and the block is now a compound whose Inspector opens it again.
  await page.getByTestId('comp-breadcrumb').getByRole('button', { name: 'Timeline' }).click()
  await page.evaluate(() => window.__reelStores.useUi.getState().selectLayer('V1'))
  await page.getByRole('button', { name: '✎ Edit contents' }).click()
  await expect(page.getByTestId('comp-breadcrumb')).toContainText('Compound clip')
})

test('editing inside a compound resizes its block in the parent timeline', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addVideoLayer('V1', 'no-such-media', 0, 6, false)
    useUi.getState().selectLayer('V1')
  })
  await page.getByRole('button', { name: '🧩 Edit as compound clip' }).click()
  await expect(page.getByTestId('comp-breadcrumb')).toBeVisible()

  // Inside: add a text layer running to 10s, past the comp's current 6s.
  await page.evaluate(() => {
    const { useProject, usePlayback } = window.__reelStores
    usePlayback.getState().setTime(7)
    useProject.getState().addLayer({
      id: 'T1',
      hidden: false,
      startSec: 7,
      endSec: 10,
      x: 540,
      y: 600,
      scale: 1,
      content: {
        kind: 'text',
        text: 'later',
        fontFamily: 'montserrat-extrabold',
        fontSizePx: 60,
        color: '#fff',
        pill: { enabled: false, color: '#000', padPx: 0 }
      }
    })
  })

  // The parent block grew to match the comp (v1 comps are untrimmed), so the
  // extra content can't be clipped by a stale window.
  const end = await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0].endSec)
  expect(end).toBeCloseTo(10, 5)
})

test('undo while inside a comp pops the edit path instead of dangling', async ({ appPage: page }) => {
  await arrangeLayoutWithCell(page)
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.convertCellToComp('LAY', 0)
    s.enterComposition({ layerId: 'LAY', cellIndex: 0 })
  })
  await expect(page.getByTestId('comp-breadcrumb')).toBeVisible()

  // One undo reverts the conversion — the comp the editor stands in no longer
  // exists, so the edit path must pop to the root (not crash / dangle).
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('comp-breadcrumb')).toHaveCount(0)
  const s = await rootState(page)
  expect(s.editPath).toEqual([])
  expect((s.cell0 as { comp?: unknown }).comp).toBeUndefined()
  // The editor is normal again: the layout block renders at the root.
  await expect(page.locator('div[title="Layout"]')).toBeVisible()
})

/**
 * REGRESSION: a nested comp's AUDIO TRACK reaches the mix.
 *
 * The comp's video layers always carried their own audio (a `<video>` element
 * plays it), but the comp's audioClips were never rendered as followers — so
 * the standard workflow (mute the clip, extract its audio to the lane) went
 * silent one level up, while text and pictures propagated fine.
 */
test('a nested comp plays its own audio track from the parent timeline', async ({ appPage: page }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')

  // A real clip WITH an audio track (followers need a ready proxy to render).
  const mp4 = join(mkdtempSync(join(tmpdir(), 'reel-na-')), 'av.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=3:size=270x480:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    mp4
  ])
  const assetId = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, mp4)
  await expect
    .poll(() => page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0]?.proxyReady, assetId), {
      timeout: 30_000
    })
    .toBe(true)

  // A layout whose cell 0 is a comp; inside it, the user's usual shape: the
  // clip muted, its audio living on the comp's own audio lane.
  await page.evaluate((id) => {
    const { useProject } = window.__reelStores
    const s = useProject.getState()
    s.addLayoutLayer('LAY', 'split-lr', 0)
    s.updateLayoutCell('LAY', 0, { mediaId: id, inSec: 0, outSec: 3 })
    s.convertCellToComp('LAY', 0)
    s.enterComposition({ layerId: 'LAY', cellIndex: 0 })
    const st = useProject.getState()
    const comp = (st.project!.layers.find((l) => l.id === 'LAY')!.content as LayoutContent).cells[0].comp!
    st.updateLayerContent(comp.layers[0].id, { mute: true })
    st.addAudioClip({
      id: 'NA1',
      mediaId: id,
      startSec: 0,
      inSec: 0,
      outSec: 3,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'extracted'
    })
    st.exitComposition()
  }, assetId)

  // Back at the ROOT, with the playhead inside the layout: the comp's audio
  // clip must have a follower <audio> on the page (it had none before the fix).
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1))
  await expect(page.getByTestId('comp-fill')).toHaveCount(1)
  await expect.poll(() => page.locator('audio').count()).toBeGreaterThan(0)

  // …and it is silenced when the cell holding the comp is muted, matching the
  // export (which skips a muted cell's intermediate audio entirely).
  await page.evaluate(() => window.__reelStores.useProject.getState().updateLayoutCell('LAY', 0, { mute: true }))
  await expect.poll(() => page.locator('audio').count()).toBe(0)
})
