# Media pointers: the library points at your originals

Status: **implemented on branch `claude/media-pointers` (2026-10-11), phases 1–7.** Marked `[~]` in
TODO.md with what is verified; this doc describes the built behavior unless a line says otherwise.
This replaces the media-ownership half of [PROJECT-FOLDERS.md](archived/PROJECT-FOLDERS.md): no more
hard-linking or copying originals into the project. The project folder itself stays.

## Goals

- A library item points at the **original file where it already is**. Nothing is copied, linked or
  renamed.
- The pointer survives the common moves: the project folder moved together with its footage, or the
  project moved while the footage stayed put.
- A file that isn't the imported footage (re-downloaded, mangled, replaced under the same name) is
  never used silently.
- **The `.reel` changes only when you save.**

## The project folder

**New** asks for a name and a location in a small window (a name field and a *Choose location…*
button), then creates the whole structure at once. There is no untitled state.

```
<Name>/
  <Name>.reel     the save file (written at creation, then only by Save)
  generated/      media the editor makes: background removal, audio effects, extracted audio, stills
  transcripts/    whisper word timings, one file per clip (slow to rebuild, so not in cache/)
  cache/          proxies, thumbnails, waveforms, display PNGs (safe to delete, rebuilds itself)
  autosave.json   crash recovery (not the save file)
```

- A name whose folder already exists is refused in the window.
- Your footage can live in this folder too, as it often does today. Relative paths handle that well.
- `transcripts/` is new; today transcripts sit beside each clip's record in `media/`, which goes away.
- **At launch** the app reopens the last project. If there is none, or it's gone, a start screen
  offers New and Open. The scratch folder and the move-everything-on-first-save step go away.

## A library item

