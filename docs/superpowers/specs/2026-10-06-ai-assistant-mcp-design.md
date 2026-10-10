# AI assistant via MCP — design

Status: approved in conversation 2026-10-06. Revised the same day: transport
changed from a local HTTP server to **stdio + named pipe** (see "Why not local
HTTP").

## Goal

Let an AI model operate the editor on the owner's behalf. v1 job: **a rough cut
from raw footage** — the model reads the clips, picks the usable parts, and lays
them on the timeline, either in an order it chooses or in an order the owner
dictates — and can **export the finished video** through the normal export
pipeline. The model can also **file feature requests into `docs/TODO.md`** when it
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
- The assistant connection is **on by default** and can be switched off in Settings.
- Must work with Norton 360 running normally (no exclusions, no pausing it).

### Success criteria

1. From a Claude Code session, the owner can say "make a ~30s reel from these
   clips" (or "…in this order: …") and watch the cut appear in the open editor.
2. Every assistant edit is one undo step; Ctrl+Z reverts it.
3. When the model hits a missing ability it calls `request_feature`, and a
   well-formed entry appears under `## Assistant requests` in `docs/TODO.md`.
4. Turning the Settings toggle off disconnects the assistant; on reconnects it.
5. "Export it" produces an .mp4 in the Settings export folder, identical to what
   the Export button would produce for the same project and preset.
6. After a one-time `claude mcp add --scope user …`, any Claude Code session sees
   the tools, and `/edit-video` (in sessions opened in this repo) starts the
   editing workflow. With the editor closed, tool calls say so plainly.

## Why not local HTTP

Verified 2026-10-06 on the owner's machine: something outside Node (Norton 360
is the only third-party network-filtering software running) inspects **local
plain-HTTP MCP traffic** and corrupts it — a correct fixed-length response is
rewritten in transit to `transfer-encoding: chunked` with an unframed body, so
every client rejects it. Triggered by a POST to any path whose last segment is
`mcp`, and by MCP traffic on a connection after its handshake; a plain Node
server with no SDK is affected identically; SDK versions 1.29.0–1.32.1 all fail
the same way. **stdio** (how the owner's existing playwright MCP server runs)
and a **Windows named pipe** are not network traffic and were verified intact:
handshake, tool list, a relayed tool call carrying MCP-shaped JSON, and a 5 KB
image byte-for-byte — using the SDK's stock stdio transport.

## Architecture

```
Claude Code ──stdio──► reel-mcp (out/main/mcp.js — Claude Code launches it with node)
                          │ JSON lines over a named pipe: \\.\pipe\reel-editor
                          ▼
                       Electron main (pipe server + tool handlers)
                          │ IPC request/response
                          ▼
                       renderer store actions (the same calls the UI makes)
```

- **reel-mcp** is a small stdio MCP server (SDK `McpServer` + `StdioServerTransport`,
  unmodified). It owns the tool definitions (names, descriptions, zod schemas)
  and forwards every call down the pipe. It never writes to stdout itself (that
  is the protocol channel); diagnostics go to stderr.
- **The editor** listens on the pipe while the assistant is enabled, runs the
  tool, and answers. Edits go through the renderer's real store actions — the
  code that already enforces nonlinear source time, links and undo.
- Rejected alternatives: a local HTTP server (above); a headless process editing
  the project file on disk (duplicates store logic, fights autosave, no live
  preview); a single "run arbitrary JS" tool (no schema, brittle across refactors).

### Units

| Unit | Location | Responsibility |
|---|---|---|
| Pipe protocol | `src/shared/assistant/pipeProtocol.ts` | **Pure.** Message types (`PipeRequest`, `PipeResponse`, `ToolContent`), JSON-lines encode + incremental decoder, default pipe path. |
| Tool argument types | `src/shared/assistant/toolArgs.ts` | **Types only.** `ToolArgs` (tool name → argument shape) — the compile-time link between reel-mcp's zod schemas and main's handlers. |
| Pipe transport | `src/main/assistant/pipe.ts` | `servePipe(path, handle)` (server) and `callPipe(path, tool, args)` (client). No Electron imports, so it is unit-tested with a real pipe. |
| reel-mcp | `src/mcp/index.ts`, `src/mcp/tools.ts` | stdio entry; MCP tool registrations that forward via `callPipe`. Built to `out/main/mcp.js` as a second entry of the main build. |
| Tool handlers | `src/main/assistant/tools.ts` | One async handler per tool → `ToolContent[]`. Read tools use the media store / whisper / ffmpeg; edit tools use `callRenderer`. |
| Assistant service | `src/main/assistant/service.ts` | Start/stop the pipe server from settings; status for the UI. |
| Renderer bridge | `src/main/assistant/bridge.ts`, `src/renderer/src/assistant/handlers.ts` | `callRenderer(op, args)` ⇄ renderer op table over store actions; 10 s timeout. Each request carries a deadline 1 s short of it; the renderer drops a request that arrives later (blocked by a dialog), so a timed-out edit never lands late. |
| Sequence builder | `src/renderer/src/lib/sequence.ts` | **Pure.** `applySequence(comp, plan, ctx)` → the layers + linked audio to add, built from `makeVideoLayer` + `trimVideoStart`/`trimVideoEnd`. |
| Transcript / frames / summary | `src/shared/assistant/` | **Pure.** Transcript text, frame sampling times, timeline summary. |
| TODO appender | `src/main/assistant/todoAppend.ts`, `todoFile.ts` | **Pure core** + serialized I/O for `docs/TODO.md`. |
| Export target | `src/main/services/exportTarget.ts` | **Pure.** Safe file names, unique paths, export refusal reasons. |
| Settings | `src/shared/settings.ts`, `SettingsModal.tsx` | `assistant: { enabled: boolean }`. UI: toggle, status line, copyable `claude mcp add …` command. |

### Pipe protocol

- One connection per tool call. reel-mcp writes one line
  `{"id","tool","args"}`; the editor answers one line
  `{"id","ok":true,"content":[…]}` or `{"id","ok":false,"error":"…"}` and the
  connection closes. Long calls (export, transcription) simply keep it open —
  there is no pipe-level timeout; Claude Code's own MCP tool timeout (~28 h by
  default) is the ceiling.
