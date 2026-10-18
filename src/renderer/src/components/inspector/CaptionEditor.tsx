/** Inspector ▸ the selected CAPTION, and the caption lane's shared style. */

import { useRef, type JSX } from 'react'
import type { CaptionSegment, CaptionStyle } from '@shared/project'
import { effectiveCaptionStyle } from '@shared/project'
import { captionWithText } from '@/lib/captions'
import { activeComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { CollapsibleSection } from '../CollapsibleSection'
import { TextStyleControls } from '../TextStyleControls'
import { AngleField, Field, NumberInput, useTypingGesture, dangerBtnCls, disabledCls, inputCls } from '../ui'
import { useLinkGroupSize, useMaxEndSec, LinkedNote, useDeleteTile } from './controls'

/** The shared style controls (color / font / position / rotation / pill) used by
 *  both the lane-wide caption style and a per-caption override. */
function CaptionStyleFields({
  style,
  onPatch
}: {
  style: CaptionStyle
  onPatch: (patch: Partial<CaptionStyle>) => void
}): JSX.Element {
  return (
    <>
      <TextStyleControls style={style} onPatch={onPatch} />
      <div className="flex gap-2">
        <Field label="Position X">
          <NumberInput step="5" value={Math.round(style.x)} onCommit={(x) => onPatch({ x })} />
        </Field>
        <Field label="Position Y">
          <NumberInput step="5" value={Math.round(style.y)} onCommit={(y) => onPatch({ y })} />
        </Field>
      </div>
      <AngleField value={style.rotationDeg} onChange={(rotationDeg) => onPatch({ rotationDeg })} />
    </>
  )
}
/** Editing the lane-wide caption style (selected via the "Captions" gutter label):
 *  every caption without its own override updates live. */
export function CaptionStyleEditor(): JSX.Element | null {
  const captions = useProject((s) => activeComp(s)?.captions)
  const setCaptionStyle = useProject((s) => s.setCaptionStyle)
  if (!captions) return null
  const overrides = captions.segments.filter((s) => s.style).length

  return (
    <div>
      <div className="mb-1 text-sm font-medium text-zinc-200">All captions</div>
      <p className="mb-3 text-[11px] text-zinc-500">
        Style every caption at once. Select a single caption block to override it individually.
      </p>
      <CaptionStyleFields style={captions.style} onPatch={(patch) => setCaptionStyle(patch)} />
      {overrides > 0 && (
        <p className="mt-1 text-[11px] text-zinc-600">
          {overrides} caption{overrides === 1 ? '' : 's'} use a custom style and ignore these settings.
        </p>
      )}
    </div>
  )
}
function CaptionTextInput({
  seg,
  onChange
}: {
  seg: CaptionSegment
  onChange: (next: CaptionSegment) => void
}): JSX.Element {
  const origin = useRef<CaptionSegment | null>(null)
  const typing = useTypingGesture()
  // The focus-time words, unless the caption has since moved (then they'd be in the wrong place).
  const base = (): CaptionSegment => {
    const o = origin.current
    return o && o.id === seg.id && o.startSec === seg.startSec && o.endSec === seg.endSec ? o : seg
  }
  return (
    <textarea
      value={seg.text}
      rows={2}
      onFocus={() => {
        origin.current = seg
        typing.onFocus()
      }}
      onBlur={() => {
        origin.current = null
        typing.onBlur()
      }}
      onChange={(e) => onChange(captionWithText(base(), e.target.value))}
      className={inputCls}
    />
  )
}
export function CaptionEditor(): JSX.Element | null {
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const captions = useProject((s) => activeComp(s)?.captions)
  const seg = useProject((s) => activeComp(s)?.captions.segments.find((c) => c.id === selectedCaptionId) ?? null)
  const update = useProject((s) => s.updateCaption)
  const groupSize = useLinkGroupSize('caption', selectedCaptionId)
  const linked = groupSize > 1
  const remove = useDeleteTile('caption', selectedCaptionId)
  const setSegStyle = useProject((s) => s.setCaptionSegmentStyle)
  const clearSegStyle = useProject((s) => s.clearCaptionSegmentStyle)
  const selectCaptionsGlobal = useUi((s) => s.selectCaptionsGlobal)
  const maxEnd = useMaxEndSec(null) // captions don't count toward the edit's length
  if (!seg || !captions) return null
  const overridden = !!seg.style
  const style = effectiveCaptionStyle(captions, seg)

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-zinc-200">Caption</div>
      {linked && <LinkedNote size={groupSize} />}
      <Field label="Text">
        <CaptionTextInput seg={seg} onChange={(next) => update(seg.id, { text: next.text, words: next.words })} />
      </Field>
      <div className="flex gap-2">
        <Field label="Start (s)">
          <NumberInput
            step="0.1"
            min={0}
            max={seg.endSec - 0.1}
            value={seg.startSec}
            format={(v) => v.toFixed(1)}
            disabled={linked}
            onCommit={(v) => update(seg.id, { startSec: v })}
            className={`${inputCls} ${disabledCls}`}
          />
        </Field>
        <Field label="End (s)">
          <NumberInput
            step="0.1"
            min={seg.startSec + 0.1}
            max={Math.max(seg.startSec + 0.1, maxEnd)}
            value={seg.endSec}
            format={(v) => v.toFixed(1)}
            disabled={linked}
            onCommit={(v) => update(seg.id, { endSec: v })}
            className={`${inputCls} ${disabledCls}`}
          />
        </Field>
      </div>
      <label className="mb-3 flex items-center gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={seg.enabled} onChange={(e) => update(seg.id, { enabled: e.target.checked })} />
        Show this caption
      </label>

      <CollapsibleSection
        id="caption-style"
        title={overridden ? 'Style · custom' : 'Style · follows all'}
        right={
          overridden ? (
            <button onClick={() => clearSegStyle(seg.id)} className="text-[10px] text-zinc-400 hover:text-zinc-200">
              Reset to global
            </button>
          ) : null
        }
      >
        {!overridden && (
          <p className="mb-2 text-[11px] text-zinc-500">
            This caption follows the{' '}
            <button onClick={selectCaptionsGlobal} className="text-sky-400 hover:underline">
              lane-wide style
            </button>
            . Changing anything below makes it independent.
          </p>
        )}
        <CaptionStyleFields style={style} onPatch={(patch) => setSegStyle(seg.id, patch)} />
      </CollapsibleSection>

      <button onClick={remove} className={`mt-3 w-full ${dangerBtnCls}`}>
        {linked ? `Delete linked group (${groupSize})` : 'Delete caption'}
      </button>
    </div>
  )
}
