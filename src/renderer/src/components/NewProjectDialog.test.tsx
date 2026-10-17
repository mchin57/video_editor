import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NewProjectDialog as Dialog } from './NewProjectDialog'

type Props = ComponentProps<typeof Dialog>
let NewProjectDialog: typeof Dialog
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(async () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // ui.tsx pulls in the project store, which transitively imports ipc/client
  // (destructures window.api at load) — stub it before importing.
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => () => undefined })
  ;({ NewProjectDialog } = await import('./NewProjectDialog'))
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = host = null
})

function render(over: Partial<Props> = {}): Props {
  const props: Props = {
    open: true,
    onClose: vi.fn(),
    defaultLocation: 'C:\\Users\\me\\Videos',
    onChooseLocation: vi.fn(async () => null),
    onCreate: vi.fn(async () => {}),
    ...over
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<NewProjectDialog {...props} />))
  return props
}

const $ = <T extends HTMLElement>(id: string): T | null => document.querySelector<T>(`[data-testid="${id}"]`)

function type(value: string): void {
  const input = $<HTMLInputElement>('new-project-name')!
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(target: EventTarget, k: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

describe('NewProjectDialog', () => {
  it('disables Create while the name is invalid and explains why once typed', () => {
    render()
    const create = $<HTMLButtonElement>('new-project-create')!
    expect(create.disabled).toBe(true)
    expect($('new-project-name-reason')).toBeNull() // not before the user types

    type('con')
    expect(create.disabled).toBe(true)
    expect($('new-project-name-reason')?.textContent).toMatch(/reserved/i)

    type('My Reel')
    expect(create.disabled).toBe(false)
    expect($('new-project-name-reason')).toBeNull()
    expect($('new-project-dialog')!.textContent).toContain('C:\\Users\\me\\Videos\\My Reel')
  })

  it('Enter submits the trimmed name and location', () => {
    const props = render()
    type('  Trip  ')
    key($('new-project-name')!, 'Enter')
    expect(props.onCreate).toHaveBeenCalledWith('Trip', 'C:\\Users\\me\\Videos')
  })

  it('Enter does nothing while the name is invalid', () => {
    const props = render()
    type('bad|name')
    key($('new-project-name')!, 'Enter')
    expect(props.onCreate).not.toHaveBeenCalled()
  })

  it('shows a rejection inline and stays open', async () => {
    let reject!: (e: Error) => void
    const props = render({ onCreate: vi.fn(() => new Promise<void>((_, r) => (reject = r))) })
    type('Trip')
    key($('new-project-name')!, 'Enter')
    // Busy while pending.
    expect($<HTMLInputElement>('new-project-name')!.disabled).toBe(true)
    expect($<HTMLButtonElement>('new-project-create')!.disabled).toBe(true)

    await act(async () => reject(new Error('A folder named Trip already exists there.')))
    expect($('new-project-error')?.textContent).toBe('A folder named Trip already exists there.')
    expect($('new-project-dialog')).not.toBeNull()
    expect($<HTMLInputElement>('new-project-name')!.disabled).toBe(false)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('uses the chosen location', async () => {
    const props = render({ onChooseLocation: vi.fn(async () => 'D:\\Reels') })
    await act(async () => $<HTMLButtonElement>('new-project-choose')!.click())
    expect(props.onChooseLocation).toHaveBeenCalledWith('C:\\Users\\me\\Videos')
    expect($('new-project-location')!.textContent).toBe('D:\\Reels')
    expect($('new-project-location')!.title).toBe('D:\\Reels')
  })

  it('Escape cancels', () => {
    const a = render()
    key($('new-project-name')!, 'Escape')
    expect(a.onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape and hides Cancel when canCancel is false', () => {
    const b = render({ canCancel: false })
    key($('new-project-name')!, 'Escape')
    key(window, 'Escape')
    expect(b.onClose).not.toHaveBeenCalled()
    expect([...document.querySelectorAll('button')].some((btn) => btn.textContent === 'Cancel')).toBe(false)
  })
})
