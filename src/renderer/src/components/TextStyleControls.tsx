import { useEffect, type JSX } from 'react'
import type { TextStyleBase } from '@shared/project'
import { DEFAULT_GRADIENT, DEFAULT_SHADOW, DEFAULT_STROKE } from '@shared/project'
import { useBrandColors } from '@/state/brandColors'
import { FontPicker } from './FontPicker'
import { Check, Field, NumberInput, Slider, colorCls, inputCls } from './ui'

/** The styling knobs shared by a text overlay and a caption — the shared
 *  `TextStyleBase` that both `TextContent` and `CaptionStyle` extend. */
export type TextStyleLike = TextStyleBase
export type TextStylePatch = Partial<TextStyleLike>

/** Font size range in logical px. The number field has no upper cap; past the
 *  slider's end the thumb just parks there. */
const FONT_SIZE_MIN = 12
const FONT_SIZE_SLIDER_MAX = 400

const GRADIENT_PRESETS: { name: string; from: string; to: string; angle: number }[] = [
  { name: 'Sunset', from: '#FF512F', to: '#DD2476', angle: 90 },
  { name: 'Gold', from: '#F7971E', to: '#FFD200', angle: 90 },
  { name: 'Ocean', from: '#2193B0', to: '#6DD5ED', angle: 90 },
  { name: 'Grape', from: '#DA22FF', to: '#9733EE', angle: 90 },
  { name: 'Lime', from: '#56AB2F', to: '#A8E063', angle: 90 },
  { name: 'Fire', from: '#FF416C', to: '#FF4B2B', angle: 90 },
  { name: 'Ice', from: '#FFFFFF', to: '#8AB4FF', angle: 180 }
]

// --- 8-digit hex helpers (pill color carries alpha) -------------------------
const hex6 = (c: string): string => '#' + c.replace('#', '').slice(0, 6).padEnd(6, '0')
const getAlpha = (c: string): number => {
  const h = c.replace('#', '')
  return h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255
}
const withAlpha = (c: string, a: number): string =>
  hex6(c) + Math.max(0, Math.min(255, Math.round(a))).toString(16).padStart(2, '0')

/** Saved-brand-color swatches: click to apply, ＋ saves the current color,
 *  right-click removes a swatch. */
function BrandSwatches({ current, onPick }: { current: string; onPick: (hex: string) => void }): JSX.Element {
  const colors = useBrandColors((s) => s.colors)
  const add = useBrandColors((s) => s.add)
  const remove = useBrandColors((s) => s.remove)
  useEffect(() => void useBrandColors.getState().load(), [])
  return (
    <div className="mb-2">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">Brand colors</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            onContextMenu={(e) => {
              e.preventDefault()
              remove(c)
            }}
            title={`${c} — click to apply, right-click to remove`}
            className="h-5 w-5 rounded border border-white/20 shadow-sm"
            style={{ background: c }}
          />
        ))}
        <button
          type="button"
          onClick={() => add(hex6(current))}
          title="Save the current color"
          className="flex h-5 w-5 items-center justify-center rounded border border-dashed border-white/30 text-[11px] text-zinc-400 hover:text-zinc-200"
        >
          ＋
        </button>
      </div>
    </div>
  )
}

/**
 * The shared text/caption styling block: font, size, fill (+brand swatches),
 * gradient, pill (with opacity), stroke and shadow. Drives every control from
 * one `style` shape so text overlays and captions stay in lockstep.
 */
