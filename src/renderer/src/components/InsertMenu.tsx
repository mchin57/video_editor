import { type JSX } from 'react'
import { insertCaption, insertGraphics, insertText } from '@/lib/insert'
import { useContextMenu, type ContextMenuEntry } from './ui'

const ITEMS: ContextMenuEntry[] = [
  { label: 'Text', hint: 'T', onSelect: insertText, testId: 'insert-text' },
  { label: 'Caption', onSelect: insertCaption, testId: 'insert-caption' },
  { label: 'Graphics', onSelect: insertGraphics, testId: 'insert-graphics' }
]

/**
 * Insert menu: put a new text layer, caption or graphics tile (shapes and
 * telestrator marks) at the playhead. The rows open in the shared menu under
 * the button, so they get its keyboard handling; the actions live in
 * `lib/insert.ts`.
 */
export function InsertMenu(): JSX.Element {
  const menu = useContextMenu()
  return (
    <div className="relative flex items-center">
      <button
        data-testid="insert-menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          menu.openAt(r.left, r.bottom + 4, ITEMS)
        }}
        className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20"
      >
        Insert ▾
      </button>
      {menu.menu}
    </div>
  )
}
