# AI assistant via MCP — design

Status: approved in conversation 2026-10-06; this document awaits owner review.

## Goal

Let an AI model operate the editor on the owner's behalf. v1 job: **a rough cut
from raw footage** — the model reads the clips, picks the usable parts, and lays
them on the timeline, either in an order it chooses or in an order the owner
dictates. The model can also **file feature requests into `docs/TODO.md`** when it
needs an ability the editor does not expose.

### Constraints (from the owner)

- Runs on the owner's Claude **subscription**, not a paid API key. Anthropic does
  not allow third-party apps to offer claude.ai login, so the model runs in
  **Claude Code** and the editor exposes itself as an **MCP server** Claude Code
  connects to.
- Footage today is mostly talking-to-camera, but the design must not assume a
  filming style. Selection may lean on transcripts in v1; the tools stay generic
  (frames as well as words) so later versions can weigh visuals.
- `request_feature` always writes to the repo's `docs/TODO.md`. Packaged
  distribution is out of scope.
- The server is **on by default** and can be switched off in Settings.

### Success criteria

1. From a Claude Code session, the owner can say "make a ~30s reel from these
   clips" (or "…in this order: …") and watch the cut appear in the open editor.
2. Every assistant edit is one undo step; Ctrl+Z reverts it.
3. When the model hits a missing ability it calls `request_feature`, and a
   well-formed entry appears under `## Assistant requests` in `docs/TODO.md`.
4. Turning the Settings toggle off stops the server; on starts it again.

## Architecture

```
Claude Code ──HTTP (MCP)──► Electron main ──IPC──► renderer store actions
 (subscription) 127.0.0.1    src/main/assistant/     (same calls the UI makes)
```

The MCP server lives **inside the running app**, so edits go through the real
zustand store actions — the code that already enforces nonlinear source time,
links and undo. Rejected alternatives: a headless process editing the project
file on disk (duplicates store logic, fights autosave, no live preview), and a
single "run arbitrary JS" tool (no schema, brittle across refactors).

### Units

| Unit | Location | Responsibility |
|---|---|---|
| MCP server | `src/main/assistant/server.ts` | Start/stop an MCP server (`@modelcontextprotocol/sdk`, Streamable HTTP) on `127.0.0.1:<port>/mcp`; reject requests without the bearer token; register tools; serve the instructions text. |
| Main-side tools | `src/main/assistant/tools.ts` | Tools answered in main: `list_media` (asset records), `import_media`, `get_transcript`, `get_frames`, `request_feature`. Edit tools delegate to the renderer bridge. |
| Renderer bridge (main half) | `src/main/assistant/bridge.ts` | `callRenderer(op, args)`: sends `assistant:request {id, op, args}` to the window, awaits `assistant:response {id, ok, result \| error}`, 10 s timeout → tool error. |
| Renderer bridge (renderer half) | `src/renderer/src/assistant/handlers.ts` | Subscribes via preload; dispatches `op` to a small handler table calling store actions; replies. No React. |
| Sequence builder | `src/renderer/src/lib/sequence.ts` | **Pure.** `buildSequence(items, opts, ctx)` → the layers + linked audio clips to add, built from `makeVideoLayer` + `trimVideoStart`/`trimVideoEnd`. Never re-derives source↔timeline time inline. |
| Transcript formatter | `src/shared/assistant/transcriptText.ts` | **Pure.** Words → compact timed phrases (`[12.34–15.80] text`), split on pauses/punctuation; optional word-level output for a source range. |
| TODO appender | `src/main/assistant/todoAppend.ts` | **Pure core** `appendAssistantRequest(markdown, entry, date)` → new markdown; thin I/O wrapper writes `docs/TODO.md` via `writeAtomically` (`services/atomicWrite.ts`). |
| Settings | `src/shared/settings.ts`, `SettingsModal.tsx` | `assistant: { enabled: boolean; port: number; token: string }`. UI: on/off toggle, status line (running / port in use / off), copyable `claude mcp add …` command. |

New IPC: `assistant:request` (main → renderer event), `assistant:response`
(renderer → main), plus `assistant:status` (renderer asks for running/port-in-use
state). Names go in `shared/ipc.ts`; the renderer calls go through `ipc/client.ts`.

### Lifecycle

- On `app.whenReady`, after the window is created: if `settings.assistant.enabled`,
  start the server. A missing token is generated (`crypto.randomBytes(24)`, hex)
  and persisted on first read.
- Toggling the setting starts/stops the server live (no restart).
- `EADDRINUSE` (a second app instance, or another program) is reported through
  `assistant:status`, logged, and the app keeps running.
- On quit the server is closed.

### Token and port

Default port `47823`. The token lives in `settings.json` alongside the other
settings. The server binds `127.0.0.1` only and every request must carry
`Authorization: Bearer <token>`. Settings shows the exact registration line:

```bash
claude mcp add --transport http reel-editor http://127.0.0.1:47823/mcp --header "Authorization: Bearer <token>"
```

## Tools (v1)

All times are seconds. "Source time" = position inside a media file; "timeline
time" = position in the edit. Each tool's description says which it uses.

