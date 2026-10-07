# AI Assistant via MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code (on the owner's subscription) drive the running Reel Editor through a local MCP server: read clips and transcripts, look at frames, lay a rough cut on the timeline in one undo step, export it, and file feature requests into `docs/TODO.md`.

**Architecture:** An MCP server (official `@modelcontextprotocol/sdk`, stateless Streamable HTTP) runs inside Electron main on `127.0.0.1`, guarded by a bearer token. Read tools are answered in main from the media store / whisper / ffmpeg; edit tools are forwarded over a request/response IPC bridge to the renderer, which runs the real zustand store actions (so undo, links and nonlinear source time stay correct). Pure logic (sequence building, transcript text, TODO appending, export naming, timeline summary) lives in tested modules.

**Tech Stack:** Electron 42 + electron-vite, React 19, zustand, TypeScript, vitest, Playwright (Electron), `@modelcontextprotocol/sdk@1.32.1`, `zod@^4`.

**Spec:** `docs/superpowers/specs/2026-10-06-ai-assistant-mcp-design.md` — read it alongside this plan.

## Global Constraints

- Never `git push`. Commit locally only (CLAUDE.md house rule).
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `npm run typecheck` and `npm test` must be green at every commit; the `exporterArgs` tests must stay untouched and green.
- Server binds `127.0.0.1` only; default port `47823`; every request needs `Authorization: Bearer <token>`; any `Origin` header other than absent/`null` is refused.
- Registration command, exactly: `claude mcp add --scope user --transport http reel-editor http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`
- Server is ON by default; Settings has a toggle that starts/stops it live.
- `request_feature` writes to `join(app.getAppPath(), 'docs', 'TODO.md')`, overridable by env `REEL_TODO_PATH`; section heading `## Assistant requests`, inserted directly above `## Open`.
- Entry format: `- [ ] **<title>** — <problem> _Proposal:_ <proposal> _Workaround used:_ <workaround> _(requested by assistant, YYYY-MM-DD)_` (workaround clause omitted when absent).
- Every edit tool is exactly one undo step. Edits target the active composition (`editPath`), like the UI.
- Do NOT use the SDK's `StreamableHTTPServerTransport` (Node wrapper): verified 2026-10-06 on Node 24 that it sends `transfer-encoding: chunked` with an unframed body, which clients reject. Use `WebStandardStreamableHTTPServerTransport` + the small adapter in Task 10.
- `docs/TODO.md` feature entry stays `[~]` until the owner's real smoke test (Task 14) passes.

## Review Focus

1. **A media id the project doesn't have** (stale id, another project's clip) → tool error that lists the valid ids; nothing changes. Pinned in Task 12 (e2e `get_transcript` with a bogus id).
2. **Reversed or out-of-range in/out in `place_sequence`** (`outSec < inSec`, beyond the source) → clamped where possible, otherwise an error naming the item, and the timeline and undo history are untouched. Pinned in Task 6 (`rejects a reversed item…`).
3. **Two `request_feature` calls at once** (Claude Code issues tool calls in parallel) → both entries land; neither overwrites the other. Pinned in Task 3 (`todoFile.test.ts`).
4. **`export_video` while an export is already running, or with no clips** → refused with a clear reason, no second ffmpeg started. Pinned in Task 4 (`exportRefusal`).
5. **Port already taken** (a second editor instance, or another program on 47823) → Settings shows "port in use", the app keeps running. Pinned in Task 10 (`listenLocal` test).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/shared/assistant/transcriptText.ts` (+test) | create | Words → compact timed phrase / word lines |
| `src/shared/assistant/frameTimes.ts` (+test) | create | Which source times `get_frames` samples |
| `src/shared/assistant/protocol.ts` | create | Bridge op names + arg/result types, sequence types, server state type |
| `src/shared/assistant/timelineSummary.ts` (+test) | create | Composition → compact JSON the model reads |
| `src/shared/settings.ts` (+new test) | modify | `AssistantSettings`, defaults, `mcpAddCommand` |
| `src/main/assistant/todoAppend.ts` (+test) | create | Pure markdown insertion for feature requests |
| `src/main/assistant/todoFile.ts` (+test) | create | Read/serialize/write `docs/TODO.md` |
| `src/main/services/exportTarget.ts` (+test) | create | Safe export file names, unique paths, export refusal reasons |
| `src/renderer/src/lib/sequence.ts` (+test) | create | `applySequence` + `makeExtractedAudioClip` |
| `src/renderer/src/state/projectStore.ts` | modify | `addVideoSequence` action; `addVideoLayer` uses `makeExtractedAudioClip` |
| `src/main/services/settings.ts` | modify | Assistant defaults + token persistence |
| `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/ipc/client.ts` | modify | Bridge channels |
| `src/main/assistant/bridge.ts` | create | `callRenderer(op, args)` with timeout |
| `src/renderer/src/assistant/handlers.ts` | create | Renderer op table over store actions |
| `src/renderer/src/main.tsx` | modify | Install the bridge |
| `src/main/services/importMany.ts` | create (moved) | Import paths + kick proxies (was private in `ipc.ts`) |
| `src/main/assistant/tools.ts` | create | All MCP tool registrations |
| `src/main/assistant/http.ts` (+test) | create | Access check, node↔web request adapter, `listenLocal` |
| `src/main/assistant/server.ts` | create | Start/stop/status of the MCP HTTP server |
| `src/main/index.ts`, `src/main/ipc.ts` | modify | Lifecycle, status IPC, restart on settings change |
| `src/renderer/src/components/SettingsModal.tsx` | modify | Toggle, status, copyable command |
| `e2e/fixtures.ts`, `e2e/assistant.spec.ts` | modify/create | Hermetic port + TODO path; end-to-end MCP checks |
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
- Produces (protocol): `SequenceItem`, `SequencePlan`, `PlacedClip`, `AssistantOps`, `AssistantOp`, `AssistantRequest`, `AssistantResponse`, `AssistantServerState` (exact shapes below).
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

export type AssistantServerState =
  | { state: 'off' }
  | { state: 'running'; port: number }
  | { state: 'error'; message: string }
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
Expected: all PASS; typecheck clean (the `addVideoLayer` refactor is behavior-preserving; `e2e/link.spec.ts` covers it end-to-end in Task 12's full e2e run).

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
- Produces: `AssistantSettings { enabled: boolean; port: number; token: string }`; `Settings.assistant: AssistantSettings`; `DEFAULT_ASSISTANT_PORT = 47823`; `withAssistantDefaults(loaded: Partial<AssistantSettings> | undefined, makeToken: () => string): AssistantSettings`; `mcpAddCommand(port: number, token: string): string`.

- [ ] **Step 1: Write the failing test**

`src/shared/settings.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_PORT, mcpAddCommand, withAssistantDefaults } from './settings'

