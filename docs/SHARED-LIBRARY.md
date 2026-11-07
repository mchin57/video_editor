# Shared library: assets every project can use

Status: **built on branch `feat/shared-library` (2026-11-06), issue #212.** Covered by
`shared/sharedLibrary.test.ts`, `main/services/sharedLibrary.test.ts`,
`lib/templates.test.ts` (`textPieceFromSelection`) and `e2e/sharedLibrary.spec.ts`.

Sound effects, music beds, logos, stickers, intro clips and text you reuse live in one
editor-wide library instead of being imported again in every project.

## Where to find it

**Insert ▸ Shared ▸** Sounds… / Graphics… / Video… / Text… / Templates…

- The first four open the shared library dialog on that tab.
- **Templates…** opens the template gallery (it moved here from Insert ▸ Template…).
  Insert ▸ Save selection as template… stays where it was.

## Storage

Like templates (services/templates.ts): one folder per item under
`Documents\VideoEditor\shared\<id>\` holding

- `item.json`: name, kind, date added, the file's length and fingerprint, and for a
  text piece its layers;
- the item's **own copy** of its file, so it keeps working when the original moves or
  is deleted;
- `thumb.jpg` for a video, or for a picture the browser can't draw (HEIC, TIFF). A PNG,
  JPEG, WebP, GIF, BMP or AVIF is its own preview.

The record is written last, so a half-written item never lists. A failed add leaves
nothing behind (tested for files refused before their folder is made; the cleanup after a
failed copy is in the code but not exercised by a test). A damaged record, or a folder
whose file has gone, is skipped. A file named `item.json` or `thumb.jpg` is stored as
`media.<ext>`.

## Adding

- **Add files…** on a tab opens a picker for that tab's file types (several at once). A
  file of another kind is not added: the note names it and says which tab it belongs on.
  A file that can't be read, or a workout, is refused with the reason. One failure never
  stops the rest.
- **The Library's right-click ▸ Add to shared library** copies that clip's original in,
  under the library card's name, and opens the dialog on its tab with a note. The row is
  built greyed out for a Missing or unknown clip and for a workout (not covered by a test).
- **The same content is never copied twice** (fingerprint): adding it again says it is
  already in the shared library.

## Text pieces

The Text tab's **Save selected text as [name]** saves the selected TEXT layers exactly as
they are: words, style, position, size, rotation, animation, keyframes and length, timed
from the earliest one. Other selected pieces are left out, and the note says so. Saving
under a name you already use replaces that text piece, like a template, so Rename refuses
a text piece's name that another one already has. Its card draws it with the
template gallery's preview component.

## Inserting

**Insert** puts the item at the playhead, selected, as **one undo step**:

- a sound → an audio clip; a picture → a 3 s image layer; a video → a video layer (its
  audio linked). The file is **copied into the project's `generated/`** first, so the
  project never points into the shared folder: its copy is a generated file like a
  template's media. Inserting the same item again reuses the project's copy. A video is
  placed before the project's copy has its preview proxy; the proxy then builds as for any
  import.
- a text piece → its layers at the playhead (several layers land as one link group, like
  a template's).

Previews (pictures, thumbnails, the play button on a sound) are served by the
`reelmedia://shared/<id>/<file>` protocol host, which reads the shared folder rather than
the open project (e2e checks a picture preview decodes; sound playback is not tested).

## Rename and delete

- **Rename** changes only the gallery name; the stored file keeps its own.
- **Delete** asks once ("Delete for good"), then removes the item's folder. Projects that
  inserted it keep their own copy.

## Follow-ups

Tracked in GitHub issue #213 (drag onto the timeline, assistant tools, templates using
the shared library, share files, a starter pack). None ship today, including starter
sounds or graphics.
