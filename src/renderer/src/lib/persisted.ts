/**
 * View preferences kept in localStorage (zoom, follow mode, lane sizes, which
 * Inspector sections are open). Not project data: they belong to this machine's
 * editor, so they never enter the project document or its undo history.
 *
 * A preference is a key plus a `PrefCodec` that turns the stored string back
 * into a value, falling back to a default for anything missing or invalid (an
 * old format, a hand edit, a value out of range). `usePersistedState`
 * (`hooks/usePersistedState.ts`) is the React side.
 */

export interface PrefCodec<T> {
  /** The stored string (null = never saved) → a valid value. */
  decode(raw: string | null): T
  encode(value: T): string
}

/** The saved value for `key`, or the codec's fallback. Storage errors read as "never saved". */
export function readPref<T>(key: string, codec: PrefCodec<T>): T {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    // storage unavailable: use the default
  }
  return codec.decode(raw)
}

/** Save `value` under `key`. Best-effort: a preference that can't be saved just isn't remembered. */
export function writePref<T>(key: string, codec: PrefCodec<T>, value: T): void {
  try {
    localStorage.setItem(key, codec.encode(value))
  } catch {
    // storage full or unavailable
  }
}

/** A boolean stored as '1' / '0'. */
export const boolPref = (fallback: boolean): PrefCodec<boolean> => ({
  decode: (raw) => (raw === null ? fallback : raw === '1'),
  encode: (v) => (v ? '1' : '0')
})

/** A number in [min, max]; anything else (missing, NaN, out of range) is `fallback`. */
export const numberPref = (fallback: number, min: number, max: number): PrefCodec<number> => ({
  decode: (raw) => {
    const v = Number(raw)
    return raw !== null && v >= min && v <= max ? v : fallback
  },
  encode: (v) => String(v)
})

/** One of a fixed set of strings; anything else is `fallback`. */
export const enumPref = <T extends string>(values: readonly T[], fallback: T): PrefCodec<T> => ({
  decode: (raw) => (values.includes(raw as T) ? (raw as T) : fallback),
  encode: (v) => v
})

/** A JSON object; anything that isn't one (missing, unparseable, an array or scalar) is `fallback()`. */
export const objectPref = <T extends object>(fallback: () => T): PrefCodec<T> => ({
  decode: (raw) => {
    if (raw === null) return fallback()
    try {
      const v: unknown = JSON.parse(raw)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : fallback()
    } catch {
      return fallback()
    }
  },
  encode: (v) => JSON.stringify(v)
})
