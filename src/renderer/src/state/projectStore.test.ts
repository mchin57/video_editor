/**
 * The project store's behaviour, pinned at the store level (no React): undo
 * history and gestures, editing inside a nested composition, autosave and
 * Save, switching documents, and the actions whose rules live in the store
 * itself (linked A/V pairs, re-timing on speed / freeze changes, keyframe
 * guards, volume levels, caption re-timing). The e2e specs drive these through
 * the UI; this catches a regression in the store without a build.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyComposition, createEmptyProject, type AudioClip, type Layer, type Project } from '@shared/project'
import { makeTextLayer, makeVideoLayer, playedVideoDuration } from '@shared/layers'
import { makeLayoutLayer } from '@shared/layouts'
import type { LoadedProject } from '@shared/ipc'

const api = {
  saveProject: vi.fn(async () => {}),
  saveProjectFile: vi.fn(async (p: Project) => p),
  saveProjectAs: vi.fn(async (): Promise<{ path: string; project: Project } | null> => null),
  openProjectFile: vi.fn(async (): Promise<LoadedProject | null> => null),
  createProject: vi.fn(async () => ({}) as LoadedProject),
  loadProject: vi.fn(async () => ({ loaded: null, message: null }))
}

let useProject: typeof import('./projectStore').useProject
let activeComp: typeof import('./projectStore').activeComp
let useUi: typeof import('./ui').useUi
let usePlayback: typeof import('./playback').usePlayback

beforeAll(async () => {
  // ipc/client destructures window.api at load: stub what the store calls.
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (target, key) => (key in target ? target[key as keyof typeof api] : () => undefined)
  })
  ;({ useProject, activeComp } = await import('./projectStore'))
  ;({ useUi } = await import('./ui'))
  ;({ usePlayback } = await import('./playback'))
})

const PATH = 'C:/Reels/Test/Test.reel'

/** Open a fresh document with these layers / audio clips. */
function open(layers: Layer[] = [], audioClips: AudioClip[] = []): void {
  const project = { ...createEmptyProject('p1', 'Test'), layers, audioClips }
  useProject.setState({ project, past: [], future: [], filePath: PATH, dirty: false, editPath: [] })
}
const s = (): ReturnType<typeof useProject.getState> => useProject.getState()
const root = (): Project => s().project!
const layer = (id: string): Layer => activeComp(s())!.layers.find((l) => l.id === id)!
const videoOf = (id: string): Extract<Layer['content'], { kind: 'video' }> =>
  layer(id).content as Extract<Layer['content'], { kind: 'video' }>
const clip = (id: string, patch: Partial<AudioClip> = {}): AudioClip => ({
  id,
  mediaId: 'm1',
  kind: 'music',
  startSec: 0,
  inSec: 0,
  outSec: 10,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  ...patch
})

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(api)) fn.mockClear()
  useUi.getState().clearSelection()
  usePlayback.setState({ time: 0, playing: false })
})
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('history', () => {
  it('records each edit, and undo / redo step through them', () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().updateLayer('V', { x: 100 })
    s().updateLayer('V', { x: 200 })
    expect(s().past).toHaveLength(2)
    s().undo()
    expect(layer('V').x).toBe(100)
    s().undo()
    expect(layer('V').x).toBe(540)
    s().redo()
    expect(layer('V').x).toBe(100)
    expect(s().future).toHaveLength(1)
    // A new edit drops the redo branch.
    s().updateLayer('V', { y: 5 })
    expect(s().future).toHaveLength(0)
  })

  it('records nothing for an edit that changes nothing', () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().addMedia([]) // no ids to add → same document
    s().removeMedia('not-there')
    expect(s().past).toHaveLength(0)
    expect(s().dirty).toBe(false)
  })

  it('keeps the last 50 steps', () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    for (let i = 1; i <= 60; i++) s().updateLayer('V', { x: i })
    expect(s().past).toHaveLength(50)
  })

  it('a gesture (slider drag) is ONE step however many edits it makes', () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().beginGesture()
    for (let i = 1; i <= 10; i++) s().updateLayer('V', { scale: 1 + i / 10 })
    expect(layer('V').scale).toBe(2)
    s().endGesture()
    expect(s().past).toHaveLength(1)
    s().undo()
    expect(layer('V').scale).toBe(makeVideoLayer('V', 'm1', 0, 4).scale)
  })

  it('a live drag commits once, against its pre-drag snapshot', () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    const before = root()
    for (let x = 0; x < 5; x++) s().liveUpdate((c) => ({ ...c, layers: c.layers.map((l) => ({ ...l, x })) }))
    expect(s().past).toHaveLength(0)
    s().commitLive(before)
    expect(s().past).toEqual([before])
    s().commitLive(root()) // nothing changed since: no step
    expect(s().past).toHaveLength(1)
  })
})

