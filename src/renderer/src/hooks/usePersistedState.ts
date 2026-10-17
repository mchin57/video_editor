import { useCallback, useState, type SetStateAction } from 'react'
import { readPref, writePref, type PrefCodec } from '@/lib/persisted'

/**
 * `useState` for a view preference remembered in localStorage (`lib/persisted.ts`).
 * Starts from the saved value (or the codec's default) and saves on every change.
 * The default itself is never written, so a preference the user hasn't touched
 * follows the code's default if that changes later. Pass a module-level `codec`:
 * a new object every render would make the setter unstable.
 */
export function usePersistedState<T>(key: string, codec: PrefCodec<T>): [T, (next: SetStateAction<T>) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, codec))
  const set = useCallback(
    (next: SetStateAction<T>): void =>
      setValue((prev) => {
        const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        writePref(key, codec, v)
        return v
      }),
    [key, codec]
  )
  return [value, set]
}
