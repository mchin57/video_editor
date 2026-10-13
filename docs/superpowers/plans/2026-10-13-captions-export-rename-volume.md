# Plan: caption annotations, export saves, library Rename, volume levels

2026-10-13. Four backlog items, built in worktrees by subagents and merged by a lead
session. No code in this plan (owner preference); each task names files, behaviour,
tests and the done bar.

Owner decisions already made:

- Captions: drop bracketed annotations AND `♪ … ♪` lyric spans. Do not use whisper's `-sns`.
- Export saves: a successful export runs File ▸ Save, so edits made during the export
  are saved too.
- Rename: a successful rename saves the project immediately.
- Volume levels: named levels, a permanent "Default" level, auto-join is a Settings
  toggle, and a clip's own volume is shown but locked while it is in a level.

Also confirmed by the owner: Default targets −16 LUFS; "Default" can't be renamed;
levels apply to audio clips only (not a video layer's own audio); `save_project` is
out of scope; the timeline right-click level menu is in scope. Branch from `main`
(`claude/text-auditor` stays unmerged; conflicts get sorted out later).

## Evidence gathered while planning (2026-10-13)

- **Annotations.** Real transcripts carry `(birds` `chirping)`, `(inhaling` `and`
  `exhaling)`, `[` `Pause` `]`, `(upbeat` `music)` and `♪ I could break you … ♪` as
  caption words.
- **`-sns`.** Tried on four real clips. It cleans clips that have speech but rewrites
  some real words ("Sorry." lost; "what your" became "why you're"). On clips with no
  speech it invents sentences: "I'm gonna get a box." on birdsong. Rejected.
- **Loudness timeline.** One ffmpeg pass gives momentary loudness every 0.1 s
  (`ebur128=metadata=1`) and a per-0.1 s sample peak (`asetnsamples` + `astats` with
  `reset=1`): 0.33 s for a 3-minute file.
  - Gated integrated loudness computed from the stored series matched ffmpeg's direct
    measurement of five windows of the recovery teleprompter file to 0.1 LU (−40.7,
    −59.2, −36.9, −34.9, −61.6).
  - Windowed peaks matched `astats` run directly (−14.5, −22.2).
  - `ebur128`'s own `true_peak` metadata is a running maximum, so it can't give a
    window's peak.
- **Levels in real footage.** iPhone clips measure about −18 to −21 LUFS. The
  recovery teleprompter recording measures −36 with a −12 dBFS peak, so a peak cap
  limits its boost to about +11 dB. A mostly silent window measured −59 LUFS.
- **Preview gain.** Preview playback above 0 dB already works through WebAudio
  (`lib/mediaGain.ts`). The Inspector volume slider is capped at +6 dB.

## Worktrees and agents

**Step 0 (lead):**
- Branch from `main`. `claude/text-auditor` stays unmerged for now; it overlaps
  `assistant/handlers.ts`, `shared/assistant/protocol.ts`, `mcp/tools.ts`,
  `Inspector.tsx` and `state/projectStore.ts`, so expect conflicts there later.
- Commit this plan and the TODO "Audit defaults and settings" entry on `main`, so
  every worktree sees them.

**Integration worktree (lead).**
- Location and branch: `.claude/worktrees/four-features` on branch
  `claude/four-features`, from `main`.
- The lead session owns this worktree: it creates the sub-worktrees, merges them, runs
  the full suites, edits `docs/TODO.md`, and hands over to the owner.

**Sub-worktrees.**
- The lead creates each with `git worktree add` from `claude/four-features`, not from
  `main`, so every one starts from the integration branch. One subagent works in each.

| Wave | Worktree / branch | Feature | Size |
|---|---|---|---|
| 1 | `ff-captions` / `claude/ff-captions` | 1. Caption annotations | S |
| 1 | `ff-export-save` / `claude/ff-export-save` | 2. Export saves | S |
| 1 | `ff-rename` / `claude/ff-rename` | 3. Library Rename | M |
| 1 | `ff-loudness` / `claude/ff-loudness` | 4A. Loudness engine (no UI) | M |
| 2 | `ff-levels` / `claude/ff-levels` | 4B. Volume levels | L |

- Wave 1 runs four agents in parallel; their files barely overlap.
- Wave 2 branches only after 4A and Rename have merged. It needs 4A's series and
  helper, and reuses Rename's context menu.

**Every worktree, before any test run:**
- Junction `node_modules` to the main checkout's.
- Junction `resources\bin\ffmpeg` straight to the winget ffmpeg 8.1.1 `bin` (the main
  checkout's `resources/bin` is empty). Without this the e2e media specs skip and
  report green.
- Never `npm install` inside a worktree.
- On cleanup, remove the junctions with `cmd /c rmdir` before deleting the worktree.

**Rules in every subagent brief:**
- Follow CLAUDE.md.
- Commit locally on your own branch only. Never push. Never merge.
- Don't edit `docs/TODO.md`; the lead does.
- Append your own notes to `FFMPEG-NOTES.md` / `SHARED.md` / `MEDIA-POINTERS.md`.
- Verify every ffmpeg or whisper assumption against the real binary in a scratch dir.
- Stub every native dialog in e2e; renderer alerts and confirms already cancel.
- Never kill the owner's dev app.
- Run only your own e2e specs. Two worktrees building at once can collide; the lead
  runs the full suite.
- Final report: commits, tests run (with counts and skips), and anything unverified.

**Merging (lead):**
- Merge each branch `--no-ff` into `claude/four-features` as it finishes, then run
  typecheck and `npm test`.
- Expected conflicts are additive only: IPC registries (`shared/ipc.ts`,
  `main/ipc.ts`, `preload/index.ts`, `ipc/client.ts`) from Rename and 4A, plus doc
  appends.
- Only 4B bumps `PROJECT_VERSION`; only Feature 1 bumps `TRANSCRIPT_VERSION`.

## Feature 1: caption annotations (`ff-captions`)

- **Parser (`main/services/whisperParse.ts`):** replace the whole-word noise check
  with span tracking across entries.
  - An entry opening with `(` or `[` starts a span, and the entry that closes it ends
    the span. Everything between is dropped.
  - `♪` marks open and close a span the same way.
  - Single-entry annotations like `(clicking)` behave as today.
- **Safety cap:** if a span doesn't close within about 8 entries, drop only the
  entries that themselves contain a bracket or `♪`. Real speech is never swallowed.
- **Word timings:** dropped entries keep bounding the previous word's end on the DTW
  path, as today.
- **Transcript version:** bump `TRANSCRIPT_VERSION` to 3 (`shared/transcript.ts`)
  with a history line. Captions already placed in projects are untouched until
  re-captioned.
- **Tests (`whisperParse.test.ts`):**
  - every real sequence above, on both the DTW and segment paths;
  - an unclosed bracket mid-speech;
  - the previous word's end is still bounded.
- **Real-binary check:** run whisper-cli with the current args on the four affected
  source files (recovery, tritips, FTP test, run club). Feed the JSON to the new
  parser and confirm no annotation survives and no spoken word is lost.
- **Docs:** rewrite the "STILL OPEN" annotation entry in `FFMPEG-NOTES.md` with the
  fix and the `-sns` findings.

## Feature 2: export saves the project (`ff-export-save`)

- **Export button (`components/ExportButton.tsx`):**
  - When the export resolves with a path, call the store's `save` action
    (`state/projectStore.ts`).
  - A thrown export, a cancelled Save dialog (null path), or an export blocked by
    missing media doesn't save.
  - If the save fails, the export still shows as done, plus "couldn't save the
    project: …" beside Reveal.
- **Assistant path:**
  - Add a `saveProject` renderer handler: `shared/assistant/protocol.ts` +
    `renderer/src/assistant/handlers.ts`, calling the same `save` action.
  - `export_video` (`main/assistant/tools.ts`) calls it after a successful export, and
    its result gains `saved: true` or `saveError`.
  - This handler is the core of the backlog's `save_project` tool. Exposing that tool
    is not in scope unless the owner asks.
- **e2e (`exportSaves.spec.ts`):**
  - Assistant path, no dialog: make an edit, export, then the on-disk `.reel` holds
    the edit and the project isn't dirty.
  - Button path with main's Save dialog stubbed to a temp file: same result.
  - Export blocked by missing media: the `.reel` is byte-identical.
  - Cancelled dialog: the `.reel` is byte-identical.

## Feature 3: library right-click → Rename (`ff-rename`)

- **Context menu:**
  - New shared `ContextMenu` in `components/ui.tsx`, styled like `FileMenu`'s items.
  - Opens at the cursor; closes on Escape, an outside click, or scroll.
  - Listed in `SHARED.md`.
- **Library card (`Library.tsx` / `ClipCard.tsx`):** right-click offers Rename… and
  Reveal in Explorer (existing `revealFile`). Rename is greyed out, with the reason,
  for Missing and unknown clips.
- **Rename dialog:** an in-app modal, never a native prompt.
  - You edit the name without its extension, which is shown fixed.
  - Validation errors show inline.
  - A note says other projects using this file will show it as Missing until
    relinked.
- **Pure helpers** (`main/services/projectLayout.ts`, next to `safeFileName`):
  - name validation: empty, illegal characters, a trailing dot or space, reserved
    Windows names, length;
  - the target path, with case-only renames of the same file allowed.
  - Unit tested.
- **Main (`renameMedia` in `main/services/mediaStore.ts`, plus IPC wiring in the four
  registries):**
  - Refuse when the clip is missing, the target exists, or a running job uses this
    media (`jobs.ts`).
  - Then `fs.rename`, and only after it succeeds update the record: `fileName` and
    paths via the existing `pointAt`, through `putEntry`.
  - Map Windows "in use" errors to a plain message.
  - The cache and transcript are keyed by id, so they need no change.
  - Files in `generated/` rename the same way.
- **Renderer:** on success, mark the library changed and run `save`.
- **Real-binary check:** on Windows, rename a file while ffmpeg is reading it, record
  the error code, and add it to `FFMPEG-NOTES.md`.
- **e2e (`libraryRename.spec.ts`):**
  - right-click → Rename → the file is renamed on disk, the card shows the new name,
    and the `.reel` is saved with the new path;
  - reopen → the clip is not Missing;
  - a taken name → error and nothing changes;
  - Escape cancels;
  - a Missing card's Rename is disabled.
- **Docs:** a Rename section in `MEDIA-POINTERS.md`.

## Feature 4A: loudness engine (`ff-loudness`)

The contract 4B relies on. Keep it exactly.

- **Series:**
  - Per media asset with audio, `cache/<id>/loudness.json`, carrying a format
    version.
  - One entry per 0.1 s: momentary loudness (LUFS, the 400 ms block ending there) and
    the sample peak (dBFS) of that 0.1 s.
  - Disposable, like the other cache files.
- **Generation (new `main/services/loudness.ts`, with a pure arg builder and output
  parser, both unit tested):**
  - One ffmpeg pass through `runFfmpeg`, written with `writeAtomically`.
  - Apply the clip's mono-fold pan (`monoFoldPan`, `audio.ts`) so the measurement
    hears what the mix hears.
  - Resample to 48 kHz first, so the 4800-sample peak frames are exactly 0.1 s.
  - Started from `hydrate` (`mediaStore.ts`) like the waveform, so new imports and
    already-imported files both get one.
- **Window math (pure `shared/loudness.ts`):** `windowLoudness(series, inSec, outSec)`
  returns the gated integrated loudness and the peak for that range, using the
  standard's gating (absolute −70, relative −10).
  - Returns "too short" under 0.4 s.
  - Golden tests use a slice of the real recovery series and the five ffmpeg-measured
    windows listed under Evidence.
- **IPC:** `getLoudness(mediaId)` for the preview. Export reads the file in main and
  regenerates it if missing.
- **e2e/integration:** importing a synthesized lavfi tone writes `loudness.json`, and
  its window loudness matches ffmpeg's direct measurement of that tone, checked with
  the binary first.
- **Docs:** an `FFMPEG-NOTES.md` entry covering the 0.1 s metadata cadence,
  `true_peak` being a running max, the verified `astats` per-frame peak, and the
  48 kHz requirement.

## Feature 4B: volume levels (`ff-levels`, after 4A and Rename merge)

- **Schema (`shared/project.ts`, bump `PROJECT_VERSION`, add a `migrateProject`
  step):**
  - `Project.volumeLevels`: id, name and target loudness. A level with the fixed id
    `default`, named "Default", always exists.
  - `AudioClip.volumeLevelId`: optional, at most one level.
  - Migration adds Default (−16 LUFS) and puts no existing clip in it, so finished
    reels sound the same.
- **Setting:** "Auto-join new clips to the Default volume level" in
  `shared/settings.ts` + `SettingsModal.tsx`, on by default.
- **Gain helper (pure, `shared/`):** for a clip in a level, gain = target − window
  loudness, then:
  - capped so the window's peak stays at or below −1 dBFS;
  - left unchanged ("nothing to match") when the window is quieter than −45 LUFS;
  - left unchanged ("too short") under 0.4 s, or while the series isn't ready yet;
  - for a clip in no level, its own `gainDb`;
  - mute still wins;
  - an effect track (`kind: 'fx'`) gets the same change its source clip got.
  - It returns a status the Inspector shows: matched / short by N dB (would clip) /
    nothing to match / too short / measuring.
  - Export and preview both call it; this is the parity point, so note it in
    `SHARED.md`.
- **Export:** resolve each clip's gain through the helper before `buildAudioGraph`
  (`audio.ts`). Add pinned `exporterArgs` cases: in a level, capped, floor, and no
  level (unchanged output).
- **Preview:** `PreviewStage.tsx` uses the helper for each audio element. Gains above
  0 dB already route through `lib/mediaGain.ts`.
- **Auto-join:**
  - The two places that create extracted clips (`lib/timeline.ts` on drop,
    `lib/sequence.ts` for the assistant) go through one helper. It sets Default when
    the setting is on.
  - Imported music and effect tracks never auto-join.
  - Splits keep the level (check `splitAudioClip`).
- **File ▸ Volume levels (`FileMenu.tsx`):**
  - Each level: set loudness, Rename, Delete.
  - Default can't be deleted or renamed.
  - Delete is one undo step; its clips return to their own volume.
  - Plus "Create new level…", a modal asking for the name.
- **Inspector (audio clip section):**
  - The clip's own Volume slider, greyed out and locked while the clip is in a level.
    Its value is kept and restored on leaving.
  - Below it, a "Volume level" picker: None / each level / New level….
  - Below that, the level's slider, which moves every clip in the level, plus the
    status line.
  - Raise the own slider's maximum above +6 dB (to +24).
- **Timeline right-click "Add to volume level ▸"** on an audio clip, using the Rename
  `ContextMenu`: None / each level / New level…. In scope (owner, 2026-10-13).
- **Tests:**
  - Unit: the helper (every status), the migration, delete-level.
  - e2e (`volumeLevels.spec.ts`), with two synthesized clips about 15 dB apart:
    - add both to a level → their effective gains differ by about 15 dB;
    - move the level slider → both change, and a clip in another level doesn't;
    - the own slider is locked in a level and restored after leaving;
    - Default can't be deleted;
    - auto-join off → a new extracted clip joins no level;
    - auto-join on → it joins Default.
- **Real-binary check:** export that project, then measure each clip's stretch of the
  output with `ebur128`. Each should be within 1 LU of the target, or short exactly
  as the cap predicts.

## Wave 3: integration and handover (lead)

1. After all five merges: typecheck, `npm test`, then the full e2e suite once,
   serially. Compare the skip count against `main`, so a missing junction can't hide.
2. **Review:** one read-only review agent over `main...claude/four-features`, looking
   at:
   - a kill path for every new spawn;
   - preview/export parity of the gain helper;
   - the migration;
   - Windows rename edge cases;
   - dialogs in specs.
   Fix each real finding with a regression test.
3. **Docs:** update the four `docs/TODO.md` entries to `[~]`, each stating what is
   unverified; check off the plan's evidence notes.
4. **Owner smoke test in `npm run dev`, with real projects.** Only after this do
   entries go to `[x]`.
   - Re-caption the clips in tritips, recovery and run club: no annotations.
   - Edit, export, close without saving, reopen: the edit is there.
   - Rename a clip in a project: Explorer shows the new name, and reopening the
     project finds it.
   - In fart lick (hand-levelled), put the voice clips in Default and listen; try the
     recovery teleprompter clip, which should show "short by N dB".
5. Merge `claude/four-features` into `main` only when the owner says so. Never push.
   Remove the junctions, then the worktrees.
