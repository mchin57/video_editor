import { type JSX } from 'react'
import { useProject } from '@/state/projectStore'

/**
 * Global caption visibility toggle. Captions are now GENERATED per clip from the
 * clip's Inspector ("Caption this clip"); this header control just shows/hides
 * the whole caption track. Renders nothing until at least one caption exists.
 */
export function CaptionsButton(): JSX.Element | null {
  const captions = useProject((s) => s.project?.captions)
  const setCaptions = useProject((s) => s.setCaptions)
  if (!captions || captions.segments.length === 0) return null

  return (
    <button
      onClick={() => setCaptions({ ...captions, enabled: !captions.enabled })}
      className={`rounded-md px-2 py-1 text-[11px] ${
        captions.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-zinc-400'
      } hover:bg-white/10`}
      title="Show / hide captions"
    >
      {captions.enabled ? 'CC On' : 'CC Off'}
    </button>
  )
}