const TOKEN = 'a'.repeat(48)

describe('withAssistantDefaults', () => {
  it('turns the server on with the default port and a fresh token when nothing is stored', () => {
    expect(withAssistantDefaults(undefined, () => TOKEN)).toEqual({ enabled: true, port: DEFAULT_ASSISTANT_PORT, token: TOKEN })
  })

  it('keeps stored values and does not mint a new token', () => {
    let minted = 0
    const stored = { enabled: false, port: 50000, token: 'b'.repeat(48) }
    expect(withAssistantDefaults(stored, () => (minted++, TOKEN))).toEqual(stored)
    expect(minted).toBe(0)
  })

  it('replaces an invalid port or a too-short token', () => {
    expect(withAssistantDefaults({ port: 70000, token: 'short' }, () => TOKEN)).toEqual({ enabled: true, port: DEFAULT_ASSISTANT_PORT, token: TOKEN })
  })
})

describe('mcpAddCommand', () => {
  it('is the one-time user-scope registration line', () => {
    expect(mcpAddCommand(47823, 'tok')).toBe(
      'claude mcp add --scope user --transport http reel-editor http://127.0.0.1:47823/mcp --header "Authorization: Bearer tok"'
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
  /** The local MCP server Claude Code connects to (AI assistant). */
  assistant: AssistantSettings
```
and add below the interface:
```ts
export interface AssistantSettings {
  /** Run the server (on by default; Settings can switch it off). */
  enabled: boolean
  port: number
  /** Bearer token Claude Code must send. Generated once, then kept. */
  token: string
}

export const DEFAULT_ASSISTANT_PORT = 47823

/** Fill in assistant defaults. `makeToken` only runs when no usable token is stored. */
export function withAssistantDefaults(
  loaded: Partial<AssistantSettings> | undefined,
  makeToken: () => string
): AssistantSettings {
  const port = loaded?.port
  return {
    enabled: typeof loaded?.enabled === 'boolean' ? loaded.enabled : true,
    port: Number.isInteger(port) && port! > 0 && port! < 65536 ? port! : DEFAULT_ASSISTANT_PORT,
    token: typeof loaded?.token === 'string' && loaded.token.length >= 32 ? loaded.token : makeToken()
  }
}

/** The one-time registration line Settings shows (user scope: every Claude Code session). */
export function mcpAddCommand(port: number, token: string): string {
  return `claude mcp add --scope user --transport http reel-editor http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`
}
```

- [ ] **Step 4: Implement the main part**

In `src/main/services/settings.ts`:
- add imports: `import { randomBytes } from 'node:crypto'` and extend the `@shared/settings` import with `withAssistantDefaults`;
- replace the `cache = { … }` assignment in `getSettings` and what follows with:
```ts
  cache = {
    exportDir: loaded.exportDir || getSubdir('exports'),
    keywordBank: Array.isArray(loaded.keywordBank) ? loaded.keywordBank : DEFAULT_KEYWORD_BANK,
    brandColors: Array.isArray(loaded.brandColors) ? loaded.brandColors : DEFAULT_BRAND_COLORS,
    assistant: withAssistantDefaults(loaded.assistant, () => randomBytes(24).toString('hex'))
  }
  // A freshly minted token must survive restarts, or the registered Claude Code
  // command would stop working: persist it the first time.
  if (cache.assistant.token !== loaded.assistant?.token) {
    await fsp.writeFile(settingsPath(), JSON.stringify(cache, null, 2), 'utf8').catch((err) =>
      console.error('could not persist settings', err)
    )
  }
  return cache
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/shared/settings.test.ts` then `npm test` then `npm run typecheck`
Expected: PASS; typecheck clean (SettingsModal still compiles — it only spreads `settings`).

- [ ] **Step 6: Commit**

```bash
git add src/shared/settings.ts src/shared/settings.test.ts src/main/services/settings.ts
git commit -m "feat(assistant): assistant server settings with a persisted token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Renderer bridge (main ⇄ renderer request/response)

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/ipc/client.ts`, `src/renderer/src/main.tsx`
- Create: `src/main/assistant/bridge.ts`, `src/renderer/src/assistant/handlers.ts`

**Interfaces:**
- Consumes: `AssistantOps`, `AssistantRequest`, `AssistantResponse`, `AssistantServerState` (Task 5); `summarizeTimeline` (Task 5); `addVideoSequence` (Task 6); `expandSelection`, `timelineTiles` (`lib/links.ts`).
- Produces: `registerAssistantBridge(): void` and `callRenderer<K extends AssistantOp>(op: K, args: AssistantOps[K]['args']): Promise<AssistantOps[K]['result']>` (main); `installAssistantBridge(): () => void` (renderer); preload `onAssistantRequest`, `assistantRespond`, `assistantStatus`; IPC names `IPC.assistantResponse = 'assistant:response'`, `IPC.assistantStatus = 'assistant:status'`, `IPC_EVENT.assistantRequest = 'assistant:request'`.

- [ ] **Step 1: Channel names**

In `src/shared/ipc.ts`, add a comma after the last `IPC` entry (`captureStillToDisk: 'still:toDisk'`) and then these entries:
```ts
  // AI assistant bridge (the MCP server runs in main)
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

In `src/preload/index.ts` add the import:
```ts
import type { AssistantRequest, AssistantResponse, AssistantServerState } from '@shared/assistant/protocol'
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
  assistantStatus: (): Promise<AssistantServerState> => ipcRenderer.invoke(IPC.assistantStatus)
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

- [ ] **Step 5: Typecheck + tests**

Run: `npm run typecheck` then `npm test`
Expected: clean / PASS. (Behavior is exercised end-to-end in Task 12.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/renderer/src/ipc/client.ts src/main/assistant/bridge.ts src/main/ipc.ts src/renderer/src/assistant/handlers.ts src/renderer/src/main.tsx
git commit -m "feat(assistant): main<->renderer request/response bridge over store actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: MCP tools

**Files:**
- Create: `src/main/services/importMany.ts` (moved from `src/main/ipc.ts`)
- Modify: `src/main/ipc.ts` (use the moved function)
- Create: `src/main/assistant/tools.ts`

**Interfaces:**
- Consumes: `callRenderer` (Task 8); `transcriptPhraseText`, `transcriptWordText`, `frameTimes` (Task 1); `fileFeatureRequest` (Task 3); `sanitizeExportName`, `uniqueExportPath`, `exportRefusal` (Task 4); `SequenceItem` (Task 5); existing `getAsset`, `getProjectMedia`, `ensureProxy` (`services/mediaStore`), `getTranscript`, `transcribeMedia`, `whisperAvailable` (`services/whisper`), `generateStill` (`services/still`), `hdrToSdrChain` (`services/proxy`), `exportProject`, `suggestedExportName` (`services/exporter`), `listJobs` (`services/jobs`), `getSettings`, `getSubdir`, `alphaInputDecoder`, `assetAspect`, `assetKind` (`@shared/media`).
- Produces: `importMany(paths: string[]): Promise<MediaAsset[]>`; `registerTools(server: McpServer): void` registering exactly: `list_media`, `import_media`, `get_transcript`, `get_frames`, `get_timeline`, `place_sequence`, `remove_items`, `undo`, `export_video`, `request_feature`.

- [ ] **Step 1: Move `importMany`**

Create `src/main/services/importMany.ts` containing the `importMany` function cut verbatim from `src/main/ipc.ts` (lines ~38–58, including its doc comment), exported, with its imports:
```ts
import type { MediaAsset } from '@shared/media'
import { expandImportPaths } from './importScan'
import { ensureProxy, importFile } from './mediaStore'
```
In `src/main/ipc.ts`, delete the function and add `import { importMany } from './services/importMany'`; drop `expandImportPaths` from the `./services/importScan` import if nothing else in `ipc.ts` uses it (check with a search). Run `npm run typecheck` — expected clean.

- [ ] **Step 2: Write `tools.ts`**

`src/main/assistant/tools.ts`:
```ts
/**
 * The assistant's MCP tools. Read tools answer from main (library, whisper,
 * ffmpeg); edit tools go through `callRenderer` so the real store actions run.
 * A thrown Error becomes an `isError` tool result (verified against the SDK).
 * Times: "source" = seconds into a media file; "timeline" = seconds in the edit.
 */

import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { alphaInputDecoder, assetAspect, assetKind, type MediaAsset } from '@shared/media'
import type { SequenceItem } from '@shared/assistant/protocol'
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

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] })
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2))
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

