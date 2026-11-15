# Plan: volume keyframes on audio tiles (#138)

2026-11-14. Issue: mchin57/video_editor#138. No code in this plan (owner preference).

**Size: Medium.** The design decisions have clear recommendations, and the risk is
contained to audio gain. The owner answered the decisions on 2026-11-14 (see "Owner
decisions" below); it is built next, then an auditor sub-agent checks it.

This work also fixes mchin57/video_editor#217 (audio fades not heard in the preview).

The feature: a "rubber band" volume line drawn over an audio tile. Click the line to add
a point, drag points up and down, and the clip's volume follows the line.

## What exists today (read in the code)

- One gain per clip. `clipGain` (`shared/volumeLevels.ts`) decides it for both sides:
  the preview applies it through `useClipGain` and `useMediaGain` (`lib/mediaGain.ts`,
  which switches to a WebAudio gain node above 0 dB), the export through a `volume`
  filter in `buildAudioGraph` (`main/services/audio.ts`).
- Fades (`fadeInSec` / `fadeOutSec`) are exported with `afade`. The preview's
  `AudioFollower` (`components/preview/audio.tsx`) does not read them, so fades are
  heard only in the export today.
- `piecewiseLinearExpr` (`main/services/ffmpegFilters.ts`) already turns a list of
  points into an ffmpeg expression for layer motion.
- Audio tiles draw a waveform picture and have no on-tile controls.

## Evidence gathered while planning

- Measured on the bundled ffmpeg (8.1.1): a `volume` filter given an expression in time,
  evaluated per audio frame and placed after the clip's delay, follows timeline time. A
  step to one quarter volume at the 3 s mark measured 12.04 dB quieter after it.
- Not checked yet: whether per-frame steps (about 21 ms at 48 kHz) are audible on a fast
  ramp, and how long an expression can get with many points.

## Owner decisions (2026-11-14)

1. **A point is anchored to the audio itself:** stored in source time, like freeze
   holds, so a dip under a spoken phrase stays on that phrase when the clip is trimmed,
   split or moved.
2. **A point's value is a dB offset on top of the clip's normal volume,** from silence
   to +12 dB, with the line at 0 meaning no change. A clip in a volume level keeps its
   level; the line rides on top of it.
3. **Fades and the line share one gain envelope** that the preview and the export both
   read. Fades become audible in the preview, which closes #217.
4. **The line shows on selected audio tiles only,** when the lane is tall enough, so an
   unselected tile can still be grabbed and moved anywhere.
5. **Audio clips only** in this round. A video layer's own sound keeps a single volume.

Taken as defaults, not asked:

- Straight lines in dB between points.
- Editing: click the line to add a point; drag a point (up / down for level, sideways
  for time, never past its neighbours); double-click or Delete removes it; the Inspector
  lists the points with number fields and a Clear button.
- Fade handles on the tile (#137) are not part of this round.

## Phases

**Phase 0: real-ffmpeg checks.**
- A ramp in dB written as an expression: measure the level at several times against the
  shared function.
- Listen for stepping on a fast ramp; if audible, test smaller audio frames.
- The envelope together with `afade`, with ducking (the sidechain compressor) and with a
  volume level.
- An expression with 50 points still parses.
- Add the results to `docs/FFMPEG-NOTES.md`.

**Phase 1: model and shared math.**
- Optional `volumeKeyframes` on `AudioClip` (source time, dB). Bump the schema; absent
  means a flat line, so nothing is rewritten.
- New `shared/audioEnvelope.ts`: the keyframe value at a source time, the fade factor at
  a timeline time, and the combined gain. Helpers to add, move and remove a point.
- Rules: a split pins a point at the cut on both halves so the level is continuous; a
  trim keeps points outside the window, so trimming back out restores them.

**Phase 2: preview.**
- `AudioFollower` multiplies the clip's gain by the envelope on every clock tick, fades
  included. A product above 0 dB goes through the existing gain-node route.
- An e2e test reads the applied gain at several playhead times.

**Phase 3: export.**
- `buildAudioGraph` adds one expression `volume` after the static one, only when the
  clip has keyframes. With none, the arguments are byte-identical to today's.
- An e2e test exports and measures loudness in windows before, during and after a dip.

**Phase 4: the line on the tile.**
- A new tile overlay draws the line and its points; drags go through
  `lib/pointerDrag.ts`; each drag is one undo step.
- The Inspector's audio section gets the point list.

**Phase 5: assistant and docs.** `get_timeline` reports that a clip has a volume line.
Update `docs/SHARED.md`, the `docs/TIMELINE.md` table and FFMPEG-NOTES.

## Files to change

Shared: `shared/project.ts`, new `shared/audioEnvelope.ts`,
`shared/assistant/timelineSummary.ts`.

Main: `main/services/audio.ts`, `main/services/exporterArgs.ts`,
`main/services/ffmpegFilters.ts`.

Renderer: `components/preview/audio.tsx`, `lib/mediaGain.ts`, `hooks/useClipGain.ts`,
`lib/timeline.ts`, `lib/links.ts`, `components/Timeline.tsx`,
`components/timeline/parts.tsx`, a new volume-line component in `components/timeline/`,
`components/inspector/AudioClipEditor.tsx`, `state/project/audioActions.ts`.

New tests beside each module, plus `e2e/volumeKeyframes.spec.ts`.

## Tests

- Keep green: the audio graph and `exporterArgs` tests, `e2e/previewGain.spec.ts`,
  `e2e/volumeLevels.spec.ts`, `e2e/loudness.spec.ts`, `e2e/audioMute.spec.ts`,
  `e2e/timelineInteractions.spec.ts`, `lib/timeline.test.ts`.
- New unit tests: envelope values between and outside points; split and trim rules; the
  export expression.
- New e2e: add and drag a point on the tile (one undo step each); the tile body still
  drags the clip; the preview gain follows the line; the exported file is quieter inside
  the dip by the set amount.

## Risks

- **Clipping.** A positive point can push a levelled clip past the level's peak ceiling.
  The Inspector should warn when the line goes above 0 dB on such a clip.
- **Effect tracks.** An echo or chorus track follows its source clip's level but would
  not follow its volume line. Say so in the doc, or copy the line when the effect is
  made.
- **Grab conflicts.** The line sits on top of the tile's move and trim targets. Decision
  6 limits where it is active; the e2e tests cover both.
- **Preview steps.** The preview updates gain once per clock tick, the export once per
  audio frame. Both are short, but a very fast ramp may sound slightly different.

## Related plans

- Transitions (#64) needs audible fades in the preview: phases 1 and 2 here provide the
  shared envelope for it. Build this plan first.
- Audio re-timing (#58): source-anchored points map through the same time helpers once
  that lands.
