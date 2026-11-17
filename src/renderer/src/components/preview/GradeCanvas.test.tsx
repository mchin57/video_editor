/**
 * The colour-table preview's React side, in jsdom (no WebGL: `gradeGl` is
 * replaced by a fake whose draws the test controls).
 *
 * - `useTablePath`: a look that stops needing the table keeps it for a moment,
 *   so a slider dragged THROUGH neutral never drops and remakes the canvas.
 * - `useGradeView` + `GradeCanvas`, wired as the preview's layers wire them: the
 *   plain element stays visible until the canvas has drawn its first frame.
 * - A source WebGL can't read (a picture that won't load with CORS, an upload
 *   that throws) falls back to the plain element with the notice, logged.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ColorLook } from '@shared/grade'
import { setLogSink, type LogEntry } from '@shared/log'
import type * as GradeCanvasModule from './GradeCanvas'

/** What the fake WebGL does: whether a context can be made, and whether a draw puts a picture up. */
const gl = vi.hoisted(() => ({ available: true, drawOk: false, drawThrows: false, draws: 0 }))

vi.mock('./gradeGl', () => ({
  MAX_GRADED_IMAGE_SIDE: 2048,
  createGradeGl: () =>
    gl.available
      ? {
          lost: false,
          setTable: () => {},
          draw: () => {
            gl.draws++
            if (gl.drawThrows) throw new DOMException('The video element contains cross-origin data', 'SecurityError')
            return gl.drawOk
          },
          dispose: () => {}
        }
      : null
}))

/** IPC calls the test answers (others never settle). */
const api: Record<string, (...a: unknown[]) => Promise<unknown>> = {}

let mod: typeof GradeCanvasModule
let qc: QueryClient
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(async () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // GradeCanvas reaches ipc/client (the LUT query), which destructures window.api at load.
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        (...a: unknown[]) =>
          api[name]?.(...a) ?? new Promise(() => {})
    }
  )
  mod = await import('./GradeCanvas')
})

beforeEach(() => {
  Object.assign(gl, { available: true, drawOk: false, drawThrows: false, draws: 0 })
  for (const k of Object.keys(api)) delete api[k]
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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

/** A clip as `VideoLayerView` draws it: the plain <video>, the canvas over it, the notice. */
function GradedClip({ look }: { look: ColorLook }): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const g = mod.useGradeView(look)
  return (
    <div>
      <video ref={ref} data-testid="plain" style={g.hideElement ? { opacity: 0 } : {}} />
      {g.graded && <mod.GradeCanvas look={look} video={ref} style={{}} onStatus={g.onStatus} onDrawn={g.onDrawn} />}
      {g.graded && <mod.GradeNotice status={g.status} lutName={look.lut?.name} />}
    </div>
  )
}

const show = (look: ColorLook): void =>
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <GradedClip look={look} />
      </QueryClientProvider>
    )
  )
const plain = (): HTMLVideoElement => document.querySelector('[data-testid="plain"]') as HTMLVideoElement
const visible = (el: HTMLElement): boolean => el.style.opacity !== '0'
/** Pretend the <video> has a decoded frame (jsdom never loads one), then fire `ev`. */
function frameReady(ev: string): void {
  const v = plain()
  Object.defineProperty(v, 'readyState', { value: 4, configurable: true })
  Object.defineProperty(v, 'videoWidth', { value: 16, configurable: true })
  Object.defineProperty(v, 'videoHeight', { value: 9, configurable: true })
  act(() => void v.dispatchEvent(new Event(ev)))
}

describe('the plain element under a graded canvas', () => {
  const warm: ColorLook = { color: { ...neutral, temperature: 0.5 } }

  it('stays visible until the canvas has drawn its first frame, then hides', () => {
    show(warm)
    expect(document.querySelector('[data-testid="grade-canvas"]')).not.toBeNull()
    expect(visible(plain()), 'visible before any draw').toBe(true)
    // A draw that puts nothing up (no table yet, a frame not ready): still visible.
    frameReady('loadeddata')
    expect(gl.draws).toBeGreaterThan(0)
    expect(visible(plain())).toBe(true)
    // The first real picture: now the canvas covers it.
    gl.drawOk = true
    frameReady('seeked')
    expect(visible(plain()), 'hidden once the canvas drew').toBe(false)
    // Going back to a legacy look drops the canvas: the element shows again at once
    // (once the hold is over).
    vi.useFakeTimers()
    show({ color: { ...neutral, brightness: 0.1 } })
    act(() => vi.advanceTimersByTime(mod.TABLE_PATH_HOLD_MS))
    expect(document.querySelector('[data-testid="grade-canvas"]')).toBeNull()
    expect(visible(plain())).toBe(true)
  })
})

/** A picture as `StackImage` draws it: the plain <img>, the canvas loading its own CORS copy, the notice. */
function GradedPicture({ look, src }: { look: ColorLook; src: string }): JSX.Element {
  const g = mod.useGradeView(look)
  return (
    <div>
      {g.graded && <mod.GradeNotice status={g.status} lutName={look.lut?.name} />}
      <img data-testid="plain" src={src} alt="" style={g.hideElement ? { opacity: 0 } : {}} />
      {g.graded && <mod.GradeCanvas look={look} imageSrc={src} style={{}} onStatus={g.onStatus} onDrawn={g.onDrawn} />}
    </div>
  )
}

describe('when WebGL cannot read the media', () => {
  const warm: ColorLook = { color: { ...neutral, temperature: 0.5 } }
  const notice = (): string | null => document.querySelector('[data-testid="grade-warning"]')?.textContent ?? null
  let logged: LogEntry[]
  beforeEach(() => {
    logged = []
    setLogSink((e) => logged.push(e))
  })
  afterEach(() => setLogSink(null))

  it('a picture that will not load for WebGL shows plain, with the notice, and is logged', () => {
    const made: HTMLImageElement[] = []
    const RealImage = window.Image
    vi.stubGlobal(
      'Image',
      class extends RealImage {
        constructor() {
          super()
          made.push(this)
        }
      }
    )
    try {
      act(() =>
        root!.render(
          <QueryClientProvider client={qc}>
            <GradedPicture look={warm} src="reelmedia://project/pic.png" />
          </QueryClientProvider>
        )
      )
    } finally {
      vi.unstubAllGlobals()
    }
    expect(made).toHaveLength(1)
    expect(made[0].crossOrigin).toBe('anonymous')
    act(() => void made[0].dispatchEvent(new Event('error')))
    expect(visible(plain())).toBe(true)
    expect(notice()).toContain('WebGL couldn’t read this media')
    expect(logged).toContainEqual(
      expect.objectContaining({ level: 'warn', scope: 'grade-preview', message: expect.stringContaining('picture') })
    )
  })

  it('a frame whose upload throws falls back to the plain clip, with the notice, and is logged once', () => {
    show(warm)
    gl.drawOk = true
    frameReady('seeked')
    expect(visible(plain())).toBe(false)
    gl.drawThrows = true
    frameReady('seeked')
    frameReady('seeked')
    expect(visible(plain()), 'the plain clip is back').toBe(true)
    expect(notice()).toContain('WebGL couldn’t read this media')
    const warns = logged.filter((e) => e.message.includes('could not read the frame'))
    expect(warns).toHaveLength(1)
    expect(warns[0].error).toBeInstanceOf(DOMException)
  })
})
