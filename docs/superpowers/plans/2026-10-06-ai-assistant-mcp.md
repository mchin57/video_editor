# AI Assistant via MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code (on the owner's subscription) drive the running Reel Editor: read clips and transcripts, look at frames, lay a rough cut on the timeline in one undo step, export it, and file feature requests into `docs/TODO.md`.

**Architecture:** Claude Code launches **reel-mcp** (`node out/main/mcp.js`), a stdio MCP server built from this repo with the official `@modelcontextprotocol/sdk` (stock `StdioServerTransport`). reel-mcp owns the tool definitions and forwards each call as one JSON line over a Windows **named pipe** to the running editor. Electron main answers: read tools from the media store / whisper / ffmpeg, edit tools over an IPC request/response bridge to the renderer, which runs the real zustand store actions (so undo, links and nonlinear source time stay correct). No local HTTP: an MCP-aware filter on the owner's machine corrupts local plain-HTTP MCP traffic (spec, "Why not local HTTP"); stdio and pipes are verified unaffected.

**Tech Stack:** Electron 42 + electron-vite 5, React 19, zustand, TypeScript, vitest, Playwright (Electron), `@modelcontextprotocol/sdk@1.32.1`, `zod@^4`, Node 24 (on PATH, runs reel-mcp).

**Spec:** `docs/superpowers/specs/2026-10-06-ai-assistant-mcp-design.md` — read it alongside this plan.

## Global Constraints

- Never `git push`. Commit locally only (CLAUDE.md house rule).
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `npm run typecheck` and `npm test` must be green at every commit; the `exporterArgs` tests must stay untouched and green.
- No HTTP server and no SDK transport workarounds: reel-mcp uses the SDK's stock `StdioServerTransport`; editor ⇄ reel-mcp is JSON lines over a named pipe.
- Pipe path: `\\.\pipe\reel-editor` on Windows (`<tmpdir>/reel-editor.sock` elsewhere, untested); env `REEL_ASSISTANT_PIPE` overrides it on both sides.
- reel-mcp builds to `out/main/mcp.js` (second entry of the electron-vite main build) and must never import `electron` or write to stdout (stdout is the MCP channel; log with `console.error`).
- Registration command, exactly: `claude mcp add --scope user reel-editor -- node "<absolute path of out/main/mcp.js>"`
- Assistant is ON by default; Settings has a toggle that starts/stops the pipe server live.
- Not-running message, exactly: `Reel Editor isn't running, or its AI assistant is switched off in Settings. Open it and try again.`
- `request_feature` writes to `join(app.getAppPath(), 'docs', 'TODO.md')`, overridable by env `REEL_TODO_PATH`; section heading `## Assistant requests`, inserted directly above `## Open`.
- Entry format: `- [ ] **<title>** — <problem> _Proposal:_ <proposal> _Workaround used:_ <workaround> _(requested by assistant, YYYY-MM-DD)_` (workaround clause omitted when absent).
- Every edit tool is exactly one undo step. Edits target the active composition (`editPath`), like the UI.
- `docs/TODO.md` feature entry stays `[~]` until the owner's real smoke test (Task 16) passes — with Norton running normally.

## Review Focus

1. **A media id the project doesn't have** (stale id, another project's clip) → tool error that lists the valid ids; nothing changes. Pinned in Task 14 (e2e `get_transcript` with a bogus id).
2. **Reversed or out-of-range in/out in `place_sequence`** (`outSec < inSec`, beyond the source) → clamped where possible, otherwise an error naming the item, and the timeline and undo history are untouched. Pinned in Task 6 (`rejects a reversed item…`).
3. **Two `request_feature` calls at once** (Claude Code issues tool calls in parallel) → both entries land; neither overwrites the other. Pinned in Task 3 (`todoFile.test.ts`).
4. **`export_video` while an export is already running, or with no clips** → refused with a clear reason, no second ffmpeg started. Pinned in Task 4 (`exportRefusal`).
5. **A second editor instance** (same pipe already served) → Settings shows "Another copy of the editor is already connected to Claude Code", the app keeps running; and **the editor closed** → every tool says so plainly. Pinned in Task 9 (`pipe.test.ts`) and Task 14 (e2e "closed editor").

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/shared/assistant/transcriptText.ts` (+test) | create | Words → compact timed phrase / word lines |
| `src/shared/assistant/frameTimes.ts` (+test) | create | Which source times `get_frames` samples |
| `src/shared/assistant/protocol.ts` | create | Renderer-bridge op types, sequence types, `AssistantStatus` |
| `src/shared/assistant/timelineSummary.ts` (+test) | create | Composition → compact JSON the model reads |
| `src/shared/assistant/pipeProtocol.ts` (+test) | create | Pipe message types, JSON-lines encode/decode, default pipe path |
| `src/shared/assistant/toolArgs.ts` | create | Tool name → argument type (links reel-mcp and main at compile time) |
| `src/shared/settings.ts` (+new test) | modify | `AssistantSettings`, defaults, `mcpAddCommand` |
| `src/main/assistant/todoAppend.ts` (+test) | create | Pure markdown insertion for feature requests |
| `src/main/assistant/todoFile.ts` (+test) | create | Read/serialize/write `docs/TODO.md` |
| `src/main/services/exportTarget.ts` (+test) | create | Safe export file names, unique paths, export refusal reasons |
| `src/renderer/src/lib/sequence.ts` (+test) | create | `applySequence` + `makeExtractedAudioClip` |
| `src/renderer/src/state/projectStore.ts` | modify | `addVideoSequence` action; `addVideoLayer` uses `makeExtractedAudioClip` |
| `src/main/services/settings.ts` | modify | Assistant defaults |
| `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/ipc/client.ts` | modify | Bridge + status channels |
| `src/main/assistant/bridge.ts` | create | `callRenderer(op, args)` with timeout |
| `src/renderer/src/assistant/handlers.ts` | create | Renderer op table over store actions |
| `src/renderer/src/main.tsx` | modify | Install the bridge |
| `src/main/assistant/pipe.ts` (+test) | create | `servePipe` / `callPipe` over a real named pipe (no Electron imports) |
| `src/main/services/importMany.ts` | create (moved) | Import paths + kick proxies (was private in `ipc.ts`) |
| `src/main/assistant/tools.ts` | create | One handler per tool → `ToolContent[]`; `handleTool` dispatch |
| `src/mcp/tools.ts`, `src/mcp/index.ts` | create | reel-mcp: zod tool definitions forwarding over the pipe; stdio entry |
| `electron.vite.config.ts`, `tsconfig.node.json` | modify | Build `out/main/mcp.js`; typecheck `src/mcp` |
| `src/main/assistant/service.ts` | create | Start/stop/status of the pipe server |
| `src/main/index.ts`, `src/main/ipc.ts` | modify | Lifecycle, status IPC, restart on settings change |
| `src/renderer/src/components/SettingsModal.tsx` | modify | Toggle, status, copyable command |
| `e2e/fixtures.ts`, `e2e/assistant.spec.ts` | modify/create | Hermetic pipe + TODO path; end-to-end via the real stdio script |
| `.claude/skills/edit-video/SKILL.md` | create | `/edit-video` playbook |
| `docs/SHARED.md`, `docs/TODO.md`, `README.md` | modify | Docs |

---

### Task 1: Workspace setup + transcript and frame-time helpers

**Files:**
- Create: `src/shared/assistant/transcriptText.ts`, `src/shared/assistant/transcriptText.test.ts`
- Create: `src/shared/assistant/frameTimes.ts`, `src/shared/assistant/frameTimes.test.ts`
- Modify: `package.json`, `package-lock.json` (new deps)

**Interfaces:**
- Produces: `transcriptPhraseText(words: CaptionWord[], range?: TranscriptRange): string`, `transcriptWordText(words, range?): string`, `phrases(words): CaptionWord[][]`, `wordsInRange(words, range?)`, `TranscriptRange { fromSec: number; toSec: number }`, `PHRASE_GAP_SEC = 0.6`, `PHRASE_MAX_WORDS = 14`; `frameTimes(durationSec: number, times?: number[], count?: number): number[]`, `MAX_FRAMES = 8`.

- [ ] **Step 1: Give the worktree its own `node_modules` and an ffmpeg for e2e**

This worktree must NOT junction `node_modules` (the memory note's usual fix): we add dependencies, and installing through a junction would write into the main checkout. The main checkout's `resources/bin` is empty, so stage ffmpeg by junctioning the winget build.

Run (PowerShell, in the worktree root):
```powershell
npm ci
New-Item -ItemType Directory -Force resources\bin | Out-Null
New-Item -ItemType Junction -Path resources\bin\ffmpeg -Target "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-full_build\bin"
Test-Path resources\bin\ffmpeg\ffmpeg.exe; Test-Path resources\bin\ffmpeg\ffprobe.exe
```
Expected: `npm ci` completes; both `Test-Path` print `True`.

- [ ] **Step 2: Add the dependencies**

Run: `npm install @modelcontextprotocol/sdk@1.32.1 zod@^4`
Expected: both appear under `dependencies` in `package.json`. Then run `npm test` — expected: the existing suite passes (baseline).

- [ ] **Step 3: Write the failing tests**

`src/shared/assistant/transcriptText.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  PHRASE_MAX_WORDS,
  phrases,
  transcriptPhraseText,
  transcriptWordText,
  wordsInRange
} from './transcriptText'

const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec })

describe('transcriptPhraseText', () => {
  it('splits on a pause of at least 0.6s', () => {
    const words = [w('hi', 0, 0.3), w('there', 0.35, 0.7), w('next', 1.4, 1.8)]
    expect(transcriptPhraseText(words)).toBe('[0.00–0.70] hi there\n[1.40–1.80] next')
  })

  it('splits after sentence punctuation even without a pause', () => {
    const words = [w('Done.', 0, 0.4), w('Now', 0.45, 0.7)]
    expect(transcriptPhraseText(words)).toBe('[0.00–0.40] Done.\n[0.45–0.70] Now')
  })

  it('caps a phrase at PHRASE_MAX_WORDS words', () => {
    const words = Array.from({ length: PHRASE_MAX_WORDS + 1 }, (_, i) => w(`w${i}`, i * 0.2, i * 0.2 + 0.1))
    expect(phrases(words).map((p) => p.length)).toEqual([PHRASE_MAX_WORDS, 1])
  })

  it('trims the whitespace whisper leaves on word text', () => {
    expect(transcriptPhraseText([w(' hello', 0, 0.2), w(' world', 0.25, 0.5)])).toBe('[0.00–0.50] hello world')
  })

  it('keeps only words overlapping the range', () => {
    const words = [w('a', 0, 1), w('b', 2, 3), w('c', 4, 5)]
    expect(wordsInRange(words, { fromSec: 2.5, toSec: 4.2 }).map((x) => x.text)).toEqual(['b', 'c'])
  })

  it('says so when there is no speech', () => {
    expect(transcriptPhraseText([])).toBe('(no speech)')
    expect(transcriptWordText([w('a', 0, 1)], { fromSec: 5, toSec: 6 })).toBe('(no speech)')
  })
})

describe('transcriptWordText', () => {
  it('prints one timed word per line', () => {
    expect(transcriptWordText([w('hi', 0, 0.3), w('there', 0.35, 0.7)])).toBe('0.00–0.30 hi\n0.35–0.70 there')
  })
})
```

`src/shared/assistant/frameTimes.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MAX_FRAMES, frameTimes } from './frameTimes'

