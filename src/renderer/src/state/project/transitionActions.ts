/** Project store slice: TRANSITIONS between clips and fades at a clip's end
 *  (#64) — each one undo step, all through the pure edits in `lib/transitions.ts`
 *  (the rules are listed there and in docs/TIMELINE.md "Transitions"). */

import type { LayerTransition, TimelineItemRef, TransitionKind } from '@shared/project'
import type { TransitionSide } from '@shared/transitions'
import type { SourceDuration } from '@/lib/links'
import * as tx from '@/lib/transitions'
import { activeComp, type Doc } from './core'

export interface TransitionActions {
  /**
   * Add a cross dissolve / dip between the two neighbouring clips `refs` pick:
   * the incoming clip, its group and everything after it slide left by the
   * length, it goes above the outgoing clip, and their linked sound crossfades.
   * One undo step. Returns why not (changing nothing) when the selection does
   * not qualify.
   */
  applyTransition: (
    refs: TimelineItemRef[],
    kind: TransitionKind,
    srcDur?: SourceDuration
  ) => { ok: true } | { ok: false; reason: string }
  /** Change a transition's length (a pair slides its incoming side by the change). */
  setTransitionLength: (layerId: string, side: TransitionSide, sec: number, srcDur?: SourceDuration) => void
  /** Change a transition's kind (a pair together; a fade breaks the pair). */
  setTransitionKind: (layerId: string, side: TransitionSide, kind: TransitionKind) => void
  /** Remove a transition (both sides of a pair); the overlap stays. */
  removeTransition: (layerId: string, side: TransitionSide) => void
  /** A plain fade at a clip's start or end; 0 removes it. */
  setLayerFade: (layerId: string, side: TransitionSide, sec: number) => void
  /** The assistant's `set_transition`: one side's transition in ONE undo step
   *  (`setSideTransition`). Throws, changing nothing, when it can't. */
  setSideTransition: (
    layerId: string,
    side: TransitionSide,
    kind: TransitionKind | 'none',
    sec?: number,
    srcDur?: SourceDuration
  ) => { transition: LayerTransition | null; partnerId: string | null }
}

export const transitionActions = ({ get, commitComp }: Doc): TransitionActions => ({
  applyTransition: (refs, kind, srcDur) => {
    const comp = activeComp(get())
    if (!comp) return { ok: false, reason: 'No project is open.' }
    const check = tx.transitionCandidate(comp, refs)
    if (!check.ok) return check
    commitComp((c) => tx.applyTransition(c, refs, kind, srcDur))
    return { ok: true }
  },

  setTransitionLength: (layerId, side, sec, srcDur) =>
    commitComp((c) => tx.setTransitionLength(c, layerId, side, sec, srcDur)),

  setTransitionKind: (layerId, side, kind) => commitComp((c) => tx.setTransitionKind(c, layerId, side, kind)),

  removeTransition: (layerId, side) => commitComp((c) => tx.removeTransition(c, layerId, side)),

  setLayerFade: (layerId, side, sec) => commitComp((c) => tx.setFade(c, layerId, side, sec)),

  setSideTransition: (layerId, side, kind, sec, srcDur) => {
    const comp = activeComp(get())
    if (!comp) throw new Error('Editor has no project open')
    // Built first (throws before anything is committed), then ONE commit.
    const r = tx.setSideTransition(comp, layerId, side, kind, sec, srcDur)
    commitComp(() => r.comp)
    return { transition: r.transition, partnerId: r.partnerId }
  }
})