export function registerTools(server: McpServer): void {
  server.registerTool(
    'list_media',
    {
      description:
        "List the clips in the open project's media library: id, file name, path on disk, kind, duration (s), audio, picture size, whether a transcript exists, whether the preview proxy is ready."
    },
    async () => json([...(await projectAssets()).values()].map(describeAsset))
  )

  server.registerTool(
    'import_media',
    {
      description:
        'Import files or folders from this computer into the project library (a folder imports the media inside it). Returns the new library entries. Only use paths the user gave you.',
      inputSchema: { paths: z.array(z.string().min(1)).min(1).describe('Absolute paths of files or folders') }
    },
    async ({ paths }) => {
      const assets = await importMany(paths)
      if (!assets.length) throw new Error('Nothing was imported — check the paths exist and are video, audio or image files')
      await callRenderer('addMedia', { ids: assets.map((a) => a.id) })
      return json(assets.map(describeAsset))
    }
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
    async ({ mediaId, fromSec, toSec, words }) => {
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
    }
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
    async ({ mediaId, times, count }) => {
      const asset = requireAsset(await projectAssets(), mediaId)
      const v = asset.probe.video
      if (!v) throw new Error(`${asset.fileName} has no picture`)
      const dir = await fsp.mkdtemp(join(getSubdir('tmp'), 'frames-'))
      try {
        const content: CallToolResult['content'] = []
        for (const t of frameTimes(asset.probe.durationSec, times, count)) {
          const out = join(dir, `${t.toFixed(3)}.jpg`)
          const chain = [...(v.isHdr ? [hdrToSdrChain(v)] : []), 'scale=360:-2']
          await generateStill(asset.originalPath, out, t, chain, alphaInputDecoder(v))
          content.push({ type: 'text', text: `${asset.fileName} @ ${t.toFixed(2)}s` })
          content.push({ type: 'image', mimeType: 'image/jpeg', data: (await fsp.readFile(out)).toString('base64') })
        }
        return { content }
      } finally {
        await fsp.rm(dir, { recursive: true, force: true })
      }
    }
  )

  server.registerTool(
    'get_timeline',
    {
      description:
        'What is on the timeline now (the composition open in the editor): each layer with TIMELINE start/end and, for video, its SOURCE in/out; audio clips; total duration.'
    },
    async () => json(await callRenderer('getTimeline', {}))
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
    async ({ items, mode, atSec }) => {
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
    }
  )

  server.registerTool(
    'remove_items',
    {
      description: 'Delete timeline items by id (from get_timeline). Linked partners (a clip and its audio) go together. One undo step.',
      inputSchema: { ids: z.array(z.string()).min(1) }
    },
    async ({ ids }) => json(await callRenderer('removeItems', { ids }))
  )

  server.registerTool(
    'undo',
    { description: 'Undo the last edit (yours or the user\'s) — one step. Returns the timeline after undoing.' },
    async () => json(await callRenderer('undo', {}))
  )

  server.registerTool(
    'export_video',
    {
      description:
        'Render the whole project to an .mp4 exactly as the Export button does, into the export folder from Settings. Waits until the render finishes (progress shows in the editor). Never overwrites: a taken name gets " (2)". Only export when the user asks.',
      inputSchema: { fileName: z.string().max(120).optional().describe('File name without folder, e.g. "beach reel"') }
    },
    async ({ fileName }) => {
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
    }
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
    async (req) => {
      const r = await fileFeatureRequest(req)
      return text(r.status === 'duplicate' ? `Already requested: "${req.title}" is in ${r.path}` : `Filed in ${r.path}:\n${r.entry}`)
    }
  )
}
```

If typecheck reports `CallToolResult['content']` push type mismatches, annotate the two `content.push` objects `as const` on `type` (`type: 'text' as const`, `type: 'image' as const`).

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck` then `npm test`
Expected: clean / PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/importMany.ts src/main/ipc.ts src/main/assistant/tools.ts
git commit -m "feat(assistant): MCP tools for library, transcripts, frames, timeline, export and feature requests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: HTTP adapter + MCP server lifecycle

