import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverIntent } from './hoverIntent'

const timers = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  clear: (id: number) => clearTimeout(id)
}

describe('HoverIntent', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const make = (opts: { openMs?: number } = {}): { h: HoverIntent<string>; seen: (string | null)[] } => {
    const seen: (string | null)[] = []
    const h = new HoverIntent<string>((t) => seen.push(t), { closeMs: 160, timers, ...opts })
    return { h, seen }
  }

  it('opens at once and closes only after the grace period', () => {
    const { h, seen } = make()
    h.enter('a')
    expect(h.current).toBe('a')
    h.leave()
    vi.advanceTimersByTime(150)
    expect(h.current).toBe('a')
    vi.advanceTimersByTime(20)
    expect(h.current).toBeNull()
    expect(seen).toEqual(['a', null])
  })

  it('stays open while the cursor crosses from the target onto the panel', () => {
    const { h } = make()
    h.enter('a')
    h.leave() // off the target…
    vi.advanceTimersByTime(100)
    h.enter() // …onto the bridge / panel
    vi.advanceTimersByTime(1000)
    expect(h.current).toBe('a')
  })

  it('waits openMs before the first open; a quick pass never opens', () => {
    const { h, seen } = make({ openMs: 350 })
    h.enter('a')
    vi.advanceTimersByTime(200)
    h.leave()
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([])
    h.enter('a')
    vi.advanceTimersByTime(350)
    expect(h.current).toBe('a')
  })

  it('switches straight to another target while open', () => {
    const { h } = make({ openMs: 350 })
    h.enter('a')
    vi.advanceTimersByTime(350)
    h.leave()
    h.enter('b')
    expect(h.current).toBe('b')
  })

  it('a pinned panel stays open after the cursor leaves, and closes once unpinned', () => {
    const { h } = make()
    h.enter('a')
    h.pin(true)
    h.leave()
    vi.advanceTimersByTime(5000)
    expect(h.current).toBe('a')
    h.pin(false)
    vi.advanceTimersByTime(170)
    expect(h.current).toBeNull()
  })

  it('unpinning with the cursor still inside keeps it open', () => {
    const { h } = make()
    h.enter('a')
    h.pin(true)
    h.pin(false)
    vi.advanceTimersByTime(5000)
    expect(h.current).toBe('a')
  })

  it('unpinning with the live hover state corrects a leave that never arrived', () => {
    const { h } = make()
    h.enter('a')
    h.pin(true)
    // (the cursor left the focused box but no mouseleave fired)
    h.pin(false, false)
    vi.advanceTimersByTime(170)
    expect(h.current).toBeNull()
  })

  it('close() closes now, pinned or not', () => {
    const { h } = make()
    h.enter('a')
    h.pin(true)
    h.close()
    expect(h.current).toBeNull()
  })
})
