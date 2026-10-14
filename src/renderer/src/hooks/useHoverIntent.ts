import { useEffect, useRef, useState } from 'react'
import { HoverIntent, type HoverTimers } from '@/lib/hoverIntent'

/** A `HoverIntent` owned by a component: `target` is what the panel shows
 *  (null = closed); feed `intent.enter/leave/pin/close` from the target, the
 *  panel and its bridge. */
export function useHoverIntent<T>(opts: { closeMs?: number; openMs?: number; timers?: HoverTimers } = {}): {
  target: T | null
  intent: HoverIntent<T>
} {
  const [target, setTarget] = useState<T | null>(null)
  const ref = useRef<HoverIntent<T> | null>(null)
  if (!ref.current) ref.current = new HoverIntent<T>(setTarget, opts)
  useEffect(() => () => ref.current?.dispose(), [])
  return { target, intent: ref.current }
}