| Tool | Side | Input | Output |
|---|---|---|---|
| `list_media` | main + renderer | — | The project's library (`project.mediaIds` from the renderer, asset records from main): id, file name, kind, duration, has audio, transcribed, proxy ready. |
| `import_media` | main + renderer | `paths: string[]` | Imports via the existing `importFile` path and adds the ids to the project (`addMedia`). Returns the new library entries. |
| `get_transcript` | main | `mediaId`, optional `range {fromSec, toSec}`, optional `words: boolean` | Runs `transcribeMedia` first when no current transcript exists (the job shows in the app's progress UI). Returns compact timed phrases in source time; word-level lines when `words` is set (limited to `range` if given). Error if whisper is unavailable or the media has no audio. |
| `get_frames` | main | `mediaId`, and either `times: number[]` or `count` (evenly spaced); max 8 | Small JPEGs (≈360 px wide) from the **source** file via ffmpeg, reusing `buildStillArgs`, returned as MCP image content with their source times. Scratch files in `tmp/` are removed after encoding. |
| `get_timeline` | renderer | — | The active composition: each layer's id, kind, mediaId, source in/out, timeline start/end; audio clips likewise; total duration; output format. |
| `place_sequence` | renderer | `items: {mediaId, inSec, outSec}[]`, `mode: 'append' \| 'replace'` (default `append`), optional `atSec` | Lays the items end-to-end in the given order starting at `atSec` (default: end of the current timeline for append, 0 for replace). `replace` removes existing video layers + their linked audio first. Clips with audio get a linked extracted audio clip, exactly as a UI drop does. In/out clamped to the source duration; an item that clamps to nothing is an error. **One undo step** for the whole call. Returns the created layer ids and their timeline windows. |
| `remove_items` | renderer | `ids: string[]` | Removes via `removeItems` (linked partners follow). One undo step. |
| `undo` | renderer | — | One `undo()`. Returns what the timeline looks like now (same shape as `get_timeline`). |
| `request_feature` | main | `title`, `problem` (what it was trying to do and why it could not), `proposal` (suggested tool/API or behavior), optional `workaround` | Appends to `docs/TODO.md` (see below). Returns the written entry, or "already requested" when the title exists. |

### Undo semantics

`place_sequence` is a new store action `addVideoSequence(plan)` that commits the
whole `buildSequence` result through **one** `commitComp`, so it records exactly
one history entry. `remove_items` and `undo` already map to single entries. Edits
apply to the active composition (`editPath`), the same as the UI.

### Instructions text

The server's MCP `instructions` field explains, briefly:

- source time vs timeline time;
- the expected workflow: `list_media` → `get_transcript` (and `get_frames` when
  the picture matters) → choose → `place_sequence` → `get_timeline` to verify;
- an order given by the user is authoritative;
- prefer one `place_sequence` call for the whole cut over many small edits;
- when an ability is missing, call `request_feature` rather than approximating
  with tools that don't fit, then tell the user what was filed.

## `request_feature` → `docs/TODO.md`

- Path: `join(app.getAppPath(), 'docs', 'TODO.md')` — in `npm run dev` that is
  the checkout the app was launched from. `REEL_TODO_PATH` overrides it (used by
  e2e so tests never touch the repo). Missing file → tool error, nothing created.
- Section: `## Assistant requests`, inserted directly above `## Open` when
  absent (so it is near the top and visible). Entries are appended at the end of
  that section.
- Entry format:

  ```markdown
  - [ ] **<title>** — <problem> _Proposal:_ <proposal> _Workaround used:_ <workaround> _(requested by assistant, 2026-10-06)_
  ```

  `_Workaround used:_` is omitted when absent. Title/problem/proposal are
  single-lined (newlines collapsed) so one entry is one list item.
- Duplicate check: an existing entry in that section with the same title
  (case-insensitive) → no write, returns "already requested".
- Written with the existing `writeAtomically` helper (`services/atomicWrite.ts`).

## Error handling

- No project loaded / renderer not ready → tool error "Editor has no project open".
- Renderer timeout (10 s) → tool error naming the op.
- Unknown `mediaId` → tool error listing valid ids.
- Validation is by the SDK's zod schemas; a bad argument is a tool error, never
  a crash. Handler exceptions are caught and returned as tool errors.
- ffmpeg failures in `get_frames` go through `runFfmpeg` (kill path on every route).

## Testing

**vitest (pure layers):**
- `buildSequence`: order preserved; back-to-back placement; `atSec` honored;
  in/out clamp to source; zero-length item rejected; linked audio clip mirrors
  in/out and shares the link group; no audio clip when the source has none.
- `transcriptText`: phrase splitting on pauses and punctuation; range filter;
  word-level output; empty transcript.
- `appendAssistantRequest`: creates the section above `## Open`; appends to an
  existing section; duplicate title is a no-op; optional workaround omitted;
  the rest of the file is byte-identical.

**Playwright e2e (`e2e/assistant.spec.ts`):** launch the built app with
`REEL_TODO_PATH` pointed at a temp copy; connect with the SDK's MCP client:
- wrong/missing token → rejected;
- arrange media via `__reelStores`, call `place_sequence` → store has the layers
  in order and the timeline DOM shows them;
- `undo` → back to the prior state in one step;
- `request_feature` → temp TODO file has the entry; second call → "already requested";
- Settings toggle off → connection refused; on → works again.

**Definition of done:** a real Claude Code session, registered with the
Settings command, produces a rough cut from real footage in `npm run dev`
(both "you choose the order" and "use this order"). Until that smoke test the
TODO entry is `[~]` with what remains unverified.

## Out of scope for v1

- In-app chat panel (a later API-key option on top of the same tool layer).
- Frames from the **composed** timeline (needs preview capture).
- Caption, text, music and effects tools.
- Visual-only clip selection logic beyond what `get_frames` provides.
- Packaged-build behavior of `request_feature`.

## Docs to update when this lands

- `docs/SHARED.md`: `buildSequence`, `transcriptText`, the assistant bridge.
- `docs/TODO.md`: the feature entry (`[~]` until smoke-tested) and the new
  `## Assistant requests` section.
- `README.md`: how to register the server with Claude Code.
