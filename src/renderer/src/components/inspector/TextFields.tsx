/** Inspector ▸ text layer: the text box, entrance / exit animation and text effects. */

import { type JSX } from 'react'
import type { TextContent } from '@shared/project'
import { hasColorEmoji } from '@shared/textStyle'
import {
  DEFAULT_IN_SEC,
  DEFAULT_OUT_SEC,
  type TextAnimIn,
  type TextAnimOut,
  type TextAnimation
} from '@shared/textAnim'
import type { SparkleEffect } from '@shared/sparkle'
import { DEFAULT_SPARKLE, SPARKLE_DENSITY_RANGE } from '@shared/sparkle'
import { Field, NumberInput, useTypingGesture, colorCls, inputCls } from '../ui'

const ANIM_IN_OPTIONS: { value: TextAnimIn; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fadeIn', label: 'Fade in' },
  { value: 'slideUp', label: 'Slide in from bottom' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'wordHighlight', label: 'Word-by-word highlight' }
]
const ANIM_OUT_OPTIONS: { value: TextAnimOut; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fadeOut', label: 'Fade out' },
  { value: 'slideDown', label: 'Slide out' }
]
/** Entrance/exit animation controls for a text layer. Disabled while the layer
 *  burns as a rasterised PNG (gradient fill / fixed wrap width / colour emoji) — that path
 *  can't animate, and `effectiveTextAnimation` ignores the setting there so
 *  preview and export agree. */
export function TextAnimationFields({
  content,
  onPatch
}: {
  content: TextContent
  onPatch: (patch: Partial<TextContent>) => void
}): JSX.Element {
  const anim: TextAnimation = content.animation ?? {
    in: 'none',
    inSec: DEFAULT_IN_SEC.fadeIn,
    out: 'none',
    outSec: DEFAULT_OUT_SEC
  }
  const emoji = hasColorEmoji(content.text)
  const disabled = !!content.gradient || content.widthPx != null || emoji
  const patch = (p: Partial<TextAnimation>): void => onPatch({ animation: { ...anim, ...p } })
  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <div className="mb-1 mt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Animation</div>
      {disabled && (
        <p className="mb-1 text-[10px] leading-snug text-amber-300/80">
          {emoji
            ? 'Not available on text with emoji: it is rendered as an image so the emoji keep their colour.'
            : 'Not available with a gradient fill or a fixed wrap width (that text is rendered as an image).'}
        </p>
      )}
      <div className="flex gap-2">
        <Field label="Entrance">
          <select
            value={anim.in}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value as TextAnimIn
              patch({ in: v, inSec: DEFAULT_IN_SEC[v] })
            }}
            className={inputCls}
          >
            {ANIM_IN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="In (s)">
          <NumberInput
            min={0.1}
            max={10}
            step={0.1}
            value={anim.inSec}
            disabled={disabled || anim.in === 'none' || anim.in === 'wordHighlight'}
            title={anim.in === 'wordHighlight' ? 'Word-by-word spans the whole layer duration' : undefined}
            onCommit={(v) => patch({ inSec: v })}
          />
        </Field>
      </div>
      <div className="flex gap-2">
        <Field label="Exit">
          <select
            value={anim.out}
            disabled={disabled}
            onChange={(e) => patch({ out: e.target.value as TextAnimOut, outSec: DEFAULT_OUT_SEC })}
            className={inputCls}
          >
            {ANIM_OUT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Out (s)">
          <NumberInput
            min={0.1}
            max={10}
            step={0.1}
            value={anim.outSec}
            disabled={disabled || anim.out === 'none'}
            onCommit={(v) => patch({ outSec: v })}
          />
        </Field>
      </div>
    </div>
  )
}
/**
 * A caption's text box. Every change re-times the words through
 * `captionWithText` — split rebuilds text from the words, so text alone would
 * revert at the next split. It re-times from the words the caption had when the
 * box got focus, so intermediate keystrokes (a half-typed word, a stray space)
 * never wear the original timings down.
 */
/** A text layer's Text box: one undo step per typing session (`useTypingGesture`). */
export function LayerTextInput({ value, onChange }: { value: string; onChange: (text: string) => void }): JSX.Element {
  const typing = useTypingGesture()
  return <textarea value={value} rows={2} {...typing} onChange={(e) => onChange(e.target.value)} className={inputCls} />
}
/**
 * "Text effects" — decoration layered on top of the glyphs, deliberately
 * SEPARATE from the entrance/exit animation so the two combine freely: sparkles
 * plus a typewriter give letter-by-letter glints, sparkles plus a fade give a
 * shimmer, and any future effect here works with every entrance for free.
 *
 * Unlike animations, these are not lost on the rasterised-PNG path (gradient
 * fill / fixed wrap width) — sparkles burn as their own vector events above the
 * image — so there is no caveat to show here. @see shared/sparkle.ts
 */
export function TextEffectsFields({
  content,
  onPatch
}: {
  content: TextContent
  onPatch: (patch: Partial<TextContent>) => void
}): JSX.Element {
  const sparkle = content.effects?.sparkle ?? null
  const on = !!sparkle && sparkle.density > 0
  const setSparkle = (next: SparkleEffect | null): void => onPatch({ effects: { ...content.effects, sparkle: next } })

  return (
    <>
      <label className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setSparkle(e.target.checked ? { ...DEFAULT_SPARKLE } : null)}
        />
        ✧ Sparkles
      </label>
      {on && sparkle && (
        <>
          <Field label={`Amount · ${sparkle.density}`}>
            <input
              type="range"
              min={SPARKLE_DENSITY_RANGE.min}
              max={SPARKLE_DENSITY_RANGE.max}
              step={1}
              value={sparkle.density}
              onChange={(e) => setSparkle({ ...sparkle, density: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label="Color">
            <input
              type="color"
              value={sparkle.color.slice(0, 7)}
              onChange={(e) => setSparkle({ ...sparkle, color: e.target.value })}
              className={colorCls}
            />
          </Field>
          <p className="mt-1 text-[10px] leading-snug text-zinc-500">
            Follows a typewriter entrance letter by letter; scatters across the text with any other entrance.
          </p>
        </>
      )}
    </>
  )
}
