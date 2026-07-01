# Timeline behaviors — regression checklist

`Timeline.tsx` is the densest interaction surface in the app and **is not
covered end-to-end by tests** (pointer drag, edge auto-scroll, and scroll math
need a real DOM with layout + rAF, which jsdom fakes badly). A lane
resize/collapse feature was once lost this way — silently dropped by an unrelated
timeline refactor because nothing failed.

**Rule:** before you refactor `Timeline.tsx`, skim this list; after, verify each
item still works. Anything with a test file is guarded automatically — keep it
green. Everything under _Manual_ you must smoke-test in `npm run dev`.

## Guarded by tests (keep green)

| Behavior | Test |
| --- | --- |
| Overlapping blocks stack onto rows (`packRows`) | `lib/lanes.test.ts` |
| Lane vertical layout — height = `rows * rowH`, collapsed → thin strip, gaps, `totalH` (`layoutLanes`) | `lib/lanes.test.ts` |
| Lane-resize height math — delta spread across rows, clamped (`resizeRowH`) | `lib/lanes.test.ts` |
| Boundary snapping (`snap`) | `lib/lanes.test.ts` |
| Time-scale tick spacing/labels | `lib/timescale.test.ts` |

If you change any of the above, the math change should show up as a test diff —
if it doesn't, the logic probably drifted back inline into the component (where
it can be deleted silently). Push it back into `lib/`.

## Manual — smoke-test in `npm run dev`

- **Block edits:** drag a clip/caption/audio block to move; trim its left/right
  edge (video trims in/out against source length; caption/audio too).
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
- **Persistence:** lane heights/collapse (`timelineView`) and zoom
  (`timelinePps`) survive an app reload.
