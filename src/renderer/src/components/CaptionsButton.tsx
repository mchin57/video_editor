import { useEffect, useState, type JSX } from 'react'
import type { CaptionWord } from '@shared/project'
import { effectiveOut } from '@shared/project'
import { useProject } from '@/state/projectStore'
import { useLibrary } from '@/hooks/useMedia'
import { transcribeMedia, whisperAvailable } from '@/ipc/client'
import { buildTimelineCaptions, type CaptionSource } from '@/lib/captions'

/**
 * Generates auto-captions from the AUDIO track: transcribes each audio clip's
 * media (cached), projects the words to timeline time, groups them into segments,
 * and stores them on the project. Also toggles caption visibility.
 */
export function CaptionsButton(): JSX.Element {
  const project = useProject((s) => s.project)
  const audioClips = project?.audioClips
  const captions = project?.captions
  const setCaptions = useProject((s) => s.setCaptions)
  const { data: assets = [] } = useLibrary()

  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void whisperAvailable().then(setAvailable)
  }, [])

  const hasAudio = (audioClips?.length ?? 0) > 0
  const hasCaptions = (captions?.segments.length ?? 0) > 0

  const generate = async (): Promise<void> => {
    if (!audioClips || !captions || !hasAudio || busy) return
    setBusy(true)
    setError(null)
    try {
      const mediaIds = [...new Set(audioClips.map((a) => a.mediaId))]
      const wordsByMedia: Record<string, CaptionWord[]> = {}
      for (let i = 0; i < mediaIds.length; i++) {
        setStep(`${i + 1}/${mediaIds.length}`)
        const transcript = await transcribeMedia(mediaIds[i])
        wordsByMedia[mediaIds[i]] = transcript.words
      }
      const sources: CaptionSource[] = audioClips.map((a) => ({
        mediaId: a.mediaId,
        startSec: a.startSec,
        inSec: a.inSec,
        outSec: effectiveOut(a, assets.find((m) => m.id === a.mediaId)?.probe.durationSec ?? a.outSec)
      }))
      const segments = buildTimelineCaptions(sources, wordsByMedia)
      setCaptions({ ...captions, enabled: true, segments })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setStep('')
    }
  }

  const toggle = (): void => {
    if (captions) setCaptions({ ...captions, enabled: !captions.enabled })
  }

  if (!available) {
    return (
      <span className="text-[11px] text-zinc-600" title="Install whisper.cpp in bin/whisper">
        Captions unavailable
      </span>
    )
  }

  return (
    <div className="flex items-center gap-1.5">
      {error && (
        <span className="max-w-[200px] truncate text-[11px] text-rose-400" title={error}>
          {error}
        </span>
      )}
      {hasCaptions && (
        <button
          onClick={toggle}
          className={`rounded px-2 py-1 text-[11px] ${
            captions?.enabled
              ? 'bg-emerald-500/20 text-emerald-300'
              : 'bg-white/5 text-zinc-400'
          } hover:bg-white/10`}
          title="Show / hide captions"
        >
          {captions?.enabled ? 'CC On' : 'CC Off'}
        </button>
      )}
      <button
        onClick={generate}
        disabled={!hasAudio || busy}
        className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20 disabled:opacity-50"
        title="Auto-caption the audio track with whisper.cpp"
      >
        {busy ? `Transcribing… ${step}` : hasCaptions ? '↻ Captions' : '✨ Captions'}
      </button>
    </div>
  )
}
