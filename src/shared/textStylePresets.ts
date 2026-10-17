/**
 * Saved text styles (#45): a named `TextStyleBase` (font, size, fill, pill,
 * outline, shadow, gradient), plus a text layer's entrance/exit animation, that
 * applies to any text layer or caption in one click. Editor-wide: stored in
 * settings.json (`Settings.textStyles`), so every project sees the same list.
 * Pure — the renderer store (`state/textStyles.ts`) and main's settings load
 * both go through these.
 */

import type { TextStyleBase } from './project'
import type { TextAnimation } from './textAnim'

export interface TextStylePreset {
  id: string
  name: string
  style: TextStyleBase
  /** A text layer's animation, saved from one; captions don't animate and
   *  ignore it. Absent = applying leaves the target's animation alone. */
  animation?: TextAnimation | null
}

/** Longest preset name kept. */
export const TEXT_STYLE_NAME_MAX = 40

/**
 * Exactly the `TextStyleBase` fields of `src` (a text layer's content or a
 * caption style carry more: text, position, wrap width…), with the optional
 * decorations normalised to `null` when off, so applying a preset also REMOVES
 * an outline / shadow / gradient the target had.
 */
export function pickTextStyle(src: TextStyleBase): TextStyleBase {
  return {
    fontFamily: src.fontFamily,
    fontSizePx: src.fontSizePx,
    color: src.color,
    pill: { ...src.pill },
    stroke: src.stroke ? { ...src.stroke } : null,
    shadow: src.shadow ? { ...src.shadow } : null,
    gradient: src.gradient ? { ...src.gradient } : null
  }
}

/** Save `style` as `name`: replaces a preset of the same name (case-insensitive,
 *  keeping its id and place), else appends one with `id`. Blank names are refused. */
export function upsertTextStyle(
  list: TextStylePreset[],
  name: string,
  style: TextStyleBase,
  animation: TextAnimation | null | undefined,
  id: string
): TextStylePreset[] {
  const n = name.trim().slice(0, TEXT_STYLE_NAME_MAX)
  if (!n) return list
  const entry = (keepId: string): TextStylePreset => ({
    id: keepId,
    name: n,
    style: pickTextStyle(style),
    ...(animation !== undefined ? { animation } : {})
  })
  const i = list.findIndex((p) => p.name.toLowerCase() === n.toLowerCase())
  if (i < 0) return [...list, entry(id)]
  return list.map((p, k) => (k === i ? entry(p.id) : p))
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

/** settings.json's `textStyles`, keeping only well-formed entries (a hand-edited
 *  or older file can't put a half-style on a layer). */
export function sanitizeTextStyles(loaded: unknown): TextStylePreset[] {
  if (!Array.isArray(loaded)) return []
  return loaded.filter((p): p is TextStylePreset => {
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.name !== 'string' || !p.name.trim()) return false
    const s = p.style
    return (
      isObj(s) &&
      typeof s.fontFamily === 'string' &&
      typeof s.fontSizePx === 'number' &&
      Number.isFinite(s.fontSizePx) &&
      typeof s.color === 'string' &&
      isObj(s.pill) &&
      typeof s.pill.enabled === 'boolean' &&
      typeof s.pill.color === 'string' &&
      typeof s.pill.padPx === 'number'
    )
  })
}
