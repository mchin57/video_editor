# Plan: transitions between clips (#64)

2026-11-14. Issue: mchin57/video_editor#64. No code in this plan (owner preference).

**Size: Large.** A new concept in the project model, new timeline interactions, and
matching work in the preview and the export. The owner answered the decisions on
2026-11-17; see "Owner decisions" below.

Scope of the first version: cross dissolve, dip to black, dip to white, and a plain fade
in or out at a clip's end (which also covers "Video fade handles", #131).

## What exists today (read in the code)

- Layers sit at absolute times and may overlap; the export composites them with one
  overlay chain in stack order (`buildExportArgs`, `main/services/exporterArgs.ts`).
- Video and image layers already support keyframed opacity. The preview reads it from
  `layerTransformAt` (`shared/layers.ts`); the export drives it per frame
  (`pass.opacityAnim` in `exportRender.ts`, FFMPEG-NOTES "Keyframed opacity").
- Audio clips have `fadeInSec` / `fadeOutSec`, exported with `afade`. Since the volume
  keyframes work (PR 219), the preview plays them too, through the shared gain envelope
  in `shared/audioEnvelope.ts` (`fadeGainAt`, `envelopeGainAt`).
- Insert between (PR 220) added the ripple primitives in `lib/ripple.ts` (`closeGap`,
  `openGap`, `tilesFrom`): use them to pull later tiles left when an overlap is made.
- Audio re-timing (PR 222, merged) puts every audio source↔timeline conversion
  through `shared/audioTiming.ts`; fades are in played time. Use its helpers for the
  audio crossfade.
- There is no transition concept anywhere in the model.

## The approach

The issue suggests ffmpeg's `xfade`. `xfade` joins two whole streams of equal size into
one, which does not fit a compositor where each layer has its own box, transform and
position in the stack.

A cross dissolve is the same picture as the upper clip fading in over the lower one
while both play. So a transition can be an opacity ramp on one clip over a short
overlap, using the opacity path the export already has. A dip to a colour is the
outgoing clip fading out over a colour plate, then the incoming clip fading in.

This is a recommendation, not a verified result: the opacity path is verified, but a
dissolve built from it has not been rendered and measured yet (phase 0).

## Owner decisions (2026-11-17)

1. **The overlap comes from sliding the next clip in.** Applying a dissolve slides the
   incoming clip, its link group and everything after it left by the transition length
   (the ripple primitives), so the two tiles overlap and the reel gets that much
   shorter.
2. **Sound crossfades automatically:** the two clips' linked audio fades out / in over
   the same window, set when the transition is applied and editable afterwards with the
   fade fields.
3. **Video and image tiles** in this round. Text keeps its own entrance and exit
   animations; layouts, compound clips and graphics come later if wanted.
4. **Applying:** select two neighbouring clips and choose Add transition from the
   right-click menu or the Inspector. A wedge on the tile's edge shows it and drags to
   change its length. A fade at a clip's end is set in the Inspector or by dragging the
   tile's top corner.

Taken as defaults, not asked:

- A transition is stored on the tile itself, as "transition in" and "transition out"
  (kind and length), so it moves, copies and splits with the tile and can never point
  at a deleted neighbour.
- Length: 0.5 s by default, 0.1 to 2 s, never more than half of the shorter clip.
- Removing a transition does NOT slide the clip back out; it leaves the overlap as a
  plain overlap (one undo step undoes the whole apply).

## Owner decisions after the review (2026-11-17)

5. **A dip's colour card sits only behind the clips**, sized to the two clips' boxes and
   following their position, scale, rotation and keyframes, so a picture-in-picture dip
   doesn't blank the main video underneath. (Not a full-frame card.)
6. **A clip trimmed shorter than its transition keeps the transition's length, and the
   Inspector warns** that the clip never reaches full opacity. Nothing is clamped.
7. **Resizing a dissolve moves only tiles after the cut:** the incoming clip, its link
   group, and tiles that start at or after the incoming clip's ORIGINAL start. A tile
   that starts inside the overlap (an unlinked caption over the outgoing clip's last
   words) stays with the outgoing clip.
8. **Fades stay linear.** The automatic crossfade dips about 3 dB in the middle; an
   equal-power curve is a separate change for later.

