import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * A ref that always holds the latest committed `value`, for callbacks
 * registered once (a window listener, a rAF loop, a drag handler) that must see
 * current props / state without re-registering. Updated in a layout effect —
 * after the render commits, before the browser paints and before any passive
 * effect or event handler runs — so readers outside render always see the
 * current value, and render itself stays pure (React's rule: never write a ref
 * while rendering). Read `.current` only outside render.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}
