# Reel Editor — working notes for agents

Local Electron + React + TypeScript desktop video editor purpose-built for
Instagram Reels. Read this before adding code.

## Shape

- **Four layers.** `src/main/**` (Electron main: ffmpeg, media store, IPC
  handlers), `src/preload/index.ts` (the typed `api` bridge to the renderer),
  `src/renderer/**` (React UI), and `src/shared/**` (pure code imported by **both**
  main and renderer).
- **The 1080×1920 logical space is the contract.** Every spatial value (layers,
  captions, crops) is in this logical space so the *same numbers* drive the
  CSS-scaled preview and the ffmpeg/ASS export. Geometry/timing/style math that
  must agree on both sides lives in `src/shared/` (`layers.ts`, `project.ts`) —
  put it there, not in one side.
- **The project document** (`shared/project.ts`) is a single type-agnostic `layers`
  stack plus `audioClips` + `captions`. Schema changes need a bump + a step in
  `migrateProject`.

## Commands

- `npm run typecheck` — both node + web tsconfigs. Run after every change.
- `npm test` — vitest over the pure layers (exporterArgs/project/layers/assBuilder/
  audio/timeline/crop/checklist + ffmpegFilters). The `exporterArgs` tests pin the
  exact ffmpeg arg strings — keep them green; they're how we know export output
  didn't change.
- `npm run dev` — launch the app (preview/export aren't unit-covered, so smoke-test
  UI changes here).

## Reuse, don't duplicate

This codebase grew feature-by-feature and the same patterns drifted into 3–4
copies; a refactor consolidated them. **`docs/SHARED.md` is the catalog of shared
homes — check it before writing any of these:**

- a labelled form field / checkbox / stock input or button class → `components/ui.tsx`
- a pointer drag handler → `lib/pointerDrag.ts`
- a Default/On/Off override control → `OverrideToggle` in `Inspector.tsx`
- an array map-by-id / splice in a store action → `lib/arrays.ts`
- a text/caption style type → extend `TextStyleBase` (`shared/project.ts`)
- an inherit / force-on / force-off setting → `resolveOverride` (`shared/project.ts`)
- the 1080×1920 constant → `FRAME` (`shared/layers.ts`; `LOGICAL` in the renderer)
- aspect-fit box / image rotate-aspect math → `containBox`/`effectiveImageAspect` (`shared/layers.ts`)
- an ffmpeg `crop=`/`eq=` fragment or `toFixed(3)`/round → `services/ffmpegFilters.ts`
- an IPC call → add the name to the destructure in `ipc/client.ts` (don't re-wrap `window.api`)

When you extend or add a shared helper, update `docs/SHARED.md` too.

## House rules

- **Never push.** Commit locally only — the owner runs all `git push` himself.
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
