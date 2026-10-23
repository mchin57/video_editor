/** Inspector ▸ video layer: the body-pose overlay — detect, pick people, joint angles, convert to a drawing. */

import { useState, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Layer, VideoContent } from '@shared/project'
import { effectiveStabilize } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import { isJobActive } from '@shared/jobs'
import { videoSourceWindow } from '@shared/layers'
import {
  POSE_ANGLES,
  POSE_ANGLE_IDS,
  POSE_DEFAULT_WIDTH,
  POSE_PRESETS,
  joinTrack,
  poseCovers,
  togglePersonTrack,
  trackPresence,
  validPicks,
  type PoseAngleId,
  type PoseData,
  type PoseSettings
} from '@shared/pose'
import { usePoseAvailable, usePoseData } from '@/hooks/usePose'
import { detectLayerPose, poseToGraphics } from '@/lib/pose'
import { latestJob, useEditor } from '@/state/store'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { CancelJobButton, jobProgressText, useNow } from '../JobsIndicator'
import { CollapsibleSection } from '../CollapsibleSection'
import { Check, Field, Slider, btnCls, disabledCls, toggleCls } from '../ui'

/**
 * "Pose": detect body keypoints over the footage this clip plays (a job, once
 * per media file), then choose who to draw — numbered people, picked here or by
 * clicking them on the preview, re-joinable when tracking lost them — which
 * joint angles to label, and the stroke. Lists the missing model files instead
 * of a button until they are installed.
 */
