/**
 * The Inspector panel: the hook-rule indicator, then the editor for whatever is
 * selected — a layer, a caption, the caption lane, or an audio clip. The editors
 * live in `components/inspector/`.
 */

import { type JSX } from 'react'
import { hookCovered } from '@shared/layers'
import { activeComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { LayerEditor } from './inspector/LayerEditor'
import { CaptionStyleEditor, CaptionEditor } from './inspector/CaptionEditor'
import { AudioClipEditor } from './inspector/AudioClipEditor'

export function Inspector(): JSX.Element {
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const selectedAudioId = useUi((s) => s.selectedAudioId)
  const captionsGlobalSelected = useUi((s) => s.captionsGlobalSelected)
  const layers = useProject((s) => activeComp(s)?.layers)
  const hookOk = hookCovered(layers ?? [])

  return (
    <div className="flex h-full w-full flex-col">
      <div className="border-b border-white/10 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Inspector
      </div>

      {/* Hook rule indicator */}
      <div
        className={`flex items-center gap-1.5 border-b border-white/10 px-3 py-1.5 text-[11px] ${
          hookOk ? 'text-emerald-400' : 'text-amber-400'
        }`}
        title="Instagram: get your hook text on screen in the first 3 seconds"
      >
        <span>{hookOk ? '✓' : '⚠'}</span>
        {hookOk ? 'Hook text in first 3s' : 'No hook text in first 3s'}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {selectedLayerId ? (
          <LayerEditor />
        ) : selectedCaptionId ? (
          <CaptionEditor />
        ) : captionsGlobalSelected ? (
          <CaptionStyleEditor />
        ) : selectedAudioId ? (
          <AudioClipEditor />
        ) : (
          <p className="text-sm text-zinc-600">Select a layer, caption, or audio clip to edit it.</p>
        )}
      </div>
    </div>
  )
}
