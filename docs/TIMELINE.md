# Timeline behaviors — regression checklist

`Timeline.tsx` (with its pieces in `components/timeline/`: view-state and
effect hooks in `hooks.ts`, tile press / move / trim in `useTileDrags.ts`, the
toolbar and the lane gutter) is the densest interaction surface in the app.
Pointer drag, edge auto-scroll and scroll math need a real DOM with layout +
rAF, which jsdom fakes badly, so its guarantees live in the e2e suite below. A
lane resize/collapse feature was once lost — silently dropped by an unrelated
timeline refactor because nothing failed; the 2026-10 split of the component was
done only after the manual list below was automated
(`e2e/timelineInteractions.spec.ts`).

**Rule:** before you refactor `Timeline.tsx`, skim this list; after, verify each
item still works. Anything with a test file is guarded automatically — keep it
green. Everything under _Manual_ you must smoke-test in `npm run dev`.

**The e2e suite (`npm run test:e2e`, Playwright driving the real Electron app)
is the migration target for the Manual list** — real pointer drags, keybinds,
and drop-zone state are all expressible there now (see `e2e/fixtures.ts` for
the arrange-via-stores / act-via-events pattern). When you automate a Manual
item, move it into the guarded table below.

## Guarded by tests (keep green)

| Behavior | Test |
| --- | --- |
| Overlapping blocks stack onto rows (`packRows`) | `lib/lanes.test.ts` |
| Lane vertical layout — height = `rows * rowH`, collapsed → thin strip, gaps, `totalH` (`layoutLanes`) | `lib/lanes.test.ts` |
| Lane-resize height math — delta spread across rows, clamped (`resizeRowH`) | `lib/lanes.test.ts` |
| Boundary snapping (`snap`) | `lib/lanes.test.ts` |
| Time-scale tick spacing/labels | `lib/timescale.test.ts` |
| Freeze-aware trim/split — holds survive edge trims, splits partition holds, window invariant (`trimVideoStart`/`trimVideoEnd`/`splitVideoLayer`) | `lib/timeline.test.ts` |
| Splitting a text/image layer (`splitStaticLayer`) — entrance goes left, exit goes right, `wordHighlight` stays on both — and a caption (`splitCaptionSegment`) — words partition, text rebuilt | `lib/timeline.test.ts` |
| Keyframes survive a split — right half re-based, interpolated transform pinned at the seam, full opacity stays absent (video + static layers) | `lib/timeline.test.ts` |
| Block move drag + right-edge trim drag on the real timeline (incl. frozen-clip regression) | `e2e/freezeTrim.spec.ts` |
| S-keybind split at the playhead | `e2e/freezeTrim.spec.ts` |
| Right-edge trim walks back through footage AND holds (`trimVideoEndBy`, lone tile and group): into a freeze it cuts everything past it, then shortens the hold, dropping a used-up hold (or one cut under 1 ms) and carrying on into earlier footage — continuous in the delta incl. exactly at a boundary, through the clip's speed; a link group trimmed into a freeze stays in step; a freeze overlay's edge sets one hold (`setFreezeHold`, ≥ 0.1 s, only the clip end moves); overlay placement (`freezeSpans`); a picked freeze resolves by index + `atSec`, stale or linked = none (`pickedFreezeIndex`) | `lib/timeline.test.ts`, `lib/links.test.ts`, `shared/layers.test.ts` |
| Freeze overlay on a clip tile: a blue box over each hold; dragging its right edge changes the hold (one undo step); dragging the clip's right edge into it cuts past it then shortens it; a freeze on the last frame keeps both handles reachable (the box's sits just inside the clip's); a click (on the box or, without moving, its edge) picks it and Delete / Backspace remove only that freeze; a linked clip's box is display-only (no handle, not pickable) | `e2e/freezeTrim.spec.ts` |
| Link groups — expand/link/unlink/prune, shared-delta move (offsets + durations kept, clamp on the earliest tile), shared-delta TRIM (per-member mapping incl. a 2× clip, clamped to the most constrained member), playhead split incl. the uncut-member and re-grouping rules, group delete | `lib/links.test.ts` |
| Per-tile edge trims report the delta they `achieved` (source limits, minimum window, speed conversion) — what the group clamp is built on | `lib/timeline.test.ts` |
| Linked tiles on the real timeline — a clip with audio is **added linked**, edge drags trim the whole group (from either side), Ctrl-click multi-select → 🔗 Link, group drag keeps the offset, clamp at 0, S/✂ splits every crossed member (and only those, **incl. a text tile**), ⛓ Unlink restores independent move AND trim, click narrows a multi-selection, Del removes the group in one undo step | `e2e/link.spec.ts` |
| Right-click an audio tile → **Add to volume level ▸** (None / each level / New level…) assigns the clip (the whole selection's audio when it's part of one) and badges the tile; a RIGHT-button press only selects — dragging with it never moves the tile; splits (playhead and link-group) keep the level on both halves | `e2e/volumeLevels.spec.ts`, `lib/timeline.test.ts`, `lib/links.test.ts` |
| T/Ctrl+Z/Ctrl+Shift+Z/Delete keybind flow | `e2e/keybinds.spec.ts` |
| Editing shortcuts (Delete, Ctrl+Z, T, S, N, M, New/Open) are ignored while a timeline drag is held; the drag records exactly one undo step | `e2e/keybinds.spec.ts` |
| An assistant edit that arrives mid-drag (or between press and first move) waits for the release, then lands as its own undo step | `e2e/assistant.spec.ts` |
| Snap-to-previous — the delta closes a gap (left) or an overlap (right), picks the NEAREST preceding tile in the SAME lane, ignores other lanes and the audio/fx split, snaps to 0 with nothing before it, moves a link group off its earliest member, and skips a tile whose end is unknown | `lib/links.test.ts` |
| ⇤ Snap / **N** on the real timeline — button + keybind agree, N is ignored while a field has focus, the button disables when already flush, one undo step, a linked pair keeps its offset | `e2e/snapToPrevious.spec.ts` |
| **M** toggles mute on the selection — a video layer's own audio and an audio clip together (a mixed selection mutes all first), the 🔇 badge follows, one undo step per press, ignored while a field has focus; tiles without sound are skipped | `e2e/keybinds.spec.ts`, `lib/links.test.ts` |
| Edge auto-scroll speed is CONSTANT across the 40px band (no proximity ramp) | `lib/pointerDrag.test.ts` |
| No horizontal shrink runaway — dragging the rightmost tile leftwards never shrinks the scrollable width mid-drag (the clamp used to feed back into the drag and accelerate it), including a mid-drag REVERSAL (right then left without releasing, which a non-ratcheting pin misses); the pin is released afterwards | `e2e/edgeScrollShrink.spec.ts` |
| Numeric Inspector fields keep a draft while typing — clearable, below-minimum intermediates survive, in-range commits live, blur/Enter clamp, Escape abandons | `e2e/numberInput.spec.ts` |
| OS-file import overlay can't get stuck (depth counter; the Timeline drop-ring shares the hook) | `e2e/dropOverlay.spec.ts` |
| Video LEFT-edge trim (end kept, source in-point follows); caption and audio tiles move and trim from both edges (audio's source window follows) | `e2e/timelineInteractions.spec.ts` |
| Playhead: pressing the track scrubs there and follows the drag (playback stops); Space toggles playback | `e2e/timelineInteractions.spec.ts` |
| Zoom: Ctrl+wheel zooms, anchored at the cursor (the second under it stays under it) | `e2e/timelineInteractions.spec.ts` |
| Drop from Library: a clip dropped on the track lands as a layer at the drop point | `e2e/timelineInteractions.spec.ts` |
| Gutter sync: the lane-header gutter follows a vertical scroll of the track | `e2e/timelineInteractions.spec.ts` |
| Lane resize from the header bubble AND the bottom-edge handle, clips scaling with it; collapse/expand from the chevron and by double-clicking the bubble (blocks and handle hidden while collapsed); the Captions bubble selects the lane-wide caption style | `e2e/timelineInteractions.spec.ts` |
| Persistence: lane heights and zoom survive a reload | `e2e/timelineInteractions.spec.ts` |
| New tiles come from the header's Insert menu (Text / Caption / Graphics, at the playhead; the toolbar has no ＋ Text / ＋ Caption); the Graphics lane shows only once a graphics tile exists | `e2e/insertMenu.spec.ts`, `e2e/addCaption.spec.ts` |
| Drawing on a graphics tile: an armed tool draws one mark at the playhead (drag = size, click = default, angle = three clicks) then disarms; marks drag whole and by point handles, one undo step each; Escape disarms only; a mark on an unselected tile is grabbable from the stage; arming a tool from outside the tile brings the playhead in; Delete with a mark selected removes only that mark | `e2e/graphics.spec.ts` |
| A workout overlay from the library: ＋ End lays the whole recording into 8 s in a Workout lane (shown once a workout tile exists) with its speed on the tile; ＋ Playhead (or a drop) over a clip filmed during the workout syncs to it — the clip's window, real time, linked; widgets drag on the preview (one undo step); the right edge trims the ride window at the tile's speed; S splits into consecutive ride windows | `e2e/workoutOverlay.spec.ts`, `lib/timeline.test.ts`, `lib/links.test.ts` |
| The workout graph window (Inspector ▸ Graph…): lines toggle, Time / Distance axis, the wheel zooms to exactly 1 s, Fit; a press sets the cursor; S splits, Del deletes, handles trim, Ctrl+Z undoes — inside the window only, keys never reaching the editor; Save is one undo step, Cancel changes nothing; a linked range is locked | `e2e/workoutGraph.spec.ts`, `lib/workoutGraph.test.ts` |
| A graphics tile's left-edge trim (lone tile and group) and S-split keep every mark at its absolute moment (re-based `atSec`; one whose moment falls before the new start keeps it as a negative `atSec` — on screen from the start, mid-reveal if cut inside one — so trimming back out restores it; a split's right half gets fresh mark ids). The tile's Motion keyframes still ride the start edge, like an image's | `e2e/graphics.spec.ts`, `lib/timeline.test.ts` |