describe('frameTimes', () => {
  it('samples the centres of equal slices when given a count', () => {
    expect(frameTimes(8, undefined, 4)).toEqual([1, 3, 5, 7])
  })

  it('defaults to 4 frames', () => {
    expect(frameTimes(8)).toHaveLength(4)
  })

  it('clamps explicit times into the clip and drops duplicates', () => {
    expect(frameTimes(10, [-1, 0, 3, 3, 99])).toEqual([0, 3, 9.95])
  })

  it('never returns more than MAX_FRAMES', () => {
    expect(frameTimes(100, undefined, 50)).toHaveLength(MAX_FRAMES)
    expect(frameTimes(100, Array.from({ length: 20 }, (_, i) => i))).toHaveLength(MAX_FRAMES)
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run src/shared/assistant`
Expected: FAIL — cannot resolve `./transcriptText` / `./frameTimes`.

- [ ] **Step 5: Implement**

`src/shared/assistant/transcriptText.ts`:
```ts
/**
 * Transcript → compact text for the AI assistant (`get_transcript`). Phrase
 * lines keep token cost low; word lines are for cutting on a precise word.
 * All times are SOURCE time (seconds into the media file). Pure.
 */

import type { CaptionWord } from '../project'

/** A pause at least this long between two words starts a new phrase (s). */
export const PHRASE_GAP_SEC = 0.6
/** A phrase is also closed after this many words so lines stay scannable. */
export const PHRASE_MAX_WORDS = 14

export interface TranscriptRange {
  fromSec: number
  toSec: number
}

const fmt = (s: number): string => s.toFixed(2)

/** Words whose span overlaps `range` (all of them when absent). */
export function wordsInRange(words: CaptionWord[], range?: TranscriptRange): CaptionWord[] {
  if (!range) return words
  return words.filter((w) => w.endSec > range.fromSec && w.startSec < range.toSec)
}

/** Group words into phrases: break on a pause, after sentence punctuation, or at the word cap. */
export function phrases(words: CaptionWord[]): CaptionWord[][] {
  const out: CaptionWord[][] = []
  let cur: CaptionWord[] = []
  for (const w of words) {
    const prev = cur[cur.length - 1]
    const breakHere =
      prev !== undefined &&
      (w.startSec - prev.endSec >= PHRASE_GAP_SEC ||
        /[.!?]$/.test(prev.text.trim()) ||
        cur.length >= PHRASE_MAX_WORDS)
    if (breakHere) {
      out.push(cur)
      cur = []
    }
    cur.push(w)
  }
  if (cur.length) out.push(cur)
  return out
}

/** `[12.34–15.80] text` per phrase. */
export function transcriptPhraseText(words: CaptionWord[], range?: TranscriptRange): string {
  const ws = wordsInRange(words, range)
  if (!ws.length) return '(no speech)'
  return phrases(ws)
    .map((p) => `[${fmt(p[0].startSec)}–${fmt(p[p.length - 1].endSec)}] ${p.map((w) => w.text.trim()).join(' ')}`)
    .join('\n')
}

/** `12.34–12.61 word` per word. */
export function transcriptWordText(words: CaptionWord[], range?: TranscriptRange): string {
  const ws = wordsInRange(words, range)
  if (!ws.length) return '(no speech)'
  return ws.map((w) => `${fmt(w.startSec)}–${fmt(w.endSec)} ${w.text.trim()}`).join('\n')
}
```

`src/shared/assistant/frameTimes.ts`:
```ts
/** Which source times `get_frames` grabs. Pure. */

export const MAX_FRAMES = 8
/** Stay this far inside the end: a seek to the very last instant can return no frame. */
const END_GUARD_SEC = 0.05

/**
 * Explicit `times` (clamped into the clip, duplicates dropped), else `count`
 * evenly spaced frames at the centres of equal slices (default 4). Never more
 * than MAX_FRAMES.
 */
export function frameTimes(durationSec: number, times?: number[], count?: number): number[] {
  const last = Math.max(0, durationSec - END_GUARD_SEC)
  if (times?.length) {
    return [...new Set(times.map((t) => Math.min(Math.max(0, t), last)))].slice(0, MAX_FRAMES)
  }
  const n = Math.min(Math.max(1, count ?? 4), MAX_FRAMES)
  return Array.from({ length: n }, (_, i) => Math.min(((i + 0.5) * durationSec) / n, last))
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/shared/assistant` then `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/shared/assistant/transcriptText.ts src/shared/assistant/transcriptText.test.ts src/shared/assistant/frameTimes.ts src/shared/assistant/frameTimes.test.ts
git commit -m "feat(assistant): transcript text + frame sampling helpers; add MCP SDK deps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: TODO appender (pure)

**Files:**
- Create: `src/main/assistant/todoAppend.ts`, `src/main/assistant/todoAppend.test.ts`

**Interfaces:**
- Produces: `ASSISTANT_SECTION = '## Assistant requests'`; `interface FeatureRequest { title: string; problem: string; proposal: string; workaround?: string }`; `formatRequestEntry(req, date: string): string`; `appendAssistantRequest(markdown: string, req: FeatureRequest, date: string): AppendResult` where `AppendResult = { status: 'added'; markdown: string; entry: string } | { status: 'duplicate'; markdown: string }`.

- [ ] **Step 1: Write the failing test**

`src/main/assistant/todoAppend.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { appendAssistantRequest, formatRequestEntry } from './todoAppend'

const DOC = ['# TODO / backlog', '', '## Bugs', '', '- [ ] a bug', '', '## Open', '', '- [ ] thing', ''].join('\n')
const REQ = { title: 'Trim by word', problem: 'Needed to cut at a word.', proposal: 'trim_to_word tool' }
const ENTRY =
  '- [ ] **Trim by word** — Needed to cut at a word. _Proposal:_ trim_to_word tool _(requested by assistant, 2026-10-06)_'

describe('appendAssistantRequest', () => {
  it('creates the section directly above ## Open', () => {
    const r = appendAssistantRequest(DOC, REQ, '2026-10-06')
    expect(r.status).toBe('added')
    expect(r.markdown).toBe(
      ['# TODO / backlog', '', '## Bugs', '', '- [ ] a bug', '', '## Assistant requests', '', ENTRY, '', '## Open', '', '- [ ] thing', ''].join('\n')
    )
  })

  it('leaves the rest of the file byte-identical', () => {
    const r = appendAssistantRequest(DOC, REQ, '2026-10-06')
    expect(r.markdown.replace(`## Assistant requests\n\n${ENTRY}\n\n`, '')).toBe(DOC)
  })

  it('appends after the last entry of an existing section', () => {
    const first = appendAssistantRequest(DOC, REQ, '2026-10-06').markdown
    const r = appendAssistantRequest(first, { title: 'Beat snap', problem: 'p', proposal: 'q' }, '2026-10-07')
    expect(r.markdown).toContain(`${ENTRY}\n- [ ] **Beat snap** — p _Proposal:_ q _(requested by assistant, 2026-10-07)_\n\n## Open`)
  })

  it('separates the first entry from explanatory text with a blank line', () => {
    const doc = ['## Assistant requests', '', '> Filed by the assistant.', '', '## Open', ''].join('\n')
    const r = appendAssistantRequest(doc, REQ, '2026-10-06')
    expect(r.markdown).toBe(['## Assistant requests', '', '> Filed by the assistant.', '', ENTRY, '', '## Open', ''].join('\n'))
  })

  it('treats the same title in any case as already requested', () => {
    const first = appendAssistantRequest(DOC, REQ, '2026-10-06').markdown
    const r = appendAssistantRequest(first, { ...REQ, title: 'TRIM BY WORD' }, '2026-10-08')
    expect(r).toEqual({ status: 'duplicate', markdown: first })
  })

  it('appends a section at the end when there is no ## Open', () => {
    const r = appendAssistantRequest('# T\n\n- [ ] x\n', REQ, '2026-10-06')
    expect(r.markdown).toBe(`# T\n\n- [ ] x\n\n## Assistant requests\n\n${ENTRY}\n`)
  })

  it('keeps CRLF line endings', () => {
    const r = appendAssistantRequest(DOC.replace(/\n/g, '\r\n'), REQ, '2026-10-06')
    expect(r.markdown).not.toMatch(/[^\r]\n/)
    expect(r.markdown).toContain(`## Assistant requests\r\n\r\n${ENTRY}\r\n`)
  })
})

describe('formatRequestEntry', () => {
  it('includes the workaround only when given, and keeps one entry on one line', () => {
    expect(formatRequestEntry({ ...REQ, workaround: '  split\nby hand ' }, '2026-10-06')).toBe(
      '- [ ] **Trim by word** — Needed to cut at a word. _Proposal:_ trim_to_word tool _Workaround used:_ split by hand _(requested by assistant, 2026-10-06)_'
    )
    expect(formatRequestEntry({ ...REQ, problem: 'line one\nline two' }, '2026-10-06')).toContain('— line one line two _Proposal:_')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/assistant/todoAppend.test.ts`
Expected: FAIL — cannot resolve `./todoAppend`.

- [ ] **Step 3: Implement**

`src/main/assistant/todoAppend.ts`:
```ts
/**
 * Insert an assistant feature request into docs/TODO.md's markdown. Pure: the
 * file I/O lives in `todoFile.ts`. The section is created directly above
 * `## Open` so requests sit near the top for triage.
 */

export const ASSISTANT_SECTION = '## Assistant requests'

export interface FeatureRequest {
  title: string
  problem: string
  proposal: string
  workaround?: string
}

export type AppendResult =
  | { status: 'added'; markdown: string; entry: string }
  | { status: 'duplicate'; markdown: string }

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const ENTRY_TITLE = /^- \[[ x~]\] \*\*(.+?)\*\*/i

export function formatRequestEntry(req: FeatureRequest, date: string): string {
  const parts = [`- [ ] **${oneLine(req.title)}** — ${oneLine(req.problem)}`, `_Proposal:_ ${oneLine(req.proposal)}`]
  const workaround = req.workaround ? oneLine(req.workaround) : ''
  if (workaround) parts.push(`_Workaround used:_ ${workaround}`)
  parts.push(`_(requested by assistant, ${date})_`)
  return parts.join(' ')
}

export function appendAssistantRequest(markdown: string, req: FeatureRequest, date: string): AppendResult {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const entry = formatRequestEntry(req, date)
  const start = lines.findIndex((l) => l.trim() === ASSISTANT_SECTION)

  if (start === -1) {
    const open = lines.findIndex((l) => l.trim() === '## Open')
    if (open === -1) {
      const body = markdown.replace(/(\r?\n)+$/, '')
      return { status: 'added', entry, markdown: `${body}${eol}${eol}${ASSISTANT_SECTION}${eol}${eol}${entry}${eol}` }
    }
    const next = [...lines.slice(0, open), ASSISTANT_SECTION, '', entry, '', ...lines.slice(open)]
    return { status: 'added', entry, markdown: next.join(eol) }
  }

  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end === -1) end = lines.length
  const title = oneLine(req.title).toLowerCase()
  const dup = lines
    .slice(start + 1, end)
    .some((l) => ENTRY_TITLE.exec(l)?.[1].trim().toLowerCase() === title)
  if (dup) return { status: 'duplicate', markdown }

  let last = end - 1
  while (last > start && lines[last].trim() === '') last--
  // Directly under another entry; otherwise (heading, prose, quote) leave a blank line.
  const insert = last > start && lines[last].startsWith('- ') ? [entry] : ['', entry]
  const next = [...lines.slice(0, last + 1), ...insert, ...lines.slice(last + 1)]
  return { status: 'added', entry, markdown: next.join(eol) }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/assistant/todoAppend.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/assistant/todoAppend.ts src/main/assistant/todoAppend.test.ts
git commit -m "feat(assistant): pure TODO.md appender for assistant feature requests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: TODO file writer (serialized I/O)

**Files:**
- Create: `src/main/assistant/todoFile.ts`, `src/main/assistant/todoFile.test.ts`

**Interfaces:**
- Consumes: `appendAssistantRequest`, `FeatureRequest` (Task 2); `writeAtomically(finalPath, write)` from `src/main/services/atomicWrite.ts`.
- Produces: `todoPath(): string`; `fileFeatureRequest(req: FeatureRequest): Promise<FileResult>` where `FileResult = { status: 'added'; entry: string; path: string } | { status: 'duplicate'; path: string }`.

- [ ] **Step 1: Write the failing test**

`src/main/assistant/todoFile.test.ts`:
```ts
// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => 'C:/not-used' } }))

import { fileFeatureRequest, todoPath } from './todoFile'

let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'todo-')), 'TODO.md')
  writeFileSync(file, '# TODO\n\n## Open\n\n- [ ] x\n')
  process.env.REEL_TODO_PATH = file
})
afterEach(() => {
  delete process.env.REEL_TODO_PATH
})

describe('fileFeatureRequest', () => {
  it('uses REEL_TODO_PATH when set', () => {
    expect(todoPath()).toBe(file)
  })

  it('writes the entry and reports a repeat as a duplicate', async () => {
    const req = { title: 'Beat snap', problem: 'needed beats', proposal: 'detect_beats tool' }
    expect((await fileFeatureRequest(req)).status).toBe('added')
    expect((await fileFeatureRequest(req)).status).toBe('duplicate')
    expect(readFileSync(file, 'utf8').match(/Beat snap/g)).toHaveLength(1)
  })

  it('keeps both of two requests filed at the same time', async () => {
    await Promise.all([
      fileFeatureRequest({ title: 'One', problem: 'p1', proposal: 'q1' }),
      fileFeatureRequest({ title: 'Two', problem: 'p2', proposal: 'q2' })
    ])
    const md = readFileSync(file, 'utf8')
    expect(md).toContain('**One**')
    expect(md).toContain('**Two**')
  })

  it('fails clearly when the file is missing', async () => {
    process.env.REEL_TODO_PATH = join(tmpdir(), 'definitely-missing-TODO.md')
    await expect(fileFeatureRequest({ title: 'T', problem: 'p', proposal: 'q' })).rejects.toThrow(/Could not read the TODO list/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/assistant/todoFile.test.ts`
Expected: FAIL — cannot resolve `./todoFile`.

- [ ] **Step 3: Implement**

`src/main/assistant/todoFile.ts`:
```ts
/**
 * File assistant feature requests into the repo's docs/TODO.md. Writes are
 * serialized: Claude Code can issue tool calls in parallel, and two
 * read-modify-writes racing would drop one request.
 */

import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { writeAtomically } from '../services/atomicWrite'
import { appendAssistantRequest, type FeatureRequest } from './todoAppend'

export type FileResult = { status: 'added'; entry: string; path: string } | { status: 'duplicate'; path: string }

/** The checkout the app was launched from (npm run dev); REEL_TODO_PATH overrides (e2e). */
export const todoPath = (): string => process.env.REEL_TODO_PATH || join(app.getAppPath(), 'docs', 'TODO.md')

/** Local calendar date, YYYY-MM-DD. */
const today = (): string => new Date().toLocaleDateString('en-CA')

let queue: Promise<unknown> = Promise.resolve()

export function fileFeatureRequest(req: FeatureRequest): Promise<FileResult> {
  const run = queue.then(() => writeRequest(req))
  queue = run.catch(() => {})
  return run
}

async function writeRequest(req: FeatureRequest): Promise<FileResult> {
  const path = todoPath()
  let markdown: string
  try {
    markdown = await fsp.readFile(path, 'utf8')
  } catch {
    throw new Error(`Could not read the TODO list at ${path}`)
  }
  const r = appendAssistantRequest(markdown, req, today())
  if (r.status === 'duplicate') return { status: 'duplicate', path }
  await writeAtomically(path, (part) => fsp.writeFile(part, r.markdown, 'utf8'))
  return { status: 'added', entry: r.entry, path }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/assistant/todoFile.test.ts` then `npm run typecheck`
Expected: PASS (4 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/assistant/todoFile.ts src/main/assistant/todoFile.test.ts
git commit -m "feat(assistant): serialized TODO.md writer for feature requests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Export target helpers

**Files:**
- Create: `src/main/services/exportTarget.ts`, `src/main/services/exportTarget.test.ts`

**Interfaces:**
- Consumes: `Job` from `@shared/jobs`, `Project` from `@shared/project`.
- Produces: `sanitizeExportName(raw: string): string | null`; `uniqueExportPath(dir: string, name: string, exists: (path: string) => boolean): string`; `exportRefusal(project: Pick<Project, 'layers'>, jobs: Pick<Job, 'type' | 'status'>[]): string | null`.

- [ ] **Step 1: Write the failing test**

`src/main/services/exportTarget.test.ts`:
```ts
// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTextLayer, makeVideoLayer } from '@shared/layers'
import { exportRefusal, sanitizeExportName, uniqueExportPath } from './exportTarget'

describe('sanitizeExportName', () => {
  it('forces .mp4 and keeps a plain name', () => {
    expect(sanitizeExportName('my cut')).toBe('my cut.mp4')
    expect(sanitizeExportName('my cut.MP4')).toBe('my cut.mp4')
  })

  it('drops any directory part so a name cannot leave the export folder', () => {
    expect(sanitizeExportName('../../evil.mp4')).toBe('evil.mp4')
    expect(sanitizeExportName('C:\\Windows\\x')).toBe('x.mp4')
  })

  it('strips reserved characters and trailing dots/spaces', () => {
    expect(sanitizeExportName('a<b>:c"d|e?f*. ')).toBe('abcdef.mp4')
  })

  it('rejects names that end up empty and guards device names', () => {
    expect(sanitizeExportName('..')).toBeNull()
    expect(sanitizeExportName('   ')).toBeNull()
    expect(sanitizeExportName('CON')).toBe('_CON.mp4')
  })
})

describe('uniqueExportPath', () => {
  it('keeps a free name and numbers collisions', () => {
    const taken = new Set([join('d', 'cut.mp4'), join('d', 'cut (2).mp4')])
    expect(uniqueExportPath('d', 'new.mp4', (p) => taken.has(p))).toBe(join('d', 'new.mp4'))
    expect(uniqueExportPath('d', 'cut.mp4', (p) => taken.has(p))).toBe(join('d', 'cut (3).mp4'))
  })
})

describe('exportRefusal', () => {
  const clip = makeVideoLayer('v', 'm', 0, 3)
  const text = makeTextLayer('t', 0, 2)

  it('allows a project with a video clip and no export running', () => {
    expect(exportRefusal({ layers: [clip] }, [{ type: 'export', status: 'done' }])).toBeNull()
  })

  it('refuses while another export is running', () => {
    expect(exportRefusal({ layers: [clip] }, [{ type: 'export', status: 'running' }])).toMatch(/already running/)
  })

  it('refuses a timeline with no video clips', () => {
    expect(exportRefusal({ layers: [text] }, [])).toMatch(/no video clips/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/services/exportTarget.test.ts`
Expected: FAIL — cannot resolve `./exportTarget`.

- [ ] **Step 3: Implement**

`src/main/services/exportTarget.ts`:
```ts
/**
 * Where an assistant-driven export goes (no Save dialog): a safe single file
 * name inside the export folder, never overwriting an existing file. Pure.
 */

import { join, parse } from 'node:path'
import type { Job } from '@shared/jobs'
import type { Project } from '@shared/project'

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** A model-supplied name → `<stem>.mp4` with no directory part, or null if nothing usable is left. */
export function sanitizeExportName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const stem = base
    .replace(/\.mp4$/i, '')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .replace(/[. ]+$/, '')
    .trim()
  if (!stem || /^\.+$/.test(stem)) return null
  return `${RESERVED.test(stem) ? `_${stem}` : stem}.mp4`
}

/** The first of `name`, `name (2)`, `name (3)`… in `dir` that `exists` reports free. */
export function uniqueExportPath(dir: string, name: string, exists: (path: string) => boolean): string {
  const { name: stem, ext } = parse(name)
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? name : `${stem} (${n})${ext}`)
    if (!exists(candidate)) return candidate
  }
}

/** Why an export must not start now, or null. Same "no clips" guard as the Export button. */
export function exportRefusal(
  project: Pick<Project, 'layers'>,
  jobs: Pick<Job, 'type' | 'status'>[]
): string | null {
  if (jobs.some((j) => j.type === 'export' && j.status === 'running')) {
    return 'An export is already running — wait for it to finish'
  }
  if (!project.layers.some((l) => l.content.kind === 'video')) return 'The timeline has no video clips to export'
  return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/services/exportTarget.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/exportTarget.ts src/main/services/exportTarget.test.ts
git commit -m "feat(assistant): safe export names, unique paths and export refusal reasons

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Bridge protocol types + timeline summary

**Files:**
- Create: `src/shared/assistant/protocol.ts`
- Create: `src/shared/assistant/timelineSummary.ts`, `src/shared/assistant/timelineSummary.test.ts`

**Interfaces:**
- Produces (protocol): `SequenceItem`, `SequencePlan`, `PlacedClip`, `AssistantOps`, `AssistantOp`, `AssistantRequest`, `AssistantResponse`, `AssistantStatus` (exact shapes below).
- Produces (summary): `summarizeTimeline(comp: Composition): TimelineSummary`, `LayerSummary`, `AudioSummary`, `TimelineSummary`.

- [ ] **Step 1: Write the protocol types (no test — types only)**

`src/shared/assistant/protocol.ts`:
```ts
/**
 * The assistant bridge: ops the MCP server (main) asks the renderer to run
 * against the real store, with their argument and result types. One table, so
 * main's `callRenderer` and the renderer's handlers can't drift apart.
 */

import type { Project, TimelineItemRef } from '../project'
import type { TimelineSummary } from './timelineSummary'

/** One clip in a rough cut. In/out are SOURCE seconds. */
export interface SequenceItem {
  mediaId: string
  inSec: number
  outSec: number
  /** Facts the renderer can't look up itself — main fills them from the library. */
  sourceDurationSec: number
  hasAudio: boolean
  aspect?: number
}

export interface SequencePlan {
  items: SequenceItem[]
  /** append: after the current end; replace: clear existing video clips first and start at 0. */
  mode: 'append' | 'replace'
  /** Timeline second to start at (overrides the mode's default). */
  atSec?: number
}

export interface PlacedClip {
  layerId: string
  mediaId: string
  inSec: number
  outSec: number
  startSec: number
  endSec: number
}

type NoArgs = Record<string, never>

export interface AssistantOps {
  getMediaIds: { args: NoArgs; result: string[] }
  addMedia: { args: { ids: string[] }; result: null }
  getTimeline: { args: NoArgs; result: TimelineSummary }
  placeSequence: { args: SequencePlan; result: PlacedClip[] }
  removeItems: { args: { ids: string[] }; result: { removed: TimelineItemRef[] } }
  undo: { args: NoArgs; result: { undone: boolean; timeline: TimelineSummary } }
  getProject: { args: NoArgs; result: Project }
}

export type AssistantOp = keyof AssistantOps

export interface AssistantRequest<K extends AssistantOp = AssistantOp> {
  id: string
  op: K
  args: AssistantOps[K]['args']
}

export type AssistantResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string }

/** What Settings shows about the Claude Code connection. */
export interface AssistantStatus {
  state: 'off' | 'listening' | 'error'
  /** Why, when state is 'error'. */
  message?: string
  /** Absolute path of reel-mcp's built entry (out/main/mcp.js) for the registration command. */
  scriptPath: string
}
```

- [ ] **Step 2: Write the failing summary test**

`src/shared/assistant/timelineSummary.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createEmptyComposition, type AudioClip } from '../project'
import { makeImageLayer, makeVideoLayer } from '../layers'
import { summarizeTimeline } from './timelineSummary'

const audio = (over: Partial<AudioClip>): AudioClip => ({
  id: 'a1',
  mediaId: 'm1',
  startSec: 1,
  inSec: 0,
  outSec: 4,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  kind: 'extracted',
  ...over
})

describe('summarizeTimeline', () => {
  it('lists layers by start time with their source window', () => {
    const comp = {
      ...createEmptyComposition(),
      layers: [makeVideoLayer('v', 'm1', 1, 4), makeImageLayer('i', 'm2', 0, 2)],
      audioClips: [audio({ linkGroupId: 'g' })]
    }
    const s = summarizeTimeline(comp)
    expect(s.layers.map((l) => l.id)).toEqual(['i', 'v'])
    expect(s.layers[1]).toEqual({ id: 'v', kind: 'video', startSec: 1, endSec: 5, hidden: false, mediaId: 'm1', inSec: 0, outSec: 4 })
    expect(s.layers[0]).toMatchObject({ id: 'i', kind: 'image', mediaId: 'm2' })
    expect(s.audioClips).toEqual([{ id: 'a1', mediaId: 'm1', startSec: 1, endSec: 5, inSec: 0, outSec: 4, linkGroupId: 'g' }])
    expect(s.durationSec).toBe(5)
  })

  it('reports a whole-source audio clip with an open end', () => {
    const s = summarizeTimeline({ ...createEmptyComposition(), audioClips: [audio({ outSec: 0 })] })
    expect(s.audioClips[0]).toMatchObject({ endSec: null, outSec: null })
  })

  it('rounds to milliseconds', () => {
    const v = makeVideoLayer('v', 'm1', 0.123456, 1)
    expect(summarizeTimeline({ ...createEmptyComposition(), layers: [v] }).layers[0].startSec).toBe(0.123)
  })

  it('summarises an empty timeline', () => {
    expect(summarizeTimeline(createEmptyComposition())).toEqual({ durationSec: 0, layers: [], audioClips: [] })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/shared/assistant/timelineSummary.test.ts`
Expected: FAIL — cannot resolve `./timelineSummary`.

- [ ] **Step 4: Implement**

`src/shared/assistant/timelineSummary.ts`:
```ts
/**
 * A composition as compact JSON for the AI assistant (`get_timeline`). Layers
 * are listed by start time (not stack order); captions are left out. Pure.
 */

import type { Composition, Layer } from '../project'
import { audioClipEnd } from '../project'
import { visualDuration } from '../layers'

export interface LayerSummary {
  id: string
  kind: Layer['content']['kind']
  startSec: number
  endSec: number
  hidden: boolean
  mediaId?: string
  /** Source window (video only). */
  inSec?: number
  outSec?: number
  text?: string
  linkGroupId?: string
}

export interface AudioSummary {
  id: string
  mediaId: string
  startSec: number
  /** null = plays to the end of its source. */
  endSec: number | null
  inSec: number
  outSec: number | null
  linkGroupId?: string
}

export interface TimelineSummary {
  durationSec: number
  layers: LayerSummary[]
  audioClips: AudioSummary[]
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000

function layerSummary(l: Layer): LayerSummary {
  const s: LayerSummary = { id: l.id, kind: l.content.kind, startSec: r3(l.startSec), endSec: r3(l.endSec), hidden: l.hidden }
  const c = l.content
  if (c.kind === 'video') Object.assign(s, { mediaId: c.mediaId, inSec: r3(c.inSec), outSec: r3(c.outSec) })
  else if (c.kind === 'image') s.mediaId = c.mediaId
  else if (c.kind === 'text') s.text = c.text
  if (l.linkGroupId) s.linkGroupId = l.linkGroupId
  return s
}

export function summarizeTimeline(comp: Composition): TimelineSummary {
  const layers = [...comp.layers].sort((a, b) => a.startSec - b.startSec).map(layerSummary)
  const audioClips: AudioSummary[] = comp.audioClips.map((c) => {
    const bounded = c.outSec > 0
    const a: AudioSummary = {
      id: c.id,
      mediaId: c.mediaId,
      startSec: r3(c.startSec),
      endSec: bounded ? r3(audioClipEnd(c, Infinity)) : null,
      inSec: r3(c.inSec),
      outSec: bounded ? r3(c.outSec) : null
    }
    if (c.linkGroupId) a.linkGroupId = c.linkGroupId
    return a
  })
  const audioEnd = audioClips.reduce((m, a) => Math.max(m, a.endSec ?? 0), 0)
  return { durationSec: r3(Math.max(visualDuration(comp.layers), audioEnd)), layers, audioClips }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/shared/assistant/timelineSummary.test.ts` then `npm run typecheck`
Expected: PASS (4 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/assistant/protocol.ts src/shared/assistant/timelineSummary.ts src/shared/assistant/timelineSummary.test.ts
git commit -m "feat(assistant): bridge protocol types and timeline summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Sequence builder + `addVideoSequence` store action

**Files:**
- Create: `src/renderer/src/lib/sequence.ts`, `src/renderer/src/lib/sequence.test.ts`
- Modify: `src/renderer/src/state/projectStore.ts` (interface near line 183; `addVideoLayer` near line 508; add the new action after it)

**Interfaces:**
- Consumes: `SequencePlan`, `PlacedClip` (Task 5); `makeVideoLayer`, `visualDuration`, `playedVideoDuration` (`@shared/layers`); `trimVideoStart`, `trimVideoEnd` (`lib/timeline.ts`); `expandSelection`, `removeItems` (`lib/links.ts`).
- Produces: `MIN_SEQUENCE_ITEM_SEC = 0.1`; `makeExtractedAudioClip(id, mediaId, startSec, inSec, outSec, linkGroupId): AudioClip`; `applySequence(comp: Composition, plan: SequencePlan, ctx: { frame: FrameRect; newId: () => string }): { comp: Composition; placed: PlacedClip[] }`; store action `addVideoSequence(plan: SequencePlan): PlacedClip[]` (throws, changing nothing, on a bad item or no project).

- [ ] **Step 1: Write the failing test**

`src/renderer/src/lib/sequence.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createEmptyComposition, type VideoContent } from '@shared/project'
import { centeredFrame } from '@shared/frame'
import { makeImageLayer, playedVideoDuration } from '@shared/layers'
import type { SequenceItem } from '@shared/assistant/protocol'
import { applySequence } from './sequence'

const ctx = () => {
  let n = 0
  return { frame: centeredFrame(1080, 1920), newId: () => `id${++n}` }
}
const item = (mediaId: string, inSec: number, outSec: number, extra: Partial<SequenceItem> = {}): SequenceItem => ({
  mediaId,
  inSec,
  outSec,
  sourceDurationSec: 20,
  hasAudio: true,
  aspect: 9 / 16,
  ...extra
})
const content = (l: { content: unknown }) => l.content as VideoContent

describe('applySequence', () => {
  it('lays items end-to-end in the given order from 0 on an empty timeline', () => {
    const { comp, placed } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 2, 5), item('b', 10, 11.5)] }, ctx())
    expect(placed.map((p) => [p.mediaId, p.startSec, p.endSec])).toEqual([['a', 0, 3], ['b', 3, 4.5]])
    expect(comp.layers.map((l) => [content(l).inSec, content(l).outSec])).toEqual([[2, 5], [10, 11.5]])
  })

  it("keeps every layer's window equal to its played duration", () => {
    const { comp } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 1.25, 7.5), item('b', 0, 3)] }, ctx())
    for (const l of comp.layers) expect(l.endSec - l.startSec).toBeCloseTo(playedVideoDuration(content(l)), 9)
  })

  it('appends after the current end of the timeline', () => {
    const first = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 3)] }, ctx()).comp
    const { placed } = applySequence(first, { mode: 'append', items: [item('b', 0, 2)] }, ctx())
    expect(placed[0]).toMatchObject({ startSec: 3, endSec: 5 })
  })

  it('starts at atSec when given', () => {
    const { placed } = applySequence(createEmptyComposition(), { mode: 'append', atSec: 7, items: [item('a', 0, 1)] }, ctx())
    expect(placed[0]).toMatchObject({ startSec: 7, endSec: 8 })
  })

  it('replace removes existing video clips and their linked audio, keeps other layers, and starts at 0', () => {
    const first = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 3)] }, ctx()).comp
    const withImage = { ...first, layers: [...first.layers, makeImageLayer('img', 'pic', 0, 2)] }
    const { comp, placed } = applySequence(withImage, { mode: 'replace', items: [item('b', 0, 2)] }, ctx())
    expect(comp.layers.map((l) => l.content.kind).sort()).toEqual(['image', 'video'])
    expect(comp.audioClips.map((a) => a.mediaId)).toEqual(['b'])
    expect(placed[0]).toMatchObject({ mediaId: 'b', startSec: 0 })
  })

  it('clamps in/out to the source', () => {
    const { placed } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', -1, 99)] }, ctx())
    expect(placed[0]).toMatchObject({ inSec: 0, outSec: 20, startSec: 0, endSec: 20 })
  })

  it('rejects an item that clamps to (almost) nothing, naming it', () => {
    expect(() => applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 1), item('b', 25, 30)] }, ctx())).toThrow(/item 1 \(b\)/)
  })

  it('rejects a reversed item without touching the input composition', () => {
    const start = createEmptyComposition()
    expect(() => applySequence(start, { mode: 'append', items: [item('a', 5, 2)] }, ctx())).toThrow(/item 0/)
    expect(start.layers).toEqual([])
  })

  it('links a matching extracted audio clip for sources with audio', () => {
    const { comp } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 2, 5)] }, ctx())
    const [layer] = comp.layers
    const [clip] = comp.audioClips
    expect(content(layer).mute).toBe(true)
    expect(clip).toMatchObject({ mediaId: 'a', startSec: layer.startSec, inSec: 2, outSec: 5, kind: 'extracted' })
    expect(clip.linkGroupId).toBeDefined()
    expect(clip.linkGroupId).toBe(layer.linkGroupId)
  })

  it('adds no audio and leaves the clip unmuted when the source is silent', () => {
    const { comp } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 2, { hasAudio: false })] }, ctx())
    expect(comp.audioClips).toEqual([])
    expect(content(comp.layers[0]).mute).toBe(false)
    expect(comp.layers[0].linkGroupId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/lib/sequence.test.ts`
Expected: FAIL — cannot resolve `./sequence`.

- [ ] **Step 3: Implement `lib/sequence.ts`**

`src/renderer/src/lib/sequence.ts`:
```ts
/**
 * Lay library clips end-to-end as ONE edit — the assistant's rough-cut
 * primitive (`place_sequence`). Pure. Layers come from the shared constructor
 * and are trimmed through `trimVideoStart`/`trimVideoEnd`, so the
 * source↔timeline mapping is never re-derived here (CLAUDE.md).
 */

import type { AudioClip, Composition, Layer, VideoContent } from '@shared/project'
import type { FrameRect } from '@shared/frame'
import type { PlacedClip, SequencePlan } from '@shared/assistant/protocol'
import { makeVideoLayer, visualDuration } from '@shared/layers'
import { trimVideoEnd, trimVideoStart } from './timeline'
import { expandSelection, removeItems } from './links'

/** Shortest source span an item may keep (seconds). */
export const MIN_SEQUENCE_ITEM_SEC = 0.1

export interface SequenceCtx {
  frame: FrameRect
  newId: () => string
}

/** The audio a video drop pulls off its source, linked to the clip. One
 *  definition, shared with `addVideoLayer`. */
export function makeExtractedAudioClip(
  id: string,
  mediaId: string,
  startSec: number,
  inSec: number,
  outSec: number,
  linkGroupId: string
): AudioClip {
  return { id, mediaId, startSec, inSec, outSec, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, duck: false, linkGroupId, kind: 'extracted' }
}

export function applySequence(
  comp: Composition,
  plan: SequencePlan,
  ctx: SequenceCtx
): { comp: Composition; placed: PlacedClip[] } {
  const base =
    plan.mode === 'replace'
      ? removeItems(
          comp,
          expandSelection(
            comp,
            comp.layers.filter((l) => l.content.kind === 'video').map((l) => ({ kind: 'layer' as const, id: l.id }))
          )
        )
      : comp
  let cursor = Math.max(0, plan.atSec ?? (plan.mode === 'replace' ? 0 : visualDuration(base.layers)))
  const layers: Layer[] = []
  const audioClips: AudioClip[] = []
  const placed: PlacedClip[] = []

  plan.items.forEach((item, i) => {
    const src = item.sourceDurationSec
    const inSec = Math.min(Math.max(0, item.inSec), src)
    const outSec = Math.min(Math.max(0, item.outSec), src)
    if (outSec - inSec < MIN_SEQUENCE_ITEM_SEC) {
      throw new Error(
        `item ${i} (${item.mediaId}): ${item.inSec}–${item.outSec}s leaves less than ${MIN_SEQUENCE_ITEM_SEC}s of a ${src.toFixed(2)}s source`
      )
    }
    const id = ctx.newId()
    const full = makeVideoLayer(id, item.mediaId, 0, src, { mute: item.hasAudio, frame: ctx.frame, aspect: item.aspect })
    const tail = trimVideoEnd(full, full.content as VideoContent, outSec)
    const trimmed = trimVideoStart(tail, tail.content as VideoContent, inSec)
    // The trims leave the window where the source sits; slide it to the cursor.
    const shift = cursor - trimmed.startSec
    let layer: Layer = { ...trimmed, startSec: trimmed.startSec + shift, endSec: trimmed.endSec + shift }
    if (item.hasAudio) {
      const group = ctx.newId()
      layer = { ...layer, linkGroupId: group }
      audioClips.push(makeExtractedAudioClip(ctx.newId(), item.mediaId, layer.startSec, inSec, outSec, group))
    }
    layers.push(layer)
    placed.push({ layerId: id, mediaId: item.mediaId, inSec, outSec, startSec: layer.startSec, endSec: layer.endSec })
    cursor = layer.endSec
  })

  return {
    comp: { ...base, layers: [...base.layers, ...layers], audioClips: [...base.audioClips, ...audioClips] },
    placed
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/lib/sequence.test.ts`
Expected: PASS (10 tests). If `clamps in/out to the source` fails on `endSec`, check `makeVideoLayer` still sets `outSec: durationSec` (`src/shared/layers.ts` ~line 517) — the trims depend on the full-source starting layer.

- [ ] **Step 5: Add the store action and reuse the audio helper in `addVideoLayer`**

In `src/renderer/src/state/projectStore.ts`:

1. Add imports below `import * as links from '@/lib/links'`:
```ts
import { applySequence, makeExtractedAudioClip } from '@/lib/sequence'
import type { PlacedClip, SequencePlan } from '@shared/assistant/protocol'
```

2. In the `ProjectState` interface, directly after the `addVideoLayer: (...) => void` declaration, add:
```ts
  /** Lay `plan.items` end-to-end (the assistant's `place_sequence`) as ONE
   *  undo step and return what was placed. Throws — changing nothing — when
   *  there is no project or an item is unusable. */
  addVideoSequence: (plan: SequencePlan) => PlacedClip[]
```

3. In `addVideoLayer`'s implementation, replace the inline audio-clip object literal (the `{ id: newId(), mediaId, startSec, inSec: 0, outSec: Math.max(0.1, durationSec), … kind: 'extracted' as const }` inside `audioClips: hasAudio ? [...]`) with:
```ts
              makeExtractedAudioClip(newId(), mediaId, startSec, 0, Math.max(0.1, durationSec), linkGroupId!)
```
(`linkGroupId` is always set when `hasAudio` is true; the `!` states that.)

4. Directly after the `addVideoLayer: …` implementation, add:
```ts
    addVideoSequence: (plan) => {
      const comp = activeComp(get())
      if (!comp) throw new Error('Editor has no project open')
      // Build first (throws on a bad item before anything is committed), then
      // commit the finished composition as a single history entry.
      const result = applySequence(comp, plan, { frame: projectFormat(get()).frame, newId })
      commitComp(() => result.comp)
      return result.placed
    },
```

- [ ] **Step 6: Run the whole suite + typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all PASS; typecheck clean (the `addVideoLayer` refactor is behavior-preserving; `e2e/link.spec.ts` covers it end-to-end in Task 14's full e2e run).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/sequence.ts src/renderer/src/lib/sequence.test.ts src/renderer/src/state/projectStore.ts
git commit -m "feat(assistant): applySequence + addVideoSequence store action (one undo step)

addVideoLayer now builds its linked audio through the shared
makeExtractedAudioClip so the two paths can't drift.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Assistant settings

**Files:**
- Modify: `src/shared/settings.ts`
- Create: `src/shared/settings.test.ts`
- Modify: `src/main/services/settings.ts`

**Interfaces:**
- Produces: `AssistantSettings { enabled: boolean }`; `Settings.assistant: AssistantSettings`; `withAssistantDefaults(loaded: Partial<AssistantSettings> | undefined): AssistantSettings`; `mcpAddCommand(scriptPath: string): string`.

- [ ] **Step 1: Write the failing test**

`src/shared/settings.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mcpAddCommand, withAssistantDefaults } from './settings'

describe('withAssistantDefaults', () => {
  it('turns the assistant on when nothing is stored', () => {
    expect(withAssistantDefaults(undefined)).toEqual({ enabled: true })
    expect(withAssistantDefaults({})).toEqual({ enabled: true })
  })

  it('keeps a stored choice', () => {
    expect(withAssistantDefaults({ enabled: false })).toEqual({ enabled: false })
  })
})

describe('mcpAddCommand', () => {
  it('is the one-time user-scope registration line', () => {
    expect(mcpAddCommand('C:\\code\\video_editor\\out\\main\\mcp.js')).toBe(
      'claude mcp add --scope user reel-editor -- node "C:\\code\\video_editor\\out\\main\\mcp.js"'
    )
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/shared/settings.test.ts`
Expected: FAIL — `withAssistantDefaults` is not exported.

- [ ] **Step 3: Implement the shared part**

In `src/shared/settings.ts`, add to the `Settings` interface (after `brandColors`):
```ts
  /** Claude Code connection (AI assistant). */
  assistant: AssistantSettings
```
and add below the interface:
```ts
export interface AssistantSettings {
  /** Serve Claude Code over the named pipe (on by default; Settings can switch it off). */
  enabled: boolean
}

export function withAssistantDefaults(loaded: Partial<AssistantSettings> | undefined): AssistantSettings {
  return { enabled: typeof loaded?.enabled === 'boolean' ? loaded.enabled : true }
}

/** The one-time registration line Settings shows. `scriptPath` = absolute path of out/main/mcp.js. */
export function mcpAddCommand(scriptPath: string): string {
  return `claude mcp add --scope user reel-editor -- node "${scriptPath}"`
}
```

- [ ] **Step 4: Implement the main part**

In `src/main/services/settings.ts`, add `withAssistantDefaults` to the `@shared/settings` import, and add one property to the `cache = { … }` object in `getSettings`:
```ts
    assistant: withAssistantDefaults(loaded.assistant)
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/shared/settings.test.ts` then `npm test` then `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/settings.ts src/shared/settings.test.ts src/main/services/settings.ts
git commit -m "feat(assistant): assistant on/off setting and registration command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Renderer bridge (main ⇄ renderer request/response)

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/ipc/client.ts`, `src/renderer/src/main.tsx`, `src/main/ipc.ts`
- Create: `src/main/assistant/bridge.ts`, `src/renderer/src/assistant/handlers.ts`

**Interfaces:**
- Consumes: `AssistantOps`, `AssistantRequest`, `AssistantResponse`, `AssistantStatus` (Task 5); `summarizeTimeline` (Task 5); `addVideoSequence` (Task 6); `expandSelection`, `timelineTiles` (`lib/links.ts`).
- Produces: `registerAssistantBridge(): void` and `callRenderer<K extends AssistantOp>(op: K, args: AssistantOps[K]['args']): Promise<AssistantOps[K]['result']>` (main); `installAssistantBridge(): () => void` (renderer); preload `onAssistantRequest`, `assistantRespond`, `assistantStatus`; channel names `IPC.assistantResponse = 'assistant:response'`, `IPC.assistantStatus = 'assistant:status'`, `IPC_EVENT.assistantRequest = 'assistant:request'`.

- [ ] **Step 1: Channel names**

In `src/shared/ipc.ts`, add a comma after the last `IPC` entry (`captureStillToDisk: 'still:toDisk'`) and then:
```ts
  // AI assistant: main ⇄ renderer bridge + status for Settings
  assistantResponse: 'assistant:response',
  assistantStatus: 'assistant:status'
```
And make `IPC_EVENT`:
```ts
export const IPC_EVENT = {
  jobProgress: 'job:progress',
  assistantRequest: 'assistant:request'
} as const
```

- [ ] **Step 2: Preload surface**

In `src/preload/index.ts` add:
```ts
import type { AssistantRequest, AssistantResponse, AssistantStatus } from '@shared/assistant/protocol'
```
and add these properties to the `api` object after `onJobProgress` (put a comma after `onJobProgress`'s closing brace):
```ts
  // AI assistant: main asks the renderer to run store ops; the renderer answers.
  onAssistantRequest: (cb: (req: AssistantRequest) => void): (() => void) => {
    const handler = (_e: unknown, req: AssistantRequest): void => cb(req)
    ipcRenderer.on(IPC_EVENT.assistantRequest, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.assistantRequest, handler)
  },
  assistantRespond: (res: AssistantResponse): void => ipcRenderer.send(IPC.assistantResponse, res),
  assistantStatus: (): Promise<AssistantStatus> => ipcRenderer.invoke(IPC.assistantStatus)
```

In `src/renderer/src/ipc/client.ts`, add `onAssistantRequest`, `assistantRespond`, `assistantStatus` to the destructure list (after `onJobProgress`).

- [ ] **Step 3: Main half**

`src/main/assistant/bridge.ts`:
```ts
/**
 * Main half of the assistant bridge: ask the renderer to run a store op and
 * await its answer. Edits must run in the renderer — that is where the store,
 * its undo history and its invariants live.
 */

import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC, IPC_EVENT } from '@shared/ipc'
import type { AssistantOp, AssistantOps, AssistantRequest, AssistantResponse } from '@shared/assistant/protocol'

export const RENDERER_TIMEOUT_MS = 10_000

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}
const pending = new Map<string, Pending>()

/** Listen for renderer answers. Call once, from registerIpcHandlers. */
export function registerAssistantBridge(): void {
  ipcMain.on(IPC.assistantResponse, (_e, res: AssistantResponse) => {
    const p = pending.get(res.id)
    if (!p) return
    pending.delete(res.id)
    clearTimeout(p.timer)
    if (res.ok) p.resolve(res.result)
    else p.reject(new Error(res.error))
  })
}

/** The editor window (the first one created). */
function editorWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed())
    .sort((a, b) => a.id - b.id)[0]
}

export function callRenderer<K extends AssistantOp>(
  op: K,
  args: AssistantOps[K]['args']
): Promise<AssistantOps[K]['result']> {
  const win = editorWindow()
  if (!win) return Promise.reject(new Error('The editor window is not open'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`The editor did not answer "${op}" within ${RENDERER_TIMEOUT_MS / 1000}s`))
    }, RENDERER_TIMEOUT_MS)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    const req: AssistantRequest<K> = { id, op, args }
    win.webContents.send(IPC_EVENT.assistantRequest, req)
  })
}
```

In `src/main/ipc.ts`: import `registerAssistantBridge` from `./assistant/bridge` and call it as the first line inside `registerIpcHandlers()`.

- [ ] **Step 4: Renderer half**

`src/renderer/src/assistant/handlers.ts`:
```ts
/**
 * Renderer half of the assistant bridge: run each op against the REAL store
 * actions (the same calls the UI makes), so undo, links and source-time
 * mapping behave exactly as for a human edit. No React.
 */