**Files:**
- Create: `src/main/assistant/http.ts`, `src/main/assistant/http.test.ts`
- Create: `src/main/assistant/server.ts`
- Modify: `src/main/index.ts`, `src/main/ipc.ts`

**Interfaces:**
- Consumes: `registerTools` (Task 9); `getSettings` (Task 7); `AssistantServerState` (Task 5).
- Produces: `checkAccess(headers, token): { ok: true } | { ok: false; status: number; message: string }`; `toWebRequest(req: IncomingMessage): Promise<Request>`; `writeWebResponse(res: ServerResponse, response: Response): Promise<void>`; `listenLocal(server: Server, port: number): Promise<AssistantServerState>`; `startAssistantServer(): Promise<AssistantServerState>` (restarts if running); `stopAssistantServer(): Promise<void>`; `assistantState(): AssistantServerState`. Env `REEL_ASSISTANT_PORT` overrides the port (e2e uses `0`).

- [ ] **Step 1: Write the failing test**

`src/main/assistant/http.test.ts`:
```ts
// @vitest-environment node
import { createServer } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { checkAccess, listenLocal, toWebRequest, writeWebResponse } from './http'

const TOKEN = 't'.repeat(48)

describe('checkAccess', () => {
  it('accepts the right bearer token with no Origin', () => {
    expect(checkAccess({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toEqual({ ok: true })
  })
  it('rejects a missing or wrong token with 401', () => {
    expect(checkAccess({}, TOKEN)).toMatchObject({ ok: false, status: 401 })
    expect(checkAccess({ authorization: 'Bearer nope' }, TOKEN)).toMatchObject({ ok: false, status: 401 })
  })
  it('rejects any browser Origin with 403, even with the token', () => {
    expect(checkAccess({ authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' }, TOKEN)).toMatchObject({ ok: false, status: 403 })
  })
  it('allows the literal "null" origin', () => {
    expect(checkAccess({ authorization: `Bearer ${TOKEN}`, origin: 'null' }, TOKEN)).toEqual({ ok: true })
  })
})

describe('toWebRequest / writeWebResponse', () => {
  it('carries method, url, headers and body across', async () => {
    const req = Object.assign(Readable.from([Buffer.from('{"a":1}')]), {
      method: 'POST',
      url: '/mcp',
      headers: { host: '127.0.0.1:5', 'content-type': 'application/json' }
    }) as unknown as IncomingMessage
    const web = await toWebRequest(req)
    expect(web.method).toBe('POST')
    expect(web.url).toBe('http://127.0.0.1:5/mcp')
    expect(web.headers.get('content-type')).toBe('application/json')
    expect(await web.json()).toEqual({ a: 1 })
  })

  it('drops transfer-encoding/content-length so node frames the body itself', async () => {
    const sink = new PassThrough()
    let head: { status?: number; headers?: Record<string, string> } = {}
    const res = Object.assign(sink, {
      writeHead(status: number, headers: Record<string, string>) {
        head = { status, headers }
        return this
      }
    }) as unknown as ServerResponse
    const chunks: Buffer[] = []
    sink.on('data', (c: Buffer) => chunks.push(c))
    await writeWebResponse(res, new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }))
    await new Promise((r) => sink.on('end', r))
    expect(head.status).toBe(200)
    expect(head.headers).toEqual({ 'content-type': 'application/json' })
    expect(Buffer.concat(chunks).toString()).toBe('{"ok":true}')
  })
})

describe('listenLocal', () => {
  it('reports the bound port', async () => {
    const s = createServer()
    const state = await listenLocal(s, 0)
    expect(state.state).toBe('running')
    s.close()
  })

  it('reports a taken port instead of throwing', async () => {
    const holder = createServer()
    const held = await listenLocal(holder, 0)
    if (held.state !== 'running') throw new Error('setup failed')
    const state = await listenLocal(createServer(), held.port)
    expect(state).toMatchObject({ state: 'error' })
    expect(state.state === 'error' && state.message).toMatch(/already in use/)
    holder.close()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/assistant/http.test.ts`
