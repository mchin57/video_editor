# Plan: insert between, and the ripple edits built on it (#215)

2026-11-14. Issue: mchin57/video_editor#215, with the related #117 (insert vs overwrite
drop), #115 (ripple delete), #116 (ripple trim) and #121 (close gaps). No code in this
plan (owner preference).

**Size: Large.** The timeline has no notion of "everything after this point", and the
answer has to hold for every tile kind, for link groups and for nested compositions.
The owner answered the decisions on 2026-11-14; see "Owner decisions" below.

**This round builds:** the bug fix below, phase 1, phase 2, phase 2b and the insert part
of phase 6. Ripple delete (#115), ripple trim (#116) and close gaps (#121) are follow-up
PRs on the same primitive and stay open.

## What exists today (read in the code)

- Tiles live in three arrays: `layers`, `captions.segments` and `audioClips`.
  `lib/links.ts` flattens them (`timelineTiles`) and owns every whole-set operation:
  `moveItemsBy`, `trimItemsBy`, `removeItems`, `splitItemsAt`, `snapToPreviousDelta`.
  All of them work on a `Composition`, so they already serve nested comps.
- Placing something never moves anything else. A library drop, the Library's add
  buttons and the shared library all go through `placeAsset` (`lib/placeAsset.ts`),
  which puts the new tile at the given time on top of whatever is there. The Insert menu
  (`lib/insert.ts`), templates (`applyTemplate`) and the assistant's `place_sequence`
  (`lib/sequence.ts`, modes append / replace) behave the same way.
- There is no "main track". Any lane can hold overlapping tiles, so a "gap" is not
  defined by the model.
- Other things pinned to a timeline time: script lines (`ScriptLine.atSec`, project root
  only) and caption word timings.

## One bug to fix before building

`moveItemsBy` shifts a caption's start and end but not its word timings, so a caption
that has been moved splits wrongly: both halves get the whole text
(mchin57/video_editor#218, confirmed by running the move and split operations in a
throwaway test). Fix it first, because every operation in this plan moves captions.

## Owner decisions (2026-11-14)

1. **What gets pushed right:** every tile on every lane that starts at or after the
   insert point, so picture, sound, captions and text stay together.
2. **Tiles that span the insert point** (a music bed, a long title) stay where they are,
   uncut. A link group moves as a whole if its earliest member starts at or after the
   point, and stays otherwise.
3. **Inserting a new item:** a drop on the seam between two tiles, or at the very start
   of the timeline, inserts, and an insert caret shows where. A drop anywhere else
   places on top as today.
4. **Inserting an existing tile:** in this round. Holding Shift while dragging a tile
   shows the insert caret at the nearest seam; releasing there inserts the tile and
   closes the hole it left. A plain drag works exactly as today.
5. **Script lines** pinned at or after the insert point move with the tiles.
6. **Scope:** insert only in this round (see the top of this plan).

Taken as defaults, not asked: the insert point snaps to the nearest tile edge in the
lane under the pointer, and the timeline start counts as an edge. The Ripple toolbar
toggle for delete and trim belongs to the follow-up PRs.

## Phases

**Phase 1: the pure primitives.**
- A new `lib/ripple.ts` beside `lib/links.ts`: which tiles count as "from this point on"
  (whole link groups, the straddle rule from decision 2), opening a gap of a given
  length at a time, and closing one. Built on `timelineTiles` and `moveItemsBy`.
- Unit tests for every tile kind, link groups on both sides of the point and across it,
  a point at 0, and open-ended audio tiles.

**Phase 2: insert between (#215, #117).**
- A store action that opens the gap and adds the new item as one undo step.
- `placeAsset` takes an insert option; the timeline drop detects a seam and shows the
  caret; the Library add buttons, the shared library's Insert, the Insert menu and
  templates offer it.
- The gap's length is the inserted item's length (for a clip with sound, its link
  group's span).

**Phase 2b: insert an existing tile (Shift-drag).**
- While Shift is held during a tile drag, the caret shows at the nearest seam. On
  release the dragged set (its whole link group) is lifted out, the hole it left is
  closed, and it is inserted at the seam, all as one undo step.
- Closing the hole uses the close-gap primitive from phase 1: every tile that started at
  or after the lifted set's start moves left by the set's span, never past 0, with the
  same spanning-tile rule as an insert.
- A plain drag, and a Shift-drag released away from any seam, behave exactly as today.

**Phase 3: ripple delete (#115).** Delete with ripple on removes the selection and pulls
everything after it left by the removed span, never past 0.

**Phase 4: ripple trim (#116).** An edge trim with ripple on moves later tiles by the
amount the trim actually achieved. `trimLayerEdge`, `trimAudioEdge` and
`trimCaptionEdge` already report that amount.

**Phase 5: close gaps (#121).** One action for a lane or the whole timeline. Because any
lane can overlap, this plan defines a gap as a stretch where the lane has no tile.

**Phase 6: assistant and docs.** `place_sequence` gains an insert mode. Add rows to the
`docs/TIMELINE.md` table and update `docs/SHARED.md` and the `/edit-video` skill.

## Files to change

Shared: `shared/assistant/protocol.ts`, `shared/assistant/toolArgs.ts`.

Main / MCP: `main/assistant/tools.ts`, `mcp/tools.ts`.

Renderer: new `lib/ripple.ts`, `lib/links.ts`, `lib/placeAsset.ts`, `lib/insert.ts`,
`lib/sequence.ts`, `lib/templates.ts`, `lib/workout.ts`,
`state/project/timelineActions.ts`, `state/project/rootActions.ts`, `state/ui.ts`,
`components/Timeline.tsx`, `components/timeline/useTileDrags.ts`,
`components/timeline/TimelineToolbar.tsx`, `components/Library.tsx`,
`assistant/handlers.ts`.

New: `lib/ripple.test.ts` and `e2e/insertBetween.spec.ts`, `e2e/ripple.spec.ts`.

## Tests

- Keep green: `lib/links.test.ts`, `lib/timeline.test.ts`, `e2e/link.spec.ts`,
  `e2e/timelineInteractions.spec.ts`, `e2e/snapToPrevious.spec.ts`,
  `e2e/templates.spec.ts`, `e2e/assistant.spec.ts`, `e2e/nestedComp.spec.ts`.
- New e2e, each ending in one Ctrl+Z that restores everything:
  - drop an image on the seam between two video clips: the second clip, its linked
    audio and its captions all move right by the image's length;
  - drop at the very start: the whole timeline moves right;
  - a music bed that spans the seam does not move;
  - ripple delete and ripple trim close and open the right amount;
  - the same insert inside a nested composition, with the parent block growing.

## Risks

- **Surprise on other lanes.** Pushing every lane is right for sync but moves things the
  user is not looking at. The insert caret should span all lanes to show it.
- **A group that straddles the point** stays put under decision 2, so a tile after the
  point can stay behind if it is linked to one before it. Cover it in the tests and say
  it in the doc.
- **No main track.** "Close gaps" and "ripple delete" need the gap definition above;
  other definitions give different results on overlapping lanes.
- **Drag plumbing.** The timeline's edge auto-scroll and width pinning
  (`e2e/edgeScrollShrink.spec.ts`) must keep working while tiles shift under a drop.

## Related plans

Transitions (#64) uses the gap primitive to pull later tiles left when it creates an
overlap.
