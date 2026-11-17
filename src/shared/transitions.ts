/**
 * TRANSITIONS (#64) — cross dissolve, dip to black / white, and a plain fade at
 * a clip's end, for video and image tiles. THE preview/export parity point for
 * them: the preview's layer box takes its opacity from `layerOpacityAt` and its
 * dip plates from `transitionPlates`; the export drives the same opacity through
 * its keyframed-opacity path (`layerOpacityPoints` → sendcmd → colorchannelmixer
 * `aa`) and paints the same plates as a full-frame `drawbox`. Verified against
 * the real binary — docs/FFMPEG-NOTES.md "Transitions".
 *
 * The model (`Layer.transitionIn` / `transitionOut`, shared/project.ts): each
 * tile carries its own edges. A transition between two clips is a PAIR — the
 * outgoing tile's `transitionOut` and the incoming tile's `transitionIn`, same
 * kind and length, where the incoming tile starts `sec` before the outgoing one
 * ends (they overlap by exactly the transition). The pair is found from the
 * tiles (`transitionPairs`), never stored, so it cannot point at a deleted tile.
 *
 * Every side is a ramp on its own tile's opacity, and needs no partner:
 *
 * - fade / dissolve IN: 0 → 1 over the window. A dissolve is the incoming clip
 *   fading in over the outgoing one, which stays at full strength underneath
 *   (a dissolve OUT is no ramp at all — fading it too would darken the middle).
 * - fade OUT: 1 → 0 over the window, onto whatever is underneath.
 * - dip OUT: 1 → 0 over the first half, then hidden; dip IN: hidden for the
 *   first half, then 0 → 1. Under them, a full-frame colour PLATE for the
 *   window: one plate under the lower tile of a pair (so whatever lies under the
 *   pair is hidden while the picture dips), or under a lone side's own tile.
 */

import type { Layer, LayerTransition, TransitionKind } from './project'
import { layerTransformAt, opacityKeyframePoints } from './layers'
import { clamp, clamp01 } from './math'

/** Length bounds (seconds): the default, and the range any edit is held to. A
 *  transition is also never longer than half the shorter of its tiles
 *  (`maxTransitionSec`). */
export const TRANSITION_DEFAULT_SEC = 0.5
export const TRANSITION_MIN_SEC = 0.1
export const TRANSITION_MAX_SEC = 2

/** How far (seconds) the incoming tile's start may sit from where the pair
 *  needs it (`outgoing end − sec`) and still count as a pair. */
export const TRANSITION_PAIR_TOL = 0.02

/** What each kind is: its label, whether it joins two clips (`pair`), and the
 *  colour of the plate under a dip. */
export const TRANSITION_KINDS = {
  dissolve: { label: 'Cross dissolve', pair: true, plate: null },
  dipBlack: { label: 'Dip to black', pair: true, plate: '#000000' },
  dipWhite: { label: 'Dip to white', pair: true, plate: '#ffffff' },
  fade: { label: 'Fade', pair: false, plate: null }
} as const satisfies Record<TransitionKind, { label: string; pair: boolean; plate: string | null }>

/** The kinds that join two neighbouring clips (Add transition offers these). */
export const PAIR_KINDS = (Object.keys(TRANSITION_KINDS) as TransitionKind[]).filter((k) => TRANSITION_KINDS[k].pair)

export type TransitionSide = 'in' | 'out'

/** The field a side lives in. */
export const sideField = (side: TransitionSide): 'transitionIn' | 'transitionOut' =>
  side === 'in' ? 'transitionIn' : 'transitionOut'

/** Whether a layer kind takes transitions at all (video and image, this round). */
export function takesTransitions(layer: Layer): boolean {
  return layer.content.kind === 'video' || layer.content.kind === 'image'
}

/** A layer's transition on `side`, or null (absent, or a kind that ignores them). */
export function transitionOf(layer: Layer, side: TransitionSide): LayerTransition | null {
  if (!takesTransitions(layer)) return null
  const tr = layer[sideField(side)]
  return tr && Number.isFinite(tr.sec) && tr.sec > 0 && tr.kind in TRANSITION_KINDS ? tr : null
}

/** The longest transition tiles of these lengths can take: half the shorter,
 *  never above TRANSITION_MAX_SEC (may come out below TRANSITION_MIN_SEC — then
 *  they are too short for one). */
export function maxTransitionSec(...tileSec: number[]): number {
  return Math.min(TRANSITION_MAX_SEC, ...tileSec.map((s) => Math.max(0, s) / 2))
}

/** `sec` held to [TRANSITION_MIN_SEC, max]. */
export function clampTransitionSec(sec: number, max: number): number {
  return clamp(sec, TRANSITION_MIN_SEC, Math.max(TRANSITION_MIN_SEC, max))
}

/** `layer` with `side` set to `tr`, or the field removed for null — never left
 *  as `undefined`, so a tile without transitions keeps the shape it had. */
