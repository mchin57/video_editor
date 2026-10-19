/** Timeline ▸ geometry constants, lane colours (`LANE_STYLE`, exhaustive over `TileLane`) and the persisted view preferences (zoom, follow mode, lane sizes). */

import type { AudioClip, CaptionSegment, Layer, ScriptLine, VolumeLevel } from '@shared/project'
import { type LaneGeometry, type LaneViewPref } from '@/lib/lanes'
import { type TileLane } from '@/lib/links'
import { enumPref, numberPref, objectPref } from '@/lib/persisted'

const DEFAULT_PPS = 48
export const HOOK_SEC = 3
export const SNAP_PX = 7
/** Pointer slop (px) below which a press+release counts as a click, not a drag. */
export const CLICK_SLOP = 2
export const GUTTER = 84
export const RULER_H = 20
export const ROW_H = 26
export const MIN_ROW_H = 16
export const MAX_ROW_H = 60
const COLLAPSED_H = 14
export const GAP = 4
export const SCALE_H = 18
export const DND_MIME = 'application/x-reel-asset'
export const EMPTY_LAYERS: Layer[] = []
export const EMPTY_CAPTIONS: CaptionSegment[] = []
export const EMPTY_SCRIPT: ScriptLine[] = []
export const EMPTY_AUDIO: AudioClip[] = []
export const EMPTY_LEVELS: VolumeLevel[] = []
// Lane visual identity (the labeled bands the user likes — now purely a visual
// grouping over the unified layer stack). Keyed by `TileLane`, and the
// `satisfies` makes that exhaustive: adding a band to the tile model without
// giving it colours here is a compile error, so the two can't drift apart.
export const LANE_STYLE = {
  clips: {
    dot: 'bg-sky-400',
    tint: 'border-sky-400/30 bg-sky-500/10',
    block: 'border-sky-400/40 bg-sky-500/20',
    sel: 'border-sky-300 ring-1 ring-sky-300/50'
  },
  layout: {
    dot: 'bg-fuchsia-400',
    tint: 'border-fuchsia-400/30 bg-fuchsia-500/10',
    block: 'border-fuchsia-400/40 bg-fuchsia-500/20',
    sel: 'border-fuchsia-300 ring-1 ring-fuchsia-300/50'
  },
  text: {
    dot: 'bg-violet-400',
    tint: 'border-violet-400/30 bg-violet-500/10',
    block: 'border-violet-400/40 bg-violet-500/20',
    sel: 'border-violet-300 ring-1 ring-violet-300/50'
  },
  image: {
    dot: 'bg-orange-400',
    tint: 'border-orange-400/30 bg-orange-500/10',
    block: 'border-orange-400/40 bg-orange-500/20',
    sel: 'border-orange-300 ring-1 ring-orange-300/50'
  },
  caption: {
    dot: 'bg-emerald-400',
    tint: 'border-emerald-400/30 bg-emerald-500/10',
    block: 'border-emerald-400/40 bg-emerald-500/25',
    sel: 'border-emerald-300 ring-1 ring-emerald-300/50'
  },
  audio: {
    dot: 'bg-sky-300',
    tint: 'border-sky-300/30 bg-sky-500/10',
    block: 'border-sky-400/40 bg-sky-500/15',
    sel: 'border-sky-300 ring-1 ring-sky-300/50'
  },
  fx: {
    dot: 'bg-teal-300',
    tint: 'border-teal-300/30 bg-teal-500/10',
    block: 'border-teal-400/40 bg-teal-500/15',
    sel: 'border-teal-300 ring-1 ring-teal-300/50'
  }
} as const satisfies Record<TileLane, { dot: string; tint: string; block: string; sel: string }>
export type LaneKey = TileLane
// Vertical geometry passed to the pure lane-layout math in `lib/lanes.ts`.
export const LANE_GEOM: LaneGeometry = {
  rulerH: RULER_H,
  rowH: ROW_H,
  minRowH: MIN_ROW_H,
  maxRowH: MAX_ROW_H,
  collapsedH: COLLAPSED_H,
  gap: GAP,
  scaleH: SCALE_H
}
/** Per-lane view prefs — height-per-row (so clips scale with the lane) and a
 *  collapsed flag. Purely a UI preference like the zoom level, so it lives in
 *  localStorage (`timelineView`), not the project document. */
type TimelineView = Partial<Record<LaneKey, LaneViewPref>>
/** How the track scroll tracks the playhead during playback: stay put, jump a
 *  page when the playhead exits the view (DAW default), or keep it centered.
 *  A view preference like zoom, so it lives in localStorage. */
type FollowMode = 'none' | 'page' | 'centered'
export const FOLLOW_OPTIONS: { mode: FollowMode; label: string; title: string }[] = [
  { mode: 'none', label: 'Off', title: 'Timeline stays where you scrolled it during playback' },
  { mode: 'page', label: 'Page', title: 'Jump forward a page when the playhead reaches the right edge' },
  { mode: 'centered', label: 'Center', title: 'Continuously scroll to keep the playhead centered' }
]
// View preferences (lib/persisted.ts): zoom, follow mode, per-lane sizes.
export const PPS_PREF = numberPref(DEFAULT_PPS, 8, 240)
export const FOLLOW_PREF = enumPref<FollowMode>(['none', 'page', 'centered'], 'none')
export const VIEW_PREF = objectPref<TimelineView>(() => ({}))