Expected: FAIL — cannot resolve `./http`.

- [ ] **Step 3: Implement `http.ts`**

`src/main/assistant/http.ts`:
```ts
/**
 * node:http plumbing for the assistant's MCP server.
 *
 * Why not the SDK's `StreamableHTTPServerTransport`: verified 2026-10-06
 * (SDK 1.32.1, Node 24) that its Node wrapper answers with
 * `transfer-encoding: chunked` but an UNFRAMED body, which every HTTP client
 * rejects ("Invalid character in chunk size"). We use the web-standard
 * transport and convert here, dropping the framing headers so Node sets them.
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { AssistantServerState } from '@shared/assistant/protocol'

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Token required; a browser Origin is refused (a web page must not drive the editor). */
export function checkAccess(
  headers: IncomingHttpHeaders,
  token: string
): { ok: true } | { ok: false; status: number; message: string } {
  const origin = headers.origin
  if (origin !== undefined && origin !== 'null') return { ok: false, status: 403, message: 'Browser origins are not allowed' }
  const auth = headers.authorization ?? ''
  if (!token || !sameSecret(auth, `Bearer ${token}`)) return { ok: false, status: 401, message: 'Missing or wrong bearer token' }
  return { ok: true }
}

export async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v)
    else if (Array.isArray(v)) headers.set(k, v.join(', '))
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0
  return new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body: hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined
  })
}

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((v, k) => {
    if (k !== 'transfer-encoding' && k !== 'content-length') headers[k] = v
  })
  res.writeHead(response.status, headers)
  if (!response.body) {
    res.end()
    return
  }
  Readable.fromWeb(response.body as unknown as NodeReadableStream).pipe(res)
}

/** Listen on 127.0.0.1 only. A taken port is a reported state, not a crash. */
export function listenLocal(server: Server, port: number): Promise<AssistantServerState> {
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve({
        state: 'error',
        message:
          err.code === 'EADDRINUSE'
            ? `Port ${port} is already in use (is another copy of the editor open?)`
            : err.message
      })
    })
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ state: 'running', port: typeof addr === 'object' && addr ? addr.port : port })
    })
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/assistant/http.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Implement `server.ts`**

`src/main/assistant/server.ts`:
```ts
/**
 * The assistant's MCP server: stateless Streamable HTTP on 127.0.0.1, one
 * fresh McpServer + transport per request (the SDK's stateless pattern).
 * Claude Code registers it once (Settings shows the command).
 */

import { app } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AssistantServerState } from '@shared/assistant/protocol'
import { getSettings } from '../services/settings'
import { checkAccess, listenLocal, toWebRequest, writeWebResponse } from './http'
import { registerTools } from './tools'

const INSTRUCTIONS =
  'Tools for the Reel Editor desktop app, which is open on this computer. Times are seconds: SOURCE time is a position inside a media file, TIMELINE time is a position in the edit. Workflow: list_media, get_transcript (and get_frames when the picture matters), choose the cut, one place_sequence call, then get_timeline to verify. An order the user gives is authoritative. Export only when asked. If an ability is missing, call request_feature instead of approximating.'

let http: Server | null = null
let state: AssistantServerState = { state: 'off' }

export const assistantState = (): AssistantServerState => state

