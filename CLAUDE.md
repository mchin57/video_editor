# Reel Editor — working notes for agents

Local Electron + React + TypeScript desktop video editor purpose-built for
Instagram Reels. Read this before adding code.

## Shape

- **Four layers.** `src/main/**` (Electron main: ffmpeg, media store, IPC
  handlers), `src/preload/index.ts` (the typed `api` bridge to the renderer),
  `src/renderer/**` (React UI), and `src/shared/**` (pure code imported by **both**
  main and renderer).
- **The 1080×1920 logical space is the contract.** Every spatial value (layers,
  captions, crops) is in this canonical logical space so the *same numbers*
  drive the CSS-scaled preview and the ffmpeg/ASS export. The project's output
  format (`shared/formats.ts`: 9:16, 1:1, 16:9, …) is a *window* centred on it
  (`shared/frame.ts`): changing format moves the window, never the layers, and
  both sides map through it (`frameCanvasStyle` / `frameToOutput`). Geometry/
  timing/style math that must agree on both sides lives in `src/shared/`
  (`layers.ts`, `project.ts`) — put it there, not in one side.
- **The project document** (`shared/project.ts`) is a single type-agnostic `layers`
  stack plus `audioClips` + `captions`. Schema changes need a bump + a step in
  `migrateProject`.

## Commands

- `npm run typecheck` — both node + web tsconfigs. Run after every change.
- `npm test` — vitest over the pure layers (exporterArgs/project/layers/assBuilder/
  audio/timeline/crop/checklist + ffmpegFilters). The `exporterArgs` tests pin the
  exact ffmpeg arg strings — keep them green; they're how we know export output
  didn't change.
- `npm run test:e2e` — Playwright drives the BUILT Electron app (builds first)
  with real pointer/keyboard events against a throwaway data dir + profile.
  This is where interaction guarantees live (drags, drops, keybinds, overlays)
  — the things vitest/jsdom can't express. Spec pattern: ARRANGE via
  `window.__reelStores` (real store actions), ACT via real events, ASSERT on
  store + DOM — see `e2e/fixtures.ts`. Keep it small and high-value; pure logic
  still goes in `src/**/*.test.ts`.
- `npm run dev` — launch the app.

## Reuse, don't duplicate

This codebase grew feature-by-feature and the same patterns drifted into 3–4
copies; a refactor consolidated them. **`docs/SHARED.md` is the catalog of shared
homes — check it before writing any of these:**

- a labelled form field / checkbox / stock input or button class → `components/ui.tsx`
- a pointer drag handler → `lib/pointerDrag.ts`
- a Default/On/Off override control → `OverrideToggle` in `Inspector.tsx`
- an array map-by-id / splice in a store action → `lib/arrays.ts`
- a text/caption style type → extend `TextStyleBase` (`shared/project.ts`)
- how a text block looks (box, wrap, leading, paint, pill) → `shared/textStyle.ts` — text layers
  and captions are ONE thing: the preview's `TextBlock` and the export both build from it, and
  burned text is laid out by Chromium, never wrapped or spaced by libass
  (docs/FFMPEG-NOTES.md "libass text metrics")
- an inherit / force-on / force-off setting → `resolveOverride` (`shared/project.ts`)
- the 1080×1920 constant → `FRAME` (`shared/frame.ts`, re-exported by `layers.ts`; `LOGICAL` in the renderer)
- an output format / aspect ratio / platform safe zone → the registry in `shared/formats.ts`
  (`defineAspect` + `definePreset`); read the project's with `projectFormat`
- aspect-fit box / image rotate-aspect math → `containBox`/`effectiveImageAspect` (`shared/layers.ts`)
- an ffmpeg `crop=`/`eq=` fragment or `toFixed(3)`/round → `services/ffmpegFilters.ts`
- an IPC call → add the name to the destructure in `ipc/client.ts` (don't re-wrap `window.api`)

When you extend or add a shared helper, update `docs/SHARED.md` too.

## Media semantics — the binary is the oracle

The arg-builder tests pin *strings*, not ffmpeg *behavior*; they stay green
while the command does the wrong thing (this once shipped a feature whose own
output never registered as alpha). Before wiring any new codec / container /
pix_fmt / filter interaction, verify the assumption against the real ffmpeg
once: synthesize a tiny input (lavfi) in a scratch dir, run the actual command,
inspect the result (ffprobe, `alphaextract`+`signalstats`, pixel dumps). Never
answer ffmpeg edge-case questions from memory. Verified traps live in
**`docs/FFMPEG-NOTES.md`** — read it before touching probe/proxy/export code,
and add an entry whenever you verify something new.

## Definition of done

There is no manual smoke test. A fix or feature is done when it has its tests
(a regression spec for a bug, unit and/or e2e coverage for a feature, plus a
real-ffmpeg check for new media behavior, per the section above) and
`npm run typecheck`, `npm test` and the full `npm run test:e2e` all pass. Then
close its GitHub issue with a comment naming the tests that cover it (commit
messages can say `Closes #N`). Leave the issue open, labelled `needs-verification`,
for work that is built but not yet passing or not yet tested. Docs must never
assert untested behavior as fact.

## Backlog = GitHub Issues

The backlog is **GitHub Issues** on `mchin57/video_editor` (`gh issue list`,
`gh issue create`). There is no `docs/TODO.md`: never create one, and never
write backlog entries into a file. Labels: `bug`, `enhancement`, `tech-debt`,
`assistant` (the editor's AI assistant), `manual-step` (hands-on owner steps),
`needs-verification` (built, not yet seen working), `out-of-scope-v1`. A bug
issue is symptom + repro only, no suspected cause or fix. The in-app assistant's
`request_feature` tool files issues itself (`main/assistant/issueFile.ts`).
`docs/archived/TODO-done-2026-10-16.md` is the history of work finished before
the move.

Interaction features (drags, keybinds, drop targets) should land with a
Playwright spec in `e2e/` where practical — and every interaction BUG you fix
gets a regression spec there. That is what converts `docs/TIMELINE.md`'s manual
checklist into guarantees a refactor can't silently break.

## Process & time-mapping rules

- Every `spawn()` needs a kill path on every exception route between spawn and
  the awaited exit — a throw in between leaks a live ffmpeg. Use `runFfmpeg`
  (`services/ffmpegRun.ts`) instead of re-rolling the spawn/progress/stderr-tail
  promise.
- All timeline-time ↔ source-time conversion goes through the shared helpers
  (`videoSourceTime` in `shared/layers.ts`; `trimVideoStart`/`trimVideoEnd`/
  `splitVideoLayer` in `lib/timeline.ts`). Freeze holds (and future speed
  ramps) make the mapping nonlinear — never re-derive it inline in a
  drag/split/trim handler.
- Anything implemented twice on purpose (CSS preview + ffmpeg export, renderer
  + main path selection) must either share a pure helper or be called out in
  the relevant doc's parity notes before the change lands.

## House rules

- **Never push.** Commit locally only — the owner runs every `git push`.
- Behavior-preserving refactors must keep `npm test` + `npm run typecheck` green at
  every step.
- **Don't let untested behavior get refactored away.** `npm test` only guards the
  pure layers; UI interaction (drag, scroll, pointer) is invisible to it, so a
  rewrite can silently drop a feature. Two defenses: (1) put a feature's pure
  logic in a `lib/`/`shared/` module with tests — then deleting it fails the suite
  or won't compile; (2) for the genuinely un-unit-testable parts, keep a
  behavior checklist (see `docs/TIMELINE.md`). Before refactoring a dense UI
  component, list the interactions it supports and confirm each is still green or
  checked off afterward.
