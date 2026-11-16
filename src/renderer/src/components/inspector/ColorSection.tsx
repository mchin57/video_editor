/**
 * Inspector ▸ Color — ONE section for video clips and pictures alike: the
 * grade (Exposure / Contrast / Saturation), the newer controls (Temperature,
 * Tint = green / magenta, Vibrance, each with its own reset), the Color wash
 * (stored as `tint`, shared/tint.ts) and a `.cube` LUT at a strength. How
 * each draws is `shared/grade.ts`: the first three and the wash keep the CSS /
 * `lutrgb` paths; anything newer goes through the colour table, in the
 * preview (GradeCanvas) and the export (exportGrade.ts) alike.
 *
 * Sliders are live while dragging (one undo step each, `LiveRange`). A LUT is
 * imported (copied into the project's `luts/`), picked from the shared
 * library's LUTs, or saved there.
 */

import { useState, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColorAdjust, Composition, ImageContent, Layer, LutRef, VideoContent } from '@shared/project'
import { NEUTRAL_COLOR, isNeutralColor } from '@shared/project'
import { DEFAULT_TINT, isNeutralTint } from '@shared/tint'
import { describeSharedAdd } from '@shared/sharedLibrary'
import { copySharedLut, importLutDialog, ipcErrorMessage, listShared, shareLut } from '@/ipc/client'
import { idle } from '@/lib/interaction'
import { useProject } from '@/state/projectStore'
import { CollapsibleSection } from '../CollapsibleSection'
import { SHARED_QUERY_KEY } from '../SharedDialog'
import { Field, colorCls, disabledCls, inputCls, subtleBtnCls } from '../ui'
import { LiveRange, setLayer } from './controls'

type Graded = VideoContent | ImageContent
type NewControl = 'temperature' | 'greenMagenta' | 'vibrance'

/** The newer controls: stored −1…1, shown −100…100. */
const NEW_CONTROLS: { key: NewControl; label: string; hint: string }[] = [
  { key: 'temperature', label: 'Temperature', hint: 'Cooler (blue) ← → warmer (amber)' },
  { key: 'greenMagenta', label: 'Tint', hint: 'Green ← → magenta' },
  { key: 'vibrance', label: 'Vibrance', hint: 'Saturation that favours the dull colours' }
]

