import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve('src/shared')

/**
 * Content Security Policy for the built renderer: scripts only from the app's
 * own files (no inline script, no eval), so injected markup can't run code.
 * Styles allow inline (a library inserts a <style> element, and fontFaces.ts
 * writes the @font-face rules into one). `reelmedia://` (media, thumbnails,
 * fonts) is registered with `bypassCSP` (mediaProtocol.ts), so it needs no
 * entry here. Built only: the dev server's hot reload runs inline scripts and
 * a websocket this policy would block.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const contentSecurityPolicy = (): Plugin => ({
  name: 'reel-content-security-policy',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        // Two entries: the app's main process, and reel-mcp — the stdio MCP
        // server Claude Code launches with plain node (src/mcp).
        input: { index: resolve('src/main/index.ts'), mcp: resolve('src/mcp/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react(), tailwindcss(), contentSecurityPolicy()]
  }
})
