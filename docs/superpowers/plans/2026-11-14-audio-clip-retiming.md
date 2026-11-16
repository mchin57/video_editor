# Plan: audio clips get speed, speed ramps and freeze holds (#58)

2026-11-14. Issue: mchin57/video_editor#58. No code in this plan (owner preference).

**Size: Large.** Several design decisions, a schema bump, and a change to how every
audio clip maps timeline time to source time. The owner answered the decisions on
2026-11-16; see "Owner decisions" below. This round builds phases 0 to 4.

## The problem in one paragraph

A clip dropped with sound lands as a muted video layer plus a linked audio clip. An
audio clip can only play at 1x, so the Inspector locks speed and freeze on a linked
tile. To slow a normal clip down today you unlink it, and its sound then stays at 1x.
A clip with a speed ramp loses its own sound in both the preview and the export.

## What exists today (read in the code)

- `AudioClip` (`shared/project.ts`) has a start, a source in/out, gain, fades, duck and
  denoise. It has no speed, ramp or freeze fields. `audioTimelineAt`
  (`lib/timeline.ts`) is a straight offset.
- Video layers have all three: `VideoContent.speed`, `speedRamp`, `freezes`. The
  mapping lives in `shared/speed.ts` and `shared/layers.ts` (`videoSourceTime`,
  `playedVideoDuration`, `sourceAfterPlayed`).
