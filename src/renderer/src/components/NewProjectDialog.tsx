import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { validateProjectName } from '@shared/projectName'
import { btnCls, disabledCls, Field, inputCls } from './ui'

/** `<location><sep><name>` in the location's own separator style (no doubled separator at a root). */
function joinShown(location: string, name: string): string {
  const sep = location.includes('\\') || !location.includes('/') ? '\\' : '/'
  return `${location.replace(/[\\/]+$/, '')}${sep}${name}`
}

/**
 * File ▸ New: asks for a project NAME and a LOCATION, then hands both to
 * `onCreate` (which makes `<location>/<Name>/` with `<Name>.reel`, `generated/`,
 * `transcripts/`, `cache/` — docs/MEDIA-POINTERS.md "The project folder").
 * Presentational: the folder picker and the creation are the caller's.
 *
 * - The name is validated live (`validateProjectName`, which main re-checks);
 *   the reason shows once the user has typed, and Create stays disabled.
 * - Enter submits when valid; Escape cancels unless `canCancel` is false
 *   (the start screen's non-cancelable form hides Cancel too).
 * - While `onCreate` is pending every control is disabled. A rejection's
 *   message is shown inline and the dialog stays open. On success the dialog
 *   does NOT close itself — the caller owns `open`.
 * - Keys pressed inside the dialog don't reach the app's global shortcuts.
 */
export function NewProjectDialog({
  open,
  onClose,
  defaultLocation,
  onChooseLocation,
  onCreate,
  canCancel = true
}: {
  open: boolean
  onClose: () => void
  /** Absolute folder path shown initially. */
  defaultLocation: string
  /** Opens the native folder picker; resolves `null` when canceled. */
  onChooseLocation: (current: string) => Promise<string | null>
  /** Creates the project; reject with an Error whose message is shown inline. */
  onCreate: (name: string, location: string) => Promise<void>
  canCancel?: boolean
}): JSX.Element | null {
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  // null = still the caller's default (which may arrive after opening).
  const [picked, setPicked] = useState<string | null>(null)
  const location = picked ?? defaultLocation
  const [busy, setBusy] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Each opening starts fresh at the caller's default location.
  useEffect(() => {
    if (!open) return
    setName('')
    setTouched(false)
    setPicked(null)
    setBusy(false)
    setChoosing(false)
    setError(null)
  }, [open])

  // After a failed create, put the user back in the name field (it was
  // disabled while pending, so this waits for the re-render that enables it).
  useEffect(() => {
    if (error && !busy) nameRef.current?.focus()
  }, [error, busy])

  const cancelable = canCancel && !busy
  // Escape from anywhere while open (even with focus outside the dialog), and
  // never let it fall through to the app's Escape (clear selection, close panels).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (cancelable) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, cancelable, onClose])

  if (!open) return null

  const trimmed = name.trim()
  const reason = validateProjectName(name)
  const locked = busy || choosing
  const canCreate = reason === null && !!location && !locked

  const submit = (e?: FormEvent): void => {
    e?.preventDefault()
    if (!canCreate) {
      setTouched(true)
      return
    }
    setBusy(true)
    setError(null)
    onCreate(trimmed, location).then(
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

  const choose = (): void => {
    setChoosing(true)
    onChooseLocation(location).then(
      (folder) => {
        if (!mounted.current) return
        setChoosing(false)
        if (folder) {
          setPicked(folder)
          setError(null)
        }
      },
      (err: unknown) => {
        if (!mounted.current) return
        setChoosing(false)
        setError(err instanceof Error ? err.message : String(err))
      }
    )
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/70 p-8"
      // Clicking the backdrop keeps the dialog (a stray click shouldn't lose the
      // typed name) and puts focus back in it so its keys stay its own.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          nameRef.current?.focus()
        }
      }}
    >
      <form
        data-testid="new-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        aria-busy={busy}
        className="w-[460px] max-w-full rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
        onSubmit={submit}
        // The app's shortcuts (Space, S, T, Delete, Ctrl+S…) listen on window;
        // none of them should act on the editor behind this dialog.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 id="new-project-title" className="mb-4 text-sm font-semibold text-zinc-100">
          New project
        </h2>

        <Field label="Name">
          <input
            ref={nameRef}
            data-testid="new-project-name"
            autoFocus
            spellCheck={false}
            maxLength={260}
            value={name}
            disabled={busy}
            aria-invalid={touched && reason !== null}
            placeholder="My reel"
            // Enter submits explicitly (not via the form's implicit submission)
            // so it behaves the same however the field is driven.
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            onChange={(e) => {
              setName(e.target.value)
              setTouched(true)
              setError(null)
            }}
            className={`${inputCls} py-1.5 ${disabledCls}`}
          />
        </Field>
        {touched && reason && (
          <p data-testid="new-project-name-reason" className="-mt-1 mb-2 text-[11px] text-rose-300">
            {reason}
          </p>
        )}

        <div className="mb-1 mt-3 text-[10px] uppercase tracking-wide text-zinc-500">Location</div>
        <div className="flex items-center gap-2">
          <div
            data-testid="new-project-location"
            className="min-w-0 flex-1 truncate rounded border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-zinc-300"
            title={location}
          >
            {location || '…'}
          </div>
          <button
            type="button"
            data-testid="new-project-choose"
            onClick={choose}
            disabled={locked}
            className={`shrink-0 ${btnCls} px-3 ${disabledCls}`}
          >
            Choose location…
          </button>
        </div>

        <p className="mt-3 break-all text-[11px] text-zinc-500">
          Creates{' '}
          <span className="text-zinc-300">
            {joinShown(location, '')}
            {reason === null ? trimmed : <span className="italic text-zinc-500">Name</span>}
          </span>
        </p>

        {error && (
          <p
            data-testid="new-project-error"
            role="alert"
            className="mt-3 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {canCancel && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className={`${btnCls} px-4 ${disabledCls}`}
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            data-testid="new-project-create"
            disabled={!canCreate}
            className="rounded-md bg-sky-500/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sky-500/90"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