## Phases

**Phase 0: real-ffmpeg checks.**
- Render a dissolve with the opacity path and compare the middle frame with a 50/50
  blend of the two sources.
- Two opacity ramps on one clip (its own opacity keyframes and a transition) multiply
  correctly.
- A white plate under a fading pair gives a clean dip to white.
- Two linear `afade`s summed in the mix: measure the level through the crossfade (the
  fade shape is linear today on both sides, `fadeGainAt`). If the dip in the middle is
  audible, report the numbers; changing the shared fade curve is a decision for the
  owner, not this round.
- Add the results to `docs/FFMPEG-NOTES.md`.

**Phase 1: model and shared math.**
- New `shared/transitions.ts`: the transition types and one function giving a layer's
  opacity at a time (its keyframed opacity times its transition ramps). The preview and
  the export both call it.
- Optional fields on `Layer`. Bump the schema; absent means no transition, so nothing is
  rewritten.
- Split rule, matching text entrances today: the left half keeps the transition in, the
  right half keeps the transition out.

**Phase 2: preview.**
- `preview/layers.tsx` uses the shared opacity function.
- The dip colour is a full-frame plate under the pair for the transition window.
- Audio fades are already audible in the preview (shared gain envelope, PR 219); the
  crossfade only sets the two clips' fade fields.

**Phase 3: export.**
- The transition ramp feeds the existing opacity animation; the dip plate becomes an
  extra visual under the pair.
- With no transitions the ffmpeg arguments must be byte-identical to today's.

**Phase 4: timeline and Inspector.**
- The wedge on the tile edge, its drag, the right-click action, the Inspector section,
  and the action that creates the overlap in one undo step.
- Tiles after the pair follow when the overlap is created, through `lib/ripple.ts`
  (insert between has landed).

**Phase 5: assistant and docs.** `get_timeline` reports transitions, and one tool call
can set one. Update `docs/SHARED.md` and the `docs/TIMELINE.md` table.

## Files to change

Shared: `shared/project.ts`, `shared/layers.ts`, new `shared/transitions.ts`,
`shared/assistant/timelineSummary.ts`.

Main: `main/services/exportRender.ts`, `main/services/exportLayers.ts`,
`main/services/exporterArgs.ts`, `main/services/ffmpegFilters.ts`.

Renderer: `components/preview/layers.tsx`, `components/preview/audio.tsx`,
`components/Timeline.tsx`, `components/timeline/parts.tsx`,
`components/timeline/useTileDrags.ts`, `components/inspector/LayerEditor.tsx`,
`lib/timeline.ts`, `lib/links.ts`, `state/project/layerActions.ts`,
`state/project/timelineActions.ts`.

New: an Inspector transition section, tests beside each module, and
`e2e/transitions.spec.ts` plus `e2e/transitionExport.spec.ts`.

## Tests

- Keep green: the `exporterArgs` tests, `e2e/opacityKeyframes.spec.ts`,
  `e2e/motionExport.spec.ts`, `e2e/link.spec.ts`, `lib/timeline.test.ts`.
- New unit tests: opacity over time for each transition kind; split and trim rules; the
  export strings.
- New e2e: add a dissolve to two clips and the incoming tile overlaps by its length;
  drag the wedge and the length changes in one undo step; export and check that a frame
  in the middle of the dissolve shows both clips and that the audio does not dip.

## Risks

- **Export speed.** A clip with an opacity ramp runs through an alpha pipeline for its
  whole length, not only for the transition window. Measure the cost on a real reel.
- **Clips that do not fill the frame, or have a removed background.** There the ramp is a
  fade over whatever is underneath, which is correct but is not a true blend of two
  pictures. Say so in the doc.
- **Stack order.** The incoming clip must be above the outgoing one for a dissolve. The
  apply action has to reorder when it is not.
- **Overlapping tiles in one lane** stack onto two rows in the timeline. Check that the
  wedge still reads clearly there.

## Related plans

Volume keyframes (#138) and insert between (#215) have both landed and provide the gain
envelope and the ripple primitives this plan uses. Color correction (#105) is being
built at the same time and also touches `preview/layers.tsx`, `exportLayers.ts` and
`exporterArgs.ts`: keep edits there small and localised.
