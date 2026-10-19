/** Inspector ▸ sound effects: echo / ensemble / chorus rendered from a clip onto their own track. */

import { useState, type JSX } from 'react'
import type { AudioFx, AudioFxKind, AudioFxSettings, ChorusEffect, EchoEffect, EnsembleEffect } from '@shared/audioFx'
import {
  CHORUS_RANGE,
  DEFAULT_CHORUS,
  DEFAULT_ECHO,
  DEFAULT_ENSEMBLE,
  ECHO_RANGE,
  ENSEMBLE_RANGE,
  fxLabel
} from '@shared/audioFx'
import { useAddAudioFx } from '@/hooks/useMedia'
import { activeComp, useProject } from '@/state/projectStore'
import { CollapsibleSection } from '../CollapsibleSection'
import { Field, disabledCls } from '../ui'

const FX_KINDS: { value: AudioFxKind; label: string; hint: string }[] = [
  { value: 'echo', label: 'Echo', hint: 'Repeats that fall away — lands emphasis on a word.' },
  {
    value: 'ensemble',
    label: 'Ensemble',
    hint: 'Copies at a fixed detune, stacked — thickens a voice without movement.'
  },
  {
    value: 'chorus',
    label: 'Chorus',
    hint: 'Copies whose pitch drifts back and forth — the classic shimmer.'
  }
]
/**
 * "Sound effects" — builds an echo or chorus from the selected clip's audio and
 * drops it on the timeline as its OWN track, mixed over the untouched original.
 *
 * The wet signal is rendered to a real audio asset rather than resolved at
 * export time, so what plays in the preview is what the export mixes, the
 * timeline draws the effect's own waveform, and the track can be moved, faded,
 * trimmed and split like any other. @see shared/audioFx.ts
 *
 * With `existing` set, the section is editing a track that already IS an
 * effect: the same controls re-render it in place instead of stacking another.
 */
