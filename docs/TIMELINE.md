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
| Block move drag + right-edge trim drag on the real timeline (incl. frozen-clip regression) | `e2e/freezeTrim.spec.ts` |
| S-keybind split at the playhead | `e2e/freezeTrim.spec.ts` |
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
- **Persistence:** lane heights/collapse (`timelineView`) and zoom
  (`timelinePps`) survive an app reload.
- **Container:** the Timeline is a dockview panel (`lib/dockLayout.ts` manifest);
  its height/position live in the dock layout (`dockLayout` localStorage key,
  not the retired `panelSizes`). It must always sit in a sized flex container —
  it fills whatever box the dock gives it, including after drag-redocking.
  Closing the panel unmounts it; zoom/lanes state survives via localStorage.
