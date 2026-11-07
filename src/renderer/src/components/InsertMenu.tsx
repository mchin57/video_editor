import { type JSX } from 'react'
import { SHARED_KINDS, SHARED_KIND_LABELS } from '@shared/sharedLibrary'
import { insertCaption, insertGraphics, insertText } from '@/lib/insert'
import { useUi } from '@/state/ui'
import { MENU_SEPARATOR, useContextMenu, type ContextMenuEntry } from './ui'

/** The rows, built when the menu opens (Save needs the current selection). */
const items = (): ContextMenuEntry[] => {
  const ui = useUi.getState()
  return [
    { label: 'Text', hint: 'T', onSelect: insertText, testId: 'insert-text' },
    { label: 'Caption', onSelect: insertCaption, testId: 'insert-caption' },
    { label: 'Graphics', onSelect: insertGraphics, testId: 'insert-graphics' },
    MENU_SEPARATOR,
    {
      label: 'Shared',
      testId: 'insert-shared',
      submenu: [
        ...SHARED_KINDS.map((tab): ContextMenuEntry => ({
          label: `${SHARED_KIND_LABELS[tab]}…`,
          onSelect: () => ui.setSharedOpen({ tab }),
          testId: `insert-shared-${tab}`
        })),
        MENU_SEPARATOR,
        { label: 'Templates…', onSelect: () => ui.setTemplatesOpen('gallery'), testId: 'insert-template' }
      ]
    },
    {
      label: 'Save selection as template…',
      onSelect: () => ui.setTemplatesOpen('save'),
      disabled: ui.selection.length === 0,
      reason: 'Select the pieces on the timeline first.',
      testId: 'insert-save-template'
    }
  ]
}

/**
 * Insert menu: put a new text layer, caption or graphics tile (shapes and
 * telestrator marks) at the playhead; or, under Shared, something from the
 * editor-wide shared library (sounds, graphics, video, saved text —
 * `SharedDialog`) or a template (`TemplatesDialog`); or save the selection as
 * a template. The rows open in the shared menu under the button, so they get
 * its keyboard handling; the actions live in `lib/insert.ts` and the dialogs.
 */
export function InsertMenu(): JSX.Element {
  const menu = useContextMenu()
  return (
    <div className="relative flex items-center">
      <button
        data-testid="insert-menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          menu.openAt(r.left, r.bottom + 4, items())
        }}
        className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20"
      >
        Insert ▾
      </button>
      {menu.menu}
    </div>
  )
}
