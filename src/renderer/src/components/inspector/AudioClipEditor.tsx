/** Inspector ▸ the selected AUDIO clip, and its volume-level section. */

import { useState, type JSX } from 'react'
import type { AudioClip, VolumeLevel } from '@shared/project'
import { levelOf, levelStatusText } from '@shared/volumeLevels'
import { useClipGain } from '@/hooks/useClipGain'
import { LevelLoudnessField } from '../VolumeLevelDialog'
import { effectiveDenoise, effectiveOut } from '@shared/project'
import { useLibrary } from '@/hooks/useMedia'
import { detectSilence } from '@/ipc/client'
import { expandGroup } from '@/lib/links'
import { speechSegments } from '@/lib/silence'
import { activeComp, useProject } from '@/state/projectStore'
import { idle } from '@/lib/interaction'
import { useUi } from '@/state/ui'
import { Check, Field, NumberInput, Slider, dangerBtnCls, disabledCls, inputCls } from '../ui'
import { useLinkGroupSize, LinkedNote, useDeleteTile, OverrideToggle } from './controls'
import { SoundEffectsSection } from './SoundEffects'

export function AudioClipEditor(): JSX.Element | null {
  const selectedAudioId = useUi((s) => s.selectedAudioId)
  const clip = useProject((s) => activeComp(s)?.audioClips.find((a) => a.id === selectedAudioId) ?? null)
  const update = useProject((s) => s.updateAudioClip)
  const groupSize = useLinkGroupSize('audio', selectedAudioId)
  const linked = groupSize > 1
  const remove = useDeleteTile('audio', selectedAudioId)
  const moveItems = useProject((s) => s.moveItemsBy)
  const denoiseDefault = useProject((s) => s.project?.denoiseDefault ?? false)
  const splitOnSilence = useProject((s) => s.splitAudioOnSilence)
  const { data: assets = [] } = useLibrary()
  const [splitting, setSplitting] = useState(false)
  const [splitNote, setSplitNote] = useState<string | null>(null)
  if (!clip) return null
  const asset = assets.find((a) => a.id === clip.mediaId)

  const runSplitOnSilence = async (): Promise<void> => {
    if (splitting) return
    setSplitting(true)
    setSplitNote(null)
    try {
      const dur = asset?.probe.durationSec ?? clip.outSec
      const silences = await detectSilence(clip.mediaId)
      const ranges = speechSegments(silences, clip.inSec, effectiveOut(clip, dur), 0.4)
      await idle() // detection can finish mid-drag; the split waits for the release
      // A linked clip cuts its partners too, at the same timeline seconds.
      const srcDur = (mediaId: string): number => assets.find((a) => a.id === mediaId)?.probe.durationSec ?? 0
      if (ranges.length > 1) splitOnSilence(clip.id, ranges, srcDur)
      else setSplitNote('No silence gaps found to split on.')
    } finally {
      setSplitting(false)
    }
  }

  return (
    <div>
      <div className="mb-1 text-sm font-medium text-zinc-200">Audio clip</div>
      <div className="mb-3 truncate text-xs text-zinc-400" title={asset?.fileName}>
        {asset?.fileName ?? clip.mediaId} · {clip.kind}
      </div>
      {linked && <LinkedNote size={groupSize} />}
      <Check checked={!!clip.mute} onChange={(v) => update(clip.id, { mute: v })}>
        🔇 Mute this clip
      </Check>
      <ClipVolumeSection clip={clip} />
      {/* An audio clip's Start is a MOVE (its trim doesn't change), so unlike a
          layer's it translates onto a group: the whole group shifts by the delta. */}
      <Field label={linked ? 'Start (s) · moves the group' : 'Start (s)'}>
        <NumberInput
          step="0.1"
          min={0}
          value={clip.startSec}
          format={(v) => v.toFixed(1)}
          onCommit={(next) => {
            if (!linked) return update(clip.id, { startSec: next })
            const p = useProject.getState().project
            if (p) moveItems(expandGroup(p, { kind: 'audio', id: clip.id }), next - clip.startSec)
          }}
        />
      </Field>
      <div className="flex gap-2">
        <Field label="Fade in (s)">
          <NumberInput step="0.5" min={0} value={clip.fadeInSec} onCommit={(v) => update(clip.id, { fadeInSec: v })} />
        </Field>
        <Field label="Fade out (s)">
          <NumberInput
            step="0.5"
            min={0}
            value={clip.fadeOutSec}
            onCommit={(v) => update(clip.id, { fadeOutSec: v })}
          />
        </Field>
      </div>
      <label className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={clip.duck} onChange={(e) => update(clip.id, { duck: e.target.checked })} />
        Duck under other audio (music bed)
      </label>
      <OverrideToggle
        label="Reduce noise (on export)"
        noun="noise reduction"
        effectiveOn={effectiveDenoise(clip, denoiseDefault)}
        defaultOn={denoiseDefault}
        mode={clip.denoise === undefined ? 'default' : clip.denoise ? 'on' : 'off'}
        onPick={(key) => update(clip.id, { denoise: key === 'default' ? undefined : key === 'on' })}
      />
      <label className="mb-3 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={!!clip.excludeFromCaptions}
          onChange={(e) => update(clip.id, { excludeFromCaptions: e.target.checked })}
        />
        Exclude from captions
      </label>

      <button
        onClick={() => void runSplitOnSilence()}
        disabled={splitting}
        className={`mb-1 w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 disabled:opacity-50 ${disabledCls}`}
        title={
          linked
            ? 'Detect silence and split this clip into its speech segments; its linked tiles are cut at the same points'
            : 'Detect silence and split this clip into its speech segments'
        }
      >
        {splitting ? 'Detecting…' : '✂ Split on silence'}
      </button>
      {splitNote && <p className="mb-2 text-[11px] text-zinc-500">{splitNote}</p>}

      {/* An effect track re-renders from the clip it was BUILT from, not from
          its own (already wet) audio — an echo of an echo is not the intent. */}
      <SoundEffectsSection
        key={clip.id}
        sourceMediaId={clip.fx ? clip.fx.fromMediaId : clip.mediaId}
        inSec={clip.fx ? clip.fx.fromInSec : clip.inSec}
        outSec={clip.fx ? clip.fx.fromOutSec : effectiveOut(clip, asset?.probe.durationSec ?? clip.outSec)}
        startSec={clip.startSec}
        linkGroupId={clip.linkGroupId}
        existing={clip.fx}
        replaceClipId={clip.fx ? clip.id : undefined}
      />

      <button onClick={remove} className={`mt-2 w-full ${dangerBtnCls}`}>
        {linked ? `Delete linked group (${groupSize})` : 'Remove audio clip'}
      </button>
    </div>
  )
}
const NO_LEVELS: VolumeLevel[] = []
const NO_CLIPS: AudioClip[] = []
const NEW_LEVEL = '__new-level'
/**
 * An audio clip's loudness controls, top to bottom: its OWN volume slider; the
 * "Volume level" picker; and, for a clip in a level, that level's loudness
 * (which moves every clip in it) with the status line saying what the level
 * did to this clip. The gain itself comes from `clipGain` — the export's call.
 *
 * The own slider keeps its value, but is greyed out and locked while the clip
 * is muted (unmuting restores it) or in a level (leaving restores it).
 */
