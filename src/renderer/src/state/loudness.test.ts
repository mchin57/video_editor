import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoudnessSeries } from '@shared/loudness'
import type { Project } from '@shared/project'

type Answer = { resolve: (s: LoudnessSeries | null) => void }
const answers: Answer[] = []
const getLoudness = vi.fn(
  () =>
    new Promise<LoudnessSeries | null>((resolve) => {
      answers.push({ resolve })
    })
)

let useLoudness: typeof import('./loudness').useLoudness
let useProject: typeof import('./projectStore').useProject

beforeAll(async () => {
  // ipc/client destructures window.api at load — stub it (getLoudness answered by hand).
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {},
    { get: (_t, key) => (key === 'getLoudness' ? getLoudness : () => undefined) }
  )
  ;({ useLoudness } = await import('./loudness'))
  ;({ useProject } = await import('./projectStore'))
})

const series = (m: number): LoudnessSeries => ({ version: 1, stepSec: 0.1, startSec: 0, momentary: [m], peak: [m] })
const open = (id: string, filePath: string): void => useProject.setState({ project: { id } as Project, filePath })
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(async () => {
  open('p1', 'C:/Reels/p1/p1.reel')
  useLoudness.getState().reset()
  answers.length = 0
  getLoudness.mockClear()
})

describe('the renderer loudness cache', () => {
  it('is cleared when another project is opened', async () => {
    useLoudness.getState().request('m')
    answers[0].resolve(null)
    await settle()
    expect(useLoudness.getState().series).toEqual({ m: null })
    open('p2', 'C:/Reels/p2/p2.reel')
    expect(useLoudness.getState().series).toEqual({})
  })

  it('drops an answer that was in flight for the previous project', async () => {
    useLoudness.getState().request('m')
    open('p2', 'C:/Reels/p2/p2.reel')
    answers[0].resolve(series(-20))
    await settle()
    expect(useLoudness.getState().series).toEqual({})
    // …and the new project's own request is not blocked by the stale one.
    useLoudness.getState().request('m')
    expect(getLoudness).toHaveBeenCalledTimes(2)
  })

  it('keeps its cache across edits to the same project', async () => {
    useLoudness.getState().request('m')
    answers[0].resolve(series(-20))
    await settle()
    useProject.setState({ project: { id: 'p1', name: 'edited' } as Project })
    expect(useLoudness.getState().series.m).toEqual(series(-20))
  })

  it('asks again for a series that came back null (a failure is not final)', async () => {
    useLoudness.getState().request('m')
    answers[0].resolve(null)
    await settle()
    useLoudness.getState().request('m')
    expect(getLoudness).toHaveBeenCalledTimes(2)
    answers[1].resolve(series(-18))
    await settle()
    expect(useLoudness.getState().series.m).toEqual(series(-18))
    // A real series is cached: no third request.
    useLoudness.getState().request('m')
    expect(getLoudness).toHaveBeenCalledTimes(2)
  })
})