import type { AssistantOps, AssistantRequest, AssistantResponse } from '@shared/assistant/protocol'
import type { Composition, Project } from '@shared/project'
import { summarizeTimeline } from '@shared/assistant/timelineSummary'
import { activeComp, useProject } from '@/state/projectStore'
import { expandSelection, timelineTiles } from '@/lib/links'
import { assistantRespond, onAssistantRequest } from '@/ipc/client'

type Handlers = { [K in keyof AssistantOps]: (args: AssistantOps[K]['args']) => AssistantOps[K]['result'] }

function project(): Project {
  const p = useProject.getState().project
  if (!p) throw new Error('Editor has no project open')
  return p
}

function comp(): Composition {
  const c = activeComp(useProject.getState())
  if (!c) throw new Error('Editor has no project open')
  return c
}

const handlers: Handlers = {
  getMediaIds: () => project().mediaIds,
  addMedia: ({ ids }) => {
    useProject.getState().addMedia(ids)
    return null
  },
  getTimeline: () => summarizeTimeline(comp()),
  placeSequence: (plan) => useProject.getState().addVideoSequence(plan),
  removeItems: ({ ids }) => {
    const c = comp()
    const tiles = timelineTiles(c)
    const unknown = ids.filter((id) => !tiles.some((t) => t.ref.id === id))
    if (unknown.length) throw new Error(`No timeline item with id ${unknown.join(', ')}`)
    const refs = expandSelection(c, tiles.filter((t) => ids.includes(t.ref.id)).map((t) => t.ref))
    useProject.getState().removeItems(refs)
    return { removed: refs }
  },
  undo: () => {
    const before = useProject.getState().past.length
    useProject.getState().undo()
    return { undone: useProject.getState().past.length < before, timeline: summarizeTimeline(comp()) }
  },
  getProject: () => project()
}

