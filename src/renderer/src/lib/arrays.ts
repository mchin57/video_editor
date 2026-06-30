/**
 * Tiny immutable array helpers for the project store's two recurring idioms:
 * "update the item with this id" and "replace a slice in place". Use these
 * instead of re-rolling `.map((x) => x.id === id ? … : x)` or
 * `slice()` + `splice()` so the update shape can't drift between actions.
 * @see docs/SHARED.md
 */

/** A new array with the item whose `id` matches replaced by `fn(item)`; other
 *  items are left referentially identical (so React/zustand can skip them). */
export function updateById<T extends { id: string }>(arr: T[], id: string, fn: (item: T) => T): T[] {
  return arr.map((item) => (item.id === id ? fn(item) : item))
}

/** A new array with `count` items at `index` replaced by `items` (an immutable
 *  splice). An out-of-range `index` returns the array unchanged. */
export function replaceAt<T>(arr: T[], index: number, count: number, ...items: T[]): T[] {
  if (index < 0 || index >= arr.length) return arr
  const next = arr.slice()
  next.splice(index, count, ...items)
  return next
}
