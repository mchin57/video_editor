import type { JSX } from 'react'
import { fileNameOf } from '@shared/media'
import { useUi } from '@/state/ui'
import { subtleBtnCls } from './ui'

/**
 * The import notice: which files the latest import (dialog, drop, folder)
 * could not take, and why. Without it a bad file just never appears in the
 * library. Main sends the list (`onImportSkipped`); it stays until dismissed
 * or the next failing import replaces it.
 */
export function ImportFailures(): JSX.Element | null {
  const skipped = useUi((s) => s.importSkipped)
  if (!skipped.length) return null
  const n = skipped.length
  return (
    <div
      role="alert"
      data-testid="import-failures"
      className="fixed bottom-10 right-4 z-40 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-rose-400/30 bg-zinc-900 p-3 shadow-2xl"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-rose-200">
          {n === 1 ? "Couldn't import 1 file" : `Couldn't import ${n} files`}
        </span>
        <button
          onClick={() => useUi.getState().setImportSkipped([])}
          className={`${subtleBtnCls} py-0.5`}
          data-testid="import-failures-dismiss"
        >
          Dismiss
        </button>
      </div>
      <ul className="max-h-48 space-y-1.5 overflow-y-auto">
        {skipped.map((s) => (
          <li key={s.path} className="text-xs" title={s.path}>
            <span className="block truncate font-medium text-zinc-100">{fileNameOf(s.path)}</span>
            <span className="block text-zinc-400">{s.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
