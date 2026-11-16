/** Inspector ▸ the selected audio clip's VOLUME LINE: its points as exact fields, and Clear. */

import type { JSX } from 'react'
import type { AudioClip, VolumeLevel } from '@shared/project'
import {
  VOLUME_LINE_MAX_DB,
  VOLUME_LINE_SILENCE_DB,
  moveVolumeKeyframe,
  removeVolumeKeyframe,
  sortedVolumeKeyframes
} from '@shared/audioEnvelope'
import { levelOf } from '@shared/volumeLevels'
import { audioSourceAt, audioTimelineAt } from '@shared/audioTiming'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { Field, NumberInput, subtleBtnCls } from '../ui'

const NO_LEVELS: VolumeLevel[] = []

/**
 * One row per point, in time order: its TIMELINE second (where it plays — the
 * point itself stays on its sound in the source) and its level over the
 * clip's normal volume (−60 = silence, up to +12). A point a trim has left
 * outside the clip is listed greyed: it still shapes the line at the edge, and
 * trimming back out brings it back into play. Every edit is one undo step.
 */
export function VolumeLineSection({ clip, outSec }: { clip: AudioClip; outSec: number }): JSX.Element {
  const setLine = useProject((s) => s.setVolumeKeyframes)
  const levels = useProject((s) => s.project?.volumeLevels ?? NO_LEVELS)
  const picked = useUi((s) => s.selectedVolumePoint)
  const points = sortedVolumeKeyframes(clip)
  const toTimeline = (sourceSec: number): number => audioTimelineAt(clip, sourceSec)
  const level = levelOf(clip, levels)
  const boosts = points.some((k) => k.db > 0)

  return (
    <div data-testid="volume-line-section" className="mb-3">
      <Field
        label={`Volume line · ${points.length === 0 ? 'flat' : `${points.length} point${points.length === 1 ? '' : 's'}`}`}
      >
        {points.length === 0 ? (
          <p className="text-[11px] text-zinc-500">
            Select the tile and click its line to add a point, then drag it. Double-click a point (or click it and press
            Delete) to remove it.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex gap-1 text-[10px] text-zinc-500">
              <span className="flex-1">At (s)</span>
              <span className="flex-1">Level (dB)</span>
              <span className="w-6" />
            </div>
            {points.map((k, i) => {
              const outside = k.sourceSec < clip.inSec - 1e-6 || k.sourceSec > outSec + 1e-6
              const isPicked = picked?.clipId === clip.id && picked.index === i
              return (
                <div
                  key={`${i}-${k.sourceSec}`}
                  data-testid={`volume-point-row-${i}`}
                  className={`flex items-center gap-1 ${outside ? 'opacity-40' : ''} ${isPicked ? 'rounded ring-1 ring-amber-200/60' : ''}`}
                  title={outside ? 'Outside the clip (trimmed away) — still shapes the line at the edge' : undefined}
                >
                  <div className="flex-1">
                    <NumberInput
                      ariaLabel={`Point ${i + 1} time`}
                      step="0.1"
                      value={toTimeline(k.sourceSec)}
                      format={(v) => v.toFixed(2)}
                      onCommit={(t) =>
                        setLine(
                          clip.id,
                          moveVolumeKeyframe(
                            points,
                            i,
                            { sourceSec: audioSourceAt(clip, outSec, t), db: k.db },
                            { min: clip.inSec, max: outSec }
                          )
                        )
                      }
                    />
                  </div>
                  <div className="flex-1">
                    <NumberInput
                      ariaLabel={`Point ${i + 1} level`}
                      step="1"
                      min={VOLUME_LINE_SILENCE_DB}
                      max={VOLUME_LINE_MAX_DB}
                      value={k.db}
                      format={(v) => v.toFixed(1)}
                      onCommit={(db) => setLine(clip.id, moveVolumeKeyframe(points, i, { sourceSec: k.sourceSec, db }))}
                    />
                  </div>
                  <button
                    data-testid={`volume-point-remove-${i}`}
                    title="Remove this point"
                    onClick={() => setLine(clip.id, removeVolumeKeyframe(points, i))}
                    className="w-6 rounded px-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
                  >
                    ✕
                  </button>
                </div>
              )
            })}
            <p className="text-[10px] text-zinc-500">−60 dB is silence; 0 is the clip’s own volume.</p>
            {level && boosts && (
              <p data-testid="volume-line-clip-warning" className="text-[11px] text-amber-300">
                The line goes above 0 dB on a clip in “{level.name}”: it can push past the level’s −1 dBFS peak ceiling
                and clip.
              </p>
            )}
            <button
              data-testid="volume-line-clear"
              onClick={() => setLine(clip.id, [])}
              className={`mt-1 ${subtleBtnCls}`}
            >
              Clear the volume line
            </button>
          </div>
        )}
      </Field>
    </div>
  )
}
