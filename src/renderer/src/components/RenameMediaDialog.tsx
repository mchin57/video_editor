import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { MediaAsset } from '@shared/media'
import { pathBaseName, splitFileName, validateFileStem } from '@shared/fileName'
import { btnCls, disabledCls, Field, inputCls } from './ui'

/**
 * Library ▸ right-click ▸ Rename… (docs/MEDIA-POINTERS.md "Rename"): edits the
 * name of the clip's FILE on disk — without its extension, which is shown
 * fixed — and the library item follows. Presentational: `onRename` does the
 * rename (and the save); a rejection's message shows inline and the dialog
 * stays open. On success the caller closes it.
 *
 * - The name is validated live (`validateFileStem`, which main re-checks).
 * - Enter submits; Escape or Cancel closes without changing anything.
 * - Keys pressed inside never reach the app's global shortcuts.
 */
export function RenameMediaDialog({
  asset,
  onClose,
  onRename
}: {
  asset: MediaAsset
  onClose: () => void
  /** Rename to `stem` (+ the file's own extension); reject with a reason. */
  onRename: (stem: string) => Promise<void>
}): JSX.Element {
  const current = pathBaseName(asset.originalPath)
  const { stem: currentStem, ext } = splitFileName(current)
  const [stem, setStem] = useState(currentStem)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    // Start with the whole name selected, ready to type over.
    inputRef.current?.select()
    return () => {
      mounted.current = false
    }
  }, [])

  // Escape from anywhere while open, and never into the app's own Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (!busy) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onClose])

  // After a failed rename, put the user back in the field (it was disabled while pending).
  useEffect(() => {
    if (error && !busy) inputRef.current?.focus()
  }, [error, busy])

  const reason = validateFileStem(stem, ext)
  // Nothing to do: the same file name, and the library already shows it.
  const same = stem.trim() === currentStem && asset.fileName === current
  const canRename = reason === null && !same && !busy

  const submit = (e?: FormEvent): void => {
    e?.preventDefault()
    if (!canRename) return
    setBusy(true)
    setError(null)
    onRename(stem.trim()).then(
      () => {
        if (mounted.current) setBusy(false)
      },
      (err: unknown) => {
        if (!mounted.current) return
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      }
    )
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/70 p-8"
      // Portaled, but React events still bubble to the library card behind it.
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onMouseDown={(e) => {
        // A stray click on the backdrop keeps the dialog and the typed name.
        if (e.target === e.currentTarget) {
          e.preventDefault()
          inputRef.current?.focus()
        }
      }}
    >
      <form
        data-testid="rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        aria-busy={busy}
        className="w-[460px] max-w-full rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
        onSubmit={submit}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 id="rename-title" className="mb-1 text-sm font-semibold text-zinc-100">
          Rename file
        </h2>
        <p className="mb-4 break-all text-[11px] text-zinc-500" title={asset.originalPath}>
          Currently <span className="text-zinc-300">{current}</span>
        </p>

        <Field label="New name">
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              data-testid="rename-name"
              autoFocus
              spellCheck={false}
              value={stem}
              disabled={busy}
              aria-invalid={reason !== null}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                }
              }}
              onChange={(e) => {
                setStem(e.target.value)
                setError(null)
              }}
              className={`${inputCls} py-1.5 ${disabledCls}`}
            />
            {ext && (
              <span
                data-testid="rename-ext"
                className="shrink-0 text-xs text-zinc-400"
                title="The extension stays the same"
              >
                {ext}
              </span>
            )}
          </div>
        </Field>
        {reason && (
          <p data-testid="rename-reason" className="-mt-1 mb-2 text-[11px] text-rose-300">
            {reason}
          </p>
        )}

        <p className="mt-3 text-[11px] leading-snug text-zinc-500">
          Renames the file on disk, then saves this project. Other projects that use this file will show it as Missing
          until you relink it there.
        </p>

        {error && (
          <p
            data-testid="rename-error"
            role="alert"
            className="mt-3 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={`${btnCls} px-4 ${disabledCls}`}>
            Cancel
          </button>
          <button
            type="submit"
            data-testid="rename-submit"
            disabled={!canRename}
            className="rounded-md bg-sky-500/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sky-500/90"
          >
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
