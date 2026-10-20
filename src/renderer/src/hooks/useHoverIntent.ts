import { useEffect, useState } from 'react'
import { HoverIntent, type HoverTimers } from '@/lib/hoverIntent'
import { interactionOpen } from '@/lib/interaction'
import { useLatest } from '@/hooks/useLatest'

/** A `HoverIntent` owned by a component: `target` is what the panel shows
 *  (null = closed); feed `intent.enter/leave/pin/close` from the target, the
 *  panel and its bridge. */
export function useHoverIntent<T>(opts: { closeMs?: number; openMs?: number; timers?: HoverTimers } = {}): {
  target: T | null
  intent: HoverIntent<T>
} {
  const [target, setTarget] = useState<T | null>(null)
  // One instance for the component's life (created on the first render only).
  const [intent] = useState(() => new HoverIntent<T>(setTarget, opts))
  useEffect(() => () => intent.dispose(), [intent])
  return { target, intent }
}

/**
 * For as long as a hover panel is mounted, check every mouse move against the
 * group's elements (`members()`: the target, the panel, the bridge) and report
 * inside / outside (`HoverIntent.enter()` / `.leave()`). The enter/leave events
 * alone are not enough: after a click into a text box, Chromium can skip the
 * `mouseout` React builds `onMouseLeave` from, and the panel stayed open with
 * the cursor far away (`e2e/descriptions.spec.ts`). Moves are what the cursor
 * really did. Ignored mid-drag (a scrub that strays outside is the drag's
 * business, settled on release).
 */
export function useHoverGuard(
  group: { enter: () => void; leave: () => void },
  members: () => (Element | null | undefined)[]
): void {
  const latest = useLatest({ group, members })
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (interactionOpen()) return
      const { group, members } = latest.current
      const t = e.target instanceof Node ? e.target : null
      if (t && members().some((m) => m?.contains(t))) group.enter()
      else group.leave()
    }
    window.addEventListener('mousemove', onMove, { capture: true, passive: true })
    return () => window.removeEventListener('mousemove', onMove, { capture: true })
  }, [latest]) // stable (useLatest)
}
