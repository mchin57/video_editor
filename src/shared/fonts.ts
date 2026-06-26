/**
 * The bundled-font catalog — the SINGLE source of truth shared by the font
 * picker, the preview (`@font-face` + CSS family), and the export (libass `\fn`).
 *
 * A text overlay / caption stores a stable `id` (e.g. `montserrat-extrabold`) in
 * its `fontFamily` field. Resolve it here:
 *   - preview → `fontCssFamily(id)` (matches an injected `@font-face`),
 *   - export  → `def.assName` + `def.assBold` (the font's legacy family name).
 *
 * Every face ships as its own static TTF with a UNIQUE legacy ("Win32") family
 * name, referenced with `Bold=0`, so libass never has to disambiguate weights or
 * synthesise a faux-bold. Files live in `resources/fonts/`.
 */

export type FontCategory = 'caption' | 'display' | 'stylized'

export interface FontDef {
  /** Stable id persisted in the project (in `fontFamily`). */
  id: string
  /** Human label shown in the picker (also the injected `@font-face` family). */
  label: string
  category: FontCategory
  /** Filename under `resources/fonts/`. */
  file: string
  /** libass `\fn` name — the font's legacy/Win32 family name. */
  assName: string
  /** libass Bold flag. 0 for all bundled faces (each is its own family). */
  assBold: 0 | 1
}

/** Category display order + labels for the grouped picker. */
export const FONT_CATEGORIES: { id: FontCategory; label: string }[] = [
  { id: 'caption', label: 'Caption' },
  { id: 'display', label: 'Hook / Display' },
  { id: 'stylized', label: 'Stylized' }
]

export const FONTS: FontDef[] = [
  // --- Caption workhorses (heavy geometric, muted-viewer legibility) ---
  { id: 'montserrat-extrabold', label: 'Montserrat ExtraBold', category: 'caption', file: 'Montserrat-ExtraBold.ttf', assName: 'Montserrat ExtraBold', assBold: 0 },
  { id: 'montserrat-black', label: 'Montserrat Black', category: 'caption', file: 'Montserrat-Black.ttf', assName: 'Montserrat Black', assBold: 0 },
  { id: 'poppins-extrabold', label: 'Poppins ExtraBold', category: 'caption', file: 'Poppins-ExtraBold.ttf', assName: 'Poppins ExtraBold', assBold: 0 },
  { id: 'poppins-black', label: 'Poppins Black', category: 'caption', file: 'Poppins-Black.ttf', assName: 'Poppins Black', assBold: 0 },
  { id: 'barlow-semicondensed-extrabold', label: 'Barlow Semi Condensed', category: 'caption', file: 'BarlowSemiCondensed-ExtraBold.ttf', assName: 'Barlow Semi Condensed ExtraBold', assBold: 0 },

  // --- Hook / display (big, loud, impact titles) ---
  { id: 'anton', label: 'Anton', category: 'display', file: 'Anton-Regular.ttf', assName: 'Anton', assBold: 0 },
  { id: 'bebas-neue', label: 'Bebas Neue', category: 'display', file: 'BebasNeue-Regular.ttf', assName: 'Bebas Neue', assBold: 0 },
  { id: 'archivo-black', label: 'Archivo Black', category: 'display', file: 'ArchivoBlack-Regular.ttf', assName: 'Archivo Black', assBold: 0 },
  { id: 'barlow-condensed-black', label: 'Barlow Condensed', category: 'display', file: 'BarlowCondensed-Black.ttf', assName: 'Barlow Condensed Black', assBold: 0 },

  // --- Stylized / personality (accents — use sparingly) ---
  { id: 'permanent-marker', label: 'Permanent Marker', category: 'stylized', file: 'PermanentMarker-Regular.ttf', assName: 'Permanent Marker', assBold: 0 },
  { id: 'bangers', label: 'Bangers', category: 'stylized', file: 'Bangers-Regular.ttf', assName: 'Bangers', assBold: 0 },
  { id: 'pacifico', label: 'Pacifico', category: 'stylized', file: 'Pacifico-Regular.ttf', assName: 'Pacifico', assBold: 0 },
  { id: 'shrikhand', label: 'Shrikhand', category: 'stylized', file: 'Shrikhand-Regular.ttf', assName: 'Shrikhand', assBold: 0 },
  { id: 'abril-fatface', label: 'Abril Fatface', category: 'stylized', file: 'AbrilFatface-Regular.ttf', assName: 'Abril Fatface', assBold: 0 }
]

/** The default font id (heavy geometric — the Reels caption workhorse). */
export const DEFAULT_FONT_ID = 'montserrat-extrabold'

const BY_ID = new Map(FONTS.map((f) => [f.id, f]))

/** Resolve a stored `fontFamily` id to its FontDef, falling back to the default
 *  for unknown / legacy values (e.g. an old CSS stack like "Inter, sans-serif"). */
export function resolveFont(id: string | null | undefined): FontDef {
  return (id && BY_ID.get(id)) || BY_ID.get(DEFAULT_FONT_ID)!
}

/** True if `id` is a known bundled-font id (not a legacy CSS string). */
export function isKnownFont(id: string | null | undefined): boolean {
  return !!id && BY_ID.has(id)
}

/** The CSS `font-family` value to use in preview for a stored id — matches the
 *  injected `@font-face` family (the label), with a generic fallback. */
export function fontCssFamily(id: string | null | undefined): string {
  return `"${resolveFont(id).label}", system-ui, sans-serif`
}
