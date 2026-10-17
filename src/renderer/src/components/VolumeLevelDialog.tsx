import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_VOLUME_LEVEL_ID } from '@shared/project'
import { LEVEL_TARGET_RANGE, suggestLevelName, validateLevelName } from '@shared/volumeLevels'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { btnCls, disabledCls, Field, inputCls, NumberInput, Slider } from './ui'

/**
 * A level's loudness control: a slider over `LEVEL_TARGET_RANGE` (one undo step
 * per drag) plus an exact field. Every clip in the level follows — their gains
 * are derived from the target (shared/volumeLevels.ts), nothing is rewritten.
 * Shared by the Inspector and File ▸ Volume levels ▸ Set loudness….
 */
export function LevelLoudnessField({ levelId }: { levelId: string }): JSX.Element | null {
  const level = useProject((s) => s.project?.volumeLevels.find((l) => l.id === levelId) ?? null)
  const setTarget = useProject((s) => s.setVolumeLevelTarget)
  if (!level) return null
  return (
    <Field label={`${level.name} loudness · ${level.targetLufs} LUFS`}>
      <div className="flex items-center gap-2">
        <Slider
          ariaLabel="Level loudness"
          min={LEVEL_TARGET_RANGE.min}
          max={LEVEL_TARGET_RANGE.max}
          step={1}
          value={level.targetLufs}
          onChange={(v) => setTarget(level.id, v)}
          className="min-w-0 flex-1"
        />
        <NumberInput
          ariaLabel="Level loudness (LUFS)"
          step="0.5"
          min={LEVEL_TARGET_RANGE.min}
          max={LEVEL_TARGET_RANGE.max}
          value={level.targetLufs}
          onCommit={(v) => setTarget(level.id, v)}
          className={inputCls.replace('w-full', 'w-16 shrink-0')}
        />
      </div>
    </Field>
  )
}

/**
 * The volume-level dialog (`useUi().levelDialog`): create a level — putting
 * the clips that asked for it in at once — rename one, or set its loudness.
 * An in-app modal, never a native prompt. Enter submits; Escape or Cancel
 * closes; keys inside never reach the app's shortcuts.
 */
export function VolumeLevelDialog(): JSX.Element | null {
  const dialog = useUi((s) => s.levelDialog)
  if (!dialog) return null
  // Keyed so each opening starts fresh (a new suggested name, no stale error).
  return <LevelDialogBody key={JSON.stringify(dialog)} />
}

function LevelDialogBody(): JSX.Element | null {
  const dialog = useUi((s) => s.levelDialog)!
  const close = (): void => useUi.getState().setLevelDialog(null)
  const levels = useProject((s) => s.project?.volumeLevels ?? [])
  const target = dialog.mode === 'create' ? null : (levels.find((l) => l.id === dialog.levelId) ?? null)
  const [name, setName] = useState(() => (dialog.mode === 'create' ? suggestLevelName(levels) : (target?.name ?? '')))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.select()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The level went away (undo) while the dialog was open.
  if (dialog.mode !== 'create' && !target) return null

  const naming = dialog.mode !== 'loudness'
  const reason = naming ? validateLevelName(name, levels, target?.id) : null
  const unchanged = dialog.mode === 'rename' && name.trim() === target?.name
  const canSubmit = naming && reason === null && !unchanged

  const submit = (e?: FormEvent): void => {
    e?.preventDefault()
    if (dialog.mode === 'loudness') return close()
    if (!canSubmit) return
    const store = useProject.getState()
    if (dialog.mode === 'create') store.createVolumeLevel(name.trim(), dialog.assign ?? [])
    else if (target) store.renameVolumeLevel(target.id, name.trim())
    close()
  }

  const title =
    dialog.mode === 'create' ? 'New volume level' : dialog.mode === 'rename' ? 'Rename volume level' : 'Level loudness'

  return createPortal(
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/70 p-8"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <form
        data-testid="level-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="level-dialog-title"
        className="w-[420px] max-w-full rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
        onSubmit={submit}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 id="level-dialog-title" className="mb-3 text-sm font-semibold text-zinc-100">
          {title}
        </h2>

        {naming ? (
          <>
            <Field label="Name">
              <input
                ref={inputRef}
                data-testid="level-name"
                autoFocus
                spellCheck={false}
                value={name}
                maxLength={80}
                aria-invalid={reason !== null}
                onChange={(e) => setName(e.target.value)}
                className={`${inputCls} py-1.5`}
              />
            </Field>
            {reason && (
              <p data-testid="level-name-reason" className="-mt-1 mb-2 text-[11px] text-rose-300">
                {reason}
              </p>
            )}
            {dialog.mode === 'create' && (
              <p className="mt-2 text-[11px] leading-snug text-zinc-500">
                Clips in a level are each matched to its loudness (−16 LUFS to start; change it from File ▸ Volume
                levels or the Inspector).
                {dialog.assign?.length ? ' The selected clip joins it.' : ''}
              </p>
            )}
          </>
        ) : (
          target && (
            <>
              <LevelLoudnessField levelId={target.id} />
              <p className="mt-1 text-[11px] leading-snug text-zinc-500">
                Every clip in {target.id === DEFAULT_VOLUME_LEVEL_ID ? 'Default' : `“${target.name}”`} is matched to
                this loudness. Instagram plays reels at about −14 LUFS.
              </p>
            </>
          )
        )}

        <div className="mt-5 flex justify-end gap-2">
          {naming && (
            <button type="button" onClick={close} className={`${btnCls} px-4`}>
              Cancel
            </button>
          )}
          <button
            type="submit"
            data-testid="level-submit"
            disabled={naming && !canSubmit}
            className={`rounded-md bg-sky-500/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-400 ${disabledCls}`}
          >
            {dialog.mode === 'create' ? 'Create' : dialog.mode === 'rename' ? 'Rename' : 'Done'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