describe('autosave and Save', () => {
  it('an edit marks the project unsaved and autosaves it shortly after', () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().updateLayer('V', { x: 1 })
    s().updateLayer('V', { x: 2 })
    expect(s().dirty).toBe(true)
    expect(api.saveProject).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(api.saveProject).toHaveBeenCalledTimes(1) // debounced into one write
    expect(api.saveProject).toHaveBeenLastCalledWith(root())
  })

  it('Save writes the file, drops the pending autosave and clears unsaved', async () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().updateLayer('V', { x: 1 })
    await s().save()
    expect(api.saveProjectFile).toHaveBeenCalledWith(root())
    expect(s().dirty).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(api.saveProject).not.toHaveBeenCalled()
  })

  it('an edit made while Save is writing stays unsaved', async () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().updateLayer('V', { x: 1 })
    let finish!: () => void
    api.saveProjectFile.mockImplementationOnce((p: Project) => new Promise((r) => (finish = () => r(p))))
    const saving = s().save()
    s().updateLayer('V', { x: 2 })
    finish()
    await saving
    expect(s().dirty).toBe(true)
  })

  it('a canceled Save As still makes the autosave it dropped', async () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().updateLayer('V', { x: 1 })
    await s().saveAs()
    vi.advanceTimersByTime(400)
    expect(api.saveProject).toHaveBeenCalledTimes(1)
  })

  it('a library change marks the project unsaved and autosaves it', () => {
    open()
    s().markLibraryChanged()
    expect(s().dirty).toBe(true)
    vi.advanceTimersByTime(400)
    expect(api.saveProject).toHaveBeenCalledTimes(1)
  })
})

describe('switching documents', () => {
  it('opening a project resets history, selection, playhead and the comp being edited', async () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().updateLayer('V', { x: 1 })
    useUi.getState().selectLayer('V')
    usePlayback.setState({ time: 3, playing: true })
    useProject.setState({ dirty: false })
    const other = { ...createEmptyProject('p2', 'Other') }
    api.openProjectFile.mockResolvedValueOnce({ project: other, path: 'C:/Reels/Other/Other.reel', dirty: false })
    await s().openFile()
    expect(root().id).toBe('p2')
    expect(s().filePath).toBe('C:/Reels/Other/Other.reel')
    expect(s().past).toEqual([])
    expect(s().editPath).toEqual([])
    expect(useUi.getState().selectedLayerId).toBeNull()
    expect(usePlayback.getState()).toMatchObject({ time: 0, playing: false })
  })

  it('asks before discarding unsaved changes, and stays if declined', async () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().updateLayer('V', { x: 1 })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await s().openFile()
    expect(confirm).toHaveBeenCalled()
    expect(api.openProjectFile).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})

