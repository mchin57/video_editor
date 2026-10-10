/**
 * "The user is mid-interaction" — held for the whole of every pointer drag
 * (`startPointerDrag` opens and closes it, so every drag surface gets it).
 *
 * Why it exists: a live drag recomputes the project from the snapshot it took
 * at pointerdown and records that snapshot as its undo step on release. Any
 * other edit that lands in between — an assistant call, a keyboard shortcut —
 * is overwritten by the next pointer move, or merged into the drag's undo
 * step. So other edits wait (`whenIdle`) or are ignored while this is open.
 * No React, no store. @see docs/SHARED.md
 */

let open = 0
let waiting: (() => void)[] = []
let flushQueued = false

/** Is a pointer drag (or other live interaction) open right now? */
export function interactionOpen(): boolean {
  return open > 0
}

/**
 * Open an interaction. Returns its close function, which is idempotent, so a
 * release path that runs twice (pointerup then pointercancel) can't close
 * someone else's interaction.
 */
export function beginInteraction(): () => void {
  open++
  let closed = false
  return () => {
    if (closed) return
    closed = true
    open--
    if (open === 0) scheduleFlush()
  }
}

/**
 * Run `fn` now if nothing is open; otherwise once the last interaction closes,
 * in arrival order. The flush runs in a microtask, so the releasing drag's own
 * handler (its undo commit) finishes first.
 */
export function whenIdle(fn: () => void): void {
  if (open === 0 && waiting.length === 0) {
    fn()
    return
  }
  waiting.push(fn)
}

function scheduleFlush(): void {
  if (flushQueued || waiting.length === 0) return
  flushQueued = true
  queueMicrotask(() => {
    flushQueued = false
    while (open === 0 && waiting.length) {
      const fn = waiting.shift()!
      try {
        fn()
      } catch (e) {
        console.error('[interaction] deferred call failed', e)
      }
    }
  })
}

/** Test seam: forget all state. */
export function resetInteractionsForTest(): void {
  open = 0
  waiting = []
  flushQueued = false
}
