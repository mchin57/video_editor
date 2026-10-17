import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ContextMenu as Menu, ContextMenuEntry } from './ui'

let ContextMenu: typeof Menu
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(async () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // ui.tsx reaches ipc/client (through the project store), which destructures window.api at load.
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => () => undefined })
  ;({ ContextMenu } = await import('./ui'))
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = host = null
})

function render(items: ContextMenuEntry[]): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />))
  return { onClose }
}

const row = (testId: string): HTMLElement => document.querySelector(`[data-testid="${testId}"]`)!
const panels = (): NodeListOf<Element> => document.querySelectorAll('[data-testid="context-menu"]')
const key = (k: string, target: Element = document.activeElement ?? document.body): void =>
  act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))

describe('ContextMenu', () => {
  it('a chosen row closes the menu, then runs', () => {
    const order: string[] = []
    const { onClose } = render([{ label: 'Rename…', testId: 'r', onSelect: () => order.push('select') }])
    onClose.mockImplementation(() => order.push('close'))
    act(() => row('r').click())
    expect(order).toEqual(['close', 'select'])
  })

  it('a disabled row shows its reason and does nothing', () => {
    const onSelect = vi.fn()
    const { onClose } = render([
      { label: 'Rename…', testId: 'r', disabled: true, reason: 'The file is missing.', onSelect }
    ])
    expect(row('r').getAttribute('aria-disabled')).toBe('true')
    expect(row('r').textContent).toContain('The file is missing.')
    expect(row('r').title).toBe('The file is missing.')
    act(() => row('r').click())
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape and on a press outside, not on a press inside', () => {
    const { onClose } = render([{ label: 'A', testId: 'a' }])
    act(() => void row('a').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(onClose).not.toHaveBeenCalled()
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
    key('Escape', document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on a scroll anywhere outside it', () => {
    const { onClose } = render([{ label: 'A', testId: 'a' }])
    act(() => void document.body.dispatchEvent(new Event('scroll')))
    expect(onClose).toHaveBeenCalled()
  })

  it('opens a submenu on hover and on ArrowRight; its rows select and close the whole menu', () => {
    const pick = vi.fn()
    const { onClose } = render([
      { label: 'Rename…', testId: 'r' },
      {
        label: 'Add to volume level',
        testId: 'levels',
        submenu: [
          { label: 'Default', testId: 'lvl-default', checked: true, onSelect: () => pick('default') },
          { label: 'Voice', testId: 'lvl-voice', checked: false, onSelect: () => pick('voice') }
        ]
      }
    ])
    expect(panels()).toHaveLength(1)
    // Hover opens it; hovering a plain row closes it again.
    // (React derives mouseenter from the mouseout of the node the pointer left.)
    const hover = (from: string, to: string): void =>
      act(() => void row(from).dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: row(to) })))
    hover('r', 'levels')
    expect(panels()).toHaveLength(2)
    expect(row('lvl-default').textContent).toContain('✓')
    hover('levels', 'r')
    expect(panels()).toHaveLength(1)

    // Keyboard: ArrowDown to the row, ArrowRight opens and focuses the first sub-row.
    key('ArrowDown')
    key('ArrowDown')
    expect(document.activeElement).toBe(row('levels'))
    key('ArrowRight')
    expect(panels()).toHaveLength(2)
    expect(document.activeElement).toBe(row('lvl-default'))
    key('ArrowLeft')
    expect(panels()).toHaveLength(1)
    expect(document.activeElement).toBe(row('levels'))

    // Clicking a sub-row picks it (once) and closes everything.
    key('ArrowRight')
    act(() => row('lvl-voice').click())
    expect(pick).toHaveBeenCalledTimes(1)
    expect(pick).toHaveBeenCalledWith('voice')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