export function installAssistantBridge(): () => void {
  return onAssistantRequest((req: AssistantRequest) => {
    let res: AssistantResponse
    try {
      // The table is keyed by op, so this lookup is type-safe; widen it to call generically.
      const run = handlers[req.op] as unknown as (args: unknown) => unknown
      res = { id: req.id, ok: true, result: run(req.args) }
    } catch (e) {
      res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    assistantRespond(res)
  })
}
```

In `src/renderer/src/main.tsx`, add `import { installAssistantBridge } from './assistant/handlers'` with the other imports, and call `installAssistantBridge()` directly after the `window.__reelStores = { … }` assignment.

The `assistantStatus` IPC handler itself is added in Task 12 (its service doesn't exist yet); until then the preload method is simply unused.

- [ ] **Step 5: Typecheck + tests**

Run: `npm run typecheck` then `npm test`
Expected: clean / PASS. (Behavior is exercised end-to-end in Task 14.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/renderer/src/ipc/client.ts src/main/assistant/bridge.ts src/main/ipc.ts src/renderer/src/assistant/handlers.ts src/renderer/src/main.tsx
git commit -m "feat(assistant): main<->renderer request/response bridge over store actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Pipe protocol + pipe transport

**Files:**
- Create: `src/shared/assistant/pipeProtocol.ts`, `src/shared/assistant/pipeProtocol.test.ts`
- Create: `src/main/assistant/pipe.ts`, `src/main/assistant/pipe.test.ts`

**Interfaces:**
- Produces (protocol): `ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }`; `PipeRequest { id: string; tool: string; args: unknown }`; `PipeResponse = { id; ok: true; content: ToolContent[] } | { id; ok: false; error: string }`; `PIPE_NAME = 'reel-editor'`; `defaultPipePath(platform: string, tmpDir: string): string`; `encodeLine(msg: unknown): string`; `class LineDecoder { push(chunk: string): unknown[] }`.
- Produces (transport): `type PipeHandler = (tool: string, args: unknown) => Promise<ToolContent[]>`; `servePipe(path: string, handle: PipeHandler): Promise<{ ok: true; server: net.Server } | { ok: false; message: string }>`; `callPipe(path: string, tool: string, args: unknown): Promise<ToolContent[]>`; constants `NOT_RUNNING`, `IN_USE`.

- [ ] **Step 1: Write the failing protocol test**

`src/shared/assistant/pipeProtocol.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { LineDecoder, defaultPipePath, encodeLine } from './pipeProtocol'

