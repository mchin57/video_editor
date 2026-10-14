# Quick cut: trim or split a library clip into new clips

Status: **built on branch `claude/quick-cut` (2026-10-14)**, marked `[~]` in TODO.md with what is
verified. This describes the built behavior.

## What it does

**Library ▸ right-click a video ▸ Quick cut…** opens the clip in a window with a mini timeline
of the clip's own time beneath it, plus Cancel and Save. Its only editing tools:

- **Trim** a clip's front or back by dragging its handles. The preview shows the frame at the
  edge being dragged.
- **Split** at the playhead: the ✂ button or **S**.
- **Delete** the selected clip: the button, **Del** or **Backspace**. Never the last one: a cut
  always has at least one clip.
- **Undo / redo** inside the window: Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y.
- **Play** with Space or by clicking the picture. Playback plays only what will be saved and
  jumps the cut-away gaps. Click or drag on the track to move the playhead; ←/→ step one frame.

Deleting a clip leaves a gap; nothing slides together. A trim can grow a clip back into a gap,
up to its neighbour.

**Save** writes one new clip per remaining piece, in order, into the project's `generated/`
(`IMG_1 (cut).mp4` for one, `IMG_1 (cut 1).mp4`, `(cut 2)`, … for several). They appear in the
library and the first is selected. The original clip, its file and the timeline are unchanged.
Save is disabled until something is cut. **Cancel** or Escape closes without making anything.
While the window is open, its keys never reach the editor's own shortcuts.

Quick cut is greyed out, with the reason, for audio, images, Missing clips, and a clip whose
preview is still being prepared.

## The assistant

`trim_clip(mediaId, startSec, endSec)` keeps one window. `split_clip(mediaId, times[])` cuts at
every given source second into back-to-back clips (N times → N+1 clips). Both make exactly what
Save makes, add the clips to the project's library, and return them in order with their source
window. Bad times are refused before anything is encoded.

## The files

- **Frame-exact re-encode, not a stream copy.** A copy can only cut on a keyframe, about a
  second apart on iPhone footage. Each piece holds the source frames in `[start, end)`, so
  pieces split at one point share no frame and lose none.
- **The source's character is kept.** H.264 stays H.264 (NVENC, else libx264). HEVC or 10-bit
  stays HEVC Main10 (NVENC, else libx265) with its HDR tags. A background-removed WebM stays VP9
  with alpha. The rotation flag is baked into the picture, and the creation date is copied.
- **Quality errs large:** CQ/CRF 18, so a cut can be bigger per second than the original.
- **Transcripts:** if the original was transcribed, each cut gets the words that fall inside
  it, re-timed. Captions work without running whisper again.
- **Re-saving the same cut** gives back the existing library item IF the encoder produces
  identical bytes (generated media is content-addressed). Not verified for NVENC; otherwise it
  is a second item.

Details and the measurements behind them: FFMPEG-NOTES "Quick cut".

## Code

| | |
|---|---|
| Rules (pieces, split, trim, delete, playback skipping, names, transcript slicing) | `shared/quickCut.ts` + test |
| Encode + adopt into the library | `main/services/quickCut.ts` (`cutToLibrary`, `buildCutArgs` + pinned test) |
| Window | `renderer/components/QuickCutDialog.tsx`, opened from `Library.tsx`'s context menu |
| IPC | `media:quickCut` (`QuickCutRequest`), `useQuickCut` in `hooks/useMedia.ts` |
| Assistant | `trim_clip` / `split_clip` in `mcp/tools.ts` + `main/assistant/tools.ts` |
| Specs | `e2e/quickCut.spec.ts`, `e2e/assistant.spec.ts` |

## Not in this version

- **Joining pieces back into one clip** (cut out the middle, keep both ends as one) is part of
  TODO.md ▸ "Merge clips".
- Cancel during an encode. Cuts take about a second each on NVENC; the window just shows Saving….