- `VideoTiming.tsx` disables speed and freeze on a linked tile ("re-timing one member
  would desync the group").
- A video layer's own (unmuted) audio is already tempo-matched: the preview uses the
  element's `playbackRate`, the export uses `atempoChain` (`main/services/audio.ts`)
  through `ExportAudio.tempo`. Audio clips never set `tempo`.
- A ramped clip is muted in the preview (`preview/layers.tsx`) and its audio is left
  out of the export (`exportLayers.ts`), so both sides agree by dropping it.
- `extractAudioPieces` (`lib/timeline.ts`) handles a frozen clip by cutting the audio
  into several clips with silent gaps where the holds are.

## Evidence gathered while planning

- The bundled ffmpeg (8.1.1 full build) has `atempo` and `rubberband`.
- `atempo` accepts a tempo change while it runs: a 6 s tone with tempo switched to 2x at
  the 2 s mark came out 3.99 s long (expected 4.00). So a ramp can be exported as a
  series of small tempo steps in one filter chain.
- Not checked yet: how a stepped ramp sounds, and how far its length drifts from the
  video's played length on a long ramp.

## Owner decisions (2026-11-16)

1. **Re-timing a linked group:** changing speed or a freeze on one member applies it to
   every member that plays the same source (the clip and its extracted audio), and the
   Inspector lock goes away. Members on other media (a music bed linked in) keep their
   position and are not re-timed.
2. **Linked captions** are re-timed with the clip, word timings included, in a LATER
   PR. Until then a link group that contains a caption keeps the lock.
3. **A freeze sounds like silence** for the length of the hold, as `extractAudioPieces`
   does today.
4. **Scope of this round:** phases 0 to 4 (shared mapping, constant speed on audio
   clips, re-timing a linked group, freeze holds on audio). Speed ramps on audio
   (phase 5) are a follow-up PR; a ramped clip's audio stays dropped on both sides, and
   the Inspector lock stays for ramps on a linked tile.

Taken as defaults, not asked:

- The timing lives on `AudioClip` itself (the same fields as video, in source time),
  with the shared helpers generalised so video and audio use one mapping.
- Pitch is always kept, as video does today.
- Existing projects are not rewritten. Clips already cut into pieces around freezes stay
  as they are; only new extractions produce one clip with holds.

Since this plan was written, volume keyframes landed (`AudioClip.volumeKeyframes`,
`shared/audioEnvelope.ts`). Its points are in source time and its `clipLinePoints` /
`fadeGainAt` map source to timeline as a straight offset; they must go through the same
generalised helpers, in the preview and in the export's volume expression.

## Technical choice to settle by measurement (not an owner decision)

How a ramp's audio is exported: stepped `atempo` commands, `rubberband`, or cutting the
ramp into short constant-tempo slices. Pick the one whose output length stays within one
frame of the video's played length and that sounds clean at the step boundaries.

## Phases

**Phase 0: real-ffmpeg checks.** Measure the three ramp approaches above. Confirm how to
insert a silent hold inside one audio input. Add the results to `docs/FFMPEG-NOTES.md`.

**Phase 1: one shared mapping, no behaviour change.**
- Generalise the helpers in `shared/speed.ts` and `shared/layers.ts` to a shape both
  `VideoContent` and `AudioClip` satisfy. Move `audioTimelineAt` into `shared/`.
- Add the three optional fields to `AudioClip`. Bump the schema; absent means 1x with no
  holds, so `migrateProject` rewrites nothing.
- Switch every place that computes an audio clip's span or source position to the
  helpers (list below).
- Done when every existing test passes unchanged and a new test shows the helpers equal
  the old arithmetic for a clip at 1x with no holds.

**Phase 2: constant speed on audio clips.**
- Inspector: the speed control from `VideoTiming.tsx` becomes a shared control used by
  `AudioClipEditor.tsx`. The tile gets the same xN badge as video.
- Trim and split go through the helpers (`trimAudioEdge`, `splitAudioClip`).
- Preview: `AudioFollower` sets `playbackRate` and scales its drift correction.
- Export: `exportAudioClips` sets `ExportAudio.tempo`. At 1x the ffmpeg arguments must
  be byte-identical to today's (the pinned `exporterArgs` tests prove it).
- Captions and silence detection made from a re-timed clip map through the helper.

**Phase 3: re-time a linked group.**
- A new group operation in `lib/links.ts` applies a speed to the same-source members,
  keeps the group's start and recomputes each end.
- Remove the Inspector lock for speed. "Extract audio" works at any speed.

**Phase 4: freeze holds on audio.**
- `AudioClip.freezes` plays as silence. Adding a freeze to a clip adds it to its linked
  same-source audio. Remove the Inspector lock for freeze.
- New extractions produce one audio clip with holds.

**Phase 5: speed ramps.**
- `AudioClip.speedRamp` in the preview (per-tick `playbackRate`) and the export (the
  approach chosen in phase 0).
- In the same change, stop muting a ramped video's own audio on both sides.

**Phase 6: assistant and docs.** `get_timeline` reports an audio clip's speed. Update
`docs/SHARED.md`, the `docs/TIMELINE.md` table and the `/edit-video` skill.

## Files to change

Shared: `shared/project.ts`, `shared/speed.ts`, `shared/layers.ts`,
`shared/compositions.ts`, `shared/volumeLevels.ts`, `shared/assistant/timelineSummary.ts`.

Main: `main/services/exporterArgs.ts`, `main/services/audio.ts`,
`main/services/exportLayers.ts`.

Renderer: `lib/timeline.ts`, `lib/links.ts`, `lib/captions.ts`, `lib/silence.ts`,
`lib/templates.ts`, `components/preview/audio.tsx`, `components/preview/layers.tsx`,
`components/PreviewStage.tsx`, `components/Timeline.tsx`,
`components/timeline/geometry.tsx`, `components/timeline/useTileDrags.ts`,
`components/inspector/AudioClipEditor.tsx`, `components/inspector/VideoTiming.tsx`,
`components/ChecklistModal.tsx`, `components/CaptionAudioButton.tsx`,
`state/project/audioActions.ts`.

New: a shared speed control in `components/inspector/`, and tests beside each module.

This list comes from a search for the code that computes an audio clip's span; each
file needs a look, and some may need no change.

## Tests

- Keep green: `lib/timeline.test.ts`, `lib/links.test.ts`, `shared/layers.test.ts`, the
  `exporterArgs` tests, `e2e/link.spec.ts`, `e2e/freezeTrim.spec.ts`,
  `e2e/speedRamp.spec.ts`, `e2e/volumeLevels.spec.ts`, `e2e/silenceLinked.spec.ts`.
- New unit tests: the generalised mapping; trim and split of a 2x audio clip; group
  re-timing; the audio graph strings for tempo, holds and ramps.
- New e2e: change speed on a linked pair and both tiles resize together; export a 0.5x
  linked clip and measure that the audio lasts as long as the picture; a frozen linked
  clip exports silence during the hold.

## Risks

- **Sync drift.** Tempo filters do not promise an exact output length. Phase 0 sets the
  tolerance; an e2e export measures it.
- **Effect tracks.** An echo or chorus track is a separate rendered file tied to a
  source window. It has to follow its source clip's timing or be re-rendered.
- **Volume levels.** Loudness is measured over the source window, so it should not
  change with speed; confirm with the existing level tests.
- **Preview catch-up.** `AudioFollower` re-seeks when it drifts more than 0.3 s; that
  threshold has to scale with the playback rate.
- **Old multi-piece freezes.** Two representations of a frozen clip's audio will exist
  side by side (decision 6).

## Related plans

Volume keyframes (#138) should anchor its points in source time so they map through the
same helpers once this lands.