describe('LineDecoder', () => {
  it('returns whole messages across split chunks', () => {
    const d = new LineDecoder()
    expect(d.push('{"a":')).toEqual([])
    expect(d.push('1}\n{"b"')).toEqual([{ a: 1 }])
    expect(d.push(':2}\n')).toEqual([{ b: 2 }])
  })

  it('returns several messages from one chunk and skips blank lines', () => {
    expect(new LineDecoder().push('{"a":1}\n\n{"a":2}\r\n')).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('round-trips encodeLine, including newlines inside strings', () => {
    const msg = { text: 'two\nlines', n: 3 }
    expect(new LineDecoder().push(encodeLine(msg))).toEqual([msg])
  })
})

describe('defaultPipePath', () => {
  it('is a named pipe on Windows and a socket file elsewhere', () => {
    expect(defaultPipePath('win32', 'C:\\Temp')).toBe('\\\\.\\pipe\\reel-editor')
    expect(defaultPipePath('linux', '/tmp/')).toBe('/tmp/reel-editor.sock')
  })
})
```

- [ ] **Step 2: Write the failing transport test**

`src/main/assistant/pipe.test.ts`:
```ts
// @vitest-environment node
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IN_USE, NOT_RUNNING, callPipe, servePipe } from './pipe'

let n = 0
const uniquePipe = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\reel-test-${process.pid}-${++n}`
    : join(tmpdir(), `reel-test-${process.pid}-${++n}.sock`)

const servers: net.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

async function serve(path: string, handle: Parameters<typeof servePipe>[1]): Promise<void> {
  const r = await servePipe(path, handle)
  if (!r.ok) throw new Error(r.message)
  servers.push(r.server)
}

describe('servePipe + callPipe', () => {
  it('round-trips a call with text and image content', async () => {
    const path = uniquePipe()
    await serve(path, async (tool, args) => [
      { type: 'text', text: `${tool}:${JSON.stringify(args)}` },
      { type: 'image', data: Buffer.alloc(5000, 7).toString('base64'), mimeType: 'image/jpeg' }
    ])
    const content = await callPipe(path, 'get_frames', { mediaId: 'm', count: 2 })
    expect(content[0]).toEqual({ type: 'text', text: 'get_frames:{"mediaId":"m","count":2}' })
    expect(content[1].type === 'image' && Buffer.from(content[1].data, 'base64').equals(Buffer.alloc(5000, 7))).toBe(true)
  })

  it("passes a handler's error back as the call's error", async () => {
    const path = uniquePipe()
    await serve(path, async () => {
      throw new Error('No media "x" in this project')
    })
    await expect(callPipe(path, 'get_transcript', {})).rejects.toThrow('No media "x" in this project')
  })

  it('says plainly when nothing is serving the pipe', async () => {
    await expect(callPipe(uniquePipe(), 'list_media', {})).rejects.toThrow(NOT_RUNNING)
  })

  it('answers two concurrent calls independently', async () => {
    const path = uniquePipe()
    await serve(path, async (tool) => {
      await new Promise((r) => setTimeout(r, tool === 'slow' ? 200 : 10))
      return [{ type: 'text', text: tool }]
    })
    const [slow, fast] = await Promise.all([callPipe(path, 'slow', {}), callPipe(path, 'fast', {})])
    expect(slow).toEqual([{ type: 'text', text: 'slow' }])
    expect(fast).toEqual([{ type: 'text', text: 'fast' }])
  })

  it('reports a pipe that another editor already serves', async () => {
    const path = uniquePipe()
    await serve(path, async () => [])
    expect(await servePipe(path, async () => [])).toEqual({ ok: false, message: IN_USE })
  })

  it('reports an editor that hangs up without answering', async () => {
    const path = uniquePipe()
    const rude = net.createServer((sock) => sock.destroy())
    await new Promise<void>((r) => rude.listen(path, r))
    servers.push(rude)
    await expect(callPipe(path, 'list_media', {})).rejects.toThrow(/closed the connection before answering/)
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/shared/assistant/pipeProtocol.test.ts src/main/assistant/pipe.test.ts`
Expected: FAIL — cannot resolve `./pipeProtocol` / `./pipe`.

- [ ] **Step 4: Implement the protocol**

`src/shared/assistant/pipeProtocol.ts`:
```ts
/**
 * Wire format between reel-mcp (the stdio MCP server Claude Code launches) and
 * the running editor: one JSON object per line over a named pipe. One
 * connection per tool call. Pure.
 */

/** MCP content blocks, passed straight through to Claude Code. */
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface PipeRequest {
  id: string
  tool: string
  args: unknown
}

export type PipeResponse = { id: string; ok: true; content: ToolContent[] } | { id: string; ok: false; error: string }

export const PIPE_NAME = 'reel-editor'

/** Where the editor listens: a Windows named pipe; a unix socket elsewhere (untested). */
export function defaultPipePath(platform: string, tmpDir: string): string {
  return platform === 'win32' ? `\\\\.\\pipe\\${PIPE_NAME}` : `${tmpDir.replace(/[\\/]+$/, '')}/${PIPE_NAME}.sock`
}

/** JSON.stringify escapes newlines inside strings, so one message is always one line. */
export const encodeLine = (msg: unknown): string => `${JSON.stringify(msg)}\n`

/** Incremental JSON-lines decoder: feed chunks, get whole messages back. Throws on a malformed line. */
export class LineDecoder {
  private buf = ''

  push(chunk: string): unknown[] {
    this.buf += chunk
    const out: unknown[] = []
    let nl = this.buf.indexOf('\n')
    while (nl !== -1) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) out.push(JSON.parse(line))
      nl = this.buf.indexOf('\n')
    }
    return out
  }
}
```

- [ ] **Step 5: Implement the transport**

`src/main/assistant/pipe.ts`:
```ts
/**
 * The named pipe between reel-mcp and the editor. One connection per tool call:
 * one request line in, one response line out; a long call (export) just keeps
 * its connection open. No Electron imports — reel-mcp uses `callPipe`, and this
 * file is unit-tested against a real pipe.
 *
 * Why a pipe rather than local HTTP: an MCP-aware filter on the owner's machine
 * corrupts local plain-HTTP MCP traffic (design spec, "Why not local HTTP");
 * pipes and stdio are not network traffic and were verified unaffected.
 */

import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { LineDecoder, encodeLine, type PipeRequest, type PipeResponse, type ToolContent } from '@shared/assistant/pipeProtocol'

export type PipeHandler = (tool: string, args: unknown) => Promise<ToolContent[]>

export const NOT_RUNNING =
  "Reel Editor isn't running, or its AI assistant is switched off in Settings. Open it and try again."
export const IN_USE = 'Another copy of the editor is already connected to Claude Code'

export function servePipe(
  path: string,
  handle: PipeHandler
): Promise<{ ok: true; server: net.Server } | { ok: false; message: string }> {
  const server = net.createServer((sock) => {
    const decoder = new LineDecoder()
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      let msgs: unknown[]
      try {
        msgs = decoder.push(chunk)
      } catch {
        sock.end(encodeLine({ id: '', ok: false, error: 'Malformed request' } satisfies PipeResponse))
        return
      }
      for (const m of msgs) void answer(sock, m as PipeRequest, handle)
    })
    // The caller went away mid-call (e.g. Claude Code cancelled); nobody to tell.
    sock.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      resolve({ ok: false, message: err.code === 'EADDRINUSE' ? IN_USE : err.message })
    )
    server.listen(path, () => resolve({ ok: true, server }))
  })
}

async function answer(sock: net.Socket, req: PipeRequest, handle: PipeHandler): Promise<void> {
  let res: PipeResponse
  try {
    res = { id: req.id, ok: true, content: await handle(req.tool, req.args) }
  } catch (e) {
    res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!sock.destroyed) sock.end(encodeLine(res))
}

export function callPipe(path: string, tool: string, args: unknown): Promise<ToolContent[]> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const decoder = new LineDecoder()
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    const sock = net.connect(path)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(encodeLine({ id, tool, args } satisfies PipeRequest)))
    sock.on('data', (chunk: string) => {
      let msgs: unknown[]
      try {
        msgs = decoder.push(chunk)
      } catch {
        settle(() => reject(new Error('Reel Editor sent a malformed answer')))
        sock.destroy()
        return
      }
      const res = msgs.find((m) => (m as PipeResponse).id === id) as PipeResponse | undefined
      if (!res) return
      settle(() => (res.ok ? resolve(res.content) : reject(new Error(res.error))))
      sock.end()
    })
    sock.on('error', (err: NodeJS.ErrnoException) =>
      settle(() => reject(new Error(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? NOT_RUNNING : err.message)))
    )
    sock.on('close', () => settle(() => reject(new Error('Reel Editor closed the connection before answering'))))
  })
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/shared/assistant/pipeProtocol.test.ts src/main/assistant/pipe.test.ts` then `npm run typecheck`
Expected: PASS (4 + 6 tests); typecheck clean. If `reports a pipe that another editor already serves` fails because Windows allowed the second `listen`, stop and report it — the IN_USE guarantee then needs a different mechanism (do not weaken the test).

- [ ] **Step 7: Commit**

```bash
git add src/shared/assistant/pipeProtocol.ts src/shared/assistant/pipeProtocol.test.ts src/main/assistant/pipe.ts src/main/assistant/pipe.test.ts
git commit -m "feat(assistant): JSON-lines named-pipe transport between reel-mcp and the editor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Tool handlers (editor side)

**Files:**
- Create: `src/shared/assistant/toolArgs.ts`
- Create: `src/main/services/importMany.ts` (moved from `src/main/ipc.ts`)
- Modify: `src/main/ipc.ts`
- Create: `src/main/assistant/tools.ts`

**Interfaces:**
- Consumes: `callRenderer` (Task 8); `ToolContent` (Task 9); `transcriptPhraseText`, `transcriptWordText`, `frameTimes` (Task 1); `fileFeatureRequest` (Task 3); `sanitizeExportName`, `uniqueExportPath`, `exportRefusal` (Task 4); `SequenceItem` (Task 5); existing `getProjectMedia`, `ensureProxy` (`services/mediaStore`), `getTranscript`, `transcribeMedia`, `whisperAvailable` (`services/whisper`), `generateStill` (`services/still`), `hdrToSdrChain` (`services/proxy`), `exportProject`, `suggestedExportName` (`services/exporter`), `listJobs` (`services/jobs`), `getSettings`, `getSubdir`, `alphaInputDecoder`, `assetAspect`, `assetKind` (`@shared/media`).
- Produces: `ToolArgs` (interface: tool name → args), `ToolName = keyof ToolArgs`; `importMany(paths: string[]): Promise<MediaAsset[]>`; `toolHandlers` (one per `ToolName`); `handleTool(tool: string, args: unknown): Promise<ToolContent[]>` (a `PipeHandler`).

- [ ] **Step 1: Tool argument types**

`src/shared/assistant/toolArgs.ts`:
```ts
/**
 * Argument shape of each assistant tool. reel-mcp's zod schemas must produce
 * these (checked at compile time where it forwards a call) and the editor's
 * handlers consume them. Types only.
 */

type NoArgs = Record<string, never>

export interface ToolArgs {
  list_media: NoArgs
  import_media: { paths: string[] }
  get_transcript: { mediaId: string; fromSec?: number; toSec?: number; words?: boolean }
  get_frames: { mediaId: string; times?: number[]; count?: number }
  get_timeline: NoArgs
  place_sequence: {
    items: { mediaId: string; inSec: number; outSec: number }[]
    mode?: 'append' | 'replace'
    atSec?: number
  }
  remove_items: { ids: string[] }
  undo: NoArgs
  export_video: { fileName?: string }
  request_feature: { title: string; problem: string; proposal: string; workaround?: string }
}

export type ToolName = keyof ToolArgs
```

- [ ] **Step 2: Move `importMany`**

Create `src/main/services/importMany.ts` containing the `importMany` function cut verbatim from `src/main/ipc.ts` (lines ~38–58, including its doc comment), exported, with its imports:
```ts
import type { MediaAsset } from '@shared/media'
import { expandImportPaths } from './importScan'
import { ensureProxy, importFile } from './mediaStore'
```
In `src/main/ipc.ts`, delete the function and add `import { importMany } from './services/importMany'`; drop `expandImportPaths` from the `./services/importScan` import if nothing else in `ipc.ts` uses it (search first). Run `npm run typecheck` — expected clean.

- [ ] **Step 3: Write the handlers**

`src/main/assistant/tools.ts`:
```ts
/**
 * The assistant's tools, editor side: one async handler per tool returning MCP
 * content blocks. reel-mcp (src/mcp) defines and validates the tools and
 * forwards calls here over the pipe. Read tools answer from main (library,
 * whisper, ffmpeg); edit tools go through `callRenderer` so the real store
 * actions run. A thrown Error becomes the tool's error.
 * Times: "source" = seconds into a media file; "timeline" = seconds in the edit.
 */

import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { alphaInputDecoder, assetAspect, assetKind, type MediaAsset } from '@shared/media'
import type { SequenceItem } from '@shared/assistant/protocol'
import type { ToolContent } from '@shared/assistant/pipeProtocol'
import type { ToolArgs, ToolName } from '@shared/assistant/toolArgs'
import { transcriptPhraseText, transcriptWordText } from '@shared/assistant/transcriptText'
import { frameTimes } from '@shared/assistant/frameTimes'
import { getSubdir } from '../config'
import { ensureProxy, getProjectMedia } from '../services/mediaStore'
import { importMany } from '../services/importMany'
import { getTranscript, transcribeMedia, whisperAvailable } from '../services/whisper'
import { generateStill } from '../services/still'
import { hdrToSdrChain } from '../services/proxy'
import { exportProject, suggestedExportName } from '../services/exporter'
import { listJobs } from '../services/jobs'
import { getSettings } from '../services/settings'
import { exportRefusal, sanitizeExportName, uniqueExportPath } from '../services/exportTarget'
import { callRenderer } from './bridge'
import { fileFeatureRequest } from './todoFile'

const text = (t: string): ToolContent[] => [{ type: 'text', text: t }]
const json = (v: unknown): ToolContent[] => text(JSON.stringify(v, null, 2))
const r2 = (n: number): number => Math.round(n * 100) / 100

function describeAsset(a: MediaAsset): Record<string, unknown> {
  return {
    id: a.id,
    fileName: a.fileName,
    path: a.originalPath,
    kind: assetKind(a),
    durationSec: r2(a.probe.durationSec),
    hasAudio: !!a.probe.audio,
    width: a.probe.video?.displayWidth,
    height: a.probe.video?.displayHeight,
    transcribed: a.transcribed,
    proxyReady: a.proxyReady
  }
}

/** The open project's library, by id. */
async function projectAssets(): Promise<Map<string, MediaAsset>> {
  const ids = await callRenderer('getMediaIds', {})
  return new Map((await getProjectMedia(ids)).map((a) => [a.id, a]))
}

function requireAsset(assets: Map<string, MediaAsset>, mediaId: string): MediaAsset {
  const asset = assets.get(mediaId)
  if (!asset) {
    const valid = [...assets.keys()].join(', ') || '(the library is empty — use import_media)'
    throw new Error(`No media "${mediaId}" in this project. Valid ids: ${valid}`)
  }
  return asset
}

export const toolHandlers: { [K in ToolName]: (args: ToolArgs[K]) => Promise<ToolContent[]> } = {
  list_media: async () => json([...(await projectAssets()).values()].map(describeAsset)),

  import_media: async ({ paths }) => {
    const assets = await importMany(paths)
    if (!assets.length) throw new Error('Nothing was imported — check the paths exist and are video, audio or image files')
    await callRenderer('addMedia', { ids: assets.map((a) => a.id) })
    return json(assets.map(describeAsset))
  },

  get_transcript: async ({ mediaId, fromSec, toSec, words }) => {
    const asset = requireAsset(await projectAssets(), mediaId)
    if (!asset.probe.audio) throw new Error(`${asset.fileName} has no audio track to transcribe`)
    let transcript = await getTranscript(mediaId)
    if (!transcript) {
      if (!whisperAvailable()) throw new Error('whisper.cpp is not installed, so clips cannot be transcribed')
      transcript = await transcribeMedia(mediaId)
    }
    const range =
      fromSec !== undefined || toSec !== undefined ? { fromSec: fromSec ?? 0, toSec: toSec ?? Infinity } : undefined
    const body = words ? transcriptWordText(transcript.words, range) : transcriptPhraseText(transcript.words, range)
    return text(`${asset.fileName} (${mediaId}) — source seconds\n${body}`)
  },

  get_frames: async ({ mediaId, times, count }) => {
    const asset = requireAsset(await projectAssets(), mediaId)
    const v = asset.probe.video
    if (!v) throw new Error(`${asset.fileName} has no picture`)
    const dir = await fsp.mkdtemp(join(getSubdir('tmp'), 'frames-'))
    try {
      const content: ToolContent[] = []
      for (const t of frameTimes(asset.probe.durationSec, times, count)) {
        const out = join(dir, `${t.toFixed(3)}.jpg`)
        const chain = [...(v.isHdr ? [hdrToSdrChain(v)] : []), 'scale=360:-2']
        await generateStill(asset.originalPath, out, t, chain, alphaInputDecoder(v))
        content.push({ type: 'text', text: `${asset.fileName} @ ${t.toFixed(2)}s` })
        content.push({ type: 'image', mimeType: 'image/jpeg', data: (await fsp.readFile(out)).toString('base64') })
      }
      return content
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  },

  get_timeline: async () => json(await callRenderer('getTimeline', {})),

  place_sequence: async ({ items, mode, atSec }) => {
    const assets = await projectAssets()
    const enriched: SequenceItem[] = items.map((it) => {
      const asset = requireAsset(assets, it.mediaId)
      if (assetKind(asset) !== 'video') throw new Error(`${asset.fileName} is not a video clip`)
      return { ...it, sourceDurationSec: asset.probe.durationSec, hasAudio: !!asset.probe.audio, aspect: assetAspect(asset) }
    })
    // The preview plays proxies; wait for any still encoding (coalesced — cheap when ready).
    await Promise.all([...new Set(items.map((i) => i.mediaId))].map((id) => ensureProxy(id)))
    const placed = await callRenderer('placeSequence', { items: enriched, mode: mode ?? 'append', atSec })
    return json({ placed, note: 'One undo step: call undo to revert this whole placement.' })
  },

  remove_items: async ({ ids }) => json(await callRenderer('removeItems', { ids })),

  undo: async () => json(await callRenderer('undo', {})),

  export_video: async ({ fileName }) => {
    const project = await callRenderer('getProject', {})
    const refusal = exportRefusal(project, listJobs())
    if (refusal) throw new Error(refusal)
    const requested = fileName !== undefined ? sanitizeExportName(fileName) : null
    if (fileName !== undefined && !requested) throw new Error(`"${fileName}" is not a usable file name`)
    const preset = project.preset ?? 'reel'
    const { exportDir } = await getSettings()
    await fsp.mkdir(exportDir, { recursive: true })
    const path = uniqueExportPath(exportDir, requested ?? suggestedExportName(project.name, preset), existsSync)
    await exportProject(project, { preset, preferNvenc: true }, path)
    const { size } = await fsp.stat(path)
    return json({ path, sizeMB: Math.round((size / 1_048_576) * 10) / 10 })
  },

  request_feature: async (req) => {
    const r = await fileFeatureRequest(req)
    return text(r.status === 'duplicate' ? `Already requested: "${req.title}" is in ${r.path}` : `Filed in ${r.path}:\n${r.entry}`)
  }
}

/** Pipe entry point: dispatch one call by tool name. */
export function handleTool(tool: string, args: unknown): Promise<ToolContent[]> {
  if (!Object.hasOwn(toolHandlers, tool)) return Promise.reject(new Error(`Unknown tool "${tool}"`))
  const run = toolHandlers[tool as ToolName] as unknown as (a: unknown) => Promise<ToolContent[]>
  return run(args ?? {})
}
```

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck` then `npm test`
Expected: clean / PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/assistant/toolArgs.ts src/main/services/importMany.ts src/main/ipc.ts src/main/assistant/tools.ts
git commit -m "feat(assistant): editor-side tool handlers for library, transcripts, frames, timeline, export and feature requests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: reel-mcp (the stdio server Claude Code launches) + build

**Files:**
- Create: `src/mcp/tools.ts`, `src/mcp/index.ts`
- Modify: `electron.vite.config.ts`, `tsconfig.node.json`

**Interfaces:**
- Consumes: `ToolArgs`, `ToolName` (Task 10); `ToolContent`, `defaultPipePath` (Task 9); `callPipe` (Task 9).
- Produces: `registerTools(server: McpServer, call: CallEditor): void` with `CallEditor = <K extends ToolName>(tool: K, args: ToolArgs[K]) => Promise<ToolContent[]>`; build output `out/main/mcp.js`, runnable with `node`.

- [ ] **Step 1: Tool definitions**

`src/mcp/tools.ts`:
```ts
/**
 * reel-mcp's tool definitions: names, descriptions and argument schemas the
 * model sees. Each call is forwarded to the running editor (src/main/assistant/
 * tools.ts does the work). `CallEditor` ties every schema to `ToolArgs`, so a
 * schema that drifts from the editor's handler fails to compile.
 * Times: "source" = seconds into a media file; "timeline" = seconds in the edit.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolContent } from '@shared/assistant/pipeProtocol'
import type { ToolArgs, ToolName } from '@shared/assistant/toolArgs'

export type CallEditor = <K extends ToolName>(tool: K, args: ToolArgs[K]) => Promise<ToolContent[]>

const result = (content: ToolContent[]): CallToolResult => ({ content })

export function registerTools(server: McpServer, call: CallEditor): void {
  server.registerTool(
    'list_media',
    {
      description:
        "List the clips in the open project's media library: id, file name, path on disk, kind, duration (s), audio, picture size, whether a transcript exists, whether the preview proxy is ready."
    },
    async () => result(await call('list_media', {}))
  )

  server.registerTool(
    'import_media',
    {
      description:
        'Import files or folders from this computer into the project library (a folder imports the media inside it). Returns the new library entries. Only use paths the user gave you.',
      inputSchema: { paths: z.array(z.string().min(1)).min(1).describe('Absolute paths of files or folders') }
    },
    async (args) => result(await call('import_media', args))
  )

  server.registerTool(
    'get_transcript',
    {
      description:
        'Timed transcript of a clip in SOURCE seconds. Transcribes the clip first if needed (can take a minute; progress shows in the editor). Default: one line per phrase "[start–end] text". Set words=true for one line per word (best with a fromSec/toSec range) when you need to cut on an exact word.',
      inputSchema: {
        mediaId: z.string(),
        fromSec: z.number().min(0).optional(),
        toSec: z.number().min(0).optional(),
        words: z.boolean().optional()
      }
    },
    async (args) => result(await call('get_transcript', args))
  )

  server.registerTool(
    'get_frames',
    {
      description:
        'Small still frames (≈360px wide JPEG) from a clip at SOURCE times, to judge the picture. Give explicit times, or a count for evenly spaced frames. At most 8.',
      inputSchema: {
        mediaId: z.string(),
        times: z.array(z.number().min(0)).min(1).max(8).optional(),
        count: z.number().int().min(1).max(8).optional()
      }
    },
    async (args) => result(await call('get_frames', args))
  )

  server.registerTool(
    'get_timeline',
    {
      description:
        'What is on the timeline now (the composition open in the editor): each layer with TIMELINE start/end and, for video, its SOURCE in/out; audio clips; total duration.'
    },
    async () => result(await call('get_timeline', {}))
  )

  server.registerTool(
    'place_sequence',
    {
      description:
        'Lay clips end-to-end on the timeline in EXACTLY the given order. Each item is a SOURCE window {mediaId, inSec, outSec}. mode "append" (default) adds after the current end; "replace" first removes the existing video clips (and their linked audio) and starts at 0. Clips with sound bring linked audio, like a drag from the library. The whole call is ONE undo step. Prefer one call for the whole cut.',
      inputSchema: {
        items: z
          .array(z.object({ mediaId: z.string(), inSec: z.number().min(0), outSec: z.number().positive() }))
          .min(1)
          .max(200),
        mode: z.enum(['append', 'replace']).optional(),
        atSec: z.number().min(0).optional().describe('TIMELINE second to start at')
      }
    },
    async (args) => result(await call('place_sequence', args))
  )

  server.registerTool(
    'remove_items',
    {
      description:
        'Delete timeline items by id (from get_timeline). Linked partners (a clip and its audio) go together. One undo step.',
      inputSchema: { ids: z.array(z.string()).min(1) }
    },
    async (args) => result(await call('remove_items', args))
  )

  server.registerTool(
    'undo',
    { description: "Undo the last edit (yours or the user's) — one step. Returns the timeline after undoing." },
    async () => result(await call('undo', {}))
  )

  server.registerTool(
    'export_video',
    {
      description:
        'Render the whole project to an .mp4 exactly as the Export button does, into the export folder from Settings. Waits until the render finishes (progress shows in the editor). Never overwrites: a taken name gets " (2)". Only export when the user asks.',
      inputSchema: { fileName: z.string().max(120).optional().describe('File name without folder, e.g. "beach reel"') }
    },
    async (args) => result(await call('export_video', args))
  )

  server.registerTool(
    'request_feature',
    {
      description:
        "File a feature request in the editor's TODO list when you need an ability these tools don't have (instead of approximating with tools that don't fit). Then tell the user what you filed.",
      inputSchema: {
        title: z.string().min(3).max(120).describe('Short name of the missing ability'),
        problem: z.string().min(10).describe('What you were trying to do and why the current tools could not'),
        proposal: z.string().min(5).describe('Suggested tool/API or behavior'),
        workaround: z.string().optional().describe('What you did instead, if anything')
      }
    },
    async (args) => result(await call('request_feature', args))
  )
}
```

- [ ] **Step 2: Entry point**

`src/mcp/index.ts`:
```ts
/**
 * reel-mcp: the stdio MCP server Claude Code launches with
 * `node out/main/mcp.js` (registration command in Settings → AI assistant).
 * Every tool call is forwarded over a named pipe to the running editor.
 * stdout IS the MCP channel — never print to it; diagnostics go to stderr.
 * Must not import electron (it runs under plain node).
 */

import { tmpdir } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defaultPipePath } from '@shared/assistant/pipeProtocol'
import { callPipe } from '../main/assistant/pipe'
import { registerTools } from './tools'

const INSTRUCTIONS =
  'Tools for the Reel Editor desktop app on this computer. Times are seconds: SOURCE time is a position inside a media file, TIMELINE time is a position in the edit. Workflow: list_media, get_transcript (and get_frames when the picture matters), choose the cut, one place_sequence call, then get_timeline to verify. An order the user gives is authoritative. Export only when asked. If an ability is missing, call request_feature instead of approximating.'

const pipePath = process.env.REEL_ASSISTANT_PIPE || defaultPipePath(process.platform, tmpdir())

const server = new McpServer({ name: 'reel-editor', version: '0.1.0' }, { instructions: INSTRUCTIONS })
registerTools(server, (tool, args) => callPipe(pipePath, tool, args))
server.connect(new StdioServerTransport()).catch((err) => {
  console.error('[reel-mcp] failed to start', err)
  process.exit(1)
})
```

- [ ] **Step 3: Build it as a second main entry, and typecheck it**

In `electron.vite.config.ts`, give `main` a `build` block:
```ts
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        // Two entries: the app's main process, and reel-mcp — the stdio MCP
        // server Claude Code launches with plain node (src/mcp).
        input: { index: resolve('src/main/index.ts'), mcp: resolve('src/mcp/index.ts') }
      }
    }
  },
```
In `tsconfig.node.json`, add `"src/mcp/**/*.ts"` to `include`.

- [ ] **Step 4: Verify the build and run reel-mcp by hand**

Run: `npm run typecheck` then `npm run build`
Expected: clean; `out/main/index.js` AND `out/main/mcp.js` exist (`ls out/main`).

Then (bash):
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | node out/main/mcp.js
```
Expected: one JSON line on stdout containing `"serverInfo":{"name":"reel-editor"` and nothing else on stdout. Also confirm the bundle doesn't pull in Electron: `grep -l "require(\"electron\")" out/main/mcp.js out/main/chunks/*.js 2>/dev/null` must not list `mcp.js` or any chunk that `mcp.js` requires (`grep -o 'require("./chunks/[^"]*")' out/main/mcp.js` shows which).

No need to start the app yet — the editor's pipe server arrives in Task 12 (until then every tool call answers "isn't running", which is correct).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/index.ts electron.vite.config.ts tsconfig.node.json
git commit -m "feat(assistant): reel-mcp stdio server forwarding tool calls over the pipe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Assistant service + app lifecycle

**Files:**
- Create: `src/main/assistant/service.ts`
- Modify: `src/main/index.ts`, `src/main/ipc.ts`

**Interfaces:**
- Consumes: `servePipe` (Task 9); `handleTool` (Task 10); `getSettings` (Task 7); `AssistantStatus` (Task 5).
- Produces: `startAssistant(): Promise<AssistantStatus>` (restarts if running), `stopAssistant(): Promise<void>`, `assistantStatus(): AssistantStatus`, `mcpScriptPath(): string`, `pipePath(): string`.

- [ ] **Step 1: Implement**

`src/main/assistant/service.ts`:
```ts
/**
 * Serves Claude Code (via reel-mcp) on the named pipe while the assistant is
 * enabled in Settings. Status feeds the Settings panel.
 */

import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultPipePath } from '@shared/assistant/pipeProtocol'
import type { AssistantStatus } from '@shared/assistant/protocol'
import { getSettings } from '../services/settings'
import { servePipe } from './pipe'
import { handleTool } from './tools'

/** reel-mcp's built entry, beside this bundle (out/main/mcp.js). */
export const mcpScriptPath = (): string => join(__dirname, 'mcp.js')

export const pipePath = (): string => process.env.REEL_ASSISTANT_PIPE || defaultPipePath(process.platform, tmpdir())

let server: Server | null = null
let state: Omit<AssistantStatus, 'scriptPath'> = { state: 'off' }

export const assistantStatus = (): AssistantStatus => ({ ...state, scriptPath: mcpScriptPath() })

/** (Re)start from the current settings. */
export async function startAssistant(): Promise<AssistantStatus> {
  await stopAssistant()
  const { assistant } = await getSettings()
  if (assistant.enabled) {
    const r = await servePipe(pipePath(), handleTool)
    if (r.ok) {
      server = r.server
      state = { state: 'listening' }
    } else {
      state = { state: 'error', message: r.message }
      console.error('[assistant]', r.message)
    }
  }
  return assistantStatus()
}

/** Stop accepting calls. Waits for calls already in flight (e.g. an export) to finish. */
export async function stopAssistant(): Promise<void> {
  const s = server
  server = null
  state = { state: 'off' }
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
}
```

- [ ] **Step 2: Wire lifecycle, status IPC and restart-on-change**

In `src/main/index.ts`:
- import: `import { startAssistant, stopAssistant } from './assistant/service'`
- inside `app.whenReady().then(() => { … })`, directly after `createWindow()`:
```ts
  void startAssistant()
```
- after the `whenReady` block:
```ts
app.on('before-quit', () => {
  void stopAssistant()
})
```

In `src/main/ipc.ts`:
- import: `import { assistantStatus, startAssistant } from './assistant/service'`
- replace the `IPC.updateSettings` handler with:
```ts
  ipcMain.handle(IPC.updateSettings, async (_event, patch: Partial<Settings>) => {
    const next = await updateSettings(patch)
    // Toggling the assistant restarts (or stops) the pipe server live.
    if (patch.assistant) await startAssistant()
    return next
  })
  ipcMain.handle(IPC.assistantStatus, () => assistantStatus())
```

- [ ] **Step 3: Typecheck, build, and try it for real**

Run: `npm run typecheck`, `npm test`, `npm run build` — all succeed.
Then `npm run dev`, and in a second terminal (bash, repo root) drive reel-mcp exactly as Claude Code would, with the SDK's stdio client:
```bash
node --input-type=module -e "
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['out/main/mcp.js'] }));
console.log((await c.listTools()).tools.length, JSON.stringify(await c.callTool({ name: 'get_timeline', arguments: {} })).slice(0, 200));
await c.close();"
```
Expected: `10` and a `get_timeline` JSON result (not an error). Close the app and run it again: expected the result is an error containing `isn't running`. (This is with Norton running normally.)

