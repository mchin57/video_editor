import { useEffect, useState, type JSX } from 'react'
import { effectiveOut } from '@shared/project'
import type { CaptionSegment } from '@shared/project'
import { transcribeMedia, whisperAvailable } from '@/ipc/client'
import { buildTimelineCaptions, type CaptionSource } from '@/lib/captions'
import { useLibrary } from '@/hooks/useMedia'
import { activeComp, useProject } from '@/state/projectStore'

/**
 * Caption the whole audio lane: transcribe every audio clip that isn't excluded
 * and project its words into timeline time from THAT clip's placement/trim. Each
 * clip is captioned independently, so overlapping audio produces overlapping
 * captions, and freeze-split extracted pieces land correctly (each piece is its
 * own placed clip). Regenerates the caption track idempotently.
 */
export function CaptionAudioButton(): JSX.Element | null {
  const audioClips = useProject((s) => activeComp(s)?.audioClips)
  const captions = useProject((s) => activeComp(s)?.captions)
  const setCaptions = useProject((s) => s.setCaptions)
  const { data: assets = [] } = useLibrary()
  const [available, setAvailable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void whisperAvailable().then(setAvailable)
  }, [])

  const clips = (audioClips ?? []).filter((a) => !a.excludeFromCaptions)
  if (!captions || clips.length === 0) return null

  const generate = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      const all: CaptionSegment[] = []
      for (const clip of clips) {
        const dur = assets.find((a) => a.id === clip.mediaId)?.probe.durationSec ?? clip.outSec
        const transcript = await transcribeMedia(clip.mediaId)
        const source: CaptionSource = {
          mediaId: clip.mediaId,
          startSec: clip.startSec,
          inSec: clip.inSec,
          outSec: effectiveOut(clip, dur)
        }
        const segs = buildTimelineCaptions([source], { [clip.mediaId]: transcript.words }).map((s, i) => ({
          ...s,
          id: `cap-${clip.id}-${i}`
        }))
        all.push(...segs)
      }
      setCaptions({ ...captions, enabled: true, segments: all.sort((a, b) => a.startSec - b.startSec) })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!available) return null

  return (
    <button
      onClick={() => void generate()}
      disabled={busy}
      title="Transcribe every audio clip (except excluded ones) and caption the lane"
      className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20 disabled:opacity-50"
    >
      {busy ? 'Captioning…' : err ? '⚠ Retry caption' : '✨ Caption audio'}
    </button>
  )
}
