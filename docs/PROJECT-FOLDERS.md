# Project folders, schema 24 (hard-linked originals) — historical

_Status: **superseded (2026-10-11)** by [MEDIA-POINTERS.md](MEDIA-POINTERS.md). Kept as a record of
what schema 24 was, why it was dropped, and the hard-link facts verified for it._

## What schema 24 was (2026-10-10, one day)

A project was a folder that OWNED its media: every original was hard-linked (or, across drives,
copied) into `<Name>/media/<id>/original.<ext>` with a per-clip `asset.json`, beside `cache/`.
Unsaved work lived in a scratch folder in the data dir. Size + modified-time stamps detected an
original that changed, with "Use the new file" and "Relink…" on the library card.

## Why it was replaced

- The owner didn't want the library pointing at renamed copies (`original.mov` inside the project)
  rather than at their own files.
- A hard link shares bytes with its source: overwriting the source in place changed the project's
  clip too (table below), so ownership didn't protect against the case it was meant for.
- Converting old projects depended on the old shared library as the only record of where footage
  lived; a delete offer that checked one folder wiped that library while other projects still needed
  it (fixed, and kept as a rule: see MEDIA-POINTERS.md "Migration").

The replacement keeps the project folder but makes library items pointers to the originals in place
(relative path first, absolute second, checked against a size + sampled-hash fingerprint), with the
records saved inside the `.reel` and written only by Save. Schema-24 projects are refused with a
restore-from-backup message; their backups are converted as old projects instead.

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
