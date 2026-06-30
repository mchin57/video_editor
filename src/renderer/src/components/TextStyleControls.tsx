import { useEffect, type JSX, type ReactNode } from 'react'
import type { TextStyleBase } from '@shared/project'
import { DEFAULT_GRADIENT, DEFAULT_SHADOW, DEFAULT_STROKE } from '@shared/project'
import { useBrandColors } from '@/state/brandColors'
import { FontPicker } from './FontPicker'

/** The styling knobs shared by a text overlay and a caption — the shared
 *  `TextStyleBase` that both `TextContent` and `CaptionStyle` extend. */
export type TextStyleLike = TextStyleBase
export type TextStylePatch = Partial<TextStyleLike>

const inputCls =
  'w-full rounded border border-white/10 bg-black/40 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-sky-400/60'

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

function Field({ label, children }: { label: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <label className="mb-2 block">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  )
}

function Check({
  checked,
  onChange,
  children
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
}): JSX.Element {
  return (
    <label className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

const colorCls = 'h-7 w-full rounded border border-white/10 bg-black/40'

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

      <div className="flex items-end gap-2">
        <Field label="Font size">
          <input
            type="number"
            step="2"
            min="12"
            value={style.fontSizePx}
            onChange={(e) => onPatch({ fontSizePx: Math.max(12, Number(e.target.value)) })}
            className={inputCls}
          />
        </Field>
        <Field label="Color">
          <input
            type="color"
            value={hex6(style.color)}
            onChange={(e) => onPatch({ color: e.target.value })}
            className={colorCls}
          />
        </Field>
      </div>

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
              <input
                type="range"
                min={0}
                max={360}
                step={5}
                value={gradient.angle}
                onChange={(e) => onPatch({ gradient: { ...gradient, angle: Number(e.target.value) } })}
                className="w-full accent-sky-400"
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
                <input
                  type="number"
                  step="2"
                  min="0"
                  value={Math.round(pill.padPx)}
                  onChange={(e) => onPatch({ pill: { ...pill, padPx: Math.max(0, Number(e.target.value)) } })}
                  className={inputCls}
                />
              </Field>
            </div>
            <Field label={`Opacity · ${Math.round((getAlpha(pill.color) / 255) * 100)}%`}>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round((getAlpha(pill.color) / 255) * 100)}
                onChange={(e) => onPatch({ pill: { ...pill, color: withAlpha(pill.color, (Number(e.target.value) / 100) * 255) } })}
                className="w-full accent-sky-400"
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
              <input
                type="range"
                min={0}
                max={24}
                step={1}
                value={stroke.widthPx}
                onChange={(e) => onPatch({ stroke: { ...stroke, widthPx: Number(e.target.value) } })}
                className="w-full accent-sky-400"
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
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={shadow.distancePx}
                  onChange={(e) => onPatch({ shadow: { ...shadow, distancePx: Number(e.target.value) } })}
                  className="w-full accent-sky-400"
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
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={shadow.blur}
                onChange={(e) => onPatch({ shadow: { ...shadow, blur: Number(e.target.value) } })}
                className="w-full accent-sky-400"
              />
            </Field>
          </>
        )}
      </div>
    </div>
  )
}
