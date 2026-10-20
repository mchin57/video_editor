import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, useEffect, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useLatest } from './useLatest'

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = host = null
})

describe('useLatest', () => {
  it('a callback registered once sees the latest value, and effects see it too', () => {
    const seenByEffect: number[] = []
    let readLater: (() => number) | null = null
    function Probe({ n }: { n: number }): JSX.Element {
      const latest = useLatest(n)
      useEffect(() => {
        // Registered once, like a window listener.
        readLater = () => latest.current
      }, [latest])
      useEffect(() => {
        seenByEffect.push(latest.current)
      })
      return <span>{n}</span>
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<Probe n={1} />))
    act(() => root!.render(<Probe n={2} />))
    act(() => root!.render(<Probe n={3} />))
    expect(readLater!()).toBe(3)
    expect(seenByEffect).toEqual([1, 2, 3])
  })
})
