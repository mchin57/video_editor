// ESLint flat config. Prettier owns formatting (`eslint-config-prettier` goes
// last and switches off every stylistic rule); this file owns correctness and
// the layer boundaries from CLAUDE.md "Shape".
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// `src/shared` is imported by BOTH the main process and the renderer, so it
// must stay pure: no Node, no Electron, no React, and nothing from either side.
const SHARED_FORBIDDEN = {
  patterns: [
    { group: ['node:*', 'electron', 'electron/*', '@electron-toolkit/*'], message: 'src/shared is pure: no Node or Electron APIs.' },
    { group: ['react', 'react-dom', 'react/*', 'zustand', 'zustand/*', '@tanstack/*'], message: 'src/shared is pure: no React or renderer state.' },
    { group: ['@/*', '**/renderer/**', '**/main/**', '**/preload/**'], message: 'src/shared may not import from main, preload or the renderer.' }
  ]
}

// The renderer reaches main only through the preload `api` (ipc/client.ts).
const RENDERER_FORBIDDEN = {
  patterns: [
    { group: ['node:*', 'electron', 'electron/*'], message: 'The renderer has no Node/Electron access: add an IPC call (docs/SHARED.md "IPC").' },
    { group: ['**/main/**', '**/preload/**'], message: 'The renderer may not import main or preload code: go through ipc/client.ts.' }
  ]
}

// Main never pulls in React or renderer code.
const MAIN_FORBIDDEN = {
  patterns: [
    { group: ['react', 'react-dom', 'react/*', 'zustand', 'zustand/*', '@tanstack/*'], message: 'The main process has no React.' },
    { group: ['@/*', '**/renderer/**'], message: 'The main process may not import renderer code.' }
  ]
}

export default defineConfig([
  globalIgnores([
    'out/**',
    'release/**',
    'resources/**',
    'samples/**',
    'test-results/**',
    'playwright-report/**',
    '.claude/**',
    '.playwright-mcp/**'
  ]),
  {
    files: ['**/*.{ts,tsx,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.node } },
    rules: {
      // `_`-prefixed names are deliberately unused (destructured-away fields, positional args).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': ['error', RENDERER_FORBIDDEN],
      // Two React Compiler rules, off until the components are split up. The app
      // doesn't run the compiler, and these flag deliberate idioms it relies on:
      // the "latest value" ref written during render (read by a drag or timer
      // callback) and resetting a draft from props in an effect. Replace those
      // with `useEffectEvent` / keyed state, then turn these back on.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off'
    }
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', SHARED_FORBIDDEN] }
  },
  {
    files: ['src/main/**/*.ts', 'src/mcp/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', MAIN_FORBIDDEN] }
  },
  {
    // Tests may reach across layers to set up fixtures.
    files: ['**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' }
  },
  // Must come last: turns off every stylistic rule Prettier owns.
  prettier
])
