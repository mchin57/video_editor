# Timeline behaviors — regression checklist

`Timeline.tsx` is the densest interaction surface in the app and **is not
covered end-to-end by tests** (pointer drag, edge auto-scroll, and scroll math
need a real DOM with layout + rAF, which jsdom fakes badly). A lane
resize/collapse feature was once lost this way — silently dropped by an unrelated
timeline refactor because nothing failed.

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
| Link groups — expand/link/unlink/prune, shared-delta move (offsets + durations kept, clamp on the earliest tile), shared-delta TRIM (per-member mapping incl. a 2× clip, clamped to the most constrained member), playhead split incl. the uncut-member and re-grouping rules, group delete | `lib/links.test.ts` |
| Per-tile edge trims report the delta they `achieved` (source limits, minimum window, speed conversion) — what the group clamp is built on | `lib/timeline.test.ts` |
| Linked tiles on the real timeline — a clip with audio is **added linked**, edge drags trim the whole group (from either side), Ctrl-click multi-select → 🔗 Link, group drag keeps the offset, clamp at 0, S/✂ splits every crossed member (and only those, **incl. a text tile**), ⛓ Unlink restores independent move AND trim, click narrows a multi-selection, Del removes the group in one undo step | `e2e/link.spec.ts` |
| T/Ctrl+Z/Ctrl+Shift+Z/Delete keybind flow | `e2e/keybinds.spec.ts` |
| OS-file import overlay can't get stuck (depth counter; the Timeline drop-ring shares the hook) | `e2e/dropOverlay.spec.ts` |

If you change any of the above, the math change should show up as a test diff —
if it doesn't, the logic probably drifted back inline into the component (where
it can be deleted silently). Push it back into `lib/`.

## Manual — smoke-test in `npm run dev`

- **Block edits:** video move + right-edge trim are e2e-guarded; still manual:
  video LEFT-edge trim, and caption/audio block move + both trims.
- **Horizontal edge auto-scroll:** drag a block near the left/right edge → the
  track scrolls and the block keeps following.
- **Playhead:** click/drag on the track scrubs; space toggles play.
- **Zoom:** Ctrl/Cmd + wheel zooms anchored at the cursor.
- **Drop from Library:** drag a library asset onto the track → video/image layer
  or audio clip lands at the drop point.
- **Gutter sync:** the left lane-header gutter stays aligned as the track scrolls
  vertically.
- **Lane resize:** drag a lane's header bubble vertically **and** its bottom-edge
  handle — clips scale with the lane.
- **Vertical edge auto-scroll:** resize a lane past the top/bottom edge → the
  track scrolls with you and keeps growing the lane.
- **No shrink runaway:** while shrinking a lane, the scrollable height holds
  constant until release (no accelerating auto-scroll).
- **Collapse/expand:** the ▾/▸ chevron and double-clicking the bubble both
  toggle; collapsed lanes become a thin strip with blocks + resize handle hidden.
- **Caption gutter bubble:** clicking it selects the lane-wide caption style.
- **Link groups (visuals + the paths e2e can't reach):** the 🔗 badge and
  `· linked` tooltip on a linked tile; the Inspector's "Linked to N other tiles"
  banner with its greyed-out re-timing controls (start/end, trim in/out, speed,
  freeze, extract audio, split on silence); a linked audio clip's **Start (s)**
  field moving the whole group; Ctrl-clicking a **layout** tile selecting it alone
  (layouts can't be linked); selecting a linked layer on the **stage** or in the
  **Layers panel** highlighting its whole group in the timeline.
- **Dropping a real clip with audio:** it lands as a linked pair (both tiles show
  🔗 and highlight together), trimming either edge trims both, and A/V stays in
  sync on playback after a group trim/move — the thing only real media can tell
  you. A clip with no audio track still lands as a single unlinked tile.
- **Persistence:** lane heights/collapse (`timelineView`) and zoom
  (`timelinePps`) survive an app reload.
- **Container:** the Timeline is a dockview panel (`lib/dockLayout.ts` manifest);
  its height/position live in the dock layout (`dockLayout` localStorage key,
  not the retired `panelSizes`). It must always sit in a sized flex container —
  it fills whatever box the dock gives it, including after drag-redocking.
  Closing the panel unmounts it; zoom/lanes state survives via localStorage.
