import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { MediaAsset } from '@shared/media'
import { mergedSec, MIN_MERGE_SEGMENTS, type MergeSegment } from '@shared/merge'
import { btnCls, disabledCls } from './ui'

/**
 * Library ▸ right-click a video ▸ Merge clips… (docs/MERGE-CLIPS.md): pick
 * library videos in the order they should play, then Merge makes ONE new clip
 * of them in `generated/`. The clip right-clicked starts the list. Every clip
 * is used whole (Quick cut first to merge only part of one).
 *
 * Presentational: `onMerge` runs the merge; a rejection's message shows inline
 * and the dialog stays open. On success the caller closes it. Escape or Cancel
 * closes without making anything; keys never reach the app's shortcuts.
 */
export function MergeClipsDialog({
  clips,
  firstId,
  onClose,
  onMerge
}: {
  /** The library videos that can be merged (usable, with a file). */
  clips: MediaAsset[]
  /** The clip the dialog was opened on: first in the order. */
  firstId: string
  onClose: () => void
  onMerge: (segments: MergeSegment[]) => Promise<unknown>
}): JSX.Element {
  const [order, setOrder] = useState<string[]>(() => (clips.some((c) => c.id === firstId) ? [firstId] : []))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Keys: capture phase, swallowed whatever has focus (a reorder can disable
  // the focused button), so the app's shortcuts never act on the edit behind.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (!busy) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onClose])

  const byId = new Map(clips.map((c) => [c.id, c]))
  const segments: MergeSegment[] = order.flatMap((id) => {
    const c = byId.get(id)
    return c ? [{ mediaId: id, inSec: 0, outSec: Math.round(c.probe.durationSec * 1000) / 1000 }] : []
  })
  const canMerge = segments.length >= MIN_MERGE_SEGMENTS && !busy

  const toggle = (id: string): void => {
    setError(null)
    setOrder((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]))
  }
  const move = (i: number, by: -1 | 1): void => {
    setOrder((o) => {
      const j = i + by
      if (j < 0 || j >= o.length) return o
      const next = [...o]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  const merge = (): void => {
    if (!canMerge) return
    setBusy(true)
    setError(null)
    onMerge(segments).then(
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
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div
        data-testid="merge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-title"
        aria-busy={busy}
        className="flex max-h-full w-[520px] max-w-full flex-col rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 id="merge-title" className="mb-1 text-sm font-semibold text-zinc-100">
          Merge clips
        </h2>
        <p className="mb-3 text-[11px] text-zinc-500">
          Click clips in the order they should play. They are joined, whole, into one new clip in the library.
        </p>

        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto" data-testid="merge-clips">
          {clips.map((c) => {
            const at = order.indexOf(c.id)
            return (
              <li key={c.id}>
                <button
                  type="button"
                  data-testid={`merge-pick-${c.id}`}
                  aria-pressed={at >= 0}
                  disabled={busy}
                  onClick={() => toggle(c.id)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${disabledCls} ${
                    at >= 0 ? 'bg-sky-500/20 text-sky-100' : 'bg-white/5 text-zinc-300 hover:bg-white/10'
                  }`}
                >
                  <span className="w-5 shrink-0 text-center font-mono text-[11px] text-sky-300">
                    {at >= 0 ? at + 1 : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.fileName}</span>
                  <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                    {c.probe.durationSec.toFixed(1)}s
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        {order.length > 1 && (
          <ol className="mt-3 space-y-0.5 border-t border-white/10 pt-2" data-testid="merge-order">
            {order.map((id, i) => (
              <li key={id} className="flex items-center gap-1 text-[11px] text-zinc-300">
                <span className="w-5 text-center font-mono text-sky-300">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{byId.get(id)?.fileName}</span>
                <button
                  type="button"
                  data-testid={`merge-up-${i}`}
                  disabled={busy || i === 0}
                  onClick={() => move(i, -1)}
                  className={`${btnCls} px-1.5 py-0.5 ${disabledCls}`}
                  title="Play earlier"
                >
                  ↑
                </button>
                <button
                  type="button"
                  data-testid={`merge-down-${i}`}
                  disabled={busy || i === order.length - 1}
                  onClick={() => move(i, 1)}
                  className={`${btnCls} px-1.5 py-0.5 ${disabledCls}`}
                  title="Play later"
                >
                  ↓
                </button>
              </li>
            ))}
          </ol>
        )}

        <p data-testid="merge-summary" className="mt-3 text-[11px] text-zinc-400">
          {segments.length < MIN_MERGE_SEGMENTS
            ? `Pick at least ${MIN_MERGE_SEGMENTS} clips.`
            : `Makes one ${mergedSec(segments).toFixed(2)}s clip from ${segments.length} clips. The originals stay as they are.`}
        </p>

        {error && (
          <p
            data-testid="merge-error"
            role="alert"
            className="mt-3 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300"
          >
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="merge-cancel"
            onClick={onClose}
            disabled={busy}
            className={`${btnCls} px-4 ${disabledCls}`}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="merge-submit"
            disabled={!canMerge}
            onClick={merge}
            className="rounded-md bg-sky-500/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sky-500/90"
          >
            {busy ? 'Merging…' : `Merge ${segments.length} clips`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
