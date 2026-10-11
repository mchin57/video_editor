import type { JSX } from 'react'

const bigBtnCls =
  'flex w-56 flex-col items-start gap-1 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 text-left transition hover:border-white/25 hover:bg-white/[0.07] focus-visible:border-sky-400/60 focus-visible:outline-none'

/**
 * Fills the app area when no project is open (first launch, or the last
 * project couldn't be reopened): New or Open. There is no untitled project
 * (docs/MEDIA-POINTERS.md "The project folder"). Presentational — the caller
 * opens the New-project window / the Open dialog.
 */
export function StartScreen({
  onNew,
  onOpen,
  message
}: {
  onNew: () => void
  onOpen: () => void
  /** Shown above the buttons, e.g. "Your last project couldn't be found: C:\…". */
  message?: string
}): JSX.Element {
  return (
    <div
      data-testid="start-screen"
      className="flex h-full w-full flex-col items-center justify-center gap-6 bg-[#0b0b0f] p-8"
    >
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Reel Editor</h1>

      {message && (
        <p className="max-w-lg break-words rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-center text-xs text-amber-200">
          {message}
        </p>
      )}

      <div className="flex flex-wrap justify-center gap-4">
        <button data-testid="start-new" autoFocus onClick={onNew} className={bigBtnCls}>
          <span className="text-sm font-medium text-zinc-100">New project…</span>
          <span className="text-[11px] text-zinc-500">Name it and choose where it lives</span>
        </button>
        <button data-testid="start-open" onClick={onOpen} className={bigBtnCls}>
          <span className="text-sm font-medium text-zinc-100">Open project…</span>
          <span className="text-[11px] text-zinc-500">Pick an existing .reel file</span>
        </button>
      </div>
    </div>
  )
}
