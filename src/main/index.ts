import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { registerMediaProtocol, registerMediaSchemePrivileges } from './mediaProtocol'
import { initAutoUpdate } from './services/updater'

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
    win.webContents.on('preload-error', (_e, path, error) =>
      console.log('[preload-error]', path, error?.message)
    )
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

  registerMediaProtocol()
  registerIpcHandlers()
  createWindow()
  initAutoUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
