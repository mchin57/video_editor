/** IPC: projects — load/save the working copy, File ▸ New / Open / Save As, and
 *  converting old (shared-library) projects. */

import { app } from 'electron'
import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import {
  convertLegacyFolder,
  convertLegacyProject,
  deleteLegacyStore,
  legacyStoreBytes,
  remainingLegacyProjects,
  reportLine
} from '../services/legacyConvert'
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
} from '../services/projectStore'
import { currentProjectRoot } from '../services/projectRoot'
import { getSettings } from '../services/settings'
import { createJob, finishJob, setProgress } from '../services/jobs'
import { dialogsFor, handle, pickedPath } from './handle'

/** The user folders an old project may sit in (never converted in place;
 *  scanned before the old library may be deleted). */
const userDirs = (): string[] => (['home', 'documents', 'desktop', 'downloads'] as const).map((k) => app.getPath(k))

export function registerProjectHandlers(): void {
  handle('loadProject', () => loadProject())
  handle('saveProject', (_event, project) => saveProject(project))
  handle('saveProjectFile', (_event, project) => saveProjectFile(project))
  handle('getProjectDir', () => currentProjectRoot())

  // File ▸ New: the New project window's Create (name + location), its
  // "Choose location…" folder picker, and the location it starts from.
  handle('createProject', (_event, name, location) => createProject(name, location))
  handle('chooseProjectLocation', async (event, current) =>
    pickedPath(
      await dialogsFor(event).open({
        title: 'Choose where to create the project',
        buttonLabel: 'Choose',
        defaultPath: current && existsSync(current) ? current : app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory']
      })
    )
  )
  handle('defaultProjectLocation', async () => (await getSettings()).exportDir)

  // Open a project folder's .reel via a native dialog. The FOLDER name becomes
  // the project's name (so exports and the title bar stay in sync with it).
  // An old-format file is refused with a reason (projectStore.assertOpenable).
  handle('openProjectFile', async (event) => {
    const dialogs = dialogsFor(event)
    const path = pickedPath(
      await dialogs.open({
        title: 'Open project',
        properties: ['openFile'],
        filters: [
          { name: 'Reel Project', extensions: [REEL_EXT] },
          { name: 'JSON', extensions: ['json'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
    )
    if (!path) return null
    // An old project (media in the old shared library) becomes a project
    // folder before it opens: in place if it sits alone in its own folder,
    // else a new <Name>/ beside it. The old file is kept as .reel-legacy.
    if (documentFormat(JSON.parse(await fsp.readFile(path, 'utf8'))) !== 'legacy') return openProject(path)
    const answer = await dialogs.ask({
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
      await dialogs.ask({
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
  handle('convertLegacyFolderDialog', async (event) => {
    const dialogs = dialogsFor(event)
    const reels = join(app.getPath('documents'), 'Reels')
    const folder = pickedPath(
      await dialogs.open({
        title: 'Convert old projects in folder',
        buttonLabel: 'Convert',
        defaultPath: existsSync(reels) ? reels : app.getPath('documents'),
        properties: ['openDirectory']
      })
    )
    if (!folder) return null
    const job = createJob('convert', 'Converting old projects')
    const reports = await convertLegacyFolder(folder, (done, total) => setProgress(job.id, done / total))
    finishJob(job.id)
    const lines = reports.length ? reports.map(reportLine) : ['No old projects found in that folder.']
    const clean = reports.every((r) => !r.error && !r.missing.length)
    const leftover = remainingLegacyProjects([folder, reels, ...userDirs()])
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
      const answer = await dialogs.ask({
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
      })
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
  handle('saveProjectAs', async (event, project) => {
    const result = await dialogsFor(event).save({
      title: 'Save project as',
      defaultPath: suggestedSavePath(project, app.getPath('documents')),
      filters: [{ name: 'Reel Project', extensions: [REEL_EXT] }]
    })
    if (result.canceled || !result.filePath) return null
    return saveProjectAs(project, result.filePath)
  })
}
