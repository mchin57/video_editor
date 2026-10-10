---
name: edit-video
description: Edit a video in the running Reel Editor through its MCP tools (reel-editor) — rough cuts from raw footage in an order you choose or the user dictates, checking the timeline, exporting on request, and filing feature requests for abilities the editor lacks. Use when the user runs /edit-video or asks to cut, assemble, trim or export a reel in the editor.
---

# Edit a video in Reel Editor

You are driving the Reel Editor desktop app on this computer. Every change you
make appears live in the user's timeline and is undoable with Ctrl+Z.

## 0. Check the connection first

Look for tools named `mcp__reel-editor__*` (e.g. `mcp__reel-editor__list_media`).

- If they are missing: tell the user to open **Settings → AI assistant** in the
  editor, copy the `claude mcp add …` line, run it in a terminal, then start a new
  Claude Code session. Stop.
- If a call answers "Reel Editor isn't running…": ask the user to open the editor
  (and check the AI assistant switch in Settings), then retry.

## 1. Understand the footage

1. `list_media`. If the library is empty or lacks what the user mentioned, ask for
   the file or folder paths and use `import_media` with exactly those paths. Never guess paths.
2. `get_transcript` for each clip with audio (phrase lines, SOURCE seconds). Use
   `words: true` with a `fromSec`/`toSec` range when you need to cut on an exact word.
3. When the picture matters (no speech, choosing between takes, checking framing),
   `get_frames` with a few times or a `count`. If the `watch` skill is available and a
   clip needs real viewing, you may run it on the clip's `path` from `list_media`.

## 2. Decide the cut

- If the user gave an order, that order is authoritative — follow it exactly.
- Otherwise choose the order and say why in one line per clip.
- For talking footage: keep the best take of each line, drop false starts, filler and
  dead air; start each segment just before the first word and end just after the last.
- Keep to the target length if the user gave one.

## 3. Place it — once

Call `place_sequence` ONCE with the whole cut as `{mediaId, inSec, outSec}` items in
order (`mode: "replace"` swaps out the existing video clips and their linked audio — titles,
images, captions and music stay; `"append"`, the default, adds after the last clip).
It is one undo step. Then `get_timeline` and check the clips, order and total length.
Fix mistakes with `undo` or `remove_items` and place again.

## 4. Report

Give the user a short list: each clip, its source window, its timeline position, and
the total length. Mention anything you were unsure about.

## 5. Export only when asked

`export_video` (optional `fileName`; optional `folder`, an absolute path to an
existing folder, only when the user names where it should go — otherwise it uses the
Settings export folder). It waits for the render and returns the file path — give the
user that path.

## When an ability is missing

If the job needs something these tools cannot do (captions, music, transitions, speed
changes, cutting on beats…), do NOT approximate it with tools that don't fit. Call
`request_feature` with a clear `title`, the `problem`, a concrete `proposal` (tool name
and arguments), and any `workaround` you used — then tell the user what you filed.

## Time bases

SOURCE seconds = position inside a media file (transcripts, frames, `inSec`/`outSec`).
TIMELINE seconds = position in the edit (`atSec`, `startSec`/`endSec` in `get_timeline`).