Each item keeps, **inside the `.reel`**:
- **Relative path**: from the `.reel`'s folder to the original. Empty when the original is on a
  different drive (Windows can't express that relatively).
- **Absolute path**: the full path at import, or at the last time it was found.
- **Fingerprint**: file size plus three quick content hashes, of small fixed-size samples from the
  start, middle and end of the file. Checking it reads a few MB per clip, whatever the file's size.
- What the editor already needs: display name, kind, the probe facts (duration, resolution, rotation,
  frame rate, audio layout), import date.

**Ids.** Existing clips keep their ids, which are what the timeline references. New imports get ids
derived from the fingerprint, so importing the same file twice still gives one library item, and
import no longer hashes whole multi-GB files.

**Generated media** is a real file in `generated/` with a readable name, referenced by relative path
like anything else.

## In memory until saved

- Main owns the open project's library in memory: import, probe, verification and proxies are its
  work. The renderer shows it, as it does now.
- Import, relinking and path fixes found on open all change the library **in memory** and mark the
  project as having unsaved changes.
- **Save** writes the document and the library into the `.reel`. Nothing else writes the `.reel`.
  A finished export (the Export button or the assistant's `export_video`) runs that same Save
  afterwards; a failed, blocked or canceled export doesn't.
- `autosave.json` mirrors the in-memory state for crash recovery, as it does today.
- The per-clip record files (`media/<id>/asset.json`) go away.

## Checking on open (and when the app regains focus)

For each item, try the **relative path first, then the absolute path**:

| What's found | Result |
|---|---|
| The relative path matches the fingerprint | Use it. If the absolute path differs, update it in memory. |
| Only the absolute path matches | Use it. Update the relative path in memory. |
| Neither matches (gone, or a different file) | **Missing**, with *Relink…* on the library card. |

- **Cost:** a stat for each path, then the samples only for a file whose size matches.
- **Export** refuses while any clip in the edit is missing, naming the files, as it does now.

## Relink

1. *Relink…* opens a file picker.
2. **The file matches the fingerprint:** update both paths in memory.
3. **It doesn't match:** a warning lists the fields that differ (size, start / middle / end sample)
   and asks *"These fields do not match. Update path anyway?"*
   - **Accepted:** both paths, the fingerprint and the probe follow the new file. Its cache is dropped
     so previews rebuild, and its transcript is dropped.
   - **Same length:** timeline cuts are kept.
   - **Different length:** every timeline placement of that clip resets to the new file's full length
     and the old cut is discarded, for now (`resetMediaCuts`, `shared/compositions.ts`: in 0 → out =
     new length, freeze holds and speed ramp cleared, a constant speed kept; nested comps too; one
     undo step). The three-option follow-up is in TODO.md ▸ "Media relinking". Layers are separate
     rows, so a placement that grows doesn't collide with another layer's clip.
   - **A clip that was never fingerprinted** (an old project converted after its file was gone,
     `UNKNOWN_FINGERPRINT`) always gets the warning, worded to say it can't be checked.
4. **Relink one, fix the rest:** afterwards, the app scans the picked file's folder for the project's
   other missing clips (size first, then the samples) and reconnects every match. An info box lists
   them.

## Unknown clips

A clip the document uses but no record describes (an old project converted while the old media
library was missing) would otherwise have no library card, and so could never be relinked. On open,
each such id gets a placeholder record (`unknownMedia.ts`): named "Unknown clip", no paths, the
`UNKNOWN_FINGERPRINT`, and a kind and length taken from how the timeline uses it. It is listed in the
library (added to `mediaIds` if needed — an unsaved change) and shows **Missing, unknown clip**.

Relink always asks "Update path anyway?" (nothing can be checked), then the clip takes the picked
file's name, kind, probe and fingerprint. Its cuts are **kept**: with no known old length there is
nothing to compare, so no reset.

## Rename

Right-clicking a library card opens a menu (the shared `ContextMenu`) with **Rename…** and **Reveal
in Explorer**. Both are greyed out, with the reason, for a Missing clip and an unknown clip: there
is no file to act on.

- **The dialog** (`RenameMediaDialog`, in-app) edits the name of the file **on disk** without its
  extension, which is shown fixed. It starts from the file's current name (which can differ from the
  card's name: a known clip relinked to a differently named file keeps its old display name, and
  generated media's display name may hold characters a file can't). The name is checked live with
  `validateFileStem` (`shared/fileName.ts`: empty, `< > : " / \ | ? *` and control characters, a
  trailing dot, the reserved device names `CON PRN AUX NUL COM1-9 LPT1-9` with any extension, and the
  255-character name limit); the name is trimmed, so a trailing space never reaches the disk. The
  dialog says other projects using this file will show it as Missing until relinked there.
- **Main (`renameMedia`)** re-checks the name and refuses, changing nothing, when the clip is unknown
  or missing, the name is already taken in that folder (`fs.rename` would silently replace that file
  on Windows; a case-only change of the same file is allowed), or a running job reads the file
  (proxy, captions, background removal, audio effect, export — `createJob(…, { uses })`) or a
  loudness pass is measuring it (`loudnessPassReading`; a queued pass reads the path only when it
  starts, so it follows the rename). Then it
  renames the file, and **only after that succeeded** updates the record: `fileName` and both paths
  (`pointAt`, so a file in `generated/` stays generated). A file another program holds open fails
  with `EBUSY` (verified, docs/FFMPEG-NOTES.md) and gets a plain "in use" message that also says
  the editor itself may still be reading it — thumbnail, waveform, mono-fold and silence passes
  read originals right after an open or import without a job — so "try again in a moment".
- **Unchanged:** the id, the fingerprint (same bytes), `cache/<id>/` and the transcript (both keyed
  by id).
- **Saving:** a successful rename **saves the project at once** (owner decision), so the `.reel`
  never names a file that no longer exists. Main updates its record quietly; the renderer marks the
  library changed and then runs Save (a change notification arriving after that Save would mark the
  project unsaved again).
- **Not guarded:** the taken-name check and the rename aren't atomic, so a file created under the
  new name in between would be replaced.
- **Tests:** `rename.test.ts` (main, real files, mocked probe), `fileName.test.ts`,
  `projectLayout.test.ts` (`renameTarget`), `ContextMenu.test.tsx`, and `e2e/libraryRename.spec.ts`
  (rename → disk, card and saved `.reel`; reopen finds it; a taken name refused; Escape cancels; a
  Missing card's Rename disabled).

## Save As

Writes the `.reel` into a new project folder, copying `generated/` and `transcripts/` (`cache/` is
optional). It recomputes every relative path against the new location. Absolute paths don't change.

## Cleanup on open

On opening a project, the app removes leftovers the project no longer uses:
- `cache/` entries for ids not in the library;
- `generated/` and `transcripts/` files that neither the saved `.reel` nor `autosave.json`
  references.

It **never touches anything outside `cache/`, `generated/` and `transcripts/`**: your footage often
lives in the same folder. If a document can't be read, nothing is deleted.

## Migration

- **Old projects** (schema before 24, media in the old shared library):
  - Each item's absolute path comes from the library's record. The fingerprint and relative path are
    computed now, and the original is checked as on open.
  - Generated originals are copied into `generated/` and transcripts into `transcripts/`.
  - Derived files (proxies, thumbnails, waveforms) are linked into `cache/`, or copied across drives;
    a failure is ignored because the cache rebuilds.
  - An original that is gone (or no longer the same bytes) is looked for beside the `.reel` by its
    old whole-file hash. Not found: the record gets `UNKNOWN_FINGERPRINT` and shows Missing.
  - Converted clips keep their OLD ids (the timeline references them); only new imports get
    fingerprint-derived ids.
  - The old `.reel` is kept as `.reel-legacy`.
  - The batch keeps the "delete the old library" offer only when no old project is left anywhere the
    app looks (the 2026-10-10 fix).
- **Where:** File ▸ Open of an old `.reel` offers to convert it, then opens the result; File ▸
  Convert old projects… converts a whole folder (top level + one level of subfolders).
- **Projects in the hard-link format** (schema 24) are **not migrated**. Only a handful were made, on
  2026-10-10, and the owner restores them from backup and converts them as old projects. Opening one
  shows a message saying so, and the file is left untouched.
- Schema goes to 25; `migrateProject` gets a step.

## What goes away

Hard-linking and copying originals (`placeAgain`, the `storage` field), size + modified-date stamps
and the "source was overwritten" logic in `mediaHealth`, `media/<id>/` record files, the scratch
folder, and the "Use the new file" button. *Relink* covers that case through the mismatch warning.
(`linkOrCopy` stays for cache files during conversion; `copyAtomic`/`moveFile` for generated media.)

## Tests

- **Unit:** the fingerprint (sample placement, small files), path resolution (every row of the
  table, a different drive, Windows case differences), the mismatch field list, cut reset by length,
  and the cleanup plan.
- **End-to-end (Playwright, real files):**
  - Move the project folder together with its footage: opens, and the absolute path updates.
  - Move the project alone: opens, and the relative path updates.
  - A path fix leaves the `.reel` unchanged until Save.
  - Rename a clip: missing → Relink → its folder-mates reconnect.
  - A mismatched file: warning → accept → a different length resets the cut.
  - Cleanup leaves a user file in the project folder alone.
  - New project window: creates the structure, and refuses an existing folder.
- **Manual in `npm run dev`:** convert a restored backup of `Documents\Reels`, and check playback,
  export and transcripts.

## Phases (the app works after each)

1. The pure module: fingerprint, path resolution, mismatch fields, length reset.
2. The library moves into the `.reel` and main's memory; Save is the only writer; autosave mirrors it.
3. Import without linking; fingerprint ids; `generated/` and `transcripts/`.
4. Checking on open, Missing, Relink with the warning, relink-one-fix-the-rest.
5. The New project window, no untitled state, the launch screen, Save As.
6. Cleanup limited to the three folders.
7. Migration of old projects; schema-24 projects refused with a restore-from-backup message.
8. Remove the hard-link code; rewrite PROJECT-FOLDERS.md, SHARED.md, TODO.md and the end-to-end
   specs.

## Related TODO items

- **The assistant's `new_project` tool** (TODO.md ▸ AI assistant features): same structure as New.
  The assistant must ask the user for the name; the location defaults to the Settings export folder.
- **Keeping cuts on a different-length relink** (TODO.md ▸ "Media relinking"): for a clip placed more
  than once, the window offers both one choice for every placement and a choice per placement.
