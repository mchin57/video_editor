/**
 * Inspector ▸ Transitions (#64) for a video / image tile: Add transition (when
 * the selection is two neighbouring clips), and per edge the transition it has
 * — a cross dissolve / dip with its partner (kind, length, Remove) or a plain
 * fade (its length; 0 = none). Every change is one undo step through the
 * store's transition actions (`lib/transitions.ts` has the rules).
 */

import { useMemo, type JSX } from 'react'
import type { Layer, TransitionKind } from '@shared/project'
import { layerLabel } from '@shared/layers'
import {
  maxTransitionSec,
  pairOf,
  PAIR_KINDS,
  TRANSITION_KINDS,
  TRANSITION_MIN_SEC,
  transitionOf,
  type TransitionSide
} from '@shared/transitions'
import { maxSideSec, transitionCandidate } from '@/lib/transitions'
import { useLibrary } from '@/hooks/useMedia'
import { activeComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { Field, NumberInput, btnCls, inputCls, subtleBtnCls } from '../ui'

const SIDE_TITLE: Record<TransitionSide, string> = { in: 'Start', out: 'End' }

export function TransitionSection({ layer }: { layer: Layer }): JSX.Element | null {
  const comp = useProject(activeComp)
  const selection = useUi((s) => s.selection)
  const { data: assets = [] } = useLibrary()
  const srcDur = useMemo(() => {
    const byId = new Map(assets.map((a) => [a.id, a.probe.durationSec]))
    return (id: string): number => byId.get(id) ?? 0
  }, [assets])
  if (!comp) return null
  const check = transitionCandidate(comp, selection)
  const mine = check.ok && (check.outId === layer.id || check.inId === layer.id)
  return (
    <div data-testid="transition-section">
      {mine && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Add transition</div>
          <div className="flex flex-wrap gap-1">
            {PAIR_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                data-testid={`add-transition-${kind}`}
                className={btnCls}
                onClick={() => void useProject.getState().applyTransition(selection, kind, srcDur)}
                title={`Overlap the two clips by ${check.sec.toFixed(2)} s (the second clip and everything after it move left) and ${TRANSITION_KINDS[kind].label.toLowerCase()}`}
              >
                {TRANSITION_KINDS[kind].label}
              </button>
            ))}
          </div>
        </div>
      )}
      <SideControls layer={layer} side="in" srcDur={srcDur} />
      <SideControls layer={layer} side="out" srcDur={srcDur} />
      <p className="mt-1 text-[10px] leading-snug text-zinc-500">
        Select two clips that meet (Ctrl-click) to join them with a cross dissolve or a dip; their linked sound
        crossfades (edit it with the audio clips&apos; fades). Drag a wedge on the timeline to change a length, or a
        tile&apos;s top corner to fade it.
      </p>
    </div>
  )
}

function SideControls({
  layer,
  side,
  srcDur
}: {
  layer: Layer
  side: TransitionSide
  srcDur: (id: string) => number
}): JSX.Element | null {
  const comp = useProject(activeComp)
  if (!comp) return null
  const tr = transitionOf(layer, side)
  const pair = tr ? pairOf(comp.layers, layer.id, side) : null
  const partner = pair ? comp.layers.find((l) => l.id === (side === 'in' ? pair.outId : pair.inId)) : undefined
  const store = useProject.getState()
  const len = layer.endSec - layer.startSec
  if (!tr || tr.kind === 'fade') {
    // A plain fade at this edge: 0 = none.
    return (
      <Field label={`Fade ${side} (s) · ${SIDE_TITLE[side].toLowerCase()} of the clip`}>
        <NumberInput
          step="0.1"
          min={0}
          max={maxTransitionSec(len)}
          value={tr?.sec ?? 0}
          format={(v) => v.toFixed(2)}
          ariaLabel={`Fade ${side} seconds`}
          className={`${inputCls}`}
          onCommit={(v) => store.setLayerFade(layer.id, side, v)}
        />
      </Field>
    )
  }
  const max = maxSideSec(comp, layer.id, side)
  return (
    <div className="mb-2" data-testid={`transition-${side}`}>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
        {SIDE_TITLE[side]} · {partner ? `with ${layerLabel(partner)}` : 'no partner clip'}
      </div>
      <div className="flex items-center gap-1">
        <select
          aria-label={`Transition ${side} kind`}
          data-testid={`transition-${side}-kind`}
          className={`${inputCls} w-auto`}
          value={tr.kind}
          onChange={(e) => store.setTransitionKind(layer.id, side, e.target.value as TransitionKind)}
        >
          {[...PAIR_KINDS, 'fade' as const].map((k) => (
            <option key={k} value={k}>
              {k === 'fade' && pair ? 'Fade (separate the clips)' : TRANSITION_KINDS[k].label}
            </option>
          ))}
        </select>
        <NumberInput
          step="0.1"
          min={TRANSITION_MIN_SEC}
          max={Math.max(TRANSITION_MIN_SEC, max)}
          value={tr.sec}
          format={(v) => v.toFixed(2)}
          ariaLabel={`Transition ${side} seconds`}
          title="Length (s) — the clips overlap by this much"
          onCommit={(v) => store.setTransitionLength(layer.id, side, v, srcDur)}
        />
        <button
          type="button"
          data-testid={`transition-${side}-remove`}
          className={subtleBtnCls}
          title="Remove the transition (the clips keep their overlap)"
          onClick={() => store.removeTransition(layer.id, side)}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