function ClipVolumeSection({ clip }: { clip: AudioClip }): JSX.Element {
  const update = useProject((s) => s.updateAudioClip)
  const setClipsLevel = useProject((s) => s.setClipsVolumeLevel)
  const levels = useProject((s) => s.project?.volumeLevels ?? NO_LEVELS)
  const clips = useProject((s) => activeComp(s)?.audioClips ?? NO_CLIPS)
  const { data: assets = [] } = useLibrary()
  const durationOf = (id: string): number => assets.find((a) => a.id === id)?.probe.durationSec ?? 0
  const gain = useClipGain(clip, clips, durationOf)
  const isFx = clip.kind === 'fx'
  const level = levelOf(clip, levels)
  const followed = gain.status.kind === 'follows' ? levels.find((l) => l.id === gain.levelId) : null
  const status = levelStatusText(gain.status, gain.gainDb)

  const label = clip.mute
    ? `Volume · muted (${clip.gainDb} dB)`
    : level
      ? `Volume · ${clip.gainDb} dB · set by the level`
      : `Volume · ${clip.gainDb} dB`
  return (
    <>
      <Field label={label}>
        <Slider
          ariaLabel="Clip volume"
          min={-40}
          max={24}
          step={1}
          value={clip.gainDb}
          disabled={!!clip.mute || !!level}
          title={level ? `Set by the “${level.name}” volume level — choose None below to use this again` : undefined}
          onChange={(v) => update(clip.id, { gainDb: v })}
          className={`w-full ${disabledCls}`}
        />
      </Field>
      <Field label="Volume level">
        <select
          data-testid="volume-level-select"
          value={isFx ? '' : (level?.id ?? '')}
          disabled={isFx}
          title={isFx ? 'An effect track follows the level of the clip it was made from' : undefined}
          onChange={(e) => {
            const v = e.target.value
            if (v === NEW_LEVEL) useUi.getState().setLevelDialog({ mode: 'create', assign: [clip.id] })
            else setClipsLevel([clip.id], v || null)
          }}
          className={`${inputCls} ${disabledCls}`}
        >
          <option value="">None — its own volume</option>
          {levels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.targetLufs} LUFS)
            </option>
          ))}
          <option value={NEW_LEVEL}>New level…</option>
        </select>
      </Field>
      {level && <LevelLoudnessField levelId={level.id} />}
      {followed && (
        <p className="-mt-1 mb-2 text-[11px] text-zinc-500">
          Its source clip is in “{followed.name}” ({followed.targetLufs} LUFS).
        </p>
      )}
      {status && (
        <p
          data-testid="level-status"
          className={`-mt-1 mb-2 text-[11px] ${gain.status.kind === 'short' ? 'text-amber-300' : 'text-zinc-400'}`}
        >
          {status}
        </p>
      )}
    </>
  )
}
