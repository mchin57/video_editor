/** Inspector ▸ video layer: background removal (a matte of the clip's segment, swapped in place). */

import { useEffect, useState, type JSX } from 'react'
import type { VideoContent } from '@shared/project'
import { videoSourceWindow } from '@shared/layers'
import type { MediaAsset } from '@shared/media'
import { isJobActive } from '@shared/jobs'
import { segmentAvailable } from '@/ipc/client'
import { removeLayerBackground } from '@/lib/backgroundRemoval'
import { latestJob, useEditor } from '@/state/store'
import { CancelJobButton, jobProgressText, useNow } from '../JobsIndicator'
import { formatDuration } from '@/lib/format'
import { CollapsibleSection } from '../CollapsibleSection'

/**
 * "Remove background" for a video layer: mattes ONLY the footage this layer
 * plays (its source window) as a background job, then swaps the transparent
 * result in place — same lane, position and timing; Undo restores the original
 * (`lib/backgroundRemoval.ts`). Job state comes from the shared jobs map, so
 * the progress / ETA / Cancel row survives selecting another layer and coming
 * back, and the header's job indicator shows the same job meanwhile.
 * Renders nothing when the model isn't installed.
 */
export function RemoveBackground({
  layerId,
  content,
  asset
}: {
  layerId: string
  content: VideoContent
  asset: MediaAsset | undefined
}): JSX.Element | null {
  const [available, setAvailable] = useState(false)
  const [starting, setStarting] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const job = useEditor((s) => latestJob(s.jobs, 'matte', layerId))
  const running = !!job && isJobActive(job.status)
  const now = useNow(running)

  useEffect(() => {
    void segmentAvailable().then(setAvailable)
  }, [])

  if (!available) return null

  if (asset?.probe.video?.hasAlpha) {
    return (
      <CollapsibleSection id="removebg" title="Background">
        <p className="text-[10px] leading-snug text-zinc-500">
          Background removed — this clip is transparent, so whatever sits on the lanes below shows through (a color, an
          image, another clip).
        </p>
      </CollapsibleSection>
    )
  }

  const { startSec, durationSec } = videoSourceWindow(content)
  const run = async (): Promise<void> => {
    if (running || starting || !asset) return
    setStarting(true)
    setNote(null)
    try {
      const outcome = await removeLayerBackground(layerId, asset)
      if (outcome === 'canceled') setNote({ text: 'Canceled — the clip is unchanged.' })
      if (outcome === 'kept-in-library') {
        setNote({
          text: 'This clip changed while the background was being removed, so the transparent copy was added to your library instead.'
        })
      }
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setStarting(false)
    }
  }
  const failed = !running && !note && job?.status === 'error' ? job.error : undefined

  return (
    <CollapsibleSection id="removebg" title="Background">
      <button
        onClick={() => void run()}
        disabled={running || starting || !asset || durationSec <= 0}
        title="Detect the subject and replace this clip with a background-free version of it"
        className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 disabled:opacity-50"
      >
        {running
          ? `Removing background… ${Math.round(job.progress * 100)}%`
          : starting
            ? 'Starting…'
            : '✂ Remove background'}
      </button>
      {running && (
        <div className="mt-1.5 flex items-center gap-2" data-testid="matte-progress">
          <div className="h-1 flex-1 overflow-hidden rounded bg-white/10">
            <div className="h-full bg-sky-400" style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <span className="shrink-0 text-[10px] text-zinc-400">{jobProgressText(job, now)}</span>
          <CancelJobButton job={job} />
        </div>
      )}
      {note && (
        <p className={`mt-1 text-[10px] leading-snug ${note.error ? 'text-rose-300' : 'text-zinc-400'}`}>{note.text}</p>
      )}
      {failed && <p className="mt-1 text-[10px] leading-snug text-rose-300">{failed}</p>}
      <p className="mt-1 text-[10px] leading-snug text-zinc-500">
        Removes the background from just this clip&apos;s {formatDuration(durationSec)} of footage (source{' '}
        {formatDuration(startSec)}–{formatDuration(startSec + durationSec)}) and swaps it in place — same spot, same
        timing. Undo brings the original back. Put a new background (color, image, another clip) on a lane below.
      </p>
    </CollapsibleSection>
  )
}
