/**
 * Insert between (#215): a picture dropped from the Library on a SEAM — where
 * two tiles meet in the lane under the pointer, or the very start of the
 * timeline — is inserted there, and everything from the seam on, on every
 * lane, moves later by its length. A tile that spans the seam stays. A drop
 * anywhere else, and a dropped sound, land on top as they always did. Each
 * insert is ONE undo step. The rules are pinned in lib/ripple.test.ts; this is
 * the real drag, drop, click and Ctrl+Z.
 *
 * ARRANGE via store actions, ACT with real drag / pointer / key events, ASSERT
 * on the store and the DOM.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

/** px per second of the timeline (persisted zoom; 48 on a fresh profile). */
const pps = (page: Page): Promise<number> => page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)

/** Import `path` into the project and wait until the Library can place it. */
async function importReady(page: Page, path: string): Promise<string> {
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, path)
  await expect
    .poll(() => page.evaluate(async (mediaId) => (await window.api.listProjectMedia([mediaId]))[0]?.proxyReady, id), {
      timeout: 60_000
    })
    .toBe(true)
  return id
}

/** A still picture in the project folder, imported and ready. */
async function importPicture(page: Page, projectsDir: string): Promise<string> {
  const png = join(projectsDir, 'E2E', 'card.png')
  execFileSync(FFMPEG, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568',
    '-frames:v',
    '1',
    png
  ])
  const id = await importReady(page, png)
  // The Library (and so the timeline's own asset list) has refetched.
  await expect(page.getByTitle('Add image at the playhead')).toHaveCSS('pointer-events', 'auto')
  return id
}

/** A two-second tone in the project folder, imported and ready. */
async function importSound(page: Page, projectsDir: string): Promise<string> {
  const mp3 = join(projectsDir, 'E2E', 'tone.mp3')
  execFileSync(FFMPEG, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:a',
    'libmp3lame',
    mp3
  ])
  const id = await importReady(page, mp3)
  await expect(page.getByTitle('Add to audio track at the playhead')).toHaveCSS('pointer-events', 'auto', {
    timeout: 30_000
  })
  return id
}

/**
 * Two clips end to end (each with its linked sound), a caption and a script
 * line on the second, and a music bed under both.
 */
async function arrangeCut(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    const s = useProject.getState()
    s.addVideoLayer('V1', 'no-such-media', 0, 4, true)
    s.addVideoLayer('V2', 'no-such-media', 4, 4, true)
    s.addCaption({
      id: 'C2',
      startSec: 5,
      endSec: 7,
      text: 'hello there',
      words: [
        { text: 'hello', startSec: 5, endSec: 6 },
        { text: 'there', startSec: 6, endSec: 7 }
      ],
      enabled: true
    })
    s.addAudioClip({
      id: 'Bed',
      mediaId: 'no-such-music',
      kind: 'music',
      startSec: 0,
      inSec: 0,
      outSec: 20,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false
    })
    s.addScriptLine(6)
    useUi.getState().clearSelection()
  })
  await expect(page.getByTestId('tile-layer-V2')).toBeVisible()
}

interface Snapshot {
  /** Every tile's start by id; a clip's own sound is `<clip id>.audio`. */
  starts: Record<string, number>
  captionWords: number[]
  script: (number | null)[]
  past: number
  /** The whole document, to compare an undo against. */
  doc: string
}

/** The active composition's tiles, plus the root's script and history depth. */
const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    const root = s.project!
    // The composition being edited (one compound layer deep at most here).
    const step = s.editPath[0]
    const host = step && root.layers.find((l) => l.id === step.layerId)
    const comp = host && host.content.kind === 'compound' ? host.content.comp : root
    const starts: Record<string, number> = {}
    for (const l of comp.layers) starts[l.id] = l.startSec
    for (const c of comp.captions.segments) starts[c.id] = c.startSec
    for (const a of comp.audioClips) {
      const partner = a.linkGroupId && comp.layers.find((l) => l.linkGroupId === a.linkGroupId)
      starts[partner ? `${partner.id}.audio` : a.id] = a.startSec
    }
    return {
      starts,
      captionWords: comp.captions.segments.flatMap((c) => c.words.map((w) => w.startSec)),
      script: root.script.map((l) => l.atSec),
      past: s.past.length,
      doc: JSON.stringify(root)
    }
  })

/** The id of the one layer that is not in `known`. */
const newLayerId = (snap: Snapshot, known: string[]): string =>
  Object.keys(snap.starts).find((id) => !known.includes(id) && !id.endsWith('.audio'))!

