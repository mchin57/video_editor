/**
 * Shared launch fixture: every test gets a freshly launched app with its own
 * temp data dir (VIDEO_EDITOR_DATA → media/projects/tmp) and its own Electron
 * profile (REEL_USER_DATA_DIR → localStorage/caches), so tests are hermetic —
 * no state leaks between tests or into the developer's real app.
 *
 * There is no untitled project (docs/MEDIA-POINTERS.md), so `appPage` creates
 * one — `E2E/` in the test's own `projectsDir` — through the same store action
 * the New project window calls. A spec about the start screen or New itself
 * uses `electronApp` + `firstWindow()` directly.
 *
 * NOTHING may wait on a person. Every native dialog in main CANCELS by default
 * (Save/Open → canceled, message boxes → their cancel button) and the
 * renderer's `alert`/`confirm` log and cancel instead of blocking. A spec that
 * needs an answer stubs that dialog itself (`dialog.showSaveDialog = …` via
 * `electronApp.evaluate`); one that forgets fails fast instead of hanging.
 *
 * Pattern for specs: ARRANGE via `window.__reelStores` (the same store actions
 * the UI calls — exposed in renderer main.tsx), ACT via real pointer/keyboard
 * events, ASSERT on DOM + store state.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'

const root = resolve(__dirname, '..')
// The electron npm package's main export is the path to the binary.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBin = require('electron') as unknown as string

export const test = base.extend<{
  scratchDir: string
  projectsDir: string
  electronApp: ElectronApplication
  appPage: Page
}>({
  // The test's own temp dir (data dir, profile, pipe, projects).
  // Playwright reads a fixture's dependencies from its first parameter, so a
  // fixture with none still needs the empty pattern.
  // eslint-disable-next-line no-empty-pattern
  scratchDir: async ({}, use) => {
    await use(mkdtempSync(join(tmpdir(), 'reel-e2e-')))
  },
  // Where the test's projects are created (`appPage` opens `E2E/` here).
  projectsDir: async ({ scratchDir }, use) => {
    const dir = join(scratchDir, 'projects')
    mkdirSync(dir, { recursive: true })
    await use(dir)
  },
  // The app handle itself, for the rare spec that must reach the MAIN process
  // (e.g. stubbing a native dialog with `electronApp.evaluate`). Most specs
  // only need `appPage`.
  electronApp: async ({ scratchDir: scratch }, use) => {
    const app = await electron.launch({
      executablePath: electronBin,
      args: [join(root, 'out', 'main', 'index.js')],
      cwd: root,
      env: {
        ...process.env,
        VIDEO_EDITOR_DATA: join(scratch, 'data'),
        REEL_USER_DATA_DIR: join(scratch, 'profile'),
        // Never collide with a dev app's pipe; never file issues on the real repo.
        REEL_ASSISTANT_PIPE:
          process.platform === 'win32' ? `\\\\.\\pipe\\${basename(scratch)}` : join(scratch, 'reel.sock'),
        REEL_ISSUES_SINK: join(scratch, 'issues.jsonl')
      }
    })
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => ({ canceled: true, filePath: '' })) as typeof dialog.showSaveDialog
      dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const opts = args.find((a) => !!a && typeof a === 'object' && 'message' in a) as
          { cancelId?: number } | undefined
        return { response: opts?.cancelId ?? 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      dialog.showErrorBox = (title: string, content: string) => console.error('[e2e] error box:', title, content)
    })
    await use(app)
    await app.close()
  },
  appPage: async ({ electronApp, projectsDir }, use) => {
    const page = await electronApp.firstWindow()
    page.on('dialog', (d) => void d.dismiss().catch(() => {}))
    await page.evaluate(() => {
      window.alert = (message?: unknown) => console.error('[e2e] alert:', message)
      window.confirm = (message?: string) => {
        console.error('[e2e] confirm → cancel:', message)
        return false
      }
    })
    await page.getByTestId('start-screen').waitFor()
    await page.evaluate((dir) => window.__reelStores.useProject.getState().createProject('E2E', dir), projectsDir)
    await page.getByTestId('start-screen').waitFor({ state: 'detached' })
    await use(page)
  }
})

export { expect }