describe('nested compositions', () => {
  const withCompound = (): void => {
    const inner = createEmptyComposition()
    inner.layers = [makeVideoLayer('IV', 'm1', 0, 3)]
    open([
      {
        id: 'C',
        hidden: false,
        startSec: 0,
        endSec: 3,
        x: 540,
        y: 960,
        scale: 1,
        content: { kind: 'compound', comp: inner }
      }
    ])
  }

  it('edits land in the comp being edited; leaving returns to the root', () => {
    withCompound()
    usePlayback.setState({ time: 2, playing: true })
    s().enterComposition({ layerId: 'C' })
    expect(usePlayback.getState()).toMatchObject({ time: 0, playing: false })
    s().addLayer(makeTextLayer('T', 0, 1))
    expect(activeComp(s())!.layers.map((l) => l.id)).toEqual(['IV', 'T'])
    expect(root().layers.map((l) => l.id)).toEqual(['C'])
    s().exitComposition()
    expect(s().editPath).toEqual([])
  })

  it("undoing past the comp's creation leaves it rather than dangle", () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().convertLayerToComp('V')
    s().enterComposition({ layerId: 'V' })
    expect(s().editPath).toHaveLength(1)
    useUi.getState().selectLayer('V')
    s().undo()
    expect(s().editPath).toEqual([])
    expect(useUi.getState().selectedLayerId).toBeNull()
  })

  it('a compound clip keeps its window and stack slot, with a reset transform', () => {
    const v = { ...makeVideoLayer('V', 'm1', 1, 4), x: 300, scale: 0.5 }
    open([v])
    s().convertLayerToComp('V')
    expect(layer('V')).toMatchObject({ startSec: 1, endSec: 5, x: 540, y: 960, scale: 1 })
    expect(layer('V').content.kind).toBe('compound')
  })
})

describe('layers', () => {
  it('a clip added with its audio lands linked to it, the video muted', () => {
    open()
    s().addVideoLayer('V', 'm1', 2, 5, true)
    const a = root().audioClips[0]
    expect(layer('V').linkGroupId).toBeTruthy()
    expect(a.linkGroupId).toBe(layer('V').linkGroupId)
    expect(a).toMatchObject({ mediaId: 'm1', startSec: 2, inSec: 0, outSec: 5 })
    expect(videoOf('V').mute).toBe(true)
    // …and without audio, alone.
    s().addVideoLayer('W', 'm1', 0, 2)
    expect(layer('W').linkGroupId).toBeUndefined()
    expect(root().audioClips).toHaveLength(1)
  })

  it('speed changes re-time the clip; 1× is stored as no speed', () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().setVideoSpeed('V', 2)
    expect(layer('V').endSec).toBeCloseTo(2)
    s().setVideoSpeed('V', 1)
    expect(videoOf('V').speed).toBeUndefined()
    expect(layer('V').endSec).toBeCloseTo(4)
  })

  it('speed-ramp edits keep the window equal to the played length', () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    const window = (): number => layer('V').endSec - layer('V').startSec
    s().addSpeedKeyframe('V', 0)
    s().addSpeedKeyframe('V', 2)
    s().updateSpeedKeyframe('V', 1, 3)
    expect(videoOf('V').speedRamp).toHaveLength(2)
    expect(window()).toBeCloseTo(playedVideoDuration(videoOf('V')))
    s().removeSpeedKeyframe('V', 0)
    expect(window()).toBeCloseTo(playedVideoDuration(videoOf('V')))
    s().clearSpeedRamp('V')
    expect(videoOf('V').speedRamp).toBeUndefined()
    expect(window()).toBeCloseTo(4)
  })

  it('a freeze lengthens the clip by its hold; removing it gives the time back', () => {
    open([makeVideoLayer('V', 'm1', 0, 4)])
    s().addFreeze('V', 9, 1.5) // past the out-point: clamped to it
    expect(videoOf('V').freezes).toEqual([{ atSec: 4, holdSec: 1.5 }])
    expect(layer('V').endSec).toBeCloseTo(5.5)
    s().removeFreeze('V', 0)
    expect(videoOf('V').freezes).toBeUndefined()
    expect(layer('V').endSec).toBeCloseTo(4)
  })

  it('keyframes are added only where they drive the transform; full opacity is stored as absence', () => {
    open([makeVideoLayer('V', 'm1', 0, 4), makeTextLayer('T', 0, 4), makeLayoutLayer('L', 'split-lr', 0, 4)])
    s().addLayerKeyframe('V', 1)
    expect(layer('V').keyframes).toEqual([{ tSec: 1, x: 540, y: 960, scale: layer('V').scale }])
    s().setLayerKeyframeOpacity('V', 0, 0.4)
    expect(layer('V').keyframes![0].opacity).toBe(0.4)
    s().setLayerKeyframeOpacity('V', 0, 1)
    expect(layer('V').keyframes![0].opacity).toBeUndefined()
    s().addLayerKeyframe('T', 1)
    s().addLayerKeyframe('L', 1)
    expect(layer('T').keyframes).toBeUndefined()
    expect(layer('L').keyframes).toBeUndefined()
    s().removeLayerKeyframe('V', 0)
    expect(layer('V').keyframes).toBeUndefined()
  })

  it("a re-timed clip's audio can't be extracted; a 1× clip's can", () => {
    open([makeVideoLayer('V', 'm1', 0, 4), makeVideoLayer('W', 'm1', 0, 4)])
    s().setVideoSpeed('V', 2)
    s().extractLayerAudio('V')
    expect(root().audioClips).toHaveLength(0)
    s().extractLayerAudio('W')
    expect(root().audioClips).toHaveLength(1)
    expect(videoOf('W').mute).toBe(true)
    expect(root().audioClips[0].linkGroupId).toBeUndefined() // extracting does NOT link
  })

  it('deleting clears a selection of what was deleted', () => {
    open([makeVideoLayer('V', 'm1', 0, 4), makeVideoLayer('W', 'm1', 0, 4)])
    useUi.getState().selectLayer('V')
    s().removeLayer('V')
    expect(useUi.getState().selectedLayerId).toBeNull()
    useUi.getState().selectLayer('W')
    s().removeItems([{ kind: 'layer', id: 'W' }])
    expect(useUi.getState().selection).toEqual([])
    expect(root().layers).toEqual([])
  })
})