export function SoundEffectsSection({
  sourceMediaId,
  inSec,
  outSec,
  startSec,
  linkGroupId,
  existing,
  replaceClipId,
  disabledReason
}: {
  sourceMediaId: string
  inSec: number
  outSec: number
  startSec: number
  linkGroupId?: string
  existing?: AudioFx | null
  replaceClipId?: string
  /** Non-null disables the section and says why (e.g. the clip has no audio). */
  disabledReason?: string | null
}): JSX.Element {
  const addFx = useAddAudioFx()
  const start = existing?.settings ?? null
  const [kind, setKind] = useState<AudioFxKind>(start?.kind ?? 'echo')
  const [echo, setEcho] = useState<EchoEffect>(start?.kind === 'echo' ? start.echo : { ...DEFAULT_ECHO })
  const [ensemble, setEnsemble] = useState<EnsembleEffect>(
    start?.kind === 'ensemble' ? start.ensemble : { ...DEFAULT_ENSEMBLE }
  )
  const [chorus, setChorus] = useState<ChorusEffect>(start?.kind === 'chorus' ? start.chorus : { ...DEFAULT_CHORUS })
  const settings: AudioFxSettings =
    kind === 'echo'
      ? { kind: 'echo', echo }
      : kind === 'ensemble'
        ? { kind: 'ensemble', ensemble }
        : { kind: 'chorus', chorus }
  const busy = addFx.isPending
  const disabled = !!disabledReason || busy

  // The render is content-addressed, so re-rendering settings that are already
  // on disk legitimately produces the SAME asset and changes nothing audible.
  // Without saying so, that is indistinguishable from a failed render — report
  // it. The note is tied to the settings it describes so it disappears as soon
  // as a knob moves.
  const [note, setNote] = useState<{ text: string; sig: string } | null>(null)
  const sig = JSON.stringify(settings)

  const run = (): void => {
    const before = replaceClipId
      ? activeComp(useProject.getState())?.audioClips.find((c) => c.id === replaceClipId)?.mediaId
      : undefined
    setNote(null)
    addFx.mutate(
      { settings, sourceMediaId, inSec, outSec, startSec, linkGroupId, replaceClipId },
      {
        onSuccess: (asset) =>
          setNote({
            sig,
            text:
              before && asset.id === before
                ? 'Already up to date — this is exactly what is rendered.'
                : existing
                  ? 'Re-rendered.'
                  : 'Track added.'
          })
      }
    )
  }

  return (
    <CollapsibleSection id="soundfx" title="Sound effects">
      {disabledReason && <p className="mb-2 text-[10px] leading-snug text-amber-300/80">{disabledReason}</p>}
      <div className="mb-2 flex gap-1">
        {FX_KINDS.map((k) => (
          <button
            key={k.value}
            onClick={() => setKind(k.value)}
            disabled={disabled}
            title={k.hint}
            className={`flex-1 rounded px-2 py-1 text-xs disabled:opacity-50 ${
              kind === k.value ? 'bg-sky-500/80 text-white' : 'bg-white/10 text-zinc-300 hover:bg-white/20'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <p className="mb-2 text-[10px] leading-snug text-zinc-500">{FX_KINDS.find((k) => k.value === kind)?.hint}</p>

      {kind === 'echo' ? (
        <>
          <Field label={`Delay · ${Math.round(echo.delayMs)} ms`}>
            <input
              type="range"
              min={ECHO_RANGE.delayMs.min}
              max={ECHO_RANGE.delayMs.max}
              step={10}
              value={echo.delayMs}
              disabled={disabled}
              onChange={(e) => setEcho({ ...echo, delayMs: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Decay · ${echo.decay.toFixed(2)}`}>
            <input
              type="range"
              min={ECHO_RANGE.decay.min}
              max={ECHO_RANGE.decay.max}
              step={0.05}
              value={echo.decay}
              disabled={disabled}
              onChange={(e) => setEcho({ ...echo, decay: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Repeats · ${echo.repeats}`}>
            <input
              type="range"
              min={ECHO_RANGE.repeats.min}
              max={ECHO_RANGE.repeats.max}
              step={1}
              value={echo.repeats}
              disabled={disabled}
              onChange={(e) => setEcho({ ...echo, repeats: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
        </>
      ) : kind === 'ensemble' ? (
        <>
          <Field label={`Voices · ${ensemble.voices}`}>
            <input
              type="range"
              min={ENSEMBLE_RANGE.voices.min}
              max={ENSEMBLE_RANGE.voices.max}
              step={1}
              value={ensemble.voices}
              disabled={disabled}
              onChange={(e) => setEnsemble({ ...ensemble, voices: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Spread · ${Math.round(ensemble.spreadMs)} ms`}>
            <input
              type="range"
              min={ENSEMBLE_RANGE.spreadMs.min}
              max={ENSEMBLE_RANGE.spreadMs.max}
              step={1}
              value={ensemble.spreadMs}
              disabled={disabled}
              onChange={(e) => setEnsemble({ ...ensemble, spreadMs: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Detune · ${Math.round(ensemble.detuneCents)} cents`}>
            <input
              type="range"
              min={ENSEMBLE_RANGE.detuneCents.min}
              max={ENSEMBLE_RANGE.detuneCents.max}
              step={1}
              value={ensemble.detuneCents}
              disabled={disabled}
              onChange={(e) => setEnsemble({ ...ensemble, detuneCents: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label={`Voices · ${chorus.voices}`}>
            <input
              type="range"
              min={CHORUS_RANGE.voices.min}
              max={CHORUS_RANGE.voices.max}
              step={1}
              value={chorus.voices}
              disabled={disabled}
              onChange={(e) => setChorus({ ...chorus, voices: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Rate · ${chorus.rateHz.toFixed(1)} Hz`}>
            <input
              type="range"
              min={CHORUS_RANGE.rateHz.min}
              max={CHORUS_RANGE.rateHz.max}
              step={0.1}
              value={chorus.rateHz}
              disabled={disabled}
              onChange={(e) => setChorus({ ...chorus, rateHz: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Depth · ${chorus.depth.toFixed(2)}`}>
            <input
              type="range"
              min={CHORUS_RANGE.depth.min}
              max={CHORUS_RANGE.depth.max}
              step={0.05}
              value={chorus.depth}
              disabled={disabled}
              onChange={(e) => setChorus({ ...chorus, depth: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
        </>
      )}

      <button
        onClick={run}
        disabled={disabled}
        className={`mt-1 w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 disabled:opacity-50 ${disabledCls}`}
        title={
          disabledReason ??
          (existing
            ? 'Re-render this effect track with the settings above'
            : 'Render the effect and add it as its own track over this clip')
        }
      >
        {busy
          ? 'Rendering…'
          : existing
            ? `↻ Re-render ${fxLabel(settings).toLowerCase()}`
            : `+ Add ${fxLabel(settings).toLowerCase()} track`}
      </button>
      {note && note.sig === sig ? (
        <p className="mt-1 text-[10px] leading-snug text-emerald-400/90">{note.text}</p>
      ) : (
        <p className="mt-1 text-[10px] leading-snug text-zinc-500">
          {existing
            ? 'Replaces this track’s audio in place.'
            : 'Adds a separate track — the original clip is left untouched.'}
        </p>
      )}
    </CollapsibleSection>
  )
}