If you change any of the above, the math change should show up as a test diff —
if it doesn't, the logic probably drifted back inline into the component (where
it can be deleted silently). Push it back into `lib/`.

## Manual — smoke-test in `npm run dev`

- **Horizontal edge auto-scroll:** drag a block near the left/right edge → the
  track scrolls and the block keeps following. The rate is deliberately FLAT
  (12 px/frame anywhere in the 40px band) — judge whether that speed feels
  right; the constant is `EDGE_SCROLL_SPEED` in `lib/pointerDrag.ts`.
- **Drop from Library, other kinds:** an IMAGE or AUDIO asset dropped on the
  track (the video case is guarded).
- **Vertical edge auto-scroll:** resize a lane past the top/bottom edge → the
  track scrolls with you and keeps growing the lane.
- **No shrink runaway:** while shrinking a lane, the scrollable height holds
  constant until release (no accelerating auto-scroll). The horizontal twin —
  dragging the rightmost tile LEFT, which shrinks the width — is now guarded
  the same way (`dragFloorW`) and covered by `e2e/edgeScrollShrink.spec.ts`.
  The floor RATCHETS, so a drag that reverses (right, then left, still held) is
  guarded too — a pin snapshotted at grab time silently misses that case.
- **Link groups (visuals + the paths e2e can't reach):** the 🔗 badge and
  `· linked` tooltip on a linked tile; the Inspector's "Linked to N other tiles"
  banner with its greyed-out re-timing controls (start/end, trim in/out, speed,
  freeze, extract audio); a linked audio clip's **Start (s)**
  field moving the whole group; Ctrl-clicking a **layout** tile selecting it alone
  (layouts can't be linked); selecting a linked layer on the **stage** or in the
  **Layers panel** highlighting its whole group in the timeline.
- **Dropping a real clip with audio:** it lands as a linked pair (both tiles show
  🔗 and highlight together), trimming either edge trims both, and A/V stays in
  sync on playback after a group trim/move — the thing only real media can tell
  you. A clip with no audio track still lands as a single unlinked tile.
- **Container:** the Timeline is a dockview panel (`lib/dockLayout.ts` manifest);
  its height/position live in the dock layout (`dockLayout` localStorage key,
  not the retired `panelSizes`). It must always sit in a sized flex container —
  it fills whatever box the dock gives it, including after drag-redocking.
  Closing the panel unmounts it; zoom/lanes state survives via localStorage.
