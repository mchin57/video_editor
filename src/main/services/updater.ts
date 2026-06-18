/**
 * Auto-update via electron-updater. On launch (packaged builds only) it polls
 * the release feed configured in electron-builder.yml `publish` (GitHub
 * Releases), downloads any newer version in the background, and prompts the user
 * to restart-to-install. Failures (offline, no release yet, 404) are logged and
 * swallowed so they never block startup.
 */

import { app, dialog } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

export function initAutoUpdate(): void {
  // The updater needs a packaged app with a bundled app-update.yml feed; in dev
  // it would throw, so skip and let `npm run dev` run untouched.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => console.error('[updater] error:', err?.message ?? err))
  autoUpdater.on('update-available', (info) => console.log('[updater] update available:', info.version))
  autoUpdater.on('update-not-available', () => console.log('[updater] already up to date'))
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

  autoUpdater.checkForUpdates().catch((err) =>
    console.error('[updater] check failed:', err?.message ?? err)
  )
}