const signed = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`

/** `l` with its colour look patched (video and image layers; others untouched). */
const patchLook =
  (fn: (c: Graded) => Partial<Graded>) =>
  (l: Layer): Layer =>
    l.content.kind === 'video' || l.content.kind === 'image'
      ? ({ ...l, content: { ...l.content, ...fn(l.content) } } as Layer)
      : l

export function ColorSection({ layerId, content: c }: { layerId: string; content: Graded }): JSX.Element {
  const updateContent = useProject((s) => s.updateLayerContent)
  const mut = setLayer(layerId)
  const col = c.color ?? NEUTRAL_COLOR
  const setCol =
    (prop: keyof ColorAdjust) =>
    (p: Composition, v: number): Composition =>
      mut(
        p,
        patchLook((x) => ({ color: { ...(x.color ?? NEUTRAL_COLOR), [prop]: v } }))
      )
  const resetControl = (key: NewControl): void => {
    const next: ColorAdjust = { ...col }
    delete next[key]
    updateContent(layerId, { color: next })
  }
  // An unwashed clip shows the default colour at 0%, so dragging the strength
  // up starts from a sepia.
  const wash = c.tint ?? { ...DEFAULT_TINT, amount: 0 }
  const setWashAmount = (p: Composition, v: number): Composition =>
    mut(
      p,
      patchLook((x) => ({ tint: { color: x.tint?.color ?? wash.color, amount: v } }))
    )
  const touched = !isNeutralColor(c.color) || !isNeutralTint(c.tint) || !!c.lut

  return (
    <CollapsibleSection
      id="color"
      title="Color"
      right={
        touched ? (
          <button
            data-testid="color-reset"
            onClick={() => updateContent(layerId, { color: undefined, tint: undefined, lut: undefined })}
            className="text-[10px] text-zinc-400 hover:text-zinc-200"
          >
            Reset
          </button>
        ) : null
      }
    >
      <Field label={`Exposure  ${col.brightness >= 0 ? '+' : ''}${col.brightness.toFixed(2)}`}>
        <LiveRange min={-0.5} max={0.5} step={0.02} value={col.brightness} transform={setCol('brightness')} />
      </Field>
      <Field label={`Contrast  ${col.contrast.toFixed(2)}`}>
        <LiveRange min={0.5} max={1.8} step={0.02} value={col.contrast} transform={setCol('contrast')} />
      </Field>
      <Field label={`Saturation  ${col.saturation.toFixed(2)}`}>
        <LiveRange min={0} max={2} step={0.02} value={col.saturation} transform={setCol('saturation')} />
      </Field>
      {NEW_CONTROLS.map(({ key, label, hint }) => {
        const v = col[key] ?? 0
        return (
          <div key={key} className="mb-2" data-testid={`color-${key}`} title={hint}>
            <div className="mb-1 flex items-center justify-between text-[10px] tracking-wide text-zinc-500 uppercase">
              <span>{`${label}  ${signed(v)}`}</span>
              {v !== 0 && (
                <button
                  data-testid={`color-${key}-reset`}
                  onClick={() => resetControl(key)}
                  aria-label={`Reset ${label}`}
                  title={`Reset ${label}`}
                  className="text-zinc-400 normal-case hover:text-zinc-200"
                >
                  ↺
                </button>
              )}
            </div>
            <LiveRange min={-1} max={1} step={0.02} value={v} transform={setCol(key)} />
          </div>
        )
      })}
      <Field label={`Color wash  ${Math.round(wash.amount * 100)}%`}>
        <div className="flex items-center gap-2">
          <input
            type="color"
            data-testid="tint-color"
            title="Wash color"
            value={wash.color}
            onChange={(e) => updateContent(layerId, { tint: { ...wash, color: e.target.value } })}
            className={colorCls}
          />
          <LiveRange min={0} max={1} step={0.02} value={wash.amount} transform={setWashAmount} />
        </div>
      </Field>
      <LutControls layerId={layerId} lut={c.lut ?? null} />
    </CollapsibleSection>
  )
}

/** The LUT picker: None / the clip's own / the shared library's; Import…, strength, Save to shared library. */
function LutControls({ layerId, lut }: { layerId: string; lut: LutRef | null }): JSX.Element {
  const qc = useQueryClient()
  const updateContent = useProject((s) => s.updateLayerContent)
  const mut = setLayer(layerId)
  const shared = useQuery({ queryKey: SHARED_QUERY_KEY, queryFn: () => listShared() })
  const sharedLuts = (shared.data ?? []).filter((i) => i.kind === 'lut')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  /** Run a LUT action; a result is applied after any drag in progress ends. */
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await fn()
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const apply = async (got: { file: string; name: string } | null): Promise<void> => {
    if (!got) return
    await idle()
    updateContent(layerId, { lut: { file: got.file, name: got.name, strength: lut?.strength || 1 } })
  }
  const setStrength = (p: Composition, v: number): Composition =>
    mut(
      p,
      patchLook((x) => (x.lut ? { lut: { ...x.lut, strength: v } } : {}))
    )

  return (
    <div className="mb-1" data-testid="lut-controls">
      <span className="mb-1 block text-[10px] tracking-wide text-zinc-500 uppercase">LUT</span>
      <div className="flex gap-1">
        <select
          data-testid="lut-select"
          aria-label="LUT"
          disabled={busy}
          value={lut ? `own:${lut.file}` : ''}
          onChange={(e) => {
            const v = e.target.value
            if (!v) updateContent(layerId, { lut: null })
            else if (v.startsWith('shared:')) void run(() => copySharedLut(v.slice(7)).then(apply))
          }}
          className={`${inputCls} min-w-0 flex-1 py-1 ${disabledCls}`}
        >
          <option value="">None</option>
          {lut && <option value={`own:${lut.file}`}>{lut.name}</option>}
          {sharedLuts.length > 0 && (
            <optgroup label="Shared library">
              {sharedLuts.map((i) => (
                <option key={i.id} value={`shared:${i.id}`}>
                  {i.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button
          data-testid="lut-import"
          disabled={busy}
          onClick={() => void run(() => importLutDialog().then(apply))}
          className={`${subtleBtnCls} shrink-0 py-1 ${disabledCls}`}
          title="Pick a .cube file; it is copied into the project"
        >
          Import LUT…
        </button>
      </div>
      {lut && (
        <>
          <div className="mt-2 mb-1 flex items-center gap-2">
            <span className="w-24 shrink-0 text-[10px] tracking-wide text-zinc-500 uppercase">
              {`Strength ${Math.round(lut.strength * 100)}%`}
            </span>
            <LiveRange min={0} max={1} step={0.01} value={lut.strength} transform={setStrength} />
          </div>
          <button
            data-testid="lut-share"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const res = await shareLut(lut.file, lut.name)
                qc.setQueryData(SHARED_QUERY_KEY, res.items)
                setNote(describeSharedAdd(res))
              })
            }
            className={`${subtleBtnCls} w-full py-1 ${disabledCls}`}
          >
            Save to shared library
          </button>
        </>
      )}
      {(error || note) && (
        <p
          data-testid={error ? 'lut-error' : 'lut-note'}
          role={error ? 'alert' : 'status'}
          className={`mt-1 text-[10px] leading-snug ${error ? 'text-rose-300' : 'text-sky-200'}`}
        >
          {error ?? note}
        </p>
      )}
    </div>
  )
}