export function PoseSection({
  layer,
  content: c,
  asset
}: {
  layer: Layer
  content: VideoContent
  asset: MediaAsset | undefined
}): JSX.Element {
  const qc = useQueryClient()
  const available = usePoseAvailable()
  const data = usePoseData(c.mediaId)
  const job = useEditor((s) => latestJob(s.jobs, 'pose', layer.id))
  const running = !!job && isJobActive(job.status)
  const now = useNow(running)
  const [starting, setStarting] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const picking = useUi((s) => s.posePickLayerId === layer.id)

  const set = (pose: PoseSettings): void => useProject.getState().updateLayerContent(layer.id, { pose })
  const { startSec, durationSec } = videoSourceWindow(c)
  const covered = !!data && poseCovers(data, c.inSec, c.outSec)
  // The export stabilizes the picture, not the detection made on the original.
  const stabilized = useProject((s) => !!s.project && !!effectiveStabilize(c, s.project.stabilizeDefault))

  const detect = async (): Promise<void> => {
    if (running || starting) return
    setStarting(true)
    setNote(null)
    try {
      const outcome = await detectLayerPose(layer.id, qc)
      if (outcome === 'canceled') setNote({ text: 'Canceled — nothing changed.' })
      if (outcome === 'clip-changed') setNote({ text: 'This clip changed during detection; detect again to use it.' })
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setStarting(false)
    }
  }

  const failed = !running && !note && job?.status === 'error' ? job.error : undefined
  const settings = c.pose && data ? validPicks(c.pose, data) : c.pose
  // Without the models there is no detecting — but a pose detected earlier
  // (or on another machine) still draws, so its controls stay.
  const canDetect = !!available?.ready

  return (
    <CollapsibleSection id="pose" title="Pose">
      {available && !canDetect ? (
        <p className="text-[10px] leading-snug text-zinc-400" data-testid="pose-missing">
          Pose detection needs its two models in {available.modelsDir} — missing: {available.missing.join(', ')}. Issue
          #201 lists the files.
        </p>
      ) : (
        <button
          data-testid="pose-detect"
          onClick={() => void detect()}
          disabled={running || starting || !asset || durationSec <= 0 || !canDetect}
          className={`w-full ${btnCls} ${disabledCls}`}
          title="Find the people in this clip's footage and their joints"
        >
          {running
            ? `Detecting pose… ${Math.round(job.progress * 100)}%`
            : starting
              ? 'Starting…'
              : data
                ? covered
                  ? '↻ Detect again'
                  : '↻ Detect to cover this clip'
                : '🦴 Detect pose'}
        </button>
      )}
      {running && (
        <div className="mt-1.5 flex items-center gap-2" data-testid="pose-progress">
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
      {data && !covered && !running && canDetect && (
        <p className="mt-1 text-[10px] leading-snug text-amber-300/80">
          The detection doesn&apos;t cover all of this clip&apos;s footage — detect again to include it.
        </p>
      )}
      {!data && !running && canDetect && (
        <p className="mt-1 text-[10px] leading-snug text-zinc-500">
          Detects every person in this clip&apos;s footage (source {startSec.toFixed(1)}–
          {(startSec + durationSec).toFixed(1)}s) once; the skeleton then follows trims, freezes and speed changes.
        </p>
      )}

      {data && settings?.show && stabilized && (
        <p className="mt-1 text-[10px] leading-snug text-amber-300/80" data-testid="pose-stabilized">
          This clip is stabilized on export, which shifts the picture; the skeleton follows the unstabilized footage, so
          it may drift off the athlete. Turn stabilization off for this clip to keep them together.
        </p>
      )}
      {data && settings && (
        <PoseControls
          layer={layer}
          content={c}
          asset={asset}
          data={data}
          settings={settings}
          picking={picking}
          onChange={set}
        />
      )}
      {data && !settings && (
        <button
          className={`mt-2 w-full ${btnCls}`}
          onClick={() => set({ show: true, people: [], angles: [], widthPx: POSE_DEFAULT_WIDTH })}
        >
          Show pose on this clip
        </button>
      )}
    </CollapsibleSection>
  )
}

function PoseControls({
  layer,
  content,
  asset,
  data,
  settings,
  picking,
  onChange
}: {
  layer: Layer
  content: VideoContent
  asset: MediaAsset | undefined
  data: PoseData
  settings: PoseSettings
  picking: boolean
  onChange: (s: PoseSettings) => void
}): JSX.Element {
  const [convertNote, setConvertNote] = useState<string | null>(null)
  const personOf = (id: number): number => settings.people.findIndex((p) => p.tracks.includes(id))
  // Everyone seen in THIS clip's footage (plus anyone picked), most present
  // first — the detection may also cover other clips of the file.
  const presence = new Map(data.tracks.map((t) => [t.id, trackPresence(data, t, content.inSec, content.outSec)]))
  const tracks = data.tracks
    .filter((t) => presence.get(t.id)!.seen > 0 || personOf(t.id) >= 0)
    .sort((a, b) => presence.get(b.id)!.fraction * b.weight - presence.get(a.id)!.fraction * a.weight)
  const toggleAngle = (id: PoseAngleId): void =>
    onChange({
      ...settings,
      angles: settings.angles.includes(id) ? settings.angles.filter((a) => a !== id) : [...settings.angles, id]
    })

  return (
    <div className="mt-2" data-testid="pose-controls">
      <Check checked={settings.show} onChange={(show) => onChange({ ...settings, show })}>
        Show skeleton
      </Check>

      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">People ({tracks.length})</span>
        <button
          data-testid="pose-pick"
          aria-pressed={picking}
          className={toggleCls(picking)}
          onClick={() => useUi.getState().setPosePickLayerId(picking ? null : layer.id)}
          title="Show everyone detected as numbered boxes on the preview; click one to show or hide them"
        >
          Pick on preview
        </button>
      </div>
      <ul className="mb-2 space-y-0.5" data-testid="pose-people">
        {tracks.map((t) => {
          const owner = personOf(t.id)
          const person = owner >= 0 ? settings.people[owner] : null
          return (
            <li key={t.id} className="flex items-center gap-1.5 text-xs text-zinc-300">
              <input
                type="checkbox"
                data-testid={`pose-person-${t.id}`}
                checked={!!person}
                onChange={() => onChange(togglePersonTrack(settings, t.id))}
              />
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: person?.color ?? 'transparent', border: '1px solid #ffffff55' }}
              />
              <span className="min-w-0 flex-1 truncate">
                Person {t.id}
                <span className="ml-1 text-[10px] text-zinc-500">
                  {Math.round(presence.get(t.id)!.fraction * 100)}% of the clip
                </span>
              </span>
              {settings.people.length > 0 && (
                <select
                  aria-label={`Person ${t.id} is also`}
                  title="This is also… (re-join someone tracking lost)"
                  value={owner >= 0 && settings.people[owner].tracks.length > 1 ? owner : ''}
                  onChange={(e) => e.target.value !== '' && onChange(joinTrack(settings, t.id, Number(e.target.value)))}
                  className="w-20 rounded border border-white/10 bg-black/40 px-1 text-[10px] text-zinc-300"
                >
                  <option value="">Same as…</option>
                  {settings.people.map((p, i) => (
                    <option key={i} value={i}>
                      {p.tracks.map((x) => `#${x}`).join('+')}
                    </option>
                  ))}
                </select>
              )}
              {person && (
                <input
                  type="color"
                  aria-label={`Person ${t.id} colour`}
                  value={person.color.slice(0, 7)}
                  onChange={(e) =>
                    onChange({
                      ...settings,
                      people: settings.people.map((p, i) => (i === owner ? { ...p, color: e.target.value } : p))
                    })
                  }
                  className="h-5 w-6 shrink-0 rounded border border-white/10 bg-black/40"
                />
              )}
            </li>
          )
        })}
      </ul>

      <Field label="Joint angles">
        <div className="mb-1 flex gap-1">
          {POSE_PRESETS.map((p) => (
            <button
              key={p.id}
              data-testid={`pose-preset-${p.id}`}
              className={toggleCls(
                p.angles.length === settings.angles.length && p.angles.every((a) => settings.angles.includes(a))
              )}
              onClick={() => onChange({ ...settings, angles: p.angles })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-2">
          {POSE_ANGLE_IDS.map((id) => (
            <Check key={id} checked={settings.angles.includes(id)} onChange={() => toggleAngle(id)}>
              {POSE_ANGLES[id].label}
            </Check>
          ))}
        </div>
      </Field>
      <Field label={`Line · ${settings.widthPx}px`}>
        <Slider
          ariaLabel="Pose line width"
          min={2}
          max={24}
          value={settings.widthPx}
          onChange={(v) => onChange({ ...settings, widthPx: v })}
        />
      </Field>
      <button
        data-testid="pose-to-drawing"
        className={`w-full ${btnCls}`}
        title="Copy the skeleton on screen into a graphics tile you can draw on"
        onClick={() => {
          if (!asset) return
          const id = poseToGraphics(layer, content, asset, data, usePlayback.getState().time)
          setConvertNote(id ? null : 'Nobody picked is visible at the playhead.')
        }}
      >
        ✏️ Convert to drawing
      </button>
      {convertNote && <p className="mt-1 text-[10px] leading-snug text-zinc-400">{convertNote}</p>}
      <p className="mt-1 text-[10px] leading-snug text-zinc-500">
        {data.model}. Joints the model isn&apos;t sure about (under water, hidden) are left out.
      </p>
    </div>
  )
}