async function handle(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const access = checkAccess(req.headers, token)
  if (!access.ok) {
    res.writeHead(access.status, { 'content-type': 'text/plain' }).end(access.message)
    return
  }
  if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') {
    res.writeHead(404).end()
    return
  }
  const server = new McpServer({ name: 'reel-editor', version: app.getVersion() }, { instructions: INSTRUCTIONS })
  registerTools(server)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await writeWebResponse(res, await transport.handleRequest(await toWebRequest(req)))
  } catch (err) {
    console.error('[assistant] request failed', err)
    if (!res.headersSent) {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }))
    }
  }
}

/** (Re)start from the current settings; returns the new state. */
export async function startAssistantServer(): Promise<AssistantServerState> {
  await stopAssistantServer()
  const { assistant } = await getSettings()
  if (!assistant.enabled) return (state = { state: 'off' })
  const envPort = process.env.REEL_ASSISTANT_PORT
  const port = envPort !== undefined && envPort !== '' ? Number(envPort) : assistant.port
  const server = createServer((req, res) => void handle(req, res, assistant.token))
  state = await listenLocal(server, port)
  if (state.state === 'running') http = server
  else console.error('[assistant]', state.state === 'error' ? state.message : state)
  return state
}

export async function stopAssistantServer(): Promise<void> {
  const s = http
  http = null
  state = { state: 'off' }
  if (!s) return
  s.closeAllConnections()
  await new Promise<void>((resolve) => s.close(() => resolve()))
}
```

- [ ] **Step 6: Wire lifecycle, status IPC and restart-on-change**

In `src/main/index.ts`:
- import: `import { startAssistantServer, stopAssistantServer } from './assistant/server'`
- inside `app.whenReady().then(() => { … })`, directly after `createWindow()`, add:
```ts
  void startAssistantServer()
```
- after the `whenReady` block, add:
```ts
app.on('before-quit', () => {
  void stopAssistantServer()
})
```

In `src/main/ipc.ts`:
- import: `import { assistantState, startAssistantServer } from './assistant/server'`
- replace the `IPC.updateSettings` handler with:
```ts
  ipcMain.handle(IPC.updateSettings, async (_event, patch: Partial<Settings>) => {
    const next = await updateSettings(patch)
    // Toggling the assistant (or any change to it) restarts the server live.
    if (patch.assistant) await startAssistantServer()
    return next
  })
  ipcMain.handle(IPC.assistantStatus, () => assistantState())
```

- [ ] **Step 7: Build and probe the running server by hand**

Run: `npm run typecheck`, `npm test`, then `npm run build` — expected: all succeed. Then start the app (`npm run dev`), and in another terminal:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:47823/mcp
```
Expected: `401`. (Full protocol checks are automated in Task 12.) Close the app.

- [ ] **Step 8: Commit**

```bash
git add src/main/assistant/http.ts src/main/assistant/http.test.ts src/main/assistant/server.ts src/main/index.ts src/main/ipc.ts
git commit -m "feat(assistant): local MCP HTTP server with token/origin guard and live toggle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Settings UI

**Files:**
- Modify: `src/renderer/src/components/SettingsModal.tsx`

**Interfaces:**
- Consumes: `assistantStatus` (Task 8), `mcpAddCommand`, `Settings.assistant` (Task 7), `Check`, `btnCls` (`components/ui.tsx`).
- Produces: checkbox labelled exactly `Let Claude Code control the editor`; status line with `data-testid="assistant-status"` reading `Off`, `Running on 127.0.0.1:<port>`, or the error message; a `Copy` button for the command.

- [ ] **Step 1: Implement**

In `SettingsModal.tsx`:

1. Imports become:
```tsx
import { useEffect, useState, type JSX } from 'react'
import type { Settings } from '@shared/settings'
import { mcpAddCommand } from '@shared/settings'
import type { AssistantServerState } from '@shared/assistant/protocol'
import { useUi } from '@/state/ui'
import { assistantStatus, chooseExportDir, getSettings, updateSettings } from '@/ipc/client'
import { btnCls, Check } from './ui'
```

2. Inside the component, after the `settings` state:
```tsx
  const [status, setStatus] = useState<AssistantServerState | null>(null)
  const [copied, setCopied] = useState(false)
  const refreshStatus = (): void => void assistantStatus().then(setStatus)

  useEffect(() => {
    if (!open) return
    void getSettings().then(setSettings)
    refreshStatus()
    setCopied(false)
  }, [open])
```
(replace the existing `useEffect` with this one).

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
            : status.state === 'running'
              ? `Running on 127.0.0.1:${status.port}`
              : status.state === 'off'
                ? 'Off'
                : status.message}
        </p>
        {settings?.assistant.enabled && (
          <>
            <p className="mt-2 text-[11px] text-zinc-400">
              Register once — then every Claude Code session can use the editor while it is open:
            </p>
            <div className="mt-1 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[10px] text-zinc-300">
                {mcpAddCommand(status?.state === 'running' ? status.port : settings.assistant.port, settings.assistant.token)}
              </code>
              <button
                className={btnCls}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(
                      mcpAddCommand(status?.state === 'running' ? status.port : settings.assistant.port, settings.assistant.token)
                    )
                    .then(() => setCopied(true))
                }
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

Run: `npm run typecheck` — expected clean. Run `npm run dev`, open Settings: the AI assistant section shows the checked box, `Running on 127.0.0.1:47823`, and the command with your token; unchecking shows `Off` and hides the command; re-checking restores it. Close the app.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SettingsModal.tsx
git commit -m "feat(assistant): Settings toggle, server status and registration command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end spec

**Files:**
- Modify: `e2e/fixtures.ts`
- Create: `e2e/assistant.spec.ts`

**Interfaces:**
- Consumes: everything above, through the real MCP protocol (SDK client) and real UI events.

- [ ] **Step 1: Make every launch hermetic for the assistant**

In `e2e/fixtures.ts`, in the `env` passed to `electron.launch`, add:
```ts
        // Never collide with a dev app on 47823; never touch the repo's TODO.
        REEL_ASSISTANT_PORT: '0',
        REEL_TODO_PATH: join(scratch, 'TODO.md'),
