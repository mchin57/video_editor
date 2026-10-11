import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, promises as fsp } from 'node:fs'
import { join, parse } from 'node:path'
import { IPC, IPC_EVENT, type AudioFxRequest, type RelinkResult, type RemoveBackgroundRequest, type StillRequest } from '@shared/ipc'
import type { MediaAsset } from '@shared/media'
import { alphaInputDecoder, AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS } from '@shared/media'
import type { Project } from '@shared/project'
import { isNeutralColor } from '@shared/project'
import type { PresetId } from '@shared/formats'
import { getCapabilities } from './services/ffmpeg'
import { getDataDir } from './config'
import { generateStill } from './services/still'
import { importMany } from './services/importMany'
import { hdrToSdrChain } from './services/proxy'
import { cropFilter, eqFilter } from './services/ffmpegFilters'
import {
  ensureProxy,
  extractAudioToLibrary,
  getProjectMedia,
  importGenerated,
  relinkCheck,
  relinkMedia,
  type RelinkCheck,
  renderAudioFxToLibrary,
  requireUsable,
  tmpOutput
} from './services/mediaStore'
import {
  convertLegacyFolder,
  convertLegacyProject,
  deleteLegacyStore,
  legacyStoreBytes,
  remainingLegacyProjects,
  reportLine
} from './services/legacyConvert'
import {
  createProject,
  documentFormat,
  loadProject,
  openProject,
  REEL_EXT,
  saveProject,
  saveProjectAs,
  saveProjectFile,
  suggestedSavePath
} from './services/projectStore'
import { currentProjectRoot } from './services/projectRoot'
import { onLibraryChanged } from './services/library'
import { exportProject, suggestedExportName } from './services/exporter'
import type { Settings } from '@shared/settings'
import { getSettings, updateSettings } from './services/settings'
import { getTranscript, transcribeMedia, whisperAvailable } from './services/whisper'
import { detectSilence, type Interval } from './services/silence'
import { removeBackgroundToLibrary, segmentAvailable } from './services/removeBackground'
import { cancelJob, createJob, finishJob, setProgress } from './services/jobs'
import { registerAssistantBridge } from './assistant/bridge'
import { assistantStatus, startAssistant } from './assistant/service'

/** ffmpeg -vf chain to make a still match the preview (HDR → SDR, crop, color). */
function stillVfChain(asset: MediaAsset, req: StillRequest): string[] {
  const chain: string[] = []
  const v = asset.probe.video
  if (v?.isHdr) chain.push(hdrToSdrChain(v))
  if (req.crop) chain.push(cropFilter(req.crop))
  if (req.flipH) chain.push('hflip')
  if (req.flipV) chain.push('vflip')
  if (req.color && !isNeutralColor(req.color)) chain.push(eqFilter(req.color))
  return chain
}

/** The user folders an old project may sit in (never converted in place;
 *  scanned before the old library may be deleted). */
const userDirs = (): string[] => (['home', 'documents', 'desktop', 'downloads'] as const).map((k) => app.getPath(k))