export function withTransition(layer: Layer, side: TransitionSide, tr: LayerTransition | null): Layer {
  const field = sideField(side)
  if (tr) return { ...layer, [field]: tr }
  if (!(field in layer)) return layer
  const next = { ...layer }
  delete next[field]
  return next
}

/** The IN ramp (0..1) of a tile starting at `startSec`, at timeline time `t`. */
export function inRampAt(tr: LayerTransition, startSec: number, t: number): number {
  const local = t - startSec
  if (tr.kind === 'dipBlack' || tr.kind === 'dipWhite') {
    const half = tr.sec / 2
    return clamp01((local - half) / half)
  }
  return clamp01(local / tr.sec)
}

/** The OUT ramp (0..1) of a tile ending at `endSec`, at timeline time `t`. */
export function outRampAt(tr: LayerTransition, endSec: number, t: number): number {
  const left = endSec - t
  if (tr.kind === 'dissolve') return 1
  if (tr.kind === 'dipBlack' || tr.kind === 'dipWhite') {
    const half = tr.sec / 2
    return clamp01((left - half) / half)
  }
  return clamp01(left / tr.sec)
}

/** The product of a layer's transition ramps at `t` (1 = none). */
export function transitionGainAt(layer: Layer, t: number): number {
  const tin = transitionOf(layer, 'in')
  const tout = transitionOf(layer, 'out')
  return (tin ? inRampAt(tin, layer.startSec, t) : 1) * (tout ? outRampAt(tout, layer.endSec, t) : 1)
}

/**
 * THE layer opacity at timeline time `t` (0..1): its keyframed opacity
 * (`layerTransformAt`) times its transition ramps. The preview's layer box uses
 * it as is; the export samples it into `layerOpacityPoints`.
 */
export function layerOpacityAt(layer: Layer, t: number): number {
  return layerTransformAt(layer, t).opacity * transitionGainAt(layer, t)
}

/** Times (absolute) where a side's ramp has a corner. */
function rampCorners(layer: Layer): number[] {
  const out: number[] = []
  const tin = transitionOf(layer, 'in')
  const tout = transitionOf(layer, 'out')
  if (tin) out.push(layer.startSec, layer.startSec + tin.sec / 2, layer.startSec + tin.sec)
  if (tout && tout.kind !== 'dissolve') out.push(layer.endSec - tout.sec, layer.endSec - tout.sec / 2, layer.endSec)
  return out
}

/** The export's frame step: where two factors change at once the product is
 *  quadratic, so it is sampled at least this often (FFMPEG-NOTES "Transitions"). */
const SAMPLE_SEC = 1 / 30

/**
 * `layerOpacityAt` as ABSOLUTE-time points the export's sendcmd intervals
 * interpolate linearly (`buildOpacityCmdLines`), or null when the layer never
 * drops below full opacity — the plain opaque pipeline then stays. A layer with
 * no transition gets exactly `opacityKeyframePoints`, so its export is
 * byte-identical to one made before transitions existed. With one, the points
 * are every corner of any factor across the tile's window, plus a sample every
 * 1/30 s wherever TWO OR MORE of the three factors (keyframed opacity, the in
 * ramp, the out ramp) move at once — the product is quadratic there: keyframes
 * under a ramp, or a tile shorter than its two ramps (trimmed after they were
 * set), whose in and out ramps overlap. Each factor is linear between the
 * corners, so a stretch's ends say whether it moves. Frame-step sampling
 * matched the real render to 2.75 code values.
 */
export function layerOpacityPoints(layer: Layer): { t: number; o: number }[] | null {
  const corners = rampCorners(layer)
  if (corners.length === 0) return opacityKeyframePoints(layer)
  const lo = layer.startSec
  const hi = layer.endSec
  const kfTimes = (layer.keyframes ?? []).map((k) => layer.startSec + k.tSec)
  const times = [...new Set([lo, hi, ...corners, ...kfTimes].map((t) => clamp(t, lo, hi)))].sort((a, b) => a - b)
  const tin = transitionOf(layer, 'in')
  const tout = transitionOf(layer, 'out')
  const factors: ((t: number) => number)[] = [
    (t) => layerTransformAt(layer, t).opacity,
    (t) => (tin ? inRampAt(tin, layer.startSec, t) : 1),
    (t) => (tout ? outRampAt(tout, layer.endSec, t) : 1)
  ]
  const pts: { t: number; o: number }[] = []
  for (let i = 0; i < times.length; i++) {
    const t0 = times[i]
    pts.push({ t: t0, o: layerOpacityAt(layer, t0) })
    const t1 = times[i + 1]
    if (t1 === undefined || t1 - t0 <= 1e-6) continue
    const moving = factors.filter((f) => Math.abs(f(t0) - f(t1)) > 1e-6).length
    if (moving < 2) continue
    const n = Math.ceil((t1 - t0) / SAMPLE_SEC - 1e-9)
    for (let k = 1; k < n; k++) {
      const t = t0 + ((t1 - t0) * k) / n
      pts.push({ t, o: layerOpacityAt(layer, t) })
    }
  }
  return pts.every((p) => p.o >= 0.9995) ? null : pts
}

