import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { MediaAsset } from '@shared/media'
import {
  deletePiece,
  isUncut,
  keptSec,
  pieceAt,
  playFrom,
  splitPieceAt,
  trimPieceEdge,
  wholeClip,
  type CutPiece
} from '@shared/quickCut'
import { ipcErrorMessage, videoProxyUrl } from '@/ipc/client'
import { formatClock } from '@/lib/format'
import { startPointerDrag } from '@/lib/pointerDrag'
import { usePlayback } from '@/state/playback'
import { btnCls, disabledCls } from './ui'

/**
 * Library ▸ right-click ▸ Quick cut… (docs/QUICK-CUT.md): the clip over a mini
 * timeline of its own SOURCE time. Trim a piece's front/back by its handles,
 * split at the playhead (S), delete a piece (Del) down to one — never zero.
 * Save writes one new library clip per piece to `generated/`; Save as one clip
 * joins the pieces into a single new clip (docs/MERGE-CLIPS.md). The original
 * and the edit are untouched. The editing rules are `shared/quickCut.ts`; this is
 * the view over them, with its own undo (Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y).
 *
 * Playback plays only what will be saved, jumping the gaps. Keys pressed while
 * it is open never reach the app's own shortcuts.
 */
export function QuickCutDialog({
  asset,
  onClose,
  onSave,
  onSaveOne
}: {
  asset: MediaAsset
  onClose: () => void
  /** Encode and add the clips; reject with a reason (shown inline, dialog stays). */
  onSave: (pieces: CutPiece[]) => Promise<unknown>
  /** Save as one clip: join the pieces into ONE new clip (Merge clips). Same contract. */
  onSaveOne: (pieces: CutPiece[]) => Promise<unknown>
}): JSX.Element {
  const dur = asset.probe.durationSec
  const frame = 1 / (asset.probe.video?.avgFps || 30)
  const [hist, setHist] = useState<{ past: CutPiece[][]; now: CutPiece[]; future: CutPiece[][] }>(() => ({
    past: [],
    now: wholeClip(dur),
    future: []
  }))
  // A trim drag edits a draft; release commits it as ONE undo step.
  const [draft, setDraft] = useState<CutPiece[] | null>(null)
  const pieces = draft ?? hist.now
  const [selected, setSelected] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  const commit = useCallback((next: CutPiece[] | null, select?: number) => {
    if (!next) return
    setHist((h) => ({ past: [...h.past, h.now], now: next, future: [] }))
    if (select !== undefined) setSelected(Math.max(0, Math.min(select, next.length - 1)))
    setError(null)
  }, [])
  const undo = (): void =>
    setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), now: h.past[h.past.length - 1], future: [h.now, ...h.future] } : h))
  const redo = (): void =>
    setHist((h) => (h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1) } : h))
  // Undo can shrink the list under the selection.
  useEffect(() => setSelected((s) => Math.min(s, hist.now.length - 1)), [hist.now])

  const seek = useCallback(
    (t: number) => {
      const c = Math.max(0, Math.min(dur, t))
      if (videoRef.current) videoRef.current.currentTime = c
      setTime(c)
    },
    [dur]
  )

  // The editor's own preview stops while this is open: one player at a time.
  useEffect(() => usePlayback.getState().setPlaying(false), [])

  // Play only the pieces: start inside one, jump each gap, stop after the last.
  useEffect(() => {
    const v = videoRef.current
    if (!playing || !v) return
    const from = playFrom(hist.now, v.currentTime) ?? hist.now[0].inSec
    if (from !== v.currentTime) v.currentTime = from
    v.play().catch(() => setPlaying(false))
    let raf = 0
    const tick = (): void => {
      let t = v.currentTime
      if (pieceAt(hist.now, t) < 0) {
        const next = playFrom(hist.now, t)
        if (next === null || v.ended) {
          v.pause()
          setPlaying(false)
          setTime(Math.min(t, hist.now[hist.now.length - 1].outSec))
          return
        }
        v.currentTime = t = next
      }
      setTime(t)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      v.pause()
    }
  }, [playing, hist.now])

  const split = (): void => {
    const next = splitPieceAt(hist.now, time)
    if (next) commit(next, pieceAt(next, time))
  }
  const remove = (): void => commit(deletePiece(hist.now, selected), selected)

  // Keys: capture phase, swallowed, so the app's shortcuts don't act on the edit behind.
  const keyActions = useRef({ split, remove, undo, redo, seek, time, busy, onClose, frame })
  keyActions.current = { split, remove, undo, redo, seek, time, busy, onClose, frame }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      const a = keyActions.current
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!a.busy) a.onClose()
      } else if (a.busy) {
        return
      } else if (e.code === 'Space') {
        e.preventDefault()
        setPlaying((p) => !p)
      } else if (mod && k === 'z') {
        e.preventDefault()
        if (e.shiftKey) a.redo()
        else a.undo()
      } else if (mod && k === 'y') {
        e.preventDefault()
        a.redo()
      } else if (!mod && k === 's') {
        e.preventDefault()
        a.split()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        a.remove()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        setPlaying(false)
        a.seek(a.time + (e.key === 'ArrowLeft' ? -1 : 1) * a.frame)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const secAt = (clientX: number): number => {
    const r = trackRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(dur, ((clientX - r.left) / Math.max(1, r.width)) * dur))
  }

  // Press on the track: select the piece there (if any) and scrub.
  const onTrackDown = (e: ReactPointerEvent): void => {
    if (busy || e.button !== 0) return
    e.preventDefault()
    setPlaying(false)
    const t = secAt(e.clientX)
    const i = pieceAt(hist.now, t)
    if (i >= 0) setSelected(i)
    seek(t)
    startPointerDrag((ev) => seek(secAt(ev.clientX)))
  }

  // Drag a piece's handle: trim that edge, showing the frame at the new edge.
  const onHandleDown = (e: ReactPointerEvent, index: number, edge: 'in' | 'out'): void => {
    if (busy || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setPlaying(false)
    setSelected(index)
    const base = hist.now
    let last = base
    startPointerDrag(
      (ev) => {
        last = trimPieceEdge(base, index, edge, secAt(ev.clientX), dur)
        setDraft(last)
        const p = last[index]
        seek(edge === 'in' ? p.inSec : Math.max(p.inSec, p.outSec - frame))
      },
      () => {
        setDraft(null)
        if (last !== base) commit(last)
      }
    )
  }

  const save = (asOne = false): void => {
    if (busy || isUncut(hist.now, dur) || (asOne && hist.now.length < 2)) return
    setPlaying(false)
    setBusy(true)
    setError(null)
    ;(asOne ? onSaveOne : onSave)(hist.now).then(
      () => setBusy(false),
      (err: unknown) => {
        setBusy(false)
        setError(ipcErrorMessage(err))
      }
    )
  }

  const pct = (t: number): string => `${(t / dur) * 100}%`
  const tickStep = dur <= 12 ? 1 : dur <= 30 ? 2 : dur <= 90 ? 5 : dur <= 300 ? 15 : 60
  const ticks = Array.from({ length: Math.floor(dur / tickStep) + 1 }, (_, i) => i * tickStep)
  const uncut = isUncut(hist.now, dur)
  const canSplit = !!splitPieceAt(hist.now, time)
  const n = hist.now.length
  const v = asset.probe.video

  return createPortal(
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/75 p-6"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div
        data-testid="quickcut-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quickcut-title"
        aria-busy={busy}
        className="flex max-h-full w-[min(920px,96vw)] flex-col rounded-xl border border-white/10 bg-zinc-900 p-4 shadow-2xl"
      >
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 id="quickcut-title" className="truncate text-sm font-semibold text-zinc-100">
            Quick cut <span className="font-normal text-zinc-400">· {asset.fileName}</span>
          </h2>
          <span className="shrink-0 text-[11px] text-zinc-500">
            S split · Del delete clip · ←/→ frame · Space play · Ctrl+Z undo
          </span>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center rounded bg-black">
          <video
            ref={videoRef}
            data-testid="quickcut-video"
            src={videoProxyUrl(asset)}
            preload="auto"
            playsInline
            onClick={() => !busy && setPlaying((p) => !p)}
            className="max-h-[55vh] max-w-full object-contain"
            style={v ? { aspectRatio: `${v.displayWidth} / ${v.displayHeight}` } : undefined}
          />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            data-testid="quickcut-play"
            disabled={busy}
            onClick={() => setPlaying((p) => !p)}
            className={`${btnCls} ${disabledCls} w-16`}
          >
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <span data-testid="quickcut-time" className="w-32 font-mono text-[11px] text-zinc-300">
            {formatClock(time)} / {formatClock(dur)}
          </span>
          <div className="flex-1" />
          <button
            data-testid="quickcut-split"
            disabled={busy || !canSplit}
            onClick={split}
            title={canSplit ? 'Split the clip at the playhead (S)' : 'Put the playhead inside a clip, away from its ends'}
            className={`${btnCls} ${disabledCls}`}
          >
            ✂ Split
          </button>
          <button
            data-testid="quickcut-delete"
            disabled={busy || n <= 1}
            onClick={remove}
            title={n <= 1 ? 'There must be at least one clip' : 'Delete the selected clip (Del)'}
            className={`${btnCls} ${disabledCls}`}
          >
            Delete clip
          </button>
          <button disabled={busy || !hist.past.length} onClick={undo} title="Undo (Ctrl+Z)" className={`${btnCls} ${disabledCls}`}>
            ↶
          </button>
          <button disabled={busy || !hist.future.length} onClick={redo} title="Redo (Ctrl+Shift+Z)" className={`${btnCls} ${disabledCls}`}>
            ↷
          </button>
        </div>

        {/* The mini timeline: the clip's own source time, 0 → its length. */}
        <div className="mt-2 select-none">
          <div className="relative h-4 text-[9px] text-zinc-500">
            {ticks.map((t) => (
              <span key={t} className="absolute -translate-x-1/2" style={{ left: pct(t) }}>
                {formatClock(t).replace(/\.\d+$/, '')}
              </span>
            ))}
          </div>
          <div
            ref={trackRef}
            data-testid="quickcut-track"
            onPointerDown={onTrackDown}
            className="relative h-14 cursor-text rounded bg-white/5"
          >
            {pieces.map((p, i) => (
              <div
                key={i}
                data-testid={`quickcut-piece-${i}`}
                data-in={p.inSec}
                data-out={p.outSec}
                data-selected={i === selected}
                className={`absolute inset-y-1 overflow-hidden rounded border text-[10px] ${
                  i === selected ? 'border-sky-300 bg-sky-500/45' : 'border-sky-500/40 bg-sky-500/25'
                }`}
                style={{ left: pct(p.inSec), width: pct(p.outSec - p.inSec) }}
              >
                <span className="pointer-events-none absolute left-2.5 top-1 whitespace-nowrap font-semibold text-sky-100">
                  {n > 1 ? `${i + 1} · ` : ''}
                  {(p.outSec - p.inSec).toFixed(2)}s
                </span>
                <div
                  data-testid={`quickcut-handle-in-${i}`}
                  onPointerDown={(e) => onHandleDown(e, i, 'in')}
                  title="Drag to trim the start"
                  className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-sky-200/70 hover:bg-white"
                />
                <div
                  data-testid={`quickcut-handle-out-${i}`}
                  onPointerDown={(e) => onHandleDown(e, i, 'out')}
                  title="Drag to trim the end"
                  className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-sky-200/70 hover:bg-white"
                />
              </div>
            ))}
            <div
              data-testid="quickcut-playhead"
              className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-rose-400"
              style={{ left: pct(time) }}
            />
          </div>
        </div>

        <p data-testid="quickcut-summary" className="mt-2 text-[11px] text-zinc-400">
          {uncut
            ? 'Trim the ends or split the clip. Saving makes new clips in the library; this one stays as it is.'
            : `Saves ${n} new clip${n > 1 ? 's' : ''} (${keptSec(hist.now).toFixed(2)}s in all) to the library. This clip stays as it is.`}
        </p>

        {error && (
          <p
            data-testid="quickcut-error"
            role="alert"
            className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300"
          >
            {error}
          </p>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <button
            data-testid="quickcut-cancel"
            onClick={onClose}
            disabled={busy}
            className={`${btnCls} px-4 ${disabledCls}`}
          >
            Cancel
          </button>
          {n > 1 && (
            <button
              data-testid="quickcut-save-one"
              onClick={() => save(true)}
              disabled={busy}
              title="Join the pieces back together, without the gaps, as one new clip"
              className={`${btnCls} px-4 ${disabledCls}`}
            >
              Save as one clip
            </button>
          )}
          <button
            data-testid="quickcut-save"
            onClick={() => save()}
            disabled={busy || uncut}
            title={uncut ? 'Nothing to save yet: trim or split first' : undefined}
            className="rounded-md bg-sky-500/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sky-500/90"
          >
            {busy ? 'Saving…' : n > 1 ? `Save ${n} clips` : 'Save clip'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
