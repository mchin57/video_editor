import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { beginInteraction, idle, interactionOpen, resetInteractionsForTest, whenIdle } from './interaction'

const tick = (): Promise<void> => new Promise((r) => queueMicrotask(r))

afterEach(() => resetInteractionsForTest())

describe('interaction lock', () => {
  it('runs a call at once when nothing is open', () => {
    const ran: string[] = []
    whenIdle(() => ran.push('a'))
    expect(ran).toEqual(['a'])
  })

  it('holds calls while open and runs them in order after the close, not inside it', async () => {
    const end = beginInteraction()
    const ran: string[] = []
    whenIdle(() => ran.push('a'))
    whenIdle(() => ran.push('b'))
    expect(interactionOpen()).toBe(true)
    end()
    expect(interactionOpen()).toBe(false)
    expect(ran).toEqual([]) // the releasing handler finishes (commits) first
    await tick()
    expect(ran).toEqual(['a', 'b'])
  })

  it('waits for the LAST of overlapping interactions', async () => {
    const endA = beginInteraction()
    const endB = beginInteraction()
    const ran: string[] = []
    whenIdle(() => ran.push('x'))
    endA()
    await tick()
    expect(ran).toEqual([])
    endB()
    await tick()
    expect(ran).toEqual(['x'])
  })

  it('a close function called twice cannot close another interaction', async () => {
    const endA = beginInteraction()
    beginInteraction()
    endA()
    endA()
    expect(interactionOpen()).toBe(true)
  })

  it('a call arriving while the flush is pending keeps its place behind the queue', async () => {
    const end = beginInteraction()
    const ran: string[] = []
    whenIdle(() => ran.push('queued'))
    end()
    whenIdle(() => ran.push('late')) // idle, but must not jump ahead of 'queued'
    expect(ran).toEqual([])
    await tick()
    expect(ran).toEqual(['queued', 'late'])
  })

  it('idle() resolves at once when nothing is open, and only after the release otherwise', async () => {
    await idle() // would time out if it never resolved
    const end = beginInteraction()
    let resolved = false
    void idle().then(() => (resolved = true))
    await tick()
    await tick()
    expect(resolved).toBe(false)
    end()
    await tick()
    await tick()
    expect(resolved).toBe(true)
  })

  it('a throwing call does not strand the ones behind it', async () => {
    const end = beginInteraction()
    const ran: string[] = []
    whenIdle(() => {
      throw new Error('boom')
    })
    whenIdle(() => ran.push('after'))
    end()
    await tick()
    expect(ran).toEqual(['after'])
  })
})

describe('startPointerDrag holds the lock', () => {
  let startPointerDrag: (onMove: (ev: PointerEvent) => void, onUp?: (ev: PointerEvent) => void) => void
  beforeAll(async () => {
    // pointerDrag pulls in the project store → ipc/client, which reads window.api at load.
    ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => () => undefined })
    startPointerDrag = (await import('./pointerDrag')).startPointerDrag
  })

  for (const release of ['pointerup', 'pointercancel']) {
    it(`from start until ${release}, closing after onUp has run`, () => {
      let openDuringUp: boolean | null = null
      startPointerDrag(
        () => {},
        () => (openDuringUp = interactionOpen())
      )
      expect(interactionOpen()).toBe(true)
      window.dispatchEvent(new Event(release))
      expect(openDuringUp).toBe(true)
      expect(interactionOpen()).toBe(false)
    })
  }

  it('closes even when onUp throws', () => {
    startPointerDrag(
      () => {},
      () => {
        throw new Error('boom')
      }
    )
    const up = new Event('pointerup')
    // jsdom reports listener errors instead of throwing them out of dispatchEvent.
    const swallow = (e: ErrorEvent): void => e.preventDefault()
    window.addEventListener('error', swallow)
    window.dispatchEvent(up)
    window.removeEventListener('error', swallow)
    expect(interactionOpen()).toBe(false)
  })
})
