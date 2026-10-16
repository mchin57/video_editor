/**
 * Where a clip card's hover pop-out goes (`HoverPopout` in `ClipCard.tsx`).
 *
 * The pop-out sits beside the whole CARD, not just its thumbnail: anchored at
 * the thumbnail it opened over the card's own ＋ PH / ＋ End / × buttons, and a
 * click meant for them landed on the preview video instead. It is also kept
 * below the app header, so it never covers the File / View / Format menus.
 */

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface PopoutPlacement {
  left: number
  top: number
  /** True when the pop-out is right of the card (the description is on the far side). */
  onRight: boolean
  /** The invisible strip spanning the card→pop-out gap (width 0 = none). */
  bridge: Box
}

export function popoutPlacement({
  card,
  thumb,
  width,
  height,
  viewportW,
  viewportH,
  minTop,
  margin = 12,
  edge = 8
}: {
  /** The whole card (thumbnail, name, buttons): the pop-out never overlaps it. */
  card: Box
  /** The thumbnail: the pop-out is centred on it vertically. */
  thumb: Box
  width: number
  height: number
  viewportW: number
  viewportH: number
  /** Highest the pop-out may reach (just below the app header). */
  minTop: number
  margin?: number
  edge?: number
}): PopoutPlacement {
  const cardRight = card.left + card.width
  let left = cardRight + margin
  // Flip to the left near the viewport edge.
  const onRight = left + width <= viewportW - edge
  if (!onRight) left = card.left - margin - width
  left = Math.max(edge, left)
  const top = Math.max(minTop, Math.min(thumb.top + thumb.height / 2 - height / 2, viewportH - height - edge))

  const bridgeLeft = left >= cardRight ? cardRight : left + width
  const bridgeWidth = Math.max(0, left >= cardRight ? left - cardRight : card.left - (left + width))
  const bridgeTop = Math.min(top, thumb.top)
  const bridgeHeight = Math.max(top + height, thumb.top + thumb.height) - bridgeTop
  return { left, top, onRight, bridge: { left: bridgeLeft, top: bridgeTop, width: bridgeWidth, height: bridgeHeight } }
}

/** The lowest edge of the app header (`data-app-header`), 0 when there is none. */
export function headerBottom(): number {
  return document.querySelector('[data-app-header]')?.getBoundingClientRect().bottom ?? 0
}
