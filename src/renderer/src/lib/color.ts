/**
 * `#rrggbb[aa]` helpers for colours that carry alpha (a text pill, a shape's
 * fill) — the pure implementations live in `shared/color.ts` (the export's
 * colour keyframes need them too) and are re-exported here. @see docs/SHARED.md
 */
export { getAlpha, hex6, withAlpha } from '@shared/color'
