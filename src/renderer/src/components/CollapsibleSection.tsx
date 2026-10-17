import type { JSX, ReactNode } from 'react'
import { boolPref } from '@/lib/persisted'
import { usePersistedState } from '@/hooks/usePersistedState'

const OPEN_BY_DEFAULT = boolPref(true)
const CLOSED_BY_DEFAULT = boolPref(false)

/**
 * An Inspector sub-section with a click-to-collapse header. Open/closed state is
 * remembered per `id` in localStorage so the Inspector stays as tidy as the user
 * left it across reloads and selections.
 */
export function CollapsibleSection({
  id,
  title,
  defaultOpen = true,
  right,
  children
}: {
  id: string
  title: string
  defaultOpen?: boolean
  /** Optional control rendered at the right of the header (stops propagation). */
  right?: ReactNode
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = usePersistedState(
    `inspector.section.${id}`,
    defaultOpen ? OPEN_BY_DEFAULT : CLOSED_BY_DEFAULT
  )
  const toggle = (): void => setOpen((o) => !o)

  return (
    <div className="border-t border-white/5 first:border-t-0">
      <div className="flex items-center justify-between">
        <button
          onClick={toggle}
          className="flex flex-1 items-center gap-1.5 py-2 text-left text-[10px] font-medium uppercase tracking-wide text-zinc-400 hover:text-zinc-200"
        >
          <span className={`text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
          {title}
        </button>
        {right && <div onClick={(e) => e.stopPropagation()}>{right}</div>}
      </div>
      {open && <div className="pb-2">{children}</div>}
    </div>
  )
}
