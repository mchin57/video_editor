import { app, shell, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { initProjectRoot } from './services/projectStore'
import { registerMediaProtocol, registerMediaSchemePrivileges } from './mediaProtocol'
import { getSubdir } from './config'
import { initAutoUpdate } from './services/updater'
import { startAssistant, stopAssistant } from './assistant/service'

// Test isolation: relocate Electron's profile (localStorage, caches) so e2e
// runs get a clean slate and can't pollute the real one. Must run pre-'ready'.
if (process.env.REEL_USER_DATA_DIR) app.setPath('userData', process.env.REEL_USER_DATA_DIR)

// Must be declared before app 'ready'.
registerMediaSchemePrivileges()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0b0f',
    title: 'Reel Editor',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Let library hover-previews play with sound without a prior click gesture.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  win.on('ready-to-show', () => win.show())

  if (is.dev) {
    // Surface renderer console + crashes in the dev terminal for debugging.
    win.webContents.on('console-message', (...args: unknown[]) => {
      const ev = args[0] as { message?: string; level?: string }
      const message = ev && typeof ev === 'object' && 'message' in ev ? ev.message : args[2]
      console.log('[renderer]', message)
    })
    win.webContents.on('render-process-gone', (_e, details) =>
      console.log('[render-process-gone]', JSON.stringify(details))
    )
    win.webContents.on('preload-error', (_e, path, error) => console.log('[preload-error]', path, error?.message))
  }

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.reeleditor.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  initProjectRoot() // before the window: the media protocol serves from it
  registerMediaProtocol()
  registerIpcHandlers()
  createWindow()
  void startAssistant()
  initAutoUpdate()

  // Best-effort scratch sweep: exports clean their per-job tmp dirs, but a
  // crashed or failed job (export, matte) leaves partial files behind. Nothing
  // is running at startup, so the whole dir is safe to clear.
  void fsp.rm(getSubdir('tmp'), { recursive: true, force: true }).catch(() => {})

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void stopAssistant()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