/**
 * Drag library clip `assetId` over the timeline to (x, y) and drop it there.
 * `insertable` adds the type the Library puts on a picture's drag (a drag's
 * data can't be read before the drop; its types can). Returns where the insert
 * caret was while the drag hovered: its x in the page, or null when hidden.
 */
async function dropAsset(page: Page, assetId: string, x: number, y: number, insertable = true): Promise<number | null> {
  const scroll = page.getByTestId('timeline-scroll')
  const dt = await page.evaluateHandle(
    ({ assetId, insertable }) => {
      const d = new DataTransfer()
      d.setData('application/x-reel-asset', assetId)
      if (insertable) d.setData('application/x-reel-insert', '1')
      return d
    },
    { assetId, insertable }
  )
  const at = { clientX: x, clientY: y }
  await scroll.dispatchEvent('dragenter', { dataTransfer: dt, ...at })
  await scroll.dispatchEvent('dragover', { dataTransfer: dt, ...at })
  const caret = page.getByTestId('insert-caret')
  const box = (await caret.count()) ? await caret.boundingBox() : null
  await scroll.dispatchEvent('drop', { dataTransfer: dt, ...at })
  await expect(caret).toHaveCount(0) // the drop always clears it
  return box ? box.x + box.width / 2 : null
}

/** The page position of the left edge and vertical middle of a tile. */
async function tileEdge(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const tile = page.getByTestId(testId)
  await tile.scrollIntoViewIfNeeded()
  const b = (await tile.boundingBox())!
  return { x: b.x, y: b.y + b.height / 2 }
}

test.beforeEach(() => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(90_000)
})

test('a picture dropped on the seam between two clips is inserted: everything after moves, a spanning bed stays', async ({
  appPage: page,
  projectsDir
}) => {
  const picture = await importPicture(page, projectsDir)
  await arrangeCut(page)
  const before = await snapshot(page)
  expect(before.starts).toEqual({ V1: 0, 'V1.audio': 0, V2: 4, 'V2.audio': 4, C2: 5, Bed: 0 })

  // Drop a few px off the seam, over the Clips lane: the point snaps to it.
  const seam = await tileEdge(page, 'tile-layer-V2')
  const caretX = await dropAsset(page, picture, seam.x + 3, seam.y)
  expect(caretX).not.toBeNull()
  expect(Math.abs(caretX! - seam.x)).toBeLessThan(2) // the caret sat ON the seam

  const after = await snapshot(page)
  const added = newLayerId(after, ['V1', 'V2'])
  // The picture (3 s) sits at the seam; the second clip, its sound, its caption
  // (words included) and its script line all moved 3 s; the first clip and the
  // music bed that spans the seam did not.
  expect(after.starts).toEqual({ V1: 0, 'V1.audio': 0, [added]: 4, V2: 7, 'V2.audio': 7, C2: 8, Bed: 0 })
  expect(after.captionWords).toEqual([8, 9])
  expect(after.script).toEqual([9])
  expect(after.past).toBe(before.past + 1)

  await page.keyboard.press('Control+z')
  expect((await snapshot(page)).doc).toBe(before.doc)
})

test('a picture dropped at the very start pushes the whole timeline later', async ({ appPage: page, projectsDir }) => {
  const picture = await importPicture(page, projectsDir)
  await arrangeCut(page)
  const before = await snapshot(page)

  const start = await tileEdge(page, 'tile-layer-V1')
  expect(await dropAsset(page, picture, start.x + 2, start.y)).not.toBeNull()

  const after = await snapshot(page)
  const added = newLayerId(after, ['V1', 'V2'])
  // Everything starts at or after 0 — the bed too, so nothing spans the point.
  expect(after.starts).toEqual({ [added]: 0, V1: 3, 'V1.audio': 3, V2: 7, 'V2.audio': 7, C2: 8, Bed: 3 })
  expect(after.script).toEqual([9])

  await page.keyboard.press('Control+z')
  expect((await snapshot(page)).doc).toBe(before.doc)
})

