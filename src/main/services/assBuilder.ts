/**
 * PURE generator for an ASS subtitle file that burns the project's text overlays
 * and captions into the export. PlayResX/Y match the OUTPUT size (the exporter
 * pre-scales all geometry to output px), so what you positioned in the preview is
 * what burns.
 *
 * Two base styles: "Plain"/"Caption" (text + outline for legibility) and "Pill"
 * (BorderStyle=3 opaque box behind the text). Per-overlay font, position, size,
 * colour, stroke and shadow are inline tags. The font name (`\fn`) is resolved
 * from the bundled-font catalog (shared/fonts); the matching faces are handed to
 * libass via `fontsdir` (see exporterArgs). Gradient-filled text does NOT come
 * through here — it's rendered to a PNG and composited (ASS has no gradients).
 */

import type { CaptionsConfig, PillStyle, ShadowStyle, StrokeStyle } from '@shared/project'
import { resolveFont } from '@shared/fonts'
import type { Target } from './exporterArgs'

/** A resolved text overlay to burn (geometry in logical/output px). */
export interface AssOverlay {
  text: string
  startSec: number
  endSec: number
  x: number
  y: number
  anchor: 'center' | 'topLeft'
  /** Bundled-font id (shared/fonts) — resolved to a libass `\fn` name here. */
  fontFamily: string
  fontSizePx: number
  color: string
  pill: PillStyle
  /** Outline (output px). Ignored when `pill.enabled`. Absent = style default. */
  stroke?: StrokeStyle | null
  /** Drop shadow (output px). Absent = style default. */
  shadow?: ShadowStyle | null
}

function assTime(sec: number): string {
  const t = Math.max(0, sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const cs = Math.round((t - Math.floor(t)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** #RGB/#RGBA/#RRGGBB/#RRGGBBAA → ASS &HAABBGGRR (ASS alpha: 00 opaque, FF
 *  transparent). Malformed input falls back to opaque white rather than
 *  emitting a garbage tag libass would choke on. */
export function assColor(hex: string): string {
  let h = hex.replace('#', '').trim()
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('') // shorthand → full
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) return '&H00FFFFFF'
  const r = h.slice(0, 2)
  const g = h.slice(2, 4)
  const b = h.slice(4, 6)
  const cssAlpha = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255
  const assAlpha = (255 - cssAlpha).toString(16).padStart(2, '0')
  return `&H${assAlpha}${b}${g}${r}`.toUpperCase()
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N')
}

const f1 = (n: number): string => (Math.round(n * 10) / 10).toString()

/** `\fn…\b…` — the resolved font face + its bold flag (all bundled faces b0). */
function fontTags(fontFamilyId: string): string {
  const def = resolveFont(fontFamilyId)
  return `\\fn${def.assName}\\b${def.assBold}`
}

/**
 * Stroke + shadow inline tags shared by overlays and captions. Stroke maps to
 * `\bord`/`\3c` (BorderStyle 1) and is skipped when a pill is on, because the
 * Pill style (BorderStyle 3) repurposes those same tags for the opaque box.
 * Shadow maps to `\shad`/`\4c` (+`\blur`) and applies in both modes.
 */
function decoTags(pillEnabled: boolean, stroke?: StrokeStyle | null, shadow?: ShadowStyle | null): string {
  const tags: string[] = []
  if (!pillEnabled && stroke) {
    tags.push(`\\bord${f1(Math.max(0, stroke.widthPx))}`, `\\3c${assColor(stroke.color)}&`)
  }
  if (shadow) {
    tags.push(`\\shad${f1(Math.max(0, shadow.distancePx))}`, `\\4c${assColor(shadow.color)}&`)
    if (shadow.blur > 0) tags.push(`\\blur${f1(shadow.blur)}`)
  }
  return tags.join('')
}

export function buildAss(
  overlays: AssOverlay[],
  target: Target,
  captions?: CaptionsConfig | null
): string {
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${target.width}`,
    `PlayResY: ${target.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Bold=0: bundled faces carry their own weight (no libass faux-bold). Each
    // overlay overrides Fontname via an inline \fn tag.
    'Style: Plain,Arial,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,1,5,0,0,0,1',
    'Style: Pill,Arial,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,18,0,5,0,0,0,1',
    'Style: Caption,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,5,1,5,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  // Captions (auto-generated): each rendered with its effective style — the
  // per-segment override if present, else the lane-wide style. Geometry arrives
  // already scaled to output px (the exporter pre-scales). A gradient-filled
  // caption is rendered to a PNG instead and never reaches this builder.
  if (captions?.enabled) {
    const r = (n: number): number => Math.round(n)
    for (const seg of captions.segments) {
      if (!seg.enabled || seg.text.trim().length === 0) continue
      const st = seg.style ?? captions.style
      if (st.gradient) continue // burned as a PNG overlay by the exporter
      const styleName = st.pill.enabled ? 'Pill' : 'Caption'
      const tags = [
        `\\an5`,
        `\\pos(${r(st.x)},${r(st.y)})`,
        fontTags(st.fontFamily),
        `\\fs${r(st.fontSizePx)}`,
        `\\c${assColor(st.color)}&`
      ]
      // ASS rotation is counter-clockwise positive; our rotationDeg is clockwise.
      if (st.rotationDeg) tags.push(`\\frz${(-st.rotationDeg).toFixed(0)}`)
      if (st.pill.enabled) tags.push(`\\3c${assColor(st.pill.color)}&`, `\\bord${r(st.pill.padPx)}`)
      const deco = decoTags(st.pill.enabled, st.stroke, st.shadow)
      if (deco) tags.push(deco)
      lines.push(
        `Dialogue: 0,${assTime(seg.startSec)},${assTime(seg.endSec)},${styleName},,0,0,0,,{${tags.join('')}}${escapeText(seg.text)}`
      )
    }
  }

  for (const o of overlays) {
    if (o.text.trim().length === 0) continue
    const style = o.pill.enabled ? 'Pill' : 'Plain'
    const an = o.anchor === 'center' ? 5 : 7
    const tags = [
      `\\an${an}`,
      `\\pos(${Math.round(o.x)},${Math.round(o.y)})`,
      fontTags(o.fontFamily),
      `\\fs${Math.round(o.fontSizePx)}`,
      `\\c${assColor(o.color)}&`
    ]
    if (o.pill.enabled) {
      // BorderStyle=3 opaque box: \3c is the box colour, \bord its padding.
      tags.push(`\\3c${assColor(o.pill.color)}&`, `\\bord${Math.round(o.pill.padPx)}`)
    }
    const deco = decoTags(o.pill.enabled, o.stroke, o.shadow)
    if (deco) tags.push(deco)
    const text = `{${tags.join('')}}${escapeText(o.text)}`
    lines.push(
      `Dialogue: 0,${assTime(o.startSec)},${assTime(o.endSec)},${style},,0,0,0,,${text}`
    )
  }

  return lines.join('\n') + '\n'
}
