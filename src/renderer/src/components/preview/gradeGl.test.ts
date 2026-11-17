/**
 * The colour-table renderer's lifecycle against a FAKE WebGL2 context (jsdom
 * has none): `dispose` frees what it made AND gives the context back
 * (`WEBGL_lose_context`), so graded clips coming and going never pile up past
 * Chromium's 16 live contexts; no WebGL2 at all is `null`.
 */
import { describe, expect, it, vi } from 'vitest'
import { createGradeGl } from './gradeGl'

/** A WebGL2 context where every call succeeds; `lost` flips with `loseContext`. */
function fakeGl() {
  let lost = false
  const loseContext = vi.fn(() => {
    lost = true
  })
  const calls = new Map<string, ReturnType<typeof vi.fn>>()
  const special: Record<string, unknown> = {
    isContextLost: () => lost,
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext, restoreContext: vi.fn() } : null),
    getShaderParameter: () => true,
    getProgramParameter: () => true
  }
  const gl = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in special) return special[prop]
        if (/^[A-Z0-9_]+$/.test(prop)) return prop // constants
        if (!calls.has(prop))
          calls.set(
            prop,
            vi.fn(() => ({ name: prop }))
          )
        return calls.get(prop)
      }
    }
  )
  return { gl, loseContext, calls }
}

const canvasWith = (ctx: unknown): HTMLCanvasElement =>
  ({ getContext: vi.fn(() => ctx), width: 0, height: 0 }) as unknown as HTMLCanvasElement

describe('createGradeGl', () => {
  it('dispose frees its objects and releases the context', () => {
    const { gl, loseContext, calls } = fakeGl()
    const g = createGradeGl(canvasWith(gl))!
    expect(g).not.toBeNull()
    expect(g.lost).toBe(false)
    g.dispose()
    expect(loseContext).toHaveBeenCalledTimes(1)
    expect(calls.get('deleteTexture')).toHaveBeenCalledTimes(2)
    expect(calls.get('deleteProgram')).toHaveBeenCalledTimes(1)
    expect(g.lost).toBe(true)
    // A second dispose (the context is gone already) does nothing more.
    g.dispose()
    expect(loseContext).toHaveBeenCalledTimes(1)
  })

  it('is null without WebGL2 (no context, or one already lost)', () => {
    expect(createGradeGl(canvasWith(null))).toBeNull()
    const { gl, loseContext } = fakeGl()
    loseContext()
    expect(createGradeGl(canvasWith(gl))).toBeNull()
  })
})

describe('draw', () => {
  it('draws nothing before a table; an upload that throws is NOT swallowed (the caller falls back)', () => {
    const { gl, calls } = fakeGl()
    const g = createGradeGl(canvasWith(gl))!
    const video = document.createElement('video')
    expect(g.draw(video, 16, 9)).toBe(false)
    g.setTable(2, new Float32Array(24))
    expect(g.draw(video, 16, 9)).toBe(true)
    calls.get('texImage2D')!.mockImplementation(() => {
      throw new DOMException('The video element contains cross-origin data', 'SecurityError')
    })
    expect(() => g.draw(video, 16, 9)).toThrow('cross-origin')
  })
})
