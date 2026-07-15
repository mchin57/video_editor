import type { JSX, ReactNode } from 'react'

/** Shared chrome for every dockable panel — the single place to change how
 *  panel bodies look/behave as a class. Content components render inside a
 *  sized, clipping box and are expected to fill it (they all do). */
export function DockPanel({ children }: { children: ReactNode }): JSX.Element {
  return <div className="h-full min-h-0 overflow-hidden bg-[#0b0b0f] text-zinc-200">{children}</div>
}
