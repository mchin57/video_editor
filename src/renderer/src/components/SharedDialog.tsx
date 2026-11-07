import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  SHARED_KINDS,
  SHARED_KIND_LABELS,
  SHARED_NAME_MAX,
  cleanSharedName,
  describeSharedAdd,
  sharedTextTemplate,
  type SharedAddResult,
  type SharedItem,
  type SharedKind
} from '@shared/sharedLibrary'
import {
  addSharedFilesDialog,
  addSharedFromLibrary,
  deleteShared,
  ipcErrorMessage,
  listShared,
  renameShared,
  saveSharedText,
  sharedUrl
} from '@/ipc/client'
import { useLibrary } from '@/hooks/useMedia'
import { insertShared } from '@/lib/insert'
import { formatDuration } from '@/lib/format'
import { textPieceFromSelection, type DropMedia } from '@/lib/templates'
import { activeComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { TemplatePreview } from './TemplatePreview'
import { btnCls, dangerBtnCls, disabledCls, inputCls, subtleBtnCls } from './ui'

const SHARED_KEY = ['shared']

/** What each tab is for, under the tabs. */
const TAB_HINT: Record<SharedKind, string> = {
  sound: 'Sound effects and music beds you reuse. Insert puts one on the audio track at the playhead.',
  graphic: 'Logos, stickers and overlays. Insert puts one on the timeline at the playhead for 3 seconds.',
  video: 'Clips you reuse, like an intro or an end card. Insert puts one on the timeline at the playhead.',
  text: 'Text you reuse, saved exactly as it looks (style, position, size, animation, length). Insert drops it at the playhead.'
}

const close = (): void => useUi.getState().setSharedOpen(null)

/** A card's length: tenths under a minute (a 0.4 s whoosh), else m:ss. */
const lengthLabel = (sec: number): string =>
  !(sec > 0) ? '' : sec < 60 ? `${Math.round(sec * 10) / 10}s` : formatDuration(sec)

/**
 * Insert ▸ Shared ▸ … — the shared library (shared/sharedLibrary.ts,
 * docs/SHARED-LIBRARY.md): editor-wide sounds, graphics, video and saved text,
 * one tab each. Add files… copies files in (the Library's right-click "Add to
 * shared library" copies a clip in, opening here); the Text tab saves the
 * selected text layers. Insert puts a COPY into the open project at the
 * playhead. Items can be renamed and deleted; projects that used one keep
 * their own copy. Kept by main under `<data>/shared`.
 */
export function SharedDialog(): JSX.Element | null {
  const open = useUi((s) => s.sharedOpen)
  if (!open) return null
  return <Gallery initialTab={open.tab} addMediaId={open.addMediaId} />
}

function Gallery({ initialTab, addMediaId }: { initialTab: SharedKind; addMediaId?: string }): JSX.Element {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: SHARED_KEY, queryFn: () => listShared() })
  const library = useLibrary()
  const selection = useUi((s) => s.selection)
  const [tab, setTab] = useState<SharedKind>(initialTab)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [textName, setTextName] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      // Escape cancels a rename first, then closes.
      if (renaming) setRenaming(null)
      else close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [renaming])

  // Stop a playing sound when the dialog closes.
  useEffect(() => () => audio.current?.pause(), [])

  const items = useMemo(() => (list.data ?? []).filter((i) => i.kind === tab), [list.data, tab])
  const assets = library.data ?? []
  const media: DropMedia = {
    durationOf: (id) => assets.find((a) => a.id === id)?.probe.durationSec ?? 0,
    fpsOf: (id) => assets.find((a) => a.id === id)?.probe.video?.avgFps ?? 0
  }

  /** Run an action: busy while it runs, the list replaced by what main
   *  returns (null = a dialog was canceled), any error shown inline. */
  const run = async (
    fn: () => Promise<SharedItem[] | SharedAddResult | null>,
    done?: (r: SharedItem[] | SharedAddResult) => string | null
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const next = await fn()
      if (next) {
        qc.setQueryData(SHARED_KEY, Array.isArray(next) ? next : next.items)
        const msg = done?.(next)
        if (msg) setNote(msg)
      }
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const addNote = (r: SharedItem[] | SharedAddResult): string | null => (Array.isArray(r) ? null : describeSharedAdd(r))

  // Opened from the Library's "Add to shared library": copy that clip in once.
  const adding = useRef<string | null>(null)
  useEffect(() => {
    if (!addMediaId || adding.current === addMediaId) return
    adding.current = addMediaId
    useUi.getState().setSharedOpen({ tab: initialTab })
    void run(() => addSharedFromLibrary(addMediaId), addNote)
    // `run` and `addNote` are stable in effect (they only set state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMediaId, initialTab])

  const insert = (item: SharedItem): void => {
    setBusy(true)
    setError(null)
    setNote(null)
    insertShared(item, media).then(
      () => {
        setBusy(false)
        close()
      },
      (err: unknown) => {
        setBusy(false)
        setError(ipcErrorMessage(err))
      }
    )
  }

  const saveText = (e: FormEvent): void => {
    e.preventDefault()
    const comp = activeComp(useProject.getState())
    if (!comp) return
    const got = textPieceFromSelection(comp, selection)
    if ('error' in got) {
      setError(got.error)
      setNote(null)
      return
    }
    // The name main stores (trimmed, inner runs of spaces collapsed).
    const name = cleanSharedName(textName)
    if (!name) return
    const replaces = (list.data ?? []).some((i) => i.kind === 'text' && i.name.toLowerCase() === name.toLowerCase())
    const skipped = got.skipped
      ? ` Only text is saved, so ${got.skipped === 1 ? '1 other selected piece was' : `${got.skipped} other selected pieces were`} left out.`
      : ''
    void run(
      async () => {
        const next = await saveSharedText(name, got.layers)
        setTextName('')
        return next
      },
      () => `Saved “${name}”${replaces ? ', replacing your text of that name' : ''}.${skipped}`
    )
  }

  const togglePlay = (item: SharedItem): void => {
    audio.current?.pause()
    if (playing === item.id || !item.file) {
      setPlaying(null)
      return
    }
    const el = new Audio(sharedUrl(item.id, item.file))
    el.onended = () => setPlaying((p) => (p === item.id ? null : p))
    audio.current = el
    setPlaying(item.id)
    // A sound that can't play (a format Chromium lacks) just doesn't start.
    el.play().catch(() => setPlaying((p) => (p === item.id ? null : p)))
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
        data-testid="shared-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shared-title"
        aria-busy={busy}
        className="flex max-h-full w-[760px] max-w-full flex-col rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 id="shared-title" className="mb-2 text-sm font-semibold text-zinc-100">
          Shared library
        </h2>

        <div role="tablist" className="mb-2 flex gap-1">
          {SHARED_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              data-testid={`shared-tab-${k}`}
              onClick={() => {
                setTab(k)
                setConfirmDelete(null)
                setRenaming(null)
              }}
              className={`rounded-md px-3 py-1 text-xs font-medium ${
                tab === k ? 'bg-sky-500/90 text-white' : 'bg-white/10 text-zinc-300 hover:bg-white/20'
              }`}
            >
              {SHARED_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <p className="mb-3 text-[11px] text-zinc-500">{TAB_HINT[tab]}</p>

        {tab === 'text' ? (
          <form onSubmit={saveText} className="mb-3 flex items-center gap-2 rounded-lg bg-white/5 p-2">
            <span className="shrink-0 text-[11px] text-zinc-400">Save selected text as</span>
            <input
              data-testid="shared-text-name"
              spellCheck={false}
              value={textName}
              maxLength={SHARED_NAME_MAX}
              placeholder="Name"
              disabled={busy || selection.length === 0}
              onChange={(e) => setTextName(e.target.value)}
              className={`${inputCls} py-1 ${disabledCls}`}
            />
            <button
              type="submit"
              data-testid="shared-text-save"
              disabled={busy || selection.length === 0 || !textName.trim()}
              title={selection.length === 0 ? 'Select text layers on the timeline first.' : undefined}
              className={`${btnCls} shrink-0 px-3 ${disabledCls}`}
            >
              Save
            </button>
          </form>
        ) : (
          <div className="mb-3 flex">
            <button
              type="button"
              data-testid="shared-add"
              disabled={busy}
              onClick={() => void run(() => addSharedFilesDialog(tab), addNote)}
              className={`${btnCls} px-3 ${disabledCls}`}
            >
              Add files…
            </button>
          </div>
        )}

        {(error || note) && (
          <p
            data-testid={error ? 'shared-error' : 'shared-note'}
            role={error ? 'alert' : 'status'}
            className={`mb-3 rounded border px-2 py-1.5 text-[11px] ${
              error ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-sky-500/30 bg-sky-500/10 text-sky-200'
            }`}
          >
            {error ?? note}
          </p>
        )}

        {items.length === 0 ? (
          <p
            data-testid="shared-empty"
            className="rounded-lg border border-dashed border-white/10 p-6 text-center text-[11px] text-zinc-500"
          >
            {list.isLoading
              ? 'Loading…'
              : tab === 'text'
                ? 'No shared text yet. Select text layers on the timeline, name them above and Save.'
                : `No shared ${SHARED_KIND_LABELS[tab].toLowerCase()} yet. Use Add files…, or right-click a clip in the Library and choose Add to shared library.`}
          </p>
        ) : (
          <ul className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto" data-testid="shared-list">
            {items.map((item) => (
              <li
                key={item.id}
                data-testid={`shared-item-${item.id}`}
                className="flex gap-3 rounded-lg border border-white/10 bg-white/5 p-2"
              >
                <Preview item={item} playing={playing === item.id} onPlay={() => togglePlay(item)} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {renaming?.id === item.id ? (
                    <form
                      className="flex gap-1"
                      onSubmit={(e) => {
                        e.preventDefault()
                        const name = renaming.name
                        setRenaming(null)
                        void run(() => renameShared(item.id, name))
                      }}
                    >
                      <input
                        autoFocus
                        data-testid={`shared-rename-input-${item.id}`}
                        spellCheck={false}
                        value={renaming.name}
                        maxLength={SHARED_NAME_MAX}
                        onChange={(e) => setRenaming({ id: item.id, name: e.target.value })}
                        className={`${inputCls} py-0.5`}
                      />
                      <button
                        type="submit"
                        data-testid={`shared-rename-save-${item.id}`}
                        disabled={!renaming.name.trim()}
                        className={`${subtleBtnCls} ${disabledCls}`}
                      >
                        Save
                      </button>
                    </form>
                  ) : (
                    <div className="flex items-baseline gap-2">
                      <span
                        data-testid={`shared-name-${item.id}`}
                        className="truncate text-xs font-medium text-zinc-100"
                      >
                        {item.name}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-zinc-500">
                        {lengthLabel(item.durationSec)}
                      </span>
                    </div>
                  )}
                  {item.kind === 'text' && (
                    <span className="truncate text-[11px] text-zinc-400">
                      {item.layers.map((l) => (l.content.kind === 'text' ? l.content.text : '')).join(' · ')}
                    </span>
                  )}
                  <div className="mt-auto flex flex-wrap gap-1 pt-1">
                    <button
                      type="button"
                      data-testid={`shared-insert-${item.id}`}
                      disabled={busy}
                      onClick={() => insert(item)}
                      className={`rounded-md bg-sky-500/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-sky-400 ${disabledCls}`}
                    >
                      Insert
                    </button>
                    <button
                      type="button"
                      data-testid={`shared-rename-${item.id}`}
                      disabled={busy}
                      onClick={() => setRenaming({ id: item.id, name: item.name })}
                      className={`${subtleBtnCls} ${disabledCls}`}
                    >
                      Rename
                    </button>
                    {confirmDelete === item.id ? (
                      <button
                        type="button"
                        data-testid={`shared-delete-confirm-${item.id}`}
                        disabled={busy}
                        onClick={() => {
                          setConfirmDelete(null)
                          if (playing === item.id) audio.current?.pause()
                          void run(
                            () => deleteShared(item.id),
                            () => `Deleted “${item.name}”. Projects that used it keep their copy.`
                          )
                        }}
                        className={`${dangerBtnCls} ${disabledCls}`}
                      >
                        Delete for good
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`shared-delete-${item.id}`}
                        disabled={busy}
                        onClick={() => setConfirmDelete(item.id)}
                        className={`${subtleBtnCls} ${disabledCls}`}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex justify-end">
          <button type="button" data-testid="shared-close" onClick={close} className={`${btnCls} px-4`}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** A card's picture: the graphic or video thumbnail, a play button for a
 *  sound, or a text piece drawn as it will look (the template preview). */
function Preview({ item, playing, onPlay }: { item: SharedItem; playing: boolean; onPlay: () => void }): JSX.Element {
  const text = useMemo(() => (item.kind === 'text' ? sharedTextTemplate(item) : null), [item])
  if (text) return <TemplatePreview template={text} />
  if (item.kind === 'sound') {
    return (
      <button
        type="button"
        data-testid={`shared-play-${item.id}`}
        aria-label={playing ? `Stop ${item.name}` : `Play ${item.name}`}
        onClick={onPlay}
        className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded bg-white/10 text-xl text-zinc-200 hover:bg-white/20"
      >
        {playing ? '■' : '▶'}
      </button>
    )
  }
  return (
    <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded bg-black/40">
      {item.preview ? (
        <img
          alt=""
          data-testid={`shared-preview-${item.id}`}
          src={sharedUrl(item.id, item.preview)}
          className="max-h-full max-w-full object-contain"
        />
      ) : (
        <span className="text-[10px] text-zinc-500">{item.kind === 'video' ? 'Video' : 'Picture'}</span>
      )}
    </div>
  )
}