/** A cross dissolve or dip between two tiles: the outgoing tile's `transitionOut`
 *  and the incoming tile's `transitionIn`, found from where the tiles sit. */
export interface TransitionPair {
  outId: string
  inId: string
  kind: TransitionKind
  sec: number
}

/**
 * Every transition pair among `layers`: an incoming tile whose `transitionIn`
 * is a pair kind, matched to an outgoing tile with a `transitionOut` of the same
 * kind and length that ends `sec` after the incoming tile starts (within
 * TRANSITION_PAIR_TOL). Each tile pairs once on each side; when two candidates
 * fit, the closer one wins.
 */
export function transitionPairs(layers: Layer[]): TransitionPair[] {
  const pairs: TransitionPair[] = []
  const usedOut = new Set<string>()
  for (const b of layers) {
    const tin = transitionOf(b, 'in')
    if (!tin || !TRANSITION_KINDS[tin.kind].pair) continue
    let best: { a: Layer; err: number } | null = null
    for (const a of layers) {
      if (a.id === b.id || usedOut.has(a.id)) continue
      const tout = transitionOf(a, 'out')
      if (!tout || tout.kind !== tin.kind || Math.abs(tout.sec - tin.sec) > 1e-3) continue
      if (a.startSec >= b.startSec) continue
      const err = Math.abs(a.endSec - (b.startSec + tin.sec))
      if (err <= TRANSITION_PAIR_TOL && (!best || err < best.err)) best = { a, err }
    }
    if (!best) continue
    usedOut.add(best.a.id)
    pairs.push({ outId: best.a.id, inId: b.id, kind: tin.kind, sec: tin.sec })
  }
  return pairs
}

/** The pair a tile's `side` belongs to, or null (a fade, or a side whose
 *  partner is gone or has moved away). */
export function pairOf(layers: Layer[], id: string, side: TransitionSide): TransitionPair | null {
  return transitionPairs(layers).find((p) => (side === 'in' ? p.inId : p.outId) === id) ?? null
}

/** A full-frame colour plate painted directly UNDER layer `belowId` for
 *  [startSec, endSec] — what a dip shows while neither picture does. */
export interface TransitionPlate {
  color: string
  startSec: number
  endSec: number
  belowId: string
}

/**
 * The dip plates of a stack (`layers` back → front). A pair gets ONE plate under
 * whichever of its two tiles is lower in the stack, for the whole window; a lone
 * dip side (its partner gone) gets one under its own tile for its own window.
 * Hidden tiles contribute nothing (a pair with a hidden member counts as the
 * visible side alone).
 */
export function transitionPlates(layers: Layer[]): TransitionPlate[] {
  const shown = layers.filter((l) => !l.hidden && takesTransitions(l))
  const index = new Map(layers.map((l, i) => [l.id, i]))
  const plates: TransitionPlate[] = []
  const paired = new Set<string>()
  for (const p of transitionPairs(shown)) {
    paired.add(`in:${p.inId}`).add(`out:${p.outId}`)
    const color = TRANSITION_KINDS[p.kind].plate
    if (!color) continue
    const b = shown.find((l) => l.id === p.inId)!
    const lower = (index.get(p.outId) ?? 0) < (index.get(p.inId) ?? 0) ? p.outId : p.inId
    plates.push({ color, startSec: b.startSec, endSec: b.startSec + p.sec, belowId: lower })
  }
  for (const l of shown) {
    const tin = transitionOf(l, 'in')
    const tout = transitionOf(l, 'out')
    const inColor = tin ? TRANSITION_KINDS[tin.kind].plate : null
    const outColor = tout ? TRANSITION_KINDS[tout.kind].plate : null
    if (tin && inColor && !paired.has(`in:${l.id}`)) {
      plates.push({ color: inColor, startSec: l.startSec, endSec: l.startSec + tin.sec, belowId: l.id })
    }
    if (tout && outColor && !paired.has(`out:${l.id}`)) {
      plates.push({ color: outColor, startSec: l.endSec - tout.sec, endSec: l.endSec, belowId: l.id })
    }
  }
  return plates
}

/** The plates painted under `layerId` that are on screen at `t` (the preview's
 *  per-tick view of `transitionPlates`; the window is half-open like a layer's). */
export function platesUnderAt(plates: TransitionPlate[], layerId: string, t: number): TransitionPlate[] {
  return plates.filter((p) => p.belowId === layerId && t >= p.startSec && t < p.endSec)
}

/**
 * A layer cut in two at a split: the left half keeps the transition IN, the
 * right half the transition OUT (the same rule as a text entrance and exit), so
 * neither plays mid-clip at the seam.
 */
export function splitTransitions(left: Layer, right: Layer): [Layer, Layer] {
  return [withTransition(left, 'out', null), withTransition(right, 'in', null)]
}