- [ ] **Step 4: Commit**

```bash
git add src/main/assistant/service.ts src/main/index.ts src/main/ipc.ts
git commit -m "feat(assistant): serve Claude Code on the named pipe, with live on/off from settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Settings UI

**Files:**
- Modify: `src/renderer/src/components/SettingsModal.tsx`

**Interfaces:**
- Consumes: `assistantStatus` (Task 8 preload; handler Task 12), `mcpAddCommand`, `Settings.assistant` (Task 7), `AssistantStatus` (Task 5), `Check`, `btnCls` (`components/ui.tsx`).
- Produces: checkbox labelled exactly `Let Claude Code control the editor`; status line `data-testid="assistant-status"` reading `Off`, `Listening for Claude Code`, or the error message; command block + `Copy` button.

- [ ] **Step 1: Implement**

In `SettingsModal.tsx`:

1. Imports become:
```tsx
import { useEffect, useState, type JSX } from 'react'
import type { Settings } from '@shared/settings'
import { mcpAddCommand } from '@shared/settings'
import type { AssistantStatus } from '@shared/assistant/protocol'
import { useUi } from '@/state/ui'
import { assistantStatus, chooseExportDir, getSettings, updateSettings } from '@/ipc/client'
import { btnCls, Check } from './ui'
```

2. Replace the existing `useEffect` with:
```tsx
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [copied, setCopied] = useState(false)
  const refreshStatus = (): void => void assistantStatus().then(setStatus)

  useEffect(() => {
    if (!open) return
    void getSettings().then(setSettings)
    refreshStatus()
    setCopied(false)
  }, [open])
