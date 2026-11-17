/**
 * The colour-table preview's React side, in jsdom.
 *
 * - `useTablePath`: a look that stops needing the table keeps it for a moment,
 *   so a slider dragged THROUGH neutral never drops and remakes the canvas.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ColorLook } from '@shared/grade'
import type * as GradeCanvasModule from './GradeCanvas'

let mod: typeof GradeCanvasModule
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(async () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // GradeCanvas reaches ipc/client (the LUT query), which destructures window.api at load.
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => () => new Promise(() => {}) })
  mod = await import('./GradeCanvas')
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = host = null
  vi.useRealTimers()
})

const neutral = { brightness: 0, contrast: 1, saturation: 1 }
const lut = (strength: number): ColorLook => ({ lut: { file: '0123456789abcdef.cube', name: 'Warm', strength } })

describe('useTablePath', () => {
  function Probe({ look, seen }: { look: ColorLook; seen: boolean[] }): JSX.Element {
    const table = mod.useTablePath(look)
    seen.push(table)
    return <i />
  }

  it('a LUT strength dragged through 0 stays on the table path; resting at 0 leaves it after the hold', () => {
    vi.useFakeTimers()
    const seen: boolean[] = []
    act(() => root!.render(<Probe look={lut(0.2)} seen={seen} />))
    act(() => root!.render(<Probe look={lut(0)} seen={seen} />))
    act(() => vi.advanceTimersByTime(mod.TABLE_PATH_HOLD_MS / 2))
    act(() => root!.render(<Probe look={lut(0.1)} seen={seen} />))
    expect(seen.every(Boolean)).toBe(true)
    act(() => root!.render(<Probe look={lut(0)} seen={seen} />))
    act(() => vi.advanceTimersByTime(mod.TABLE_PATH_HOLD_MS - 1))
    expect(seen.at(-1)).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(seen.at(-1)).toBe(false)
  })

  it('a legacy look (old sliders, a wash) never takes the table path', () => {
    vi.useFakeTimers()
    const seen: boolean[] = []
    const legacy: ColorLook = {
      color: { brightness: 0.2, contrast: 1.3, saturation: 1.4 },
      tint: { color: '#ffd999', amount: 0.3 }
    }
    act(() => root!.render(<Probe look={legacy} seen={seen} />))
    act(() => root!.render(<Probe look={{ color: { ...neutral, temperature: 0 } }} seen={seen} />))
    act(() => vi.advanceTimersByTime(mod.TABLE_PATH_HOLD_MS * 2))
    expect(seen.some(Boolean)).toBe(false)
  })
})
