import type { JSX, ReactNode } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useProject } from '@/state/projectStore'

/** Shared chrome for every dockable panel — the single place to change how
 *  panel bodies look/behave as a class. Content components render inside a
 *  sized, clipping box and are expected to fill it (they all do). Each panel
 *  has its own error boundary, so one panel's render error can't unmount the
 *  whole window (which also closed every dock panel and autosaved that empty
 *  layout). */
export function DockPanel({ children }: { children: ReactNode }): JSX.Element {
  // Any project change (an undo, a fix in another panel) retries the panel.
  const project = useProject((s) => s.project)
  return (
    <div className="h-full min-h-0 overflow-hidden bg-[#0b0b0f] text-zinc-200">
      <ErrorBoundary label="Dock panel" resetKey={project} fallback={panelFallback}>
        {children}
      </ErrorBoundary>
    </div>
  )
}

function panelFallback(error: Error, retry: () => void): JSX.Element {
  return (
    <div role="alert" data-testid="panel-error" className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs">
      <p className="text-rose-300">This panel hit an error and stopped drawing.</p>
      <p className="max-w-md break-words font-mono text-[10px] text-zinc-500">{error.message}</p>
      <p className="text-zinc-400">Undo (Ctrl+Z) the last change, or try again.</p>
      <button onClick={retry} className="rounded bg-white/10 px-2 py-1 text-zinc-200 hover:bg-white/20">
        Try again
      </button>
    </div>
  )
}
