import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { ensureFontFaces } from './lib/fontFaces'
import { useProject } from './state/projectStore'
import { useEditor } from './state/store'
import { useUi } from './state/ui'
import { usePlayback } from './state/playback'
import { playedVideoDuration } from '@shared/layers'
import { useDock } from './state/dock'
// dockview's stylesheet first so index.css overrides win at equal specificity.
import 'dockview-react/dist/styles/dockview.css'
import './index.css'

declare global {
  interface Window {
    /** Debug / e2e handle to the zustand stores. Playwright specs ARRANGE
     *  state through real store actions (the same ones the UI calls), then ACT
     *  via real pointer/keyboard events and ASSERT on store + DOM. Also handy
     *  from devtools. Harmless to expose in a local desktop app. */
    __reelStores: {
      useProject: typeof useProject
      useEditor: typeof useEditor
      useUi: typeof useUi
      usePlayback: typeof usePlayback
      useDock: typeof useDock
      /** Shared duration invariant, exposed so specs can assert
       *  `endSec − startSec === playedVideoDuration(content)` without
       *  re-deriving the (nonlinear) math in the test. */
      playedVideoDuration: typeof playedVideoDuration
    }
  }
}
window.__reelStores = { useProject, useEditor, useUi, usePlayback, useDock, playedVideoDuration }

// Register the bundled-font @font-face rules before first paint so previews use
// the same faces the export burns.
ensureFontFaces()

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } }
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
