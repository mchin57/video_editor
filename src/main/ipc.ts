import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join, parse } from 'node:path'
import { IPC, IPC_EVENT, type AudioFxRequest, type RemoveBackgroundRequest, type StillRequest } from '@shared/ipc'
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
  relinkMedia,
  renderAudioFxToLibrary,
  requireUsable,
  tmpOutput
} from './services/mediaStore'
import {
  createProject,
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
import { cancelJob } from './services/jobs'
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

  // A library card's repair action: point a missing clip at a file holding
  // its original (null = dialog canceled). docs/MEDIA-POINTERS.md "Relink".
  ipcMain.handle(IPC.relinkMediaDialog, async (event, id: string): Promise<MediaAsset | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Find the original file',
      properties: ['openFile'],
      filters: [
        { name: 'Media', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return relinkMedia(id, result.filePaths[0])
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
    return openProject(result.filePaths[0])
  })

  // File ▸ Convert old projects… — being rebuilt for the pointer model
  // (docs/MEDIA-POINTERS.md "Migration").
  ipcMain.handle(IPC.convertLegacyFolderDialog, (): string[] => [
    'Converting old projects is being rebuilt for the new project format and is not available in this build yet.'
  ])

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
