import { useState, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { MediaAsset } from '@shared/media'
import type { StillRequest } from '@shared/ipc'
import { videoSourceTime } from '@shared/layers'
import { Popout } from './Popout'
import { activeComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
import { idle } from '@/lib/interaction'
import { captureStillToDisk, captureStillToLibrary, imageUrl } from '@/ipc/client'

/**
 * Floating gallery for grabbing still frames out of the selected video layer.
 * Each capture grabs the exact frame on screen (same crop/color the preview
 * shows), adds it to the project library, and can be dropped onto the timeline
 * as a full-frame image layer or saved to disk.
 */
export function StillsPopout(): JSX.Element | null {
  const open = useUi((s) => s.stillsOpen)
  const setOpen = useUi((s) => s.setStillsOpen)
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const layer = useProject((s) => activeComp(s)?.layers.find((l) => l.id === selectedLayerId) ?? null)
  const addMedia = useProject((s) => s.addMedia)
  const addLayer = useProject((s) => s.addLayer)
  const queryClient = useQueryClient()
  const [shots, setShots] = useState<MediaAsset[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (!open) return null
  const content = layer && layer.content.kind === 'video' ? layer.content : null

  const request = (): StillRequest | null => {
    if (!layer || !content) return null
    const sourceSec = videoSourceTime(content, layer, usePlayback.getState().time)
    return {
      mediaId: content.mediaId,
      sourceSec,
      crop: content.crop ?? null,
      color: content.color ?? null,
      flipH: content.flipH,
      flipV: content.flipV
    }
  }

  const capture = async (): Promise<void> => {
    const req = request()
    if (!req || busy) return
    setBusy(true)
    setErr(null)
    try {
      const asset = await captureStillToLibrary(req)
      await idle() // the capture can finish mid-drag; adding waits for the release
      addMedia([asset.id]) // make it part of this project's library
      setShots((s) => [asset, ...s])
      void queryClient.invalidateQueries({ queryKey: ['library'] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveCurrentToDisk = async (): Promise<void> => {
    const req = request()
    if (!req || busy) return
    setBusy(true)
    setErr(null)
    try {
      await captureStillToDisk(req, 'still.png')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const addAsLayer = (asset: MediaAsset): void => {
    const start = usePlayback.getState().time
    addLayer({
      id: crypto.randomUUID(),
      hidden: false,
      startSec: start,
      endSec: start + 3,
      x: 540,
      y: 960,
      scale: 1, // full-frame: a still placed over the clip reads as a held frame
      content: { kind: 'image', mediaId: asset.id, opacity: 1 }
    })
  }

  return (
    <Popout title="Clip stills" onClose={() => setOpen(false)} width={300}>
      {!content ? (
        <p className="text-xs text-zinc-500">Select a video layer to grab stills from it.</p>
      ) : (
        <>
          <div className="mb-2 flex flex-col gap-1.5">
            <button
              onClick={() => void capture()}
              disabled={busy}
              className="rounded bg-sky-500 px-2 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-50"
            >
              {busy ? 'Capturing…' : '📷 Capture current frame'}
            </button>
            <button
              onClick={() => void saveCurrentToDisk()}
              disabled={busy}
              className="rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 disabled:opacity-50"
            >
              💾 Save current frame to disk…
            </button>
          </div>
          {err && <p className="mb-2 text-[11px] text-rose-400">{err}</p>}
          <p className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
            Captured this session
          </p>
          {shots.length === 0 ? (
            <p className="text-[11px] text-zinc-600">No stills yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {shots.map((s) => (
                <div key={s.id} className="overflow-hidden rounded border border-white/10 bg-black/30">
                  <img src={imageUrl(s.id)} alt="" className="aspect-[9/16] w-full object-cover" />
                  <div className="flex flex-col gap-1 p-1">
                    <button
                      onClick={() => addAsLayer(s)}
                      className="rounded bg-white/10 px-1.5 py-1 text-[11px] text-zinc-200 hover:bg-white/20"
                    >
                      + Add as layer
                    </button>
                    <button
                      onClick={() => void captureStillToDisk({ mediaId: s.id, sourceSec: 0, crop: null, color: null }, `${s.id}.png`)}
                      className="rounded bg-white/5 px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-white/10"
                      title="Save this still to a file"
                    >
                      💾 Save…
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Popout>
  )
}
