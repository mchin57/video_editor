/**
 * Shared launch fixture: every test gets a freshly launched app with its own
 * temp data dir (VIDEO_EDITOR_DATA → media/projects/tmp) and its own Electron
 * profile (REEL_USER_DATA_DIR → localStorage/caches), so tests are hermetic —
 * no state leaks between tests or into the developer's real app.
 *
 * Pattern for specs: ARRANGE via `window.__reelStores` (the same store actions
 * the UI calls — exposed in renderer main.tsx), ACT via real pointer/keyboard
 * events, ASSERT on DOM + store state.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, test as base, expect, type Page } from '@playwright/test'

const root = resolve(__dirname, '..')
// The electron npm package's main export is the path to the binary.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBin = require('electron') as unknown as string

export const test = base.extend<{ appPage: Page }>({
  appPage: async ({}, use) => {
    const scratch = mkdtempSync(join(tmpdir(), 'reel-e2e-'))
    const app = await electron.launch({
      executablePath: electronBin,
      args: [join(root, 'out', 'main', 'index.js')],
      cwd: root,
      env: {
        ...process.env,
        VIDEO_EDITOR_DATA: join(scratch, 'data'),
        REEL_USER_DATA_DIR: join(scratch, 'profile')
      }
    })
    const page = await app.firstWindow()
    await page.getByText('Reel Editor', { exact: true }).waitFor()
    await use(page)
    await app.close()
  }
})

export { expect }
