/** Small numeric helpers shared by main and the renderer. */

/** `n` limited to [lo, hi]. If the bounds are inverted (lo > hi), `lo` wins —
 *  callers rely on that for "at least lo" ranges like `clamp(x, 0, total - len)`. */
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi))

/** `n` limited to [0, 1]. */
export const clamp01 = (n: number): number => clamp(n, 0, 1)

/** `n` rounded to the nearest integer, then limited to [lo, hi]. */
export const clampInt = (n: number, lo: number, hi: number): number => clamp(Math.round(n), lo, hi)
