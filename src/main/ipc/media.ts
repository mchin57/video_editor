/** IPC: the media library — import, relink, rename, Quick cut, merge, descriptions. */

import type { WebContents } from 'electron'
import type { MediaAsset } from '@shared/media'
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, WORKOUT_EXTS } from '@shared/media'
import { importManyReport } from '../services/importMany'
import {
  ensureProxy,
  extractAudioToLibrary,
  getProjectMedia,
  relinkCheck,
  relinkMedia,
  renameMedia,
  type RelinkCheck,
  setMediaDescription
} from '../services/mediaStore'
import { onLibraryChanged } from '../services/library'
import { cutToLibrary } from '../services/quickCut'
import { mergeToLibrary } from '../services/merge'
import { broadcast, sendTo } from './events'
import { dialogsFor, handle, pickedPath } from './handle'

const ALL_MEDIA = { name: 'Media', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS, ...WORKOUT_EXTS] }
const ALL_FILES = { name: 'All files', extensions: ['*'] }

const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`

/** The Relink warning's detail: which fingerprint fields differ, in words. */
function relinkMismatchDetail(c: RelinkCheck): string {
  if (c.placeholder) {
    return (
      'Nothing records which file this clip was (its project was converted without the old media library), ' +
      "so this file can't be checked against it. The clip will use this file; its cuts on the timeline stay as they are."
    )
  }
  if (c.unknown) {
    return (
      `"${c.fileName}" was never fingerprinted (its file was already gone when the project was converted), ` +
      "so this file can't be checked against it. The clip will use this file; its cuts on the timeline stay as they are."
    )
  }
  const lines = c.differs.map((f) =>
    f === 'size'
      ? `File size: ${mb(c.recordedSize)} recorded, ${mb(c.foundSize)} in this file`
      : `Content sample at the ${f} of the file: different`
  )
  return (
    `This file doesn't match "${c.fileName}":\n${lines.join('\n')}\n\n` +
    'The clip will use this file. If its length differs, every place the clip is used on the timeline ' +
    'resets to the whole new file.'
  )
}

/**
 * An import the user started (dialog, drop, folder): the imported assets go
 * back as the call's result, and the files that failed go to that window as
 * `importSkipped` for its import notice (it would otherwise just not appear).
 * An event rather than a wider return type keeps `importPaths` returning the
 * assets, which every e2e spec builds on.
 */
async function importForUi(sender: WebContents, paths: string[]): Promise<MediaAsset[]> {
  const { assets, skipped } = await importManyReport(paths)
  if (skipped.length) sendTo(sender, 'importSkipped', skipped)
  return assets
}

export function registerMediaHandlers(): void {
  handle('importDialog', async (event) => {
    const picked = await dialogsFor(event).open({
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        ALL_MEDIA,
        { name: 'Video', extensions: VIDEO_EXTS },
        { name: 'Audio', extensions: AUDIO_EXTS },
        { name: 'Images', extensions: IMAGE_EXTS },
        { name: 'Workouts (.fit)', extensions: WORKOUT_EXTS },
        ALL_FILES
      ]
    })
    if (picked.canceled) return []
    return importForUi(event.sender, picked.filePaths)
  })

  handle('importPaths', (event, paths) => importForUi(event.sender, paths))

  // File ▸ Import folder… — same pipeline, the picker just yields directories.
  // (Dropping a folder on the window needs no separate channel: importManyReport
  // expands whatever it is handed.)
  handle('importFolderDialog', async (event) => {
    const picked = await dialogsFor(event).open({
      title: 'Import folder',
      buttonLabel: 'Import',
      properties: ['openDirectory', 'multiSelections']
    })
    if (picked.canceled) return []
    return importForUi(event.sender, picked.filePaths)
  })

  // Pick a video (or any media) file and pull its audio track into the library as
  // a standalone audio asset — no timeline placement required.
  handle('extractAudioDialog', async (event) => {
    const path = pickedPath(
      await dialogsFor(event).open({
        title: 'Extract audio from clip',
        properties: ['openFile'],
        filters: [
          { name: 'Video', extensions: VIDEO_EXTS },
          { name: 'Media', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS] },
          ALL_FILES
        ]
      })
    )
    return path ? extractAudioToLibrary(path) : null
  })

  handle('listProjectMedia', (_event, ids) => getProjectMedia(ids))
  handle('ensureProxy', (_event, id) => ensureProxy(id))

  // A library card's repair action (docs/MEDIA-POINTERS.md "Relink"): pick a
  // file; one that doesn't match the clip's fingerprint needs "Update path
  // anyway"; then other missing clips in that folder reconnect too. Null =
  // canceled at either question.
  handle('relinkMediaDialog', async (event, id) => {
    const dialogs = dialogsFor(event)
    const path = pickedPath(
      await dialogs.open({ title: 'Find the original file', properties: ['openFile'], filters: [ALL_MEDIA, ALL_FILES] })
    )
    if (!path) return null
    const check = await relinkCheck(id, path)
    if (!check.matches) {
      const answer = await dialogs.ask({
        type: 'warning',
        buttons: ['Update path anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'These fields do not match',
        message: 'These fields do not match. Update path anyway?',
        detail: relinkMismatchDetail(check)
      })
      if (answer.response !== 0) return null
    }
    const result = await relinkMedia(id, path, !check.matches)
    if (result.alsoFound.length) {
      const n = result.alsoFound.length
      await dialogs.ask({
        type: 'info',
        buttons: ['OK'],
        message: `Also reconnected ${n} other missing clip${n === 1 ? '' : 's'} found in that folder.`,
        detail: result.alsoFound.join('\n')
      })
    }
    return result
  })

  // A library card's Rename (docs/MEDIA-POINTERS.md "Rename"): the file on
  // disk first, then the record. Rejects with a plain reason.
  handle('renameMedia', (_event, id, stem) => renameMedia(id, stem))
  // Quick cut: one new clip in generated/ per piece (the original stays as it is).
  handle('quickCut', (_event, req) => cutToLibrary(req.mediaId, req.pieces))
  // Merge clips: one new clip in generated/ joining the segments in order.
  handle('mergeClips', (_event, segments) => mergeToLibrary(segments))
  handle('setMediaDescription', (_event, id, text) => setMediaDescription(id, text))

  // A library record changed after the project opened (import, relink, a path
  // fixed by a re-check): tell the renderer it now has unsaved changes.
  onLibraryChanged(() => broadcast('libraryChanged'))
}
