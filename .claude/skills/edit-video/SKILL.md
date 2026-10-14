---
name: edit-video
description: Edit a video in the running Reel Editor through its MCP tools (reel-editor) — rough cuts from raw footage in an order you choose or the user dictates, captions and on-screen text, checking the timeline, an independent read-only audit of the result, exporting on request, and filing feature requests for abilities the editor lacks. Use when the user runs /edit-video or asks to cut, assemble, trim, caption, title or export a reel in the editor.
---

# Edit a video in Reel Editor

You are driving the Reel Editor desktop app on this computer. Every change you
make appears live in the user's timeline and is undoable with Ctrl+Z.

**Keep the user's request word for word.** You'll hand it to the auditor in step 6.

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

A cut on the timeline does NOT need new files: `inSec`/`outSec` already trim. Use
`trim_clip` (one window) or `split_clip` (cut at one or more SOURCE seconds) only when
the user wants trimmed or split clips **in the library** — they write new clips to the
project folder (a few seconds each), return their new ids in order, and change neither
the original nor the timeline. `undo` does not remove them.

## 4. Text and captions

- `get_text` lists every text layer and caption (TIMELINE seconds) with the style it
  actually renders with; the caption lane is id `"captions"`.
- `set_text` takes a list of edits in ONE undo step, all or nothing:
  - **fix or restyle:** `{id, …only the fields to change}`, e.g. `{id, text: "…"}`;
  - **create:** no id — `{text, startSec, endSec}` makes a text layer on top; add
    `kind: "caption"` for a caption;
  - **the lane:** `{id: "captions", visible, …style}` turns captions on/off or restyles
    all captions that don't have their own style.
- Timing can't change on a linked item (a caption linked to its clip) — fix its text
  and style, or tell the user.
- `render_frame` shows the finished picture at up to 4 TIMELINE times — use it to see
  how text really sits on screen.
- Only the open composition is covered: text inside nested compositions or layout
  cells isn't listed or editable yet.

## 5. Report what you did

A short list: each clip with its source window and timeline position, text you added
or changed, and the total length. Mention anything you were unsure about.

## 6. Audit — after every edit

After any change to the cut or to text (skip it for requests that only list, look or
export), start the **`reel-auditor`** agent (Agent tool, `subagent_type: "reel-auditor"`,
`run_in_background: false` — you need its findings before you report, and its read-only
tool list is only guaranteed in the foreground). It can only read. Give it exactly this brief:

```
USER GOAL (verbatim):
<the user's request, word for word>

This is the goal — did the editor achieve it? Check the result in the editor,
especially every caption and on-screen text.

WHAT CHANGED (facts only):
- <id> <kind> <timeline start–end> <added / changed / removed>
- ...
```

List facts only. Don't include your reasoning or why you chose things, so the
auditor's judgement stays independent.

Then triage its findings:

- **clear-error you agree with** → fix it with `set_text` (batch them into one call).
- **clear-error you disagree with**, and **every judgement call** → don't apply it;
  it goes to the user (below).
- If you changed any text, run the auditor **once more** with the same brief plus the
  new changes. Never more than two audits per request.

## 7. Report to the user

Report what you did as in step 5, then:

- **Fixed after audit:** each auto-applied fix as `mm:ss.s "old" → "new"`.
- **Needs your call:** each disagreement or judgement call, in timeline order:
  `mm:ss.s — I thought <X>; the auditor thought <Y>.` (or, for a judgement call you
  had no view on, `the auditor suggests <Y>`).
- Then call `set_playhead` on the **first** item that needs the user's call, and say
  so ("the playhead is at 0:12.4, the first one"). Offer to jump to the next.
- If the auditor found nothing, say so in one line.

## 8. Export only when asked

`export_video` (optional `fileName`; optional `folder`, an absolute path to an
existing folder, only when the user names where it should go — otherwise it uses the
Settings export folder). It waits for the render and returns the file path — give the
user that path. A finished export also saves the project, like the Export button: the
result has `saved: true`, or a `saveError` to pass on (the export itself still succeeded).

## When an ability is missing

If the job needs something these tools cannot do (music, transitions, speed changes,
cutting on beats, text inside nested comps…), do NOT approximate it with tools that
don't fit. Call `request_feature` with a clear `title`, the `problem`, a concrete
`proposal` (tool name and arguments), and any `workaround` you used — then tell the
user what you filed.

## Time bases

SOURCE seconds = position inside a media file (transcripts, frames, `inSec`/`outSec`).
TIMELINE seconds = position in the edit (`atSec`, `startSec`/`endSec` in `get_timeline`
and `get_text`, `render_frame` and `set_playhead` times). Write times for the user as
mm:ss.s on the timeline.
