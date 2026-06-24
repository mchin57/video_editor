/**
 * PURE generator for an ASS subtitle file that burns the project's text overlays
 * into the export. PlayResX/Y match the logical 1080x1920 space, so overlay
 * coordinates map 1:1 — what you positioned in the preview is what burns.
 *
 * Two styles: "Plain" (text + outline for legibility) and "Pill" (BorderStyle=3
 * opaque box behind the text). Per-overlay position/size/colour are inline tags.
 */

import type { CaptionsConfig, PillStyle } from '@shared/project'
import type { Target } from './exporterArgs'

/** A resolved text overlay to burn (geometry in logical/output px). */
export interface AssOverlay {
  text: string
  startSec: number
  endSec: number
  x: number
  y: number
  anchor: 'center' | 'topLeft'
  fontSizePx: number
  color: string
  pill: PillStyle
}

function assTime(sec: number): string {
  const t = Math.max(0, sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const cs = Math.round((t - Math.floor(t)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** #RRGGBB or #RRGGBBAA → ASS &HAABBGGRR (ASS alpha: 00 opaque, FF transparent). */
export function assColor(hex: string): string {
  const h = hex.replace('#', '')
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
    'Style: Plain,Arial,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,1,5,0,0,0,1',
    'Style: Pill,Arial,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,18,0,5,0,0,0,1',
    'Style: Caption,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,5,1,5,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  // Captions (auto-generated) sit at the configured baseline, above the safe zone.
  if (captions?.enabled) {
    for (const seg of captions.segments) {
      if (!seg.enabled || seg.text.trim().length === 0) continue
      const tags = `{\\an5\\pos(${Math.round(target.width / 2)},${Math.round(captions.yBaseline)})}`
      lines.push(
        `Dialogue: 0,${assTime(seg.startSec)},${assTime(seg.endSec)},Caption,,0,0,0,,${tags}${escapeText(seg.text)}`
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
      `\\fs${Math.round(o.fontSizePx)}`,
      `\\c${assColor(o.color)}&`
    ]
    if (o.pill.enabled) {
      // BorderStyle=3 opaque box: \3c is the box colour, \bord its padding.
      tags.push(`\\3c${assColor(o.pill.color)}&`, `\\bord${Math.round(o.pill.padPx)}`)
    }
    const text = `{${tags.join('')}}${escapeText(o.text)}`
    lines.push(
      `Dialogue: 0,${assTime(o.startSec)},${assTime(o.endSec)},${style},,0,0,0,,${text}`
    )
  }

  return lines.join('\n') + '\n'
}