```

- [ ] **Step 2: Write the spec**

`e2e/assistant.spec.ts`:
```ts
/**
 * The AI assistant's MCP server, driven through the real protocol (SDK client)
 * against the built app: auth, feature requests, the Settings toggle, and a
 * rough cut → undo → export round trip on synthesized media. ARRANGE via store /
 * files, ACT via MCP calls and real clicks, ASSERT on store + DOM + files.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { test, expect } from './fixtures'

const BIN = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg')
const FFMPEG = join(BIN, 'ffmpeg.exe')
const FFPROBE = join(BIN, 'ffprobe.exe')

type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }
const textOf = (r: ToolResult): string => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

async function serverInfo(page: Page): Promise<{ port: number; token: string }> {
  const status = await page.evaluate(() => window.api.assistantStatus())
  if (status.state !== 'running') throw new Error(`assistant server not running: ${JSON.stringify(status)}`)
  const settings = await page.evaluate(() => window.api.getSettings())
  return { port: status.port, token: settings.assistant.token }
}

async function connect(page: Page): Promise<Client> {
  const { port, token } = await serverInfo(page)
  const client = new Client({ name: 'e2e', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return client
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  (await c.callTool({ name, arguments: args })) as ToolResult

test('refuses requests without the token or from a browser origin', async ({ appPage: page }) => {
  const { port, token } = await serverInfo(page)
  const url = `http://127.0.0.1:${port}/mcp`
  const body = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' })
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401)
  expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body })).status).toBe(401)
  const fromPage = await fetch(url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}`, origin: 'https://evil.example' }, body })
  expect(fromPage.status).toBe(403)
})

test('lists the tools and names valid ids for an unknown media id', async ({ appPage: page }) => {
  const c = await connect(page)
  const names = (await c.listTools()).tools.map((t) => t.name).sort()
  expect(names).toEqual(
    ['export_video', 'get_frames', 'get_timeline', 'get_transcript', 'import_media', 'list_media', 'place_sequence', 'remove_items', 'request_feature', 'undo'].sort()
  )
  const r = await call(c, 'get_transcript', { mediaId: 'nope' })
  expect(r.isError).toBe(true)
  expect(textOf(r)).toMatch(/No media "nope".*Valid ids/s)
  await c.close()
})

test('files a feature request into the TODO list once', async ({ appPage: page, electronApp }) => {
  const todo = await electronApp.evaluate(() => process.env.REEL_TODO_PATH as string)
  writeFileSync(todo, '# TODO\n\n## Open\n\n- [ ] x\n')
  const c = await connect(page)
  const req = { title: 'Beat snap', problem: 'Wanted cuts on the beat of the music.', proposal: 'detect_beats tool' }
  expect(textOf(await call(c, 'request_feature', req))).toMatch(/^Filed in/)
  expect(textOf(await call(c, 'request_feature', req))).toMatch(/^Already requested/)
  const md = readFileSync(todo, 'utf8')
  expect(md).toMatch(/## Assistant requests\n\n- \[ \] \*\*Beat snap\*\* — Wanted cuts on the beat of the music\. _Proposal:_ detect_beats tool _\(requested by assistant, \d{4}-\d{2}-\d{2}\)_\n\n## Open/)
  await c.close()
})

test('the Settings toggle stops and restarts the server', async ({ appPage: page }) => {
  const before = await serverInfo(page)
  await page.evaluate(() => window.__reelStores.useUi.getState().setSettingsOpen(true))
  const toggle = page.getByLabel('Let Claude Code control the editor')
  await expect(toggle).toBeChecked()

  await toggle.click()
  await expect(page.getByTestId('assistant-status')).toHaveText('Off')
  await expect(fetch(`http://127.0.0.1:${before.port}/mcp`, { method: 'POST' })).rejects.toThrow()

  await toggle.click()
  await expect(page.getByTestId('assistant-status')).toHaveText(/^Running on 127\.0\.0\.1:\d+$/)
  const c = await connect(page)
  expect((await c.listTools()).tools.length).toBe(10)
  await c.close()
})

test('rough cut in the given order, undone in one step, then exported', async ({ appPage: page }) => {
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
  const c = await connect(page)

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

- [ ] **Step 3: Run the new spec**

Run: `npm run build` then `npx playwright test e2e/assistant.spec.ts`
Expected: 5 passed (the rough-cut test must PASS, not skip — if it skips, `resources\bin\ffmpeg` is missing; redo Task 1 Step 1).

- [ ] **Step 4: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: all pass (this also covers `addVideoLayer`'s audio-helper refactor via `link.spec.ts` and friends). Note how many specs SKIP and confirm none of them skip for the ffmpeg reason.

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures.ts e2e/assistant.spec.ts
git commit -m "test(assistant): e2e for MCP auth, feature requests, toggle and rough-cut/undo/export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: `/edit-video` skill + docs

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

You are driving the Reel Editor desktop app, which is open on this computer. Every
change you make appears live in the user's timeline and is undoable with Ctrl+Z.

## 0. Check the connection first

Look for tools named `mcp__reel-editor__*` (e.g. `mcp__reel-editor__list_media`).
If they are missing, stop and tell the user:

- open the Reel Editor app, and
- if they have never registered it: open **Settings → AI assistant**, copy the
  `claude mcp add …` line, run it in a terminal, then start a new Claude Code session.

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

Add a section (placed after the "UI (renderer)" table's section, before the next `##`):
```markdown
## AI assistant (MCP) — `src/shared/assistant/`, `src/main/assistant/`, `lib/sequence.ts`

| Concept | Home | Use instead of |
| --- | --- | --- |
| `applySequence(comp, plan, ctx)`, `makeExtractedAudioClip(…)` | `lib/sequence.ts` | building trimmed video layers + their linked audio by hand. `applySequence` lays clips end-to-end through `makeVideoLayer` + `trimVideoStart`/`trimVideoEnd` (never inline source↔timeline math); `makeExtractedAudioClip` is THE linked-audio shape, shared with `addVideoLayer`. Store entry point: `addVideoSequence(plan)` (one undo step) |
| `AssistantOps` + `callRenderer(op, args)` / `installAssistantBridge()` | `shared/assistant/protocol.ts`, `main/assistant/bridge.ts`, `renderer/assistant/handlers.ts` | reaching into renderer state from main any other way. Add an op to the `AssistantOps` table and both halves are type-checked against it |
| `summarizeTimeline(comp)` | `shared/assistant/timelineSummary.ts` | hand-serializing the timeline for the model |
| `transcriptPhraseText` / `transcriptWordText`, `frameTimes` | `shared/assistant/` | formatting transcripts / choosing frame times for the model |
| `sanitizeExportName`, `uniqueExportPath`, `exportRefusal` | `main/services/exportTarget.ts` | ad-hoc output naming for a dialog-less export (never overwrites; a name can't leave the export folder) |
| `appendAssistantRequest` / `fileFeatureRequest` | `main/assistant/todoAppend.ts`, `todoFile.ts` | editing docs/TODO.md from code (serialized; `REEL_TODO_PATH` overrides) |
| `checkAccess`, `toWebRequest`/`writeWebResponse`, `listenLocal` | `main/assistant/http.ts` | the SDK's Node `StreamableHTTPServerTransport`, which sends a broken chunked response on Node 24 (see the module header) |
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

- [~] **Claude Code can drive the editor** — local MCP server in main (`src/main/assistant/`, on by default, toggle + registration command in Settings), `/edit-video` skill (`.claude/skills/edit-video/`). Tools: list/import media, transcripts, source frames, timeline summary, `place_sequence` (one undo step), remove, undo, `export_video` (Settings export folder, never overwrites), `request_feature` (→ this file's "Assistant requests"). Spec: `docs/superpowers/specs/2026-10-06-ai-assistant-mcp-design.md`. `e2e/assistant.spec.ts` covers auth, the toggle, feature requests and a synthesized rough cut → undo → export. _Unverified: not yet smoke-tested with a real Claude Code session on real footage (rough cut in model-chosen and user-given order via `/edit-video`, then export, compared with a button export)._
```

- [ ] **Step 4: `README.md`**

In the `## Development` section, append:
```markdown
### AI assistant (Claude Code)

The editor runs a local MCP server (127.0.0.1, token-protected; toggle in
**Settings → AI assistant**). Register it once — Settings shows the exact line
with your token and a Copy button:

    claude mcp add --scope user --transport http reel-editor http://127.0.0.1:47823/mcp --header "Authorization: Bearer <token>"

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

### Task 14: Owner smoke test (manual — Definition of done)

This needs the owner; the executor prepares it and reports.

- [ ] **Step 1: Final automated gate**

Run: `npm run typecheck`, `npm test`, `npm run test:e2e`.
Expected: all green, assistant spec not skipped.

- [ ] **Step 2: Hand the owner this checklist**

1. `npm run dev` in this worktree. Settings → AI assistant shows "Running on 127.0.0.1:47823". Copy the command and run it in a terminal.
2. Start a NEW Claude Code session in this repo (worktree) and ask "list my editor's media" — the `reel-editor` tools should answer (approve the permission prompts).
3. Import 3–6 real clips (via `/edit-video` giving folder paths, or the app). Run `/edit-video make a ~30s reel` — watch the cut appear; Ctrl+Z once removes all of it.
4. Run `/edit-video` again with an explicit order ("clip C, then A, then B") — the timeline follows that order.
5. Ask it to export. The file lands in the Settings export folder; export the same project with the Export button and compare the two (same length, same look).
6. Ask for something it can't do ("add a beat-synced flash transition") — it files a request; check `docs/TODO.md` → "Assistant requests".

- [ ] **Step 3: Record the result**

If every step passed: change the TODO entry from `[~]` to `[x]` and delete its `_Unverified…_` sentence; commit `docs(assistant): mark Claude Code control smoke-tested`. If any step failed: leave `[~]`, replace the `_Unverified…_` sentence with exactly what failed, and fix before marking done.