describe('captions, audio and levels', () => {
  it('new caption text without words re-times the words to it', () => {
    open()
    s().addCaption({ id: 'S', startSec: 0, endSec: 2, text: 'one two', words: [], enabled: true })
    s().updateCaption('S', { text: 'one two three' })
    const seg = root().captions.segments[0]
    expect(seg.words.map((w) => w.text)).toEqual(['one', 'two', 'three'])
    expect(root().captions.enabled).toBe(true)
  })

  it('splitting an unlinked clip on silence keeps only the speech', () => {
    open([], [clip('A', { startSec: 5, inSec: 1, outSec: 9, fadeInSec: 1 })])
    s().splitAudioOnSilence('A', [
      { start: 1, end: 3 },
      { start: 6, end: 8 }
    ])
    expect(root().audioClips.map((a) => [a.startSec, a.inSec, a.outSec, a.fadeInSec])).toEqual([
      [5, 1, 3, 0],
      [10, 6, 8, 0]
    ])
  })

  it('a volume level is created with the clips that asked, and only real levels can be joined', () => {
    open([], [clip('A'), clip('B')])
    const id = s().createVolumeLevel('Voice', ['A'])
    expect(root().volumeLevels.map((l) => l.name)).toContain('Voice')
    expect(root().audioClips.map((a) => a.volumeLevelId)).toEqual([id, undefined])
    const steps = s().past.length
    s().setClipsVolumeLevel(['B'], 'no-such-level')
    expect(s().past).toHaveLength(steps)
    s().setClipsVolumeLevel(['B'], id)
    expect(root().audioClips[1].volumeLevelId).toBe(id)
    s().deleteVolumeLevel(id)
    expect(root().volumeLevels.some((l) => l.id === id)).toBe(false)
    expect(root().audioClips.every((a) => a.volumeLevelId !== id)).toBe(true)
  })

  it('project-wide settings and the media list', () => {
    open()
    s().setPreset('square')
    s().addMedia(['m1', 'm2'])
    s().addMedia(['m2', 'm3'])
    expect(root().mediaIds).toEqual(['m1', 'm2', 'm3'])
    s().removeMedia('m2')
    expect(root().mediaIds).toEqual(['m1', 'm3'])
    expect(root().preset).toBe('square')
    const steps = s().past.length
    s().setDenoiseDefault(root().denoiseDefault) // unchanged: no step
    expect(s().past).toHaveLength(steps)
  })
})