const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`

/** The Relink warning's detail: which fingerprint fields differ, in words. */
function relinkMismatchDetail(c: RelinkCheck): string {
  if (c.unknown) {
    return (
      `"${c.fileName}" was never fingerprinted (its file was already gone when the project was converted), ` +
      "so this file can't be checked against it. The clip will use this file."
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

export function registerIpcHandlers(): void {
  registerAssistantBridge()
  ipcMain.handle(IPC.getCapabilities, () => getCapabilities())
  ipcMain.handle(IPC.getDataDir, () => getDataDir())

  ipcMain.handle(IPC.importDialog, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS] },
        { name: 'Video', extensions: VIDEO_EXTS },
        { name: 'Audio', extensions: AUDIO_EXTS },
        { name: 'Images', extensions: IMAGE_EXTS },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return importMany(result.filePaths)
  })

  ipcMain.handle(IPC.importPaths, (_event, paths: string[]) => importMany(paths))

  // File ▸ Import folder… — same pipeline, the picker just yields directories.
  // (Dropping a folder on the window needs no separate channel: importMany
  // expands whatever it is handed.)
  ipcMain.handle(IPC.importFolderDialog, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Import folder',
      buttonLabel: 'Import',
      properties: ['openDirectory', 'multiSelections']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return importMany(result.filePaths)
  })

  // Pick a video (or any media) file and pull its audio track into the library as
  // a standalone audio asset — no timeline placement required.
  ipcMain.handle(IPC.extractAudioDialog, async (event): Promise<MediaAsset | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Extract audio from clip',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: VIDEO_EXTS },
        { name: 'Media', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return extractAudioToLibrary(result.filePaths[0])
  })

  ipcMain.handle(IPC.listProjectMedia, (_event, ids: string[]) => getProjectMedia(ids))
  ipcMain.handle(IPC.ensureProxy, (_event, id: string) => ensureProxy(id))

  // A library card's repair action (docs/MEDIA-POINTERS.md "Relink"): pick a
  // file; one that doesn't match the clip's fingerprint needs "Update path
  // anyway"; then other missing clips in that folder reconnect too. Null =
  // canceled at either question.
  ipcMain.handle(IPC.relinkMediaDialog, async (event, id: string): Promise<RelinkResult | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const ask = (box: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
      win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box)
    const options: Electron.OpenDialogOptions = {
      title: 'Find the original file',
      properties: ['openFile'],
      filters: [
        { name: 'Media', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return null
    const path = picked.filePaths[0]
    const check = await relinkCheck(id, path)
    if (!check.matches) {
      const answer = await ask({
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
      await ask({
        type: 'info',
        buttons: ['OK'],
        message: `Also reconnected ${n} other missing clip${n === 1 ? '' : 's'} found in that folder.`,
        detail: result.alsoFound.join('\n')
      })
    }
    return result
  })

  // A library record changed after the project opened (import, relink, a path
  // fixed by a re-check): tell the renderer it now has unsaved changes.
  onLibraryChanged(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_EVENT.libraryChanged)
  })

  ipcMain.handle(IPC.loadProject, () => loadProject())
  ipcMain.handle(IPC.saveProject, (_event, project: Project) => saveProject(project))

  ipcMain.handle(IPC.saveProjectFile, (_event, project: Project) => saveProjectFile(project))
  ipcMain.handle(IPC.getProjectDir, () => currentProjectRoot())

  // File ▸ New: the New project window's Create (name + location), its
  // "Choose location…" folder picker, and the location it starts from.
  ipcMain.handle(IPC.createProject, (_event, name: string, location: string) => createProject(name, location))
  ipcMain.handle(IPC.chooseProjectLocation, async (event, current: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose where to create the project',
      buttonLabel: 'Choose',
      defaultPath: current && existsSync(current) ? current : app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.defaultProjectLocation, async () => (await getSettings()).exportDir)

  // Open a project folder's .reel via a native dialog. The FOLDER name becomes
  // the project's name (so exports and the title bar stay in sync with it).
  // An old-format file is refused with a reason (projectStore.assertOpenable).
  ipcMain.handle(IPC.openProjectFile, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Open project',
      properties: ['openFile'],
      filters: [
        { name: 'Reel Project', extensions: [REEL_EXT] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    // An old project (media in the old shared library) becomes a project
    // folder before it opens: in place if it sits alone in its own folder,
    // else a new <Name>/ beside it. The old file is kept as .reel-legacy.
    if (documentFormat(JSON.parse(await fsp.readFile(path, 'utf8'))) !== 'legacy') return openProject(path)
    const ask = (box: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
      win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box)
    const answer = await ask({
      type: 'question',
      buttons: ['Convert', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Convert this old project?',
      detail:
        'It uses the old shared media library. Converting gives it a project folder whose library points at ' +
        'your original files where they are (nothing is copied). The old file is kept as a .reel-legacy backup.'
    })
    if (answer.response !== 0) return null
    const report = await convertLegacyProject(path, { sharedDirs: userDirs() })
    if (report.missing.length) {
      await ask({
        type: 'warning',
        buttons: ['OK'],
        message: 'Converted, but some media was not found.',
        detail: `Missing: ${report.missing.join(', ')}.\n\nUse Relink… on each missing clip in the Library to find it.`
      })
    }
    return openProject(report.to!)
  })

  // File ▸ Convert old projects… — convert every old .reel in a folder (and
  // its subfolders one level down), then offer to delete the old shared
  // library ONLY when no old project is left anywhere the app looks: the
  // library is the only record of where an old project's footage lives.
  // Returns the summary lines (null = canceled).
  ipcMain.handle(IPC.convertLegacyFolderDialog, async (event): Promise<string[] | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const reels = join(app.getPath('documents'), 'Reels')
    const options: Electron.OpenDialogOptions = {
      title: 'Convert old projects in folder',
      buttonLabel: 'Convert',
      defaultPath: existsSync(reels) ? reels : app.getPath('documents'),
      properties: ['openDirectory']
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return null
    const job = createJob('convert', 'Converting old projects')
    const reports = await convertLegacyFolder(picked.filePaths[0], (done, total) => setProgress(job.id, done / total))
    finishJob(job.id)
    const lines = reports.length ? reports.map(reportLine) : ['No old projects found in that folder.']
    const clean = reports.every((r) => !r.error && !r.missing.length)
    const leftover = remainingLegacyProjects([picked.filePaths[0], reels, ...userDirs()])
    const { freed } = await legacyStoreBytes()
    if (!reports.length || freed <= 0) return lines
    if (!clean) {
      lines.push('', 'The old shared library was kept: some projects have missing files or failed.')
    } else if (leftover.length) {
      const shown = leftover.slice(0, 10)
      lines.push(
        '',
        `The old shared library was kept: ${leftover.length} old project${leftover.length === 1 ? '' : 's'} still need it:`,
        ...shown.map((p) => `  ${p}`),
        ...(leftover.length > shown.length ? [`  …and ${leftover.length - shown.length} more`] : []),
        'Convert those too; this offers to delete the library once none are left.'
      )
    } else {
      const gb = (freed / 1024 ** 3).toFixed(2)
      const box: Electron.MessageBoxOptions = {
        type: 'question',
        buttons: ['Delete', 'Keep for now'],
        defaultId: 1,
        cancelId: 1,
        message: `Delete the old shared media library? It frees about ${gb} GB.`,
        detail:
          'Every converted project found all of its media, and no old projects are left in Documents, ' +
          'Documents\\Reels, Desktop, Downloads or this folder. An old .reel kept anywhere else could not be ' +
          'converted afterwards except by relinking each clip, and its transcripts and generated clips ' +
          '(background removal, effects, stills) would be gone. This cannot be undone.'
      }
      const answer = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box)
      if (answer.response === 0) {
        await deleteLegacyStore()
        lines.push('', `Deleted the old shared library (${gb} GB freed).`)
      }
    }
    return lines
  })

  // Save As… — native Save dialog for `<Name>.reel`; the project becomes the
  // folder `<Name>/` there (or the folder the user is already in, if it has
  // that name). Returns the folder's .reel + the saved doc (renamed to match).
  ipcMain.handle(IPC.saveProjectAs, async (event, project: Project) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = {
      title: 'Save project as',
      defaultPath: suggestedSavePath(project, app.getPath('documents')),
      filters: [{ name: 'Reel Project', extensions: [REEL_EXT] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    return saveProjectAs(project, result.filePath)
  })

  ipcMain.handle(
    IPC.exportProject,
    async (event, project: Project, opts: { preset: PresetId; preferNvenc: boolean }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const settings = await getSettings()
      const defaultPath = join(settings.exportDir, suggestedExportName(project.name, opts.preset))
      const options: Electron.SaveDialogOptions = {
        title: 'Export Reel',
        defaultPath,
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      return exportProject(project, opts, result.filePath)
    }
  )
  ipcMain.handle(IPC.revealFile, (_event, path: string) => {
    shell.showItemInFolder(path)
    return true
  })

  ipcMain.handle(IPC.whisperAvailable, () => whisperAvailable())
  ipcMain.handle(IPC.transcribeMedia, (_event, mediaId: string) => transcribeMedia(mediaId))
  ipcMain.handle(IPC.getTranscript, (_event, mediaId: string) => getTranscript(mediaId))

  ipcMain.handle(IPC.detectSilence, async (_event, mediaId: string): Promise<Interval[]> => {
    const asset = await requireUsable(mediaId)
    return detectSilence(asset.originalPath, asset.probe.durationSec)
  })

  // Background removal: matte one clip segment into a new transparent library
  // asset (null = the job was canceled).
  ipcMain.handle(IPC.segmentAvailable, () => segmentAvailable())
  ipcMain.handle(IPC.removeBackground, (_event, req: RemoveBackgroundRequest) => removeBackgroundToLibrary(req))
  // Ask a cancelable background job to stop (false = nothing to cancel).
  ipcMain.handle(IPC.cancelJob, (_event, jobId: string) => cancelJob(jobId))
  ipcMain.handle(IPC.renderAudioFx, (_event, req: AudioFxRequest) =>
    renderAudioFxToLibrary(req.settings, req.sourceMediaId, req.inSec, req.outSec)
  )

  // Stills: capture an exact frame from a clip, matching the preview's HDR
  // tonemap / crop / color, into the library or to a user-chosen file.
  ipcMain.handle(IPC.captureStillToLibrary, async (_event, req: StillRequest): Promise<MediaAsset> => {
    const asset = await requireUsable(req.mediaId)
    const base = parse(asset.fileName).name
    const out = tmpOutput('still', 'png')
    await generateStill(asset.originalPath, out, req.sourceSec, stillVfChain(asset, req), alphaInputDecoder(asset.probe.video))
    return importGenerated(out, `${base} (still).png`)
  })

  ipcMain.handle(
    IPC.captureStillToDisk,
    async (event, req: StillRequest, suggestedName: string): Promise<string | null> => {
      const asset = await requireUsable(req.mediaId)
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.SaveDialogOptions = {
        title: 'Save still frame',
        defaultPath: join(app.getPath('pictures'), suggestedName || 'still.png'),
        filters: [
          { name: 'PNG image', extensions: ['png'] },
          { name: 'JPEG image', extensions: ['jpg'] }
        ]
      }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      await generateStill(asset.originalPath, result.filePath, req.sourceSec, stillVfChain(asset, req), alphaInputDecoder(asset.probe.video))
      return result.filePath
    }
  )

  ipcMain.handle(IPC.getSettings, () => getSettings())
  ipcMain.handle(IPC.updateSettings, async (_event, patch: Partial<Settings>) => {
    const next = await updateSettings(patch)
    // Toggling the assistant restarts (or stops) the pipe server live.
    if (patch.assistant) await startAssistant()
    return next
  })
  ipcMain.handle(IPC.assistantStatus, () => assistantStatus())
  ipcMain.handle(IPC.chooseExportDir, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose default export folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return getSettings()
    return updateSettings({ exportDir: result.filePaths[0] })
  })
}
