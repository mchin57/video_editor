import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { boolPref } from '@/lib/persisted'
import { usePersistedState } from './usePersistedState'

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = host = null
  localStorage.clear()
})

const OPEN = boolPref(true)

function Toggle({ id }: { id: string }): JSX.Element {
  const [open, setOpen] = usePersistedState(`section.${id}`, OPEN)
  return <button onClick={() => setOpen((o) => !o)}>{open ? 'open' : 'closed'}</button>
}

const mount = (id: string): HTMLButtonElement => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<Toggle id={id} />))
  return host.querySelector('button')!
}

describe('usePersistedState', () => {
  it('starts from the default and never writes it', () => {
    const button = mount('a')
    expect(button.textContent).toBe('open')
    expect(localStorage.getItem('section.a')).toBeNull()
  })

  it('saves each change and restores it on the next mount', () => {
    const button = mount('b')
    act(() => button.click())
    expect(button.textContent).toBe('closed')
    expect(localStorage.getItem('section.b')).toBe('0')

    act(() => root!.unmount())
    host!.remove()
    expect(mount('b').textContent).toBe('closed')
  })
})
