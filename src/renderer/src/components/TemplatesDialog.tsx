import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MediaAsset } from '@shared/media'
import { createEmptyComposition } from '@shared/project'
import { newId } from '@shared/ids'
import {
  TEMPLATE_NAME_MAX,
  templateDuration,
  templatePreviewTime,
  templateSummary,
  type ReelTemplate,
  type TemplateEntry
} from '@shared/templates'
import {
  chooseTemplateSound,
  deleteTemplate,
  exportTemplateDialog,
  importTemplateDialog,
  ipcErrorMessage,
  listTemplates,
  saveTemplate
} from '@/ipc/client'
import { useLibrary } from '@/hooks/useMedia'
import { insertTemplate } from '@/lib/insert'
import { templateFromSelection } from '@/lib/templates'
import { activeComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { CompFill } from './preview/layers'
import { btnCls, dangerBtnCls, disabledCls, inputCls, subtleBtnCls } from './ui'

const TEMPLATES_KEY = ['templates']
const NO_ASSETS = new Map<string, MediaAsset>()

/**
 * Insert ▸ Template… — the template gallery (shared/templates.ts): the built-in
 * starters and your own, each with a still preview, what it does, and Insert
 * (drops it at the playhead). Your own can be exported as a share file or
 * deleted; any template with a sound slot can be given a sound (a built-in's
 * becomes your copy, which "Reset" removes again). The top row saves the
 * timeline selection as a new template (Insert ▸ Save selection as template…
 * opens with it focused). Templates are editor-wide, kept by main under
 * `<data>/templates`.
 */
export function TemplatesDialog(): JSX.Element | null {
  const mode = useUi((s) => s.templatesOpen)
  if (!mode) return null
  return <Gallery mode={mode} />
}

const close = (): void => useUi.getState().setTemplatesOpen(null)

function Gallery({ mode }: { mode: 'gallery' | 'save' }): JSX.Element {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: TEMPLATES_KEY, queryFn: () => listTemplates() })
  const library = useLibrary()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [name, setName] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const selection = useUi((s) => s.selection)

  useEffect(() => {
    if (mode === 'save') nameRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mode])

  const assets = library.data ?? []
  const entries = list.data ?? []
  const media = {
    durationOf: (id: string): number => assets.find((a) => a.id === id)?.probe.durationSec ?? 0,
    fpsOf: (id: string): number => assets.find((a) => a.id === id)?.probe.video?.avgFps ?? 0
  }

  /** Run a gallery action: busy while it runs, the list replaced by what main
   *  returns (null = a dialog was canceled), any error shown inline. */
  const run = async (fn: () => Promise<TemplateEntry[] | null | void>, done?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const next = await fn()
      if (next) qc.setQueryData(TEMPLATES_KEY, next)
      if (done && next !== null) setNote(done)
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const insert = (t: ReelTemplate): void => {
    setBusy(true)
    setError(null)
    setNote(null)
    insertTemplate(t.id, media).then(
      ({ effectSkipped }) => {
        setBusy(false)
        if (effectSkipped) {
          setNote(
            `Added “${t.name}”. There was no clip under the playhead, so only its overlays and sounds were added — no freeze.`
          )
        } else close()
      },
      (err: unknown) => {
        setBusy(false)
        setError(ipcErrorMessage(err))
      }
    )
  }

  const save = (e: FormEvent): void => {
    e.preventDefault()
    const comp = activeComp(useProject.getState())
    if (!comp) return
    const label = (mediaId: string): string =>
      assets.find((a) => a.id === mediaId)?.fileName.replace(/\.[^.]+$/, '') || 'Sound'
    const got = templateFromSelection(comp, selection, name, newId(), label)
    if ('error' in got) {
      setError(got.error)
      return
    }
    const skipped = got.skipped.length ? ` Not included: ${got.skipped.join(', ')}.` : ''
    // Saving under a name you already use replaces that template — say so.
    const lower = got.template.name.toLowerCase()
    const replaces = entries.some((e) => !e.builtIn && e.template.name.toLowerCase() === lower)
    void run(
      async () => {
        const next = await saveTemplate(got.template)
        setName('')
        return next
      },
      `Saved “${got.template.name}”${replaces ? ', replacing your template of that name' : ''}.${skipped}`
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
        data-testid="templates-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="templates-title"
        aria-busy={busy}
        className="flex max-h-full w-[760px] max-w-full flex-col rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 id="templates-title" className="mb-1 text-sm font-semibold text-zinc-100">
          Templates
        </h2>
        <p className="mb-3 text-[11px] text-zinc-500">
          Insert drops a template at the playhead. One that freezes the clip holds the frame under the playhead, and
          everything after it moves later by the hold.
        </p>

        <form onSubmit={save} className="mb-3 flex items-center gap-2 rounded-lg bg-white/5 p-2">
          <span className="shrink-0 text-[11px] text-zinc-400">Save selection as</span>
          <input
            ref={nameRef}
            data-testid="template-name"
            spellCheck={false}
            value={name}
            maxLength={TEMPLATE_NAME_MAX}
            placeholder="Template name"
            disabled={busy || selection.length === 0}
            onChange={(e) => setName(e.target.value)}
            className={`${inputCls} py-1 ${disabledCls}`}
          />
          <button
            type="submit"
            data-testid="template-save"
            disabled={busy || selection.length === 0 || !name.trim()}
            title={selection.length === 0 ? 'Select the pieces on the timeline first.' : undefined}
            className={`${btnCls} shrink-0 px-3 ${disabledCls}`}
          >
            Save
          </button>
        </form>

        {(error || note) && (
          <p
            data-testid={error ? 'templates-error' : 'templates-note'}
            role={error ? 'alert' : 'status'}
            className={`mb-3 rounded border px-2 py-1.5 text-[11px] ${
              error ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-sky-500/30 bg-sky-500/10 text-sky-200'
            }`}
          >
            {error ?? note}
          </p>
        )}

        <ul className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto" data-testid="templates-list">
          {entries.map(({ template: t, builtIn }) => (
            <li
              key={t.id}
              data-testid={`template-${t.id}`}
              className="flex gap-3 rounded-lg border border-white/10 bg-white/5 p-2"
            >
              <TemplatePreview template={t} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-xs font-medium text-zinc-100">{t.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-500">
                    {Math.round(templateDuration(t) * 10) / 10}s
                  </span>
                </div>
                <span className="text-[10px] text-zinc-500">
                  {builtIn ? 'Built in' : t.basedOn ? 'Yours (from a built-in)' : 'Yours'}
                </span>
                <span data-testid={`template-summary-${t.id}`} className="text-[11px] leading-snug text-zinc-400">
                  {templateSummary(t)}
                </span>
                <div className="mt-auto flex flex-wrap gap-1 pt-1">
                  <button
                    type="button"
                    data-testid={`template-insert-${t.id}`}
                    disabled={busy}
                    onClick={() => insert(t)}
                    className={`rounded-md bg-sky-500/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-sky-400 ${disabledCls}`}
                  >
                    Insert
                  </button>
                  {t.audio.map((a, i) => (
                    <button
                      key={i}
                      type="button"
                      data-testid={`template-sound-${t.id}-${i}`}
                      disabled={busy}
                      title={a.file ? `${a.label}: ${a.file}` : `${a.label}: none yet`}
                      onClick={() => void run(() => chooseTemplateSound(t.id, i), `Sound set for “${t.name}”.`)}
                      className={`${subtleBtnCls} ${disabledCls}`}
                    >
                      {a.file ? `${a.label} ✓` : `${a.label}…`}
                    </button>
                  ))}
                  <button
                    type="button"
                    data-testid={`template-export-${t.id}`}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const path = await exportTemplateDialog(t.id)
                        if (path) setNote(`Exported to ${path}`)
                      })
                    }
                    className={`${subtleBtnCls} ${disabledCls}`}
                  >
                    Export…
                  </button>
                  {!builtIn &&
                    (confirmDelete === t.id ? (
                      <button
                        type="button"
                        data-testid={`template-delete-confirm-${t.id}`}
                        disabled={busy}
                        onClick={() => {
                          setConfirmDelete(null)
                          void run(() => deleteTemplate(t.id))
                        }}
                        className={`${dangerBtnCls} ${disabledCls}`}
                      >
                        {t.basedOn ? 'Reset to built-in' : 'Delete for good'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`template-delete-${t.id}`}
                        disabled={busy}
                        onClick={() => setConfirmDelete(t.id)}
                        className={`${subtleBtnCls} ${disabledCls}`}
                      >
                        {t.basedOn ? 'Reset' : 'Delete'}
                      </button>
                    ))}
                </div>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex justify-between gap-2">
          <button
            type="button"
            data-testid="templates-import"
            disabled={busy}
            onClick={() => void run(() => importTemplateDialog(), 'Template imported.')}
            className={`${btnCls} px-4 ${disabledCls}`}
          >
            Import…
          </button>
          <button type="button" data-testid="templates-close" onClick={close} className={`${btnCls} px-4`}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** A still of the template's layers at its busiest moment, over a plain
 *  backdrop (tinted when the template tints the clip). Read-only. */
function TemplatePreview({ template: t }: { template: ReelTemplate }): JSX.Element {
  // Image layers point at files in the template's folder, not library media,
  // so they can't be drawn here; text and graphics are.
  const comp = useMemo(
    () => ({ ...createEmptyComposition(), layers: t.layers.filter((l) => l.content.kind !== 'image') }),
    [t.layers]
  )
  const tint = t.clipEffect?.tint
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative w-[72px] shrink-0 overflow-hidden rounded bg-gradient-to-b from-zinc-600 to-zinc-800"
      style={{ aspectRatio: '9 / 16', containerType: 'size' }}
    >
      {tint && tint.amount > 0 && (
        <div className="absolute inset-0" style={{ background: tint.color, opacity: tint.amount * 0.6 }} />
      )}
      <CompFill comp={comp} time={templatePreviewTime(t)} playing={false} assetById={NO_ASSETS} depth={1} muted />
    </div>
  )
}
