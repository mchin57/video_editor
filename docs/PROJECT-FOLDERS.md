# Project folders — media ownership design

_Status: **design agreed except decision 2** (2026-10-10). Nothing is implemented yet._

## Goals

1. Moving, renaming, deleting or replacing a source file can't break a clip.
2. Originals are not duplicated on disk.
3. Deleting a project's folder reclaims **all** of its disk space. Nothing stays behind in a shared store.

The global store `<data>/media/<hash>/` can't meet goal 3. The app opens one project at a time and
keeps no list of saved `.reel` files, so it can never know which store entries are unused.

## The shape

A project is a folder that owns everything it uses:

```
<Name>/
  <Name>.reel        the project document (JSON, same schema as today)
  autosave.json      the working copy (replaces the global projects/current.json)
  media/<id>/        what can't be rebuilt: the original, its record (asset.json), transcript.json
  cache/<id>/        what can be rebuilt: proxy.mp4|webm, audio.m4a, thumb.jpg, waveform.png, image.png
```

- **Originals are NTFS hardlinks** to the source file (`fs.link`). If linking fails (another volume,
  FAT/exFAT drive, network share, any error), the app copies the file instead. The file system's
  link count acts as the reference count: the same clip in five projects stores its bytes once, and
  the space is freed when the last link goes (the source file counts as one link).
- **`cache/` is always safe to delete.** A missing proxy, thumbnail or waveform is rebuilt the next
  time it's needed instead of causing an error. This already works this way today: every file is
  checked for existence before it's used.
- **Generated media lives in `media/`, not `cache/`.** That covers background-removed clips
  (`nobg/`), audio effects (`audiofx/`), extracted audio (`extracted/`) and stills (`stills/`). These
  files are written straight into the project rather than linked, and they can't be cheaply rebuilt:
  - background removal takes minutes of GPU time, and the output depends on the model and driver.
  - effects, extracted audio and stills use the hash of their output bytes as their id, and no record
    of how they were made is kept. A rebuild with a different ffmpeg could produce a new id and leave
    the clips that use it pointing at nothing.
- **Transcripts live in `media/`.** They are small but take minutes of CPU, and transcription only
  runs when the user starts it.
- **The `.reel` filename is kept inside the folder.** Open ▸ `.reel` then works for both legacy files
  and folders, and a file association can be added later. The project's name comes from the folder.
- **Settings, exports, `bin/` and `tmp/` stay in the data dir.** They don't belong to a project.

## Lifecycle

- **New / unsaved.** A single scratch project folder lives at `<data>/projects/scratch/`, and imports
  link into it straight away. If New or Open would discard a scratch project with content, the app
  shows the discard prompt it already has, then deletes the scratch folder.
- **First Save.** The user picks a location, and the scratch folder is renamed to it (a plain rename on
  the same volume). Across volumes the folder is copied. For each original, the app first tries to
  link to the source again if the source still exists on the destination volume with the same size,
  mtime and hash. Only after that does it fall back to copying.
- **Save As.** Creates a new folder. Originals are linked from the current folder, so this costs no
  extra space on the same volume. Records and transcripts are copied. Cache files are linked, or
  skipped and rebuilt later.
- **Autosave** writes `autosave.json` in the open folder. On open, the app restores it if it's newer
  than `<Name>.reel`. This keeps today's crash and restore behaviour.
- **Removing media from the library** does not delete its files right away, so undo still works. When
  a project opens, the app sweeps `media/<id>` and `cache/<id>` for ids that neither the document
  nor the autosave references. Undo history doesn't survive closing the project, so the sweep is safe.
- **The main process tracks the open folder.** Today only the renderer knows the file path. Every
  path the app uses goes through one pure layout module: the store, the `media://` protocol, the
  exporter, whisper, background removal and the assistant tools. The assistant tools currently read
  `asset.originalPath` directly.

## Changed-file detection

Each asset record stores the source path (for information and relinking), the hash, the size and
`mtimeMs` of its original, and whether the original is linked, copied or generated. The ids of new
imports stay equal to their hash. After an accepted change the id stays the same and only the hash
field changes. So import dedup looks up the hash field rather than the folder name.

Before the app uses an original (on project open, and before proxy, transcribe, export, background
removal or still jobs), it checks the size and mtime:

- **Same size and mtime:** the file is used as is.
- **Changed, but the content hash is the same:** the app quietly updates the stored size and mtime.
- **Content changed:** the asset is marked *changed*. Its card shows a badge with two choices: **Use
  the new file** (probe it again and rebuild its cache, keeping the id) or **Relink…**. Export is
  blocked and the message lists the affected files. The old bytes **can't be recovered**, because a
  hardlink shares them with the source (see below).
- **Missing:** the user deleted the file inside `media/`, so the asset is marked *missing*.
  Re-importing any file with the same hash relinks it, which also fixes the TODO bug "Deleted or MOVED
  files break the library".