```

3. Replace the paragraph `Each export still opens a Save dialog — this is just where it starts.` with:
```tsx
          The Export button opens a Save dialog starting here; assistant exports save here directly.
```

4. Before the final `Done` button row, add:
```tsx
        <div className="mt-5 mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
          AI assistant (Claude Code)
        </div>
        <Check
          checked={settings?.assistant.enabled ?? false}
          onChange={(enabled) => {
            if (!settings) return
            void updateSettings({ assistant: { ...settings.assistant, enabled } }).then((s) => {
              setSettings(s)
              refreshStatus()
            })
          }}
        >
          Let Claude Code control the editor
        </Check>
        <p data-testid="assistant-status" className="text-[11px] text-zinc-500">
          {status === null
            ? '…'
            : status.state === 'listening'
              ? 'Listening for Claude Code'
              : status.state === 'off'
                ? 'Off'
                : status.message}
        </p>
        {settings?.assistant.enabled && status && (
          <>
            <p className="mt-2 text-[11px] text-zinc-400">
              Register once in a terminal — then every Claude Code session can use the editor while it is open:
            </p>
            <div className="mt-1 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[10px] text-zinc-300">
                {mcpAddCommand(status.scriptPath)}
              </code>
              <button
                className={btnCls}
                onClick={() => void navigator.clipboard.writeText(mcpAddCommand(status.scriptPath)).then(() => setCopied(true))}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              Then run <code>/edit-video</code> in a Claude Code session opened in this repo.
            </p>
          </>
        )}
```

- [ ] **Step 2: Typecheck + look at it**

Run: `npm run typecheck` — expected clean. Run `npm run dev`, open Settings: the AI assistant section shows the checked box, `Listening for Claude Code`, and the command with this checkout's `out\main\mcp.js` path; unchecking shows `Off` and hides the command; re-checking restores it. Close the app.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SettingsModal.tsx
git commit -m "feat(assistant): Settings toggle, status and registration command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: End-to-end spec

**Files:**
- Modify: `e2e/fixtures.ts`
- Create: `e2e/assistant.spec.ts`

**Interfaces:**
- Consumes: everything above, through the real reel-mcp script launched by the SDK's stdio client (exactly how Claude Code runs it) and real UI events.

- [ ] **Step 1: Make every launch hermetic for the assistant**

In `e2e/fixtures.ts`, add `basename` to the `node:path` import, and in the `env` passed to `electron.launch` add:
```ts
        // Never collide with a dev app's pipe; never touch the repo's TODO.
        REEL_ASSISTANT_PIPE:
          process.platform === 'win32' ? `\\\\.\\pipe\\${basename(scratch)}` : join(scratch, 'reel.sock'),
        REEL_TODO_PATH: join(scratch, 'TODO.md'),