test('a drop away from a seam lands on top, as before: nothing else moves and no caret shows', async ({
  appPage: page,
  projectsDir
}) => {
  const picture = await importPicture(page, projectsDir)
  await arrangeCut(page)
  const before = await snapshot(page)
  const scale = await pps(page)

  // The middle of the first clip (2 s): far from 0 and from the seam at 4 s.
  const start = await tileEdge(page, 'tile-layer-V1')
  expect(await dropAsset(page, picture, start.x + 2 * scale, start.y)).toBeNull()
  // The seam at 4 s belongs to the Clips lane: over the Text lane it is not one.
  const text = (await page.getByText('Text', { exact: true }).first().boundingBox())!
  const seam = await tileEdge(page, 'tile-layer-V2')
  expect(await dropAsset(page, picture, seam.x, text.y + text.height / 2)).toBeNull()

  const after = await snapshot(page)
  const added = Object.keys(after.starts).filter((id) => !(id in before.starts))
  expect(added).toHaveLength(2)
  expect(after.starts[added[0]]).toBeCloseTo(2, 1)
  expect(after.starts[added[1]]).toBeCloseTo(4, 5) // snapped to the clip edge, as a drop always did
  for (const id of Object.keys(before.starts)) expect(after.starts[id]).toBe(before.starts[id])
  expect(after.script).toEqual(before.script)
})

test('a sound dropped at the start is placed, not inserted', async ({ appPage: page, projectsDir }) => {
  const sound = await importSound(page, projectsDir)
  await arrangeCut(page)
  const before = await snapshot(page)

  // The Library gives a sound's drag no insert type, so no caret; and the drop
  // itself decides by what the clip is, whatever the drag claimed.
  const start = await tileEdge(page, 'tile-audio-Bed')
  expect(await dropAsset(page, sound, start.x + 2, start.y, false)).toBeNull()
  expect(await dropAsset(page, sound, start.x + 2, start.y, true)).not.toBeNull()

  const after = await snapshot(page)
  const added = Object.keys(after.starts).filter((id) => !(id in before.starts))
  expect(added).toHaveLength(2)
  for (const id of added) expect(after.starts[id]).toBe(0)
  for (const id of Object.keys(before.starts)) expect(after.starts[id]).toBe(before.starts[id])
})

test('inside a nested composition the insert ripples that composition and its block grows', async ({
  appPage: page,
  projectsDir
}) => {
  const picture = await importPicture(page, projectsDir)
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.addVideoLayer('K', 'no-such-media', 0, 4, false)
    s.addVideoLayer('Next', 'no-such-media', 8, 2, false)
    s.addScriptLine(5)
    s.convertLayerToComp('K')
    s.enterComposition({ layerId: 'K' })
    // Inside: a second clip right after the one the block was made from.
    window.__reelStores.useProject.getState().addVideoLayer('In2', 'no-such-media', 4, 4, false)
  })
  await expect(page.getByTestId('comp-breadcrumb')).toBeVisible()
  const block = (): Promise<{ startSec: number; endSec: number; next: number }> =>
    page.evaluate(() => {
      const layers = window.__reelStores.useProject.getState().project!.layers
      const k = layers.find((l) => l.id === 'K')!
      return { startSec: k.startSec, endSec: k.endSec, next: layers.find((l) => l.id === 'Next')!.startSec }
    })
  expect(await block()).toEqual({ startSec: 0, endSec: 8, next: 8 })
  const before = await snapshot(page)

  const seam = await tileEdge(page, 'tile-layer-In2')
  expect(await dropAsset(page, picture, seam.x, seam.y)).not.toBeNull()

  const after = await snapshot(page)
  expect(after.starts.In2).toBe(7)
  expect(Object.values(after.starts).sort()).toEqual([0, 4, 7])
  // The block follows its composition's new length. The root timeline is a
  // different one: its tiles and its script line stay where they were.
  expect(await block()).toEqual({ startSec: 0, endSec: 11, next: 8 })
  expect(after.script).toEqual([5])
  expect(after.past).toBe(before.past + 1)

  await page.keyboard.press('Control+z')
  expect((await snapshot(page)).doc).toBe(before.doc)
})

test('Shift-click on ＋ Playhead inserts at the playhead; a plain click places on top', async ({
  appPage: page,
  projectsDir
}) => {
  await importPicture(page, projectsDir)
  await arrangeCut(page)
  const before = await snapshot(page)
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(4))
  const add = page.getByTitle('Add image at the playhead')

  await add.click({ modifiers: ['Shift'] })
  const inserted = await snapshot(page)
  const first = newLayerId(inserted, ['V1', 'V2'])
  expect(inserted.starts).toEqual({ V1: 0, 'V1.audio': 0, [first]: 4, V2: 7, 'V2.audio': 7, C2: 8, Bed: 0 })
  expect(inserted.past).toBe(before.past + 1)
  await page.keyboard.press('Control+z')
  expect((await snapshot(page)).doc).toBe(before.doc)

  await add.click()
  const placed = await snapshot(page)
  const second = newLayerId(placed, ['V1', 'V2'])
  expect(placed.starts).toEqual({ ...before.starts, [second]: 4 })
})
