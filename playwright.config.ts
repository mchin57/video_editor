import { defineConfig } from '@playwright/test'

/**
 * E2E suite: launches the BUILT Electron app (run `electron-vite build` first —
 * `npm run test:e2e` does both) against a throwaway data dir + Electron profile
 * per test, and drives it with real pointer/keyboard events. This is the home
 * for the interaction guarantees vitest/jsdom cannot express (drags, drops,
 * keybinds, overlay state) — see docs/TIMELINE.md.
 *
 * Keep it small and high-value: pure logic still belongs in src/**\/*.test.ts.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One Electron app at a time; specs are cheap, launches are not.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
})
