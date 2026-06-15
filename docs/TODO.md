# TODO / backlog

Deferred polish and features, newest-first. Not blocking; pick up as time allows.

## Open

- [ ] **Stack overlapping blocks vertically in the timeline lanes.**
  Text overlays (and captions) that overlap in time currently render on top of
  each other in their lane, obscuring each other. They should stack into rows so
  each is visible.
  - Where: `src/renderer/src/components/Timeline.tsx` — the text overlay lane
    (`top-[80px]`) and the caption lane (`top-[108px]`). Both position blocks at
    `top-0` within a fixed `h-6` lane.
  - How: greedy interval packing — sort by `startSec`, assign each block to the
    lowest row whose last block ends before this one starts; position at
    `top: row * rowHeight` and grow the lane height to fit the max row count.
    Apply the same helper to both lanes (and reflect the taller lanes in the
    `top-[…]` offsets / overall track height).

## Done

(empty)