export function TextStyleControls({
  style,
  onPatch
}: {
  style: TextStyleLike
  onPatch: (patch: TextStylePatch) => void
}): JSX.Element {
  const pill = style.pill
  const stroke = style.stroke
  const shadow = style.shadow
  const gradient = style.gradient

  return (
    <div>
      <Field label="Font">
        <FontPicker value={style.fontFamily} onChange={(id) => onPatch({ fontFamily: id })} />
      </Field>

      <Field label="Font size">
        <div className="flex items-center gap-2">
          <Slider
            ariaLabel="Font size"
            className="min-w-0 flex-1"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_SLIDER_MAX}
            step={1}
            value={style.fontSizePx}
            onChange={(v) => onPatch({ fontSizePx: v })}
          />
          <NumberInput
            ariaLabel="Font size"
            step="2"
            min={FONT_SIZE_MIN}
            value={style.fontSizePx}
            onCommit={(v) => onPatch({ fontSizePx: v })}
            className={inputCls.replace('w-full', 'w-16 shrink-0')}
          />
        </div>
      </Field>
      <Field label="Color">
        <input
          type="color"
          value={hex6(style.color)}
          onChange={(e) => onPatch({ color: e.target.value })}
          className={colorCls}
        />
      </Field>

      <BrandSwatches current={style.color} onPick={(hex) => onPatch({ color: hex })} />

      {/* Gradient fill (overrides the flat color) */}
      <div className="mb-2 rounded border border-white/5 bg-white/[0.02] p-2">
        <Check
          checked={!!gradient}
          onChange={(v) => onPatch({ gradient: v ? { ...DEFAULT_GRADIENT } : null })}
        >
          Gradient fill
        </Check>
        {gradient && (
          <>
            <div className="flex items-end gap-2">
              <Field label="From">
                <input
                  type="color"
                  value={hex6(gradient.from)}
                  onChange={(e) => onPatch({ gradient: { ...gradient, from: e.target.value } })}
                  className={colorCls}
                />
              </Field>
              <Field label="To">
                <input
                  type="color"
                  value={hex6(gradient.to)}
                  onChange={(e) => onPatch({ gradient: { ...gradient, to: e.target.value } })}
                  className={colorCls}
                />
              </Field>
            </div>
            <Field label={`Angle · ${Math.round(gradient.angle)}°`}>
              <Slider
                min={0}
                max={360}
                step={5}
                value={gradient.angle}
                onChange={(v) => onPatch({ gradient: { ...gradient, angle: v } })}
              />
            </Field>
            <div className="flex flex-wrap gap-1">
              {GRADIENT_PRESETS.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => onPatch({ gradient: { from: g.from, to: g.to, angle: g.angle } })}
                  title={g.name}
                  className="h-5 w-7 rounded border border-white/20"
                  style={{ background: `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})` }}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Pill background */}
      <div className="mb-2 rounded border border-white/5 bg-white/[0.02] p-2">
        <Check checked={pill.enabled} onChange={(v) => onPatch({ pill: { ...pill, enabled: v } })}>
          Background pill
        </Check>
        {pill.enabled && (
          <>
            <div className="flex items-end gap-2">
              <Field label="Pill color">
                <input
                  type="color"
                  value={hex6(pill.color)}
                  onChange={(e) => onPatch({ pill: { ...pill, color: withAlpha(e.target.value, getAlpha(pill.color)) } })}
                  className={colorCls}
                />
              </Field>
              <Field label="Padding">
                <NumberInput
                  step="2"
                  min={0}
                  value={pill.padPx}
                  format={(v) => String(Math.round(v))}
                  onCommit={(v) => onPatch({ pill: { ...pill, padPx: v } })}
                />
              </Field>
            </div>
            <Field label={`Opacity · ${Math.round((getAlpha(pill.color) / 255) * 100)}%`}>
              <Slider
                min={0}
                max={100}
                step={1}
                value={Math.round((getAlpha(pill.color) / 255) * 100)}
                onChange={(v) => onPatch({ pill: { ...pill, color: withAlpha(pill.color, (v / 100) * 255) } })}
              />
            </Field>
          </>
        )}
      </div>

      {/* Stroke / outline (ignored while a pill is on) */}
      <div className="mb-2 rounded border border-white/5 bg-white/[0.02] p-2">
        <Check checked={!!stroke} onChange={(v) => onPatch({ stroke: v ? { ...DEFAULT_STROKE } : null })}>
          Outline {pill.enabled && stroke ? <span className="text-zinc-500">(off while pill on)</span> : null}
        </Check>
        {stroke && (
          <div className="flex items-end gap-2">
            <Field label={`Width · ${Math.round(stroke.widthPx)}px`}>
              <Slider
                min={0}
                max={24}
                step={1}
                value={stroke.widthPx}
                onChange={(v) => onPatch({ stroke: { ...stroke, widthPx: v } })}
              />
            </Field>
            <Field label="Color">
              <input
                type="color"
                value={hex6(stroke.color)}
                onChange={(e) => onPatch({ stroke: { ...stroke, color: e.target.value } })}
                className={colorCls}
              />
            </Field>
          </div>
        )}
      </div>

      {/* Drop shadow */}
      <div className="mb-1 rounded border border-white/5 bg-white/[0.02] p-2">
        <Check checked={!!shadow} onChange={(v) => onPatch({ shadow: v ? { ...DEFAULT_SHADOW } : null })}>
          Drop shadow
        </Check>
        {shadow && (
          <>
            <div className="flex items-end gap-2">
              <Field label={`Distance · ${shadow.distancePx}px`}>
                <Slider
                  min={0}
                  max={10}
                  step={1}
                  value={shadow.distancePx}
                  onChange={(v) => onPatch({ shadow: { ...shadow, distancePx: v } })}
                />
              </Field>
              <Field label="Color">
                <input
                  type="color"
                  value={hex6(shadow.color)}
                  onChange={(e) => onPatch({ shadow: { ...shadow, color: withAlpha(e.target.value, getAlpha(shadow.color)) } })}
                  className={colorCls}
                />
              </Field>
            </div>
            <Field label={`Softness · ${shadow.blur}`}>
              <Slider
                min={0}
                max={10}
                step={1}
                value={shadow.blur}
                onChange={(v) => onPatch({ shadow: { ...shadow, blur: v } })}
              />
            </Field>
          </>
        )}
      </div>
    </div>
  )
}
