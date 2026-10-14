# Text tools + auditor agent — build plan

Branch `claude/text-auditor` (worktree `.claude/worktrees/text-auditor`, `node_modules` and ffmpeg
junctioned). Status: **built through Step 6 (2026-10-11); Step 7 review pending.** Scope: now → review complete. The owner's `/edit-video`
smoke test comes after.

## Goal

`/edit-video` gets a second, read-only **auditor** agent. It receives the user's goal verbatim plus
"this is the goal — did the editor achieve it?" and checks the result, especially on-screen text
(spelling, sense, transcription errors, layout). The editor auto-applies clear errors. Judgement calls
and editor/auditor disagreements go back to the user with timeline timestamps, and the playhead is
parked on the first one.

## New MCP tools

| Tool | Who uses it | What it does |
|---|---|---|
| `get_text` | editor + auditor | Every on-screen text item (text layers and caption segments) in the open composition, in timeline order: id, kind, timeline start/end, visible or not (and why not), text, the style actually used, position, whether a caption overrides the lane style, and whether it's linked. Also the caption lane itself (on/off and its style). Optional filters: `ids`, `fromSec`/`toSec`. |
| `set_text` | editor only | A list of edits, all applied as ONE undo step. An edit **with** `id` patches that item. An edit **without** `id` creates one (`kind` defaults to a text layer, `caption` allowed); it needs `text`, `startSec`, `endSec`, and unset style falls back to the UI's defaults. All fields are optional and typed (text, timing, x/y, font, size, colour, pill, stroke, shadow, gradient, wrap width). The reserved id `captions` patches the lane (on/off, lane-wide style). Unknown keys and unknown fonts are refused, and the error lists the valid ones. If any edit is invalid, nothing is applied. Returns the ids it touched or created. |
| `set_playhead` | editor | Moves the playhead to a timeline second, clamped to the duration. That's all; no undo step. |
| `render_frame` | editor + auditor | The **finished** frame (all layers, text and captions burned in) at 1–4 timeline seconds, as JPEGs. |

## Decisions baked in (say if any are wrong)

1. **`render_frame` uses the export pipeline**, so the auditor judges what will actually ship, not a
   screenshot of the preview. It doesn't count as an export job, so it never blocks the Export button.
   It skips the stabilization pre-pass, and its result says so when a clip is stabilized. This is the
   one known difference from a real export.
2. **The auditor gets the user's goal, not the editor's reasoning:** the user's words verbatim, the addon,
   and a factual list of what changed (ids and time ranges). That keeps it independent.
3. **One playhead, many findings.** `set_playhead` points at the first disagreement. The report lists
   them all with timestamps, and the user can ask for the next.
4. **Changing caption text re-times the words.** If the word count is unchanged, the old timings are kept.
   Otherwise the words are spread across the segment. The Inspector's caption text box gets the same fix.
   It currently has a bug: a split brings back the old words.
5. **`set_text` refuses timing changes on linked items** (a caption linked to its clip), and the error
   names the link. Text and style edits on linked items are fine. Moving one partner alone would break
   the pair.
6. **The audit loop is bounded:** one audit, the editor applies fixes, then at most one re-audit if text changed.
7. **Only the open composition is in scope**, like `get_timeline`. Text inside nested comps or layout
   cells is out of scope for v1, noted in the skill.

## Auditor protocol

- **Agent definition** `.claude/agents/reel-auditor.md`. Its `tools:` list is only the read tools
  (`get_text`, `get_timeline`, `get_transcript`, `get_frames`, `render_frame`, `list_media`).
  Read-only is enforced by the tool list, not by the prompt.