```

- [ ] **Step 2: Write the spec**

`e2e/assistant.spec.ts`:
```ts
/**
 * The AI assistant end to end, driven the way Claude Code drives it: the SDK's
 * stdio client launches the built reel-mcp (out/main/mcp.js), which talks to
 * the running app over its named pipe. ARRANGE via store / files, ACT via MCP
 * calls and real clicks, ASSERT on store + DOM + files.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test, expect } from './fixtures'

const ROOT = resolve(__dirname, '..')
const MCP = join(ROOT, 'out', 'main', 'mcp.js')
const BIN = join(ROOT, 'resources', 'bin', 'ffmpeg')
const FFMPEG = join(BIN, 'ffmpeg.exe')
const FFPROBE = join(BIN, 'ffprobe.exe')
const TOOLS = ['export_video', 'get_frames', 'get_timeline', 'get_transcript', 'import_media', 'list_media', 'place_sequence', 'remove_items', 'request_feature', 'undo']

type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }
const textOf = (r: ToolResult): string => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

const pipeOf = (app: ElectronApplication): Promise<string> => app.evaluate(() => process.env.REEL_ASSISTANT_PIPE as string)

async function connect(pipe: string): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP],
      env: { ...getDefaultEnvironment(), REEL_ASSISTANT_PIPE: pipe },
      stderr: 'pipe'
    })
  )
  return client
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  (await c.callTool({ name, arguments: args })) as ToolResult

test('lists the tools and names valid ids for an unknown media id', async ({ electronApp, appPage: _page }) => {
  const c = await connect(await pipeOf(electronApp))
  expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS)
  const r = await call(c, 'get_transcript', { mediaId: 'nope' })
  expect(r.isError).toBe(true)
  expect(textOf(r)).toMatch(/No media "nope".*Valid ids/s)
  await c.close()
})

test('says plainly when the editor is not running', async () => {
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\reel-nobody-home' : join(tmpdir(), 'reel-nobody-home.sock')
  const c = await connect(pipe)
  const r = await call(c, 'list_media')
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain("Reel Editor isn't running")
  await c.close()
})

test('files a feature request into the TODO list once', async ({ electronApp, appPage: _page }) => {
  const todo = await electronApp.evaluate(() => process.env.REEL_TODO_PATH as string)
  writeFileSync(todo, '# TODO\n\n## Open\n\n- [ ] x\n')
  const c = await connect(await pipeOf(electronApp))
  const req = { title: 'Beat snap', problem: 'Wanted cuts on the beat of the music.', proposal: 'detect_beats tool' }
  expect(textOf(await call(c, 'request_feature', req))).toMatch(/^Filed in/)
  expect(textOf(await call(c, 'request_feature', req))).toMatch(/^Already requested/)
  expect(readFileSync(todo, 'utf8')).toMatch(
    /## Assistant requests\n\n- \[ \] \*\*Beat snap\*\* — Wanted cuts on the beat of the music\. _Proposal:_ detect_beats tool _\(requested by assistant, \d{4}-\d{2}-\d{2}\)_\n\n## Open/
  )
  await c.close()
})

test('the Settings toggle disconnects and reconnects Claude Code', async ({ electronApp, appPage: page }) => {
  const c = await connect(await pipeOf(electronApp))
  await page.evaluate(() => window.__reelStores.useUi.getState().setSettingsOpen(true))
  const toggle = page.getByLabel('Let Claude Code control the editor')
  await expect(toggle).toBeChecked()
  await expect(page.getByTestId('assistant-status')).toHaveText('Listening for Claude Code')

  await toggle.click()
  await expect(page.getByTestId('assistant-status')).toHaveText('Off')
  const off = await call(c, 'get_timeline')
  expect(off.isError).toBe(true)
  expect(textOf(off)).toContain("Reel Editor isn't running")

  await toggle.click()
  await expect(page.getByTestId('assistant-status')).toHaveText('Listening for Claude Code')
  expect((await call(c, 'get_timeline')).isError).toBeFalsy()
  await c.close()
})

test('rough cut in the given order, undone in one step, then exported', async ({ electronApp, appPage: page }) => {
  test.skip(!existsSync(FFMPEG) || !existsSync(FFPROBE), 'bundled ffmpeg not staged (see plan Task 1 Step 1)')
  test.setTimeout(240_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-assistant-'))
  const clip = (name: string, color: string): string => {
    const out = join(dir, name)
    execFileSync(FFMPEG, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:s=540x960:r=30:d=4`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', out
    ])
    return out
  }
  const a = clip('a.mp4', 'red')
  const b = clip('b.mp4', 'blue')
  const c = await connect(await pipeOf(electronApp))

  const imported = JSON.parse(textOf(await call(c, 'import_media', { paths: [a, b] }))) as { id: string; fileName: string }[]
  const idOf = (f: string): string => imported.find((x) => x.fileName === f)!.id
  const [A, B] = [idOf('a.mp4'), idOf('b.mp4')]

  const frames = await call(c, 'get_frames', { mediaId: A, count: 2 })
  expect(frames.isError).toBeFalsy()
  const images = frames.content.filter((x) => x.type === 'image')
  expect(images).toHaveLength(2)
  expect(images.every((x) => x.mimeType === 'image/jpeg' && (x.data?.length ?? 0) > 100)).toBe(true)

  const historyBefore = await page.evaluate(() => window.__reelStores.useProject.getState().past.length)
  const placed = await call(c, 'place_sequence', {
    items: [{ mediaId: B, inSec: 1, outSec: 3 }, { mediaId: A, inSec: 0.5, outSec: 2 }]
  })
  expect(placed.isError).toBeFalsy()

  const layers = await page.evaluate(() =>
    window.__reelStores.useProject.getState().project!.layers.map((l) => ({
      id: l.id,
      mediaId: (l.content as { mediaId?: string }).mediaId,
      startSec: l.startSec,
      endSec: l.endSec
    }))
  )
  expect(layers.map((l) => l.mediaId)).toEqual([B, A])
  expect(layers[0].startSec).toBeCloseTo(0, 6)
  expect(layers[0].endSec).toBeCloseTo(2, 6)
  expect(layers[1].startSec).toBeCloseTo(2, 6)
  expect(layers[1].endSec).toBeCloseTo(3.5, 6)
  for (const l of layers) await expect(page.getByTestId(`tile-layer-${l.id}`)).toBeVisible()
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.audioClips.length)).toBe(2)
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().past.length)).toBe(historyBefore + 1)

  const undone = JSON.parse(textOf(await call(c, 'undo'))) as { undone: boolean; timeline: { layers: unknown[] } }
  expect(undone.undone).toBe(true)
  expect(undone.timeline.layers).toEqual([])

  await call(c, 'place_sequence', { items: [{ mediaId: B, inSec: 1, outSec: 3 }, { mediaId: A, inSec: 0.5, outSec: 2 }] })
  const first = JSON.parse(textOf(await call(c, 'export_video', { fileName: 'cut' }))) as { path: string }
  const second = JSON.parse(textOf(await call(c, 'export_video', { fileName: 'cut' }))) as { path: string }
  expect(first.path).toMatch(/[\\/]cut\.mp4$/)
  expect(second.path).toMatch(/[\\/]cut \(2\)\.mp4$/)
  const duration = Number(
    execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', first.path]).toString().trim()
  )
  expect(duration).toBeGreaterThan(3.4)
  expect(duration).toBeLessThan(3.7)
  await c.close()
})
```

(The `appPage: _page` fixture in tests that don't touch the page still waits for the window, so the app — and its pipe server — is up before connecting.)

- [ ] **Step 3: Run the new spec**

Run: `npm run build` then `npx playwright test e2e/assistant.spec.ts`
Expected: 5 passed (the rough-cut test must PASS, not skip — if it skips, `resources\bin\ffmpeg` is missing; redo Task 1 Step 1).

- [ ] **Step 4: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: all pass (this also covers `addVideoLayer`'s audio-helper refactor via `link.spec.ts` and friends). Note how many specs SKIP and confirm none skip for the ffmpeg reason.

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures.ts e2e/assistant.spec.ts
git commit -m "test(assistant): e2e via the real reel-mcp stdio script: tools, closed editor, requests, toggle, rough cut/undo/export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: `/edit-video` skill + docs

**Files:**
- Create: `.claude/skills/edit-video/SKILL.md`
- Modify: `docs/SHARED.md`, `docs/TODO.md`, `README.md`

- [ ] **Step 1: Write the skill**

`.claude/skills/edit-video/SKILL.md`:
```markdown
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
order (`mode: "replace"` to rebuild from scratch, `"append"` to add to what is there).
It is one undo step. Then `get_timeline` and check the clips, order and total length.
Fix mistakes with `undo` or `remove_items` and place again.

## 4. Report

Give the user a short list: each clip, its source window, its timeline position, and
the total length. Mention anything you were unsure about.

## 5. Export only when asked

`export_video` (optional `fileName`). It waits for the render and returns the file
path — give the user that path.

## When an ability is missing

If the job needs something these tools cannot do (captions, music, transitions, speed
changes, cutting on beats…), do NOT approximate it with tools that don't fit. Call
`request_feature` with a clear `title`, the `problem`, a concrete `proposal` (tool name
and arguments), and any `workaround` you used — then tell the user what you filed.

## Time bases

SOURCE seconds = position inside a media file (transcripts, frames, `inSec`/`outSec`).
TIMELINE seconds = position in the edit (`atSec`, `startSec`/`endSec` in `get_timeline`).
```

- [ ] **Step 2: `docs/SHARED.md`**

Add a section (after the "UI (renderer)" section, before the next `##`):
```markdown
## AI assistant (Claude Code via MCP) — `src/mcp/`, `src/main/assistant/`, `src/shared/assistant/`, `lib/sequence.ts`

Shape: Claude Code launches **reel-mcp** (`node out/main/mcp.js`, stdio) → JSON lines over the named pipe `\\.\pipe\reel-editor` → editor main → renderer store. Not local HTTP: an MCP-aware network filter on the owner's machine corrupts local plain-HTTP MCP traffic (design spec, "Why not local HTTP").

| Concept | Home | Use instead of |
| --- | --- | --- |
| Adding a tool | `shared/assistant/toolArgs.ts` (args type) → `mcp/tools.ts` (schema + description) → `main/assistant/tools.ts` (handler) | anything else — `ToolArgs` makes a schema/handler mismatch a compile error |
| `servePipe` / `callPipe`, `LineDecoder`/`encodeLine` | `main/assistant/pipe.ts`, `shared/assistant/pipeProtocol.ts` | another channel between reel-mcp and the editor. One connection per call; no Electron imports |
| `applySequence(comp, plan, ctx)`, `makeExtractedAudioClip(…)` | `lib/sequence.ts` | building trimmed video layers + their linked audio by hand. `applySequence` lays clips end-to-end through `makeVideoLayer` + `trimVideoStart`/`trimVideoEnd` (never inline source↔timeline math); `makeExtractedAudioClip` is THE linked-audio shape, shared with `addVideoLayer`. Store entry point: `addVideoSequence(plan)` (one undo step) |
| `AssistantOps` + `callRenderer(op, args)` / `installAssistantBridge()` | `shared/assistant/protocol.ts`, `main/assistant/bridge.ts`, `renderer/assistant/handlers.ts` | reaching into renderer state from main any other way. Add an op to `AssistantOps` and both halves are type-checked against it |
| `summarizeTimeline(comp)` | `shared/assistant/timelineSummary.ts` | hand-serializing the timeline for the model |
| `transcriptPhraseText` / `transcriptWordText`, `frameTimes` | `shared/assistant/` | formatting transcripts / choosing frame times for the model |
| `sanitizeExportName`, `uniqueExportPath`, `exportRefusal` | `main/services/exportTarget.ts` | ad-hoc output naming for a dialog-less export (never overwrites; a name can't leave the export folder) |
| `appendAssistantRequest` / `fileFeatureRequest` | `main/assistant/todoAppend.ts`, `todoFile.ts` | editing docs/TODO.md from code (serialized; `REEL_TODO_PATH` overrides) |
```

- [ ] **Step 3: `docs/TODO.md`**

1. Directly above `## Open`, add:
```markdown
## Assistant requests

> Filed by the editor's AI assistant (`request_feature`) when it needed an ability the editor doesn't have. Triage: promote into Open, or delete.

```
2. Under `## Open`, as the first subsection, add:
```markdown
### AI assistant (Claude Code via MCP)

- [~] **Claude Code can drive the editor** — reel-mcp (`src/mcp/`, stdio, launched by Claude Code) forwards tool calls over the named pipe `\\.\pipe\reel-editor` to the editor (`src/main/assistant/`; on by default, toggle + registration command in Settings); `/edit-video` skill (`.claude/skills/edit-video/`). Tools: list/import media, transcripts, source frames, timeline summary, `place_sequence` (one undo step), remove, undo, `export_video` (Settings export folder, never overwrites), `request_feature` (→ this file's "Assistant requests"). No local HTTP: an MCP-aware filter on this machine (Norton 360 the only candidate) corrupts local plain-HTTP MCP traffic. Spec: `docs/superpowers/specs/2026-10-06-ai-assistant-mcp-design.md`. `e2e/assistant.spec.ts` drives the real stdio script: tools, closed editor, feature requests, the toggle, and a synthesized rough cut → undo → export. _Unverified: not yet smoke-tested with a real Claude Code session on real footage (rough cut in model-chosen and user-given order via `/edit-video`, then export, compared with a button export)._
```

- [ ] **Step 4: `README.md`**

In the `## Development` section, append:
```markdown
### AI assistant (Claude Code)

Claude Code drives the editor through **reel-mcp**, a small stdio MCP server built
with the app (`out/main/mcp.js`) that talks to the running editor over a named
pipe (switch: **Settings → AI assistant**). Register it once — Settings shows the
exact line for your checkout with a Copy button:

    claude mcp add --scope user reel-editor -- node "<repo>\out\main\mcp.js"

Then, with the editor open, run `/edit-video` in a Claude Code session opened in
this repo. Claude Code asks before each tool call; choose "don't ask again" for
the reel-editor tools if you want it to work uninterrupted.
```

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/edit-video/SKILL.md docs/SHARED.md docs/TODO.md README.md
git commit -m "docs(assistant): /edit-video skill, SHARED catalog, TODO entry and README setup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Owner smoke test (manual — Definition of done)

This needs the owner; the executor prepares it and reports.

- [ ] **Step 1: Final automated gate**

Run: `npm run typecheck`, `npm test`, `npm run test:e2e`.
Expected: all green, assistant spec not skipped.

- [ ] **Step 2: Hand the owner this checklist (Norton running normally throughout)**

1. `npm run dev` in this worktree. Settings → AI assistant shows "Listening for Claude Code". Copy the command and run it in a terminal.
2. Start a NEW Claude Code session in this repo (worktree) and ask "list my editor's media" — the `reel-editor` tools should answer (approve the permission prompts).
3. Import 3–6 real clips (via `/edit-video` giving folder paths, or the app). Run `/edit-video make a ~30s reel` — watch the cut appear; Ctrl+Z once removes all of it.
4. Run `/edit-video` again with an explicit order ("clip C, then A, then B") — the timeline follows that order.
5. Ask it to export. The file lands in the Settings export folder; export the same project with the Export button and compare the two (same length, same look).
6. Ask for something it can't do ("add a beat-synced flash transition") — it files a request; check `docs/TODO.md` → "Assistant requests".
7. Close the editor and ask Claude Code to list media — it says the editor isn't running.

- [ ] **Step 3: Record the result**

If every step passed: change the TODO entry from `[~]` to `[x]` and delete its `_Unverified…_` sentence; commit `docs(assistant): mark Claude Code control smoke-tested`. If any step failed: leave `[~]`, replace the `_Unverified…_` sentence with exactly what failed, and fix before marking done.