- `content` items are MCP content blocks: `{type:"text",text}` or
  `{type:"image",data(base64),mimeType}` — reel-mcp passes them through.
- Pipe path: `\\.\pipe\reel-editor` on Windows, `<tmpdir>/reel-editor.sock`
  elsewhere (non-Windows is untested). `REEL_ASSISTANT_PIPE` overrides it for
  both sides (e2e uses a unique name per launch).
- No token. A web page cannot open a named pipe, which removes the browser
  attack an HTTP server had to defend against. Access control is Windows'
  default named-pipe security (not separately verified for other local accounts;
  this is a single-user machine).

### Lifecycle

- On `app.whenReady`, after the window is created: if `settings.assistant.enabled`,
  start the pipe server. Toggling the setting starts/stops it live.
- Pipe already in use (a second editor instance) → status
  "Another copy of the editor is already connected to Claude Code"; the app keeps
  running.
- Editor closed or assistant off → reel-mcp still starts (Claude Code shows the
  server as connected); every tool call returns "Reel Editor isn't running, or
  its AI assistant is switched off in Settings. Open it and try again."
- On quit the pipe server is closed.

### Connecting a Claude Code session

Registration is **one-time, user scope** — stored in `~/.claude.json`, so every
Claude Code session in any folder (terminal or the desktop app's Code tab) gets
the tools. Settings shows the exact line (absolute path of the running checkout's
`out/main/mcp.js`) with a Copy button:

```bash
claude mcp add --scope user reel-editor -- node "C:\…\video_editor\out\main\mcp.js"
```

`node` must be on PATH (it is: Node 24). The script resolves the SDK from the
repo's `node_modules`, so it runs from the checkout it was built in.

`/edit-video` is a **project skill** at `.claude/skills/edit-video/SKILL.md`,
checked into the repo so the playbook is versioned with the tools (available in
sessions opened in this repo or its worktrees). The skill:

1. Checks the `reel-editor` tools are present; if not, tells the owner to run the
   registration line from Settings and start a new session, and stops. If a
   call reports the editor isn't running, tells the owner to open it.
2. Carries the playbook:
   - source time vs timeline time;
   - workflow: `list_media` (or `import_media` for paths the owner gives) →
     `get_transcript` (and `get_frames` when the picture matters) → choose →
     one `place_sequence` for the whole cut → `get_timeline` to verify →
     summarize the cut for the owner;
   - an order given by the owner is authoritative;
   - export only when the owner asks (`export_video`), then report the path;
   - when an ability is missing, call `request_feature` rather than
     approximating with tools that don't fit, and tell the owner what was filed.

The tool descriptions repeat the essentials (time base, one-undo-step) so a
session that did not invoke `/edit-video` still uses the tools correctly.
reel-mcp's MCP `instructions` field carries a one-paragraph version too, but
nothing depends on it: Claude Code's docs do not say whether it is used.

## Tools (v1)

All times are seconds. "Source time" = position inside a media file; "timeline
time" = position in the edit. Each tool's description says which it uses.

| Tool | Side | Input | Output |
|---|---|---|---|
| `list_media` | main + renderer | — | The project's library (`project.mediaIds` from the renderer, asset records from main): id, file name, path, kind, duration, has audio, picture size, transcribed, proxy ready. |
| `import_media` | main + renderer | `paths: string[]` (absolute) | Rejects relative / `~` paths (they would resolve against the editor's working directory). Imports via the existing import path (folders expand) and adds the ids to the project (`addMedia`). Returns `{imported, skipped}`: the new library entries, and each file that failed with its reason. |
| `get_transcript` | main | `mediaId`, optional `fromSec`/`toSec`, optional `words: boolean` | Runs `transcribeMedia` first when no current transcript exists (the job shows in the app's progress UI). Returns compact timed phrases in source time; word-level lines when `words` is set. Error if whisper is unavailable or the media has no audio. |
| `get_frames` | main | `mediaId`, and either `times: number[]` or `count` (evenly spaced); max 8 | Small JPEGs (≈360 px wide) from the **source** file via ffmpeg, reusing `generateStill`, returned as image content with their source times. Scratch files in `tmp/` are removed after encoding. |
| `get_timeline` | renderer | — | The active composition: each layer's id, kind, mediaId, source in/out, timeline start/end; audio clips likewise; total duration. |
| `place_sequence` | renderer | `items: {mediaId, inSec, outSec}[]`, `mode: 'append' \| 'replace'` (default `append`), optional `atSec` | Lays the items end-to-end in the given order starting at `atSec` (default: end of the current timeline for append, 0 for replace). `replace` removes existing video layers + their linked audio first. Clips with audio get a linked extracted audio clip, exactly as a UI drop does. Stacking: new clips go on the top layer, like a library drag; `replace` puts them on the layer of the removed video (the lowest one, if it removed several), so layers that were above it stay above. In/out clamped to the source; an item that clamps to nothing is an error. Waits for proxies still encoding. **One undo step** for the whole call. Returns the created layer ids and their timeline windows. |
| `remove_items` | renderer | `ids: string[]` | Removes via `removeItems` (linked partners follow). One undo step. |
| `undo` | renderer | — | One `undo()`. Returns whether anything was undone and the timeline after it. |
| `export_video` | main + renderer | optional `fileName`, optional `folder` | Snapshot of the **root** project from the renderer, run through the existing `exportProject(project, { preset, preferNvenc: true }, path)`, so output is identical to a button export. Path = `folder` (absolute, must already exist; never created) or else `settings.exportDir`, + `fileName` (sanitized, `.mp4` enforced) or `suggestedExportName`, made unique so an existing file is never overwritten. Waits until the render finishes (progress shows in the app). Errors: no video clips (same guard as the button), an export already running, or the ffmpeg failure message. Returns the output path and size. |
| `request_feature` | main | `title`, `problem`, `proposal`, optional `workaround` | Appends to `docs/TODO.md` (see below). Returns the written entry, or "already requested" when the title exists. |

### Undo semantics

`place_sequence` is a new store action `addVideoSequence(plan)` that commits the
whole `applySequence` result through **one** `commitComp`, so it records exactly
one history entry. `remove_items` and `undo` already map to single entries.
Edits apply to the active composition (`editPath`), the same as the UI.

## `request_feature` → `docs/TODO.md`

- Path: `join(app.getAppPath(), 'docs', 'TODO.md')` — in `npm run dev` that is
  the checkout the app was launched from. `REEL_TODO_PATH` overrides it (used by
  e2e so tests never touch the repo). Missing file → tool error, nothing created.
- Section: `## Assistant requests`, inserted directly above `## Open` when
  absent. Entries are appended at the end of that section. Writes are
  serialized (Claude Code may call tools in parallel).
- Entry format:

  ```markdown
  - [ ] **<title>** — <problem> _Proposal:_ <proposal> _Workaround used:_ <workaround> _(requested by assistant, 2026-10-06)_
  ```

  `_Workaround used:_` is omitted when absent. Text is single-lined (whitespace
  collapsed) so one entry is one list item.
- Duplicate check: an existing entry in that section with the same title
  (case-insensitive) → no write, returns "already requested".
- Written with the existing `writeAtomically` helper (`services/atomicWrite.ts`).

## Error handling

- Editor not running / assistant off → reel-mcp returns the "isn't running" error
  for every call (pipe connect fails with ENOENT/ECONNREFUSED).
- Editor closes mid-call → "Reel Editor closed the connection before answering".
- No project loaded / renderer not ready → "Editor has no project open".
- Renderer timeout (10 s) → tool error naming the op; the late request is dropped by the renderer, so nothing changed and a retry is safe.
- Unknown `mediaId` → tool error listing valid ids.
- Argument validation is reel-mcp's zod schemas; a bad argument is a tool error,
  never a crash. Handler exceptions become tool errors.
- ffmpeg failures in `get_frames` go through `runFfmpeg` (via `generateStill`).
- `export_video` reuses `exportProject`, so a failed render is reported through
  `failJob` (visible in the app) and its message becomes the tool error.

## Testing

**vitest (pure + local I/O):**
- `pipeProtocol`: decoder handles split chunks, several lines per chunk, a
  trailing partial line; encode/decode round trip.
- `pipe` (real named pipe, node environment): request/response round trip with
  text and image content; handler error → error response; no server → "isn't
  running"; two concurrent calls; a second server on the same pipe reports
  "already connected".
- `applySequence`: order preserved; back-to-back placement; `atSec` honored;
  in/out clamp; zero-length and reversed items rejected; linked audio mirrors
  in/out and shares the link group; no audio clip for silent sources.
- `transcriptText`, `frameTimes`, `summarizeTimeline`, `appendAssistantRequest`,
  `fileFeatureRequest` (parallel requests both land), `sanitizeExportName` /
  `uniqueExportPath` / `exportRefusal`, `withAssistantDefaults` / `mcpAddCommand`.

**Playwright e2e (`e2e/assistant.spec.ts`):** launch the built app with
`REEL_ASSISTANT_PIPE` and `REEL_TODO_PATH` unique per launch; drive it the way
Claude Code does — the SDK's stdio client spawning `node out/main/mcp.js`:
- tool list; unknown media id names the valid ids;
- reel-mcp pointed at a pipe nobody serves → "isn't running";
- `request_feature` → temp TODO file has the entry; second call → "already requested";
- Settings toggle off → calls fail with "isn't running"; on → work again;
- synthesized clips: `import_media`, `get_frames`, `place_sequence` → store and
  timeline DOM in the given order, one history entry; `undo` → empty; place
  again, `export_video` twice → `cut.mp4` (≈3.5 s via ffprobe) and `cut (2).mp4`.
  Skips with a stated reason when ffmpeg is not staged.

**Definition of done:** a real Claude Code session, registered with the
Settings command, produces a rough cut from real footage in `npm run dev`
(both "you choose the order" and "use this order") via `/edit-video`, and exports
it; the exported file plays and matches a button export of the same project —
with Norton running normally. Until that smoke test the TODO entry is `[~]` with
what remains unverified.

## Out of scope for v1

- In-app chat panel (a later API-key option on top of the same tool layer).
- Frames from the **composed** timeline (needs preview capture).
- Caption, text, music and effects tools.
- Visual-only clip selection logic beyond what `get_frames` provides.
- Packaged-build behavior (`request_feature` path, reel-mcp location) and
  non-Windows pipes.

## Docs to update when this lands

- `docs/SHARED.md`: the assistant units above.
- `docs/TODO.md`: the feature entry (`[~]` until smoke-tested) and the new
  `## Assistant requests` section.
- `README.md`: how to register reel-mcp with Claude Code and use `/edit-video`.