- **Checks:** spelling and grammar, captions against the transcript, sense and tone against the goal,
  text timing (long enough to read, over the right shot), layout in rendered frames (cut off, off-frame,
  outside the safe zone, unreadable over the picture), and the goal overall (length, order, anything
  asked for that's missing).
- **Returns** findings. Each finding has: item id, timeline time, category, severity
  (`clear-error` | `judgement`), the problem, and a suggested fix (exact replacement text where it applies).
  It ends with a one-line verdict on the goal.
- **The editor triages:** a clear error it agrees with is applied via `set_text`. A clear error it
  disagrees with, and every judgement call, goes into the user report as "I thought X, the auditor
  thought Y, at mm:ss.s". Then the editor calls `set_playhead` on the first one.

---

## Build sequence

Each step ends with `npm run typecheck` + `npm test` green and a **local commit**. Never pushed.

### Step 0 — Kick off the ffmpeg check (background subagent)

Dispatch a **general-purpose subagent in the background**, working only in the scratchpad (it doesn't
touch the repo, so it can't collide with my edits). Brief: using the real ffmpeg 8.1.1, build a
miniature of the export graph (lavfi colour base, an overlaid lavfi clip, an ASS caption with a fade
and a karaoke `\k` line, the bundled `fontsdir`), and verify:

- (a) output-side seeking to a single frame at t gives exactly the frame the full render has at t, with
  captions and animation states correct, compared by pixel dump;
- (b) several times in one pass (frame `select`) against one run per time;
- (c) wall-clock for a 60 s 1080×1920 graph at t = 5 s and t = 55 s;
- (d) that dropping audio mapping changes nothing visual.

It reports back the verified command shape plus timings. Per CLAUDE.md, the binary is the oracle.

### Step 1 — Pure core (`src/shared/assistant/`, unit-tested; no wiring)

1. **Text summary** for `get_text`, in a new module next to `timelineSummary.ts`: resolves effective
   caption styles, visibility reasons (hidden layer, caption off, lane off) and the range filter.
2. **Word re-timing helper**: keep the timings when the word count matches, otherwise spread the words
   evenly. Tests cover: same count, more words, fewer words, empty text, no prior words.
3. **`applyTextEdits(composition, edits, makeId)`** → a new composition plus results, or a validation
   error naming every bad edit. Covers: create (text layer via `makeTextLayer`; caption with
   synthesized words), patch, the reserved `captions` lane id, unknown id, unknown key, unknown font
   (`isKnownFont`), end ≤ start, linked-timing refusal, all-or-nothing. This is the riskiest logic, so it
   gets the densest tests.

**Commit:** "feat(assistant): pure on-screen text summary, edits and caption re-timing".

### Step 2 — Text tools wired end to end

1. **Bridge contract**: `getText`, `applyTextEdits`, `setPlayhead` ops in
   `shared/assistant/protocol.ts`; `get_text` / `set_text` / `set_playhead` in `ToolArgs`.
2. **Renderer**: a single store action that commits `applyTextEdits` once (one undo step); handlers in
   `renderer/assistant/handlers.ts`; `set_playhead` through `usePlayback.setTime`, clamped to the duration.
3. **Main**: handlers in `main/assistant/tools.ts`.
4. **MCP**: zod schemas in `src/mcp/tools.ts`. They're strict, so unknown keys are refused at the MCP
   layer too, and the descriptions spell out create vs patch, the `captions` id, and timeline seconds.
5. **Inspector**: the caption text box goes through the re-timing helper (the bug fix).
6. **`docs/SHARED.md`**: entries for the new helpers.

**Commit:** "feat(assistant): get_text, set_text, set_playhead".

### Step 3 — End-to-end specs for the text tools

In `e2e/assistant.spec.ts`, ARRANGE via store, ACT via the real stdio MCP client, every dialog stubbed:

- `get_text` lists a seeded text layer and caption with their effective styles;
- `set_text` creates a layer without an id, and it appears in the store and the DOM;
- a batch patch of two items is reverted by one `undo`;
- an unknown key or font is refused and nothing changes;
- a timing change on a linked caption is refused;
- a caption spelling fix survives a split;
- `set_playhead` moves the playhead.

**Inspector regression spec** (new file): type a fix into a caption, split it, and the fix survives.
Confirm it **fails** with the helper bypassed, then restore.

Run `npm run test:e2e` (full suite, so nothing else regressed).

**Commit:** "test(e2e): text tools + caption-edit-survives-split regression".

### Step 4 — `render_frame`

1. Read the Step 0 report. **Gate:** if the verification failed or a frame takes over ~15 s at the end
   of a 60 s reel, stop and bring the options back to the owner before building.
2. Add a frame-only variant to the export path. The plan gets the frame times; the final output becomes
   JPEG stills in the verified shape. The existing `buildExportArgs` output must stay **byte-identical**:
   the current `exporterArgs` tests are the proof, and a new pinned test covers the frame variant.
3. Add a `renderFrames(project, times)` entry beside `exportProject`. It shares `runExport`'s internals,
   skips stabilization, uses its own temp dir with a kill path through `runFfmpeg`, and doesn't register
   an export job.
4. Add the tool to the main handler, MCP schema (1–4 times), and `ToolArgs`.
5. **E2E:** a synthesized clip plus a caption gives an image; its pixels under the caption differ from
   the same time with captions off.
6. **`docs/FFMPEG-NOTES.md`**: an entry for what Step 0 verified.

**Commit:** "feat(assistant): render_frame — finished frames through the export pipeline".

### Step 5 — Auditor agent, skill, server instructions

1. **`.claude/agents/reel-auditor.md`**: a tool allowlist of only the read tools, the checks list, the
   findings format, and a "never guess, quote the text you saw" rule.
2. **`/edit-video` skill**:
   - the new text tools (captions and on-screen text are no longer a `request_feature` case);
   - a new "Audit" section: when to audit (any change to the cut or text, never for list/export-only
     requests), the exact auditor brief (goal verbatim, the addon, the changed ids), triage rules, the
     re-audit limit, the disagreement report format with mm:ss.s, `set_playhead` on the first one;
   - the nested-comp limitation.
3. **`src/mcp/index.ts` `INSTRUCTIONS`**: mention the text tools and the audit step.
4. **Check that the agent loads**: confirm it's listed, and that a subagent with an MCP tool allowlist
   can call `mcp__reel-editor__*` tools (ask the claude-code-guide agent if unsure). Verifying it
   *against the live editor* is the owner's smoke test.

**Commit:** "feat(edit-video): read-only reel-auditor agent and the audit/triage protocol".

### Step 6 — Docs

- `docs/TODO.md` ▸ AI assistant features: one entry per tool plus the auditor, each `[~]`, saying
  exactly what's unverified (the real `/edit-video` run).
- The design spec `docs/superpowers/specs/…ai-assistant-mcp-design.md`: add the tool table.

**Commit:** "docs: text tools + auditor".

### Step 7 — Review

1. Run **`/code-review` at `high`** on the branch diff against `main`. Focus: `applyTextEdits`
   validation gaps, the one-undo-step guarantee, that the export args are unchanged, the kill path in
   `renderFrames`, and drift between schemas and handlers.
2. **Triage each finding:** fix it (adding a regression test where it's behavioural) or record why not.
3. Rerun `typecheck`, `npm test` and the full `test:e2e`, and commit the fixes ("fix: review findings …").
4. **Handoff report to the owner:** commits, what's verified (test names), what's `[~]`, any deviations
   from this plan, and a smoke-test checklist:
   - build in the worktree and point the MCP registration at it, or merge first;
   - seed a typo in a caption;
   - run `/edit-video` with a goal;
   - expect the typo auto-fixed, a judgement call reported with a timestamp, and the playhead on it.

**Done =** review findings resolved, all three suites green, the handoff report delivered. Merging is the
owner's call.

## Subagents

| When | Agent | Why it's safe in parallel |
|---|---|---|
| Step 0 → read at Step 4 | general-purpose, background | Scratchpad only; never touches the repo. |
| Step 5.4, if needed | claude-code-guide | Read-only question about subagent MCP tool allowlists. |
| Step 7 | `/code-review` (high) | Reviews a committed diff; I fix afterwards. |
| At runtime | `reel-auditor` | The product feature. |

Steps 1–6 are one sequential writer: they share `toolArgs`, `protocol`, both `tools.ts` and
`handlers.ts`, so parallel writers would collide.

## Risks

- **`render_frame` is slow on long reels.** Step 4 has a stop-and-ask gate.
- **Subagent MCP allowlists might not behave as expected.** Checked in Step 5.4. Fallback: the auditor
  is a general-purpose agent told it's read-only, which is weaker; I'd flag it if it comes to that.
- **Undo merging.** The Script drawer merges an assistant edit into a focused line's undo step (a known
  limitation from the earlier bridge work). `set_text` inherits it; it gets documented, not fixed.
