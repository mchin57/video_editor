/**
 * Auto-update via electron-updater. On launch (packaged builds only) it polls
 * the release feed configured in electron-builder.yml `publish` (GitHub
 * Releases), downloads any newer version in the background, and prompts the user
 * to restart-to-install. Failures (offline, no release yet, 404) are logged and
 * swallowed so they never block startup.
 */

import { app, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import { createLogger } from '@shared/log'

const log = createLogger('updater')

const { autoUpdater } = electronUpdater

export function initAutoUpdate(): void {
  // The updater needs a packaged app with a bundled app-update.yml feed; in dev
  // it would throw, so skip and let `npm run dev` run untouched.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => log.error('error', err))
  autoUpdater.on('update-available', (info) => log.info(`update available: ${info.version}`))
  autoUpdater.on('update-not-available', () => log.info('already up to date'))
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Reel Editor ${info.version} has been downloaded.`,
      detail: 'Restart to install the update. It will also install automatically next time you quit.'
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.checkForUpdates().catch((err) => log.error('check failed', err))
}