**One rule follows from the links:** the app never writes in place to a file that could be a link.
Records are always written to a temp file and then renamed, and that rename breaks the link instead of
writing through it (verified below).

## Verified hardlink behaviour (NTFS, Windows 11, this machine)

| Action on the source file | Project's linked copy |
|---|---|
| Move or rename it; delete it (permanently or to the Recycle Bin); delete it and create a new file with the same name | **unaffected** |
| Replace it by moving another file over it (Explorer's engine, `MoveHere`) | **unaffected** |
| Overwrite it in place (`Copy-Item -Force`, `copy /y`) | **changes too** (the same bytes) |
| Replace it by copying another file over it (Explorer's engine, `Shell.Application` `CopyHere`) | **changes too**, and size and mtime change |
| Create the link (`fs.link`) | mtime is unchanged (only ctime changes), so it doesn't trip detection |
| Rewrite one link with temp + rename | the link breaks and the other link keeps the old bytes |

The Explorer rows used Explorer's copy engine through COM, not a literal drag in Explorer.

**Consequence:** if the user overwrites the source in place, the clip changes. Detection catches it,
but the old bytes can't be recovered. Explorer's folder Size also counts every linked original in full.
A Storage readout in the app should show the real space each project holds alone (link count 1).

## Migration

Owner decision: convert all the legacy projects, not one at a time.

**What exists today** (read-only survey, 2026-10-10):
- 19 `.reel` files under `Documents\Reels`, plus the working copy.
- Every original they reference is still on disk, and all of it is on C:, so conversion links rather
  than copies and costs no extra space for originals.
- 15 files already sit in a folder next to their footage. 4 sit loose at the top level.
- `recovery` uses 36 generated files (background removal and similar).
- 44 of the 167 entries in the old store aren't referenced by any project.

**The conversion:**
- **One batch action, "Convert projects in folder…",** pointed at `Documents\Reels`. Each `.reel` file
  is first run through `migrateProject`, which fills in `mediaIds` for very old files. Then a pure,
  tested planner goes through those ids:
  - If the original at `originalPath` exists and its hash matches, it is linked into `media/`.
  - Generated media comes from `nobg/`, `audiofx/`, `extracted/` and `stills/` the same way.
  - Transcripts are copied. Proxies and thumbnails are linked from the old store, so they don't have
    to be rebuilt.
  - Anything that can't be found is marked *missing*.

  At the end the batch reports, per project, how many files were linked, copied and missing.
- **A `.reel` already in its own folder:** that folder becomes the project folder.
  - `media/` and `cache/` are added next to the existing footage.
  - The document is written as `<Folder>.reel`, so for example `4 fun\save.reel` becomes
    `4 fun\4 fun.reel`.
  - The old file is kept as `<old name>.reel-legacy` as a backup.
  - The folder then holds each clip under two names but stores it once. Explorer shows about double
    the real size.
- **A loose `.reel`:** it moves into a new `Reels\<Name>\` folder and gets the same treatment.
- **The working copy:** it is converted into the scratch folder on the first launch after the update.
- **Opening a single legacy `.reel`** found later converts it the same way. Conversion is required,
  so there is no read-only legacy mode.
- **The old global store** (about 1.3 GB: `media/`, `nobg/`, `audiofx/`, `extracted/`, `stills/`) is
  deleted once the batch reports nothing missing, after a confirmation that shows its size. Until
  then it stays as the source for conversion.

## Phases (the app works after each one)

1. A pure layout module, main-owned open-folder state, the scratch folder, link-or-copy import,
   save, Save As and open of folders, and sweeping unused media on open.
2. Changed and missing detection, the card badges, Relink, and blocking export.
3. The batch conversion of legacy `.reel` files and `current.json`, then deleting the old store.
4. The Storage panel and an optional "share without cache" copy.

**Tests:** unit tests for the layout, the link-or-copy choice (by error code), the change check, the
migration planner and the sweep planner. A Playwright spec stubs the save dialog, then:
- saves a project and checks the folder layout and a link count of 2;
- reopens it and checks the library is intact;
- renames the source and checks the clip still plays;
- overwrites the source and checks the *changed* badge.

The schema version goes from 23 to 24, recording that the document lives in a folder. The
`migrateProject` step for the document is trivial; the real work is the main-side conversion.

This replaces the TODO entry "Self-contained project folder (portable save)". A project folder is
portable as it is, and leaving out `cache/` gives a lighter copy to share.

## Decisions

The owner answered on 2026-10-10.

1. **Across volumes:** copy the original. A project never points at a source in place.
2. **Overwriting a source in place:** _open_. The choice is between detection only and a per-project
   "always copy originals" option.
3. **Legacy projects:** convert them all with the batch action, then delete the old store. There is no
   legacy mode.
4. **Document name:** `<Name>/<Name>.reel`.
5. **OneDrive:** out of scope. The owner won't use it, and the copy fallback is the only safety net.
