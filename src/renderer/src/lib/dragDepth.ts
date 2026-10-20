/**
 * Drop-zone highlight tracking that can't get stuck. The naive
 * `onDragLeave={e => e.currentTarget === e.target && setActive(false)}` pattern
 * misses the final dragleave when the drag exits via a child element or the
 * user drops OUTSIDE the app — leaving the "drop here" overlay on forever (the
 * reported bug). dragenter/dragleave always fire in balanced pairs per element
 * boundary, so a depth counter reaches 0 exactly when the drag truly left the
 * zone; window-level dragend/drop listeners mop up aborted in-app drags.
 * @see docs/SHARED.md
 */

import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { useLatest } from '@/hooks/useLatest'

export function useDragDepth(accepts: (types: readonly string[]) => boolean): {
  /** Whether an accepted drag is currently over the zone. */
  active: boolean
  onDragEnter: (e: ReactDragEvent) => void
  onDragLeave: (e: ReactDragEvent) => void
  /** Call from your onDrop handler (the depth listeners can't see the drop). */
  reset: () => void
} {
  const depth = useRef(0)
  const acceptsRef = useLatest(accepts)
  const [active, setActive] = useState(false)

  const reset = useCallback((): void => {
    depth.current = 0
    setActive(false)
  }, [])

  const onDragEnter = useCallback(
    (e: ReactDragEvent): void => {
      if (!acceptsRef.current(e.dataTransfer.types)) return
      depth.current++
      setActive(true)
    },
    [acceptsRef]
  ) // stable (useLatest)

  const onDragLeave = useCallback(
    (e: ReactDragEvent): void => {
      if (!acceptsRef.current(e.dataTransfer.types)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    },
    [acceptsRef]
  ) // stable (useLatest)

  // In-app drags that end anywhere (drop or abort) fire dragend on the source;
  // a drop claimed by a nested handler may skip our onDrop. Either way: clear.
  useEffect(() => {
    const clear = (): void => reset()
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [reset])

  return { active, onDragEnter, onDragLeave, reset }
}
