# Media pointers: the library points at your originals

Status: **design, approved direction (2026-10-11). Not implemented.** Branch `claude/media-pointers`.
This replaces the media-ownership half of [PROJECT-FOLDERS.md](PROJECT-FOLDERS.md): no more
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
     and the old cut is discarded, for now. The three-option follow-up is in TODO.md ▸ "Media
     relinking". A placement that grows follows the timeline's usual overlap rule.
4. **Relink one, fix the rest:** afterwards, the app scans the picked file's folder for the project's
   other missing clips (size first, then the samples) and reconnects every match. One summary line
   says how many were found.

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
  - Proxies are carried into `cache/` when they're on the same drive.
  - The old `.reel` is kept as `.reel-legacy`.
  - The batch keeps the "delete the old library" offer only when no old project is left anywhere the
    app looks (the 2026-10-10 fix).
- **Projects already in the hard-link format** (schema 24, a handful made on 2026-10-10):
  - The recorded source path becomes the absolute path.
  - If that file doesn't match, the copy already inside the project's `media/` is used instead, so
    nothing is lost.
  - Restoring those projects from backup and converting them as old projects is the cleaner route.
- Schema goes to 25; `migrateProject` gets a step.

## What goes away

Hard-linking and copying originals (`linkOrCopy` for originals, `placeAgain`, the `storage` field),
size + modified-date stamps and the "source was overwritten" logic in `mediaHealth`, `media/<id>/`
record files, the scratch folder, and the "Use the new file" button. *Relink* covers that case
through the mismatch warning.

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
7. Migration of old projects and schema-24 projects.
8. Remove the hard-link code; rewrite PROJECT-FOLDERS.md, SHARED.md, TODO.md and the end-to-end
   specs.

## Open

- The assistant's `new_project` TODO item needs a name and location under this model.
- One relink choice for every placement of a clip, or per placement (TODO.md ▸ "Media relinking").
