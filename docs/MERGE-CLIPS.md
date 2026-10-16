# Merge clips: join library clips into one new clip

Status: **library side built on branch `feat/merge-clips` (2026-10-16)**, GitHub issue #61. Merging
clips that are already ON THE TIMELINE is not built yet (see "Not in this version").

## What it does

Three ways in, one result: ONE new clip in the project's `generated/`, added to the library and
selected. The source clips, their files and the timeline are unchanged.

- **Library ▸ right-click a video ▸ Merge clips…** lists the library's videos. The clip you
  right-clicked is number 1; click others in the order they should play (click again to drop
  one), and use ↑ / ↓ in the order list to rearrange. **Merge N clips** needs at least two. Each
  clip is used whole: Quick cut first to merge only part of one. Escape or Cancel closes without
  making anything, and keys pressed while it is open never reach the editor's shortcuts.
  The menu item is greyed out, with the reason, for audio, images, Missing clips, and when the
  library has no other video.
- **Quick cut ▸ Save as one clip** (shown once a cut has two or more pieces) joins the pieces,
  without the gaps, into one clip: cut out the middle and keep both ends as one.
- **The assistant's `merge_clips(items)`** takes `{mediaId, inSec?, outSec?}` items in play order
  (the same clip may appear more than once; a missing in/out means the clip's start/end).

Names: pieces of ONE clip joined back are `IMG_1 (cut).mp4`, like a single Quick cut piece.
Clips from several sources take the first one's name: `IMG_1 (merged).mp4`.

## The file

- **Frame-exact windows.** Each segment is read with an input seek and re-encoded, as in Quick
  cut, so windows start and end on the frames asked for.
- **One frame for all.** The merge takes the FIRST clip's on-screen size (rotation baked in).
  A clip of another shape is fitted inside it with black bars (clear bars in a transparent merge).
- **One frame rate:** the fastest source's, rounded, between 24 and 60 fps. Slower clips repeat
  frames.
- **Audio:** a clip without audio contributes silence of its length; a merge where no clip has
  audio has no audio track. A one-sided mic recording is folded to both channels, as everywhere
  else.
- **Character:**
  - any background-removed (transparent) clip → VP9 WebM with alpha; opaque clips stay opaque;
  - every clip HDR with the same transfer → kept HDR (10-bit HEVC with the first clip's tags);
  - otherwise SDR, kept like Quick cut keeps the first clip's codec. HDR clips mixed with SDR
    ones are tone-mapped to SDR (the export's tone-map), and the merge is 8-bit bt709 H.264.
- **Quality** is Quick cut's: CQ/CRF 18.
- **Transcripts** carry over (each window's words, re-timed) when every clip with audio has one;
  otherwise the merge has none and captions transcribe it fresh. The word slicing is
  unit-tested (`mergeWords`); the carry-over itself has not been seen end to end yet.

Measurements: FFMPEG-NOTES "Merge clips".

## Code

| | |
|---|---|
| Rules (checks, plan, name, transcript) | `shared/merge.ts` + test |
| Encode + adopt into the library | `main/services/merge.ts` (`mergeToLibrary`, `buildMergeArgs` + pinned test); encoder args shared with Quick cut (`videoArgs`) |
| Window | `renderer/components/MergeClipsDialog.tsx`, opened from `Library.tsx`'s context menu; Quick cut's Save as one clip |
| IPC | `media:merge` (`MergeSegment[]`), `useMergeClips` in `hooks/useMedia.ts` |
| Assistant | `merge_clips` in `mcp/tools.ts` + `main/assistant/tools.ts` |
| Specs | `e2e/mergeClips.spec.ts`, `e2e/assistant.spec.ts` |

## Not in this version

- **Merging timeline clips** (select clips on the timeline, merge them into one asset that
  replaces them in place, with freeze holds and speed changes baked in). Still open on issue #61.
- Cancel during an encode; the dialog shows Merging….
