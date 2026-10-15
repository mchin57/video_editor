/**
 * Hover intent for a floating panel that belongs to a hover target — the
 * library's preview pop-out (and its description), the timeline's description
 * box. The target and the panel (plus an invisible bridge over the gap
 * between them) form ONE hover group: leaving any of them only closes after a
 * grace period that entering another one cancels, so moving the cursor from
 * the target onto the panel never closes it. While the panel is PINNED (its
 * text box has focus) it stays open wherever the cursor goes; unpinning with
 * the cursor outside closes it after the usual grace period.
 *
 * `openMs` delays the first open (the timeline: sweeping across tiles mustn't
 * flash a box over every one); moving straight to another target while open
 * switches at once. Not React — `useHoverIntent` wraps it. @see docs/SHARED.md
 */

export interface HoverTimers {
  set: (fn: () => void, ms: number) => number
  clear: (id: number) => void
}

const windowTimers: HoverTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id)
}

export class HoverIntent<T> {
  private target: T | null = null
  private inside = false
  private pinned = false
  private timer: number | null = null

  constructor(
    private readonly onChange: (target: T | null) => void,
    private readonly opts: { closeMs?: number; openMs?: number; timers?: HoverTimers } = {}
  ) {}

  get current(): T | null {
    return this.target
  }

  /** The cursor entered the target (with what to show) or the panel (no argument). */
  enter(target?: T): void {
    this.inside = true
    this.cancel()
    if (target === undefined) return // the panel or bridge: just keep it open
    if (this.target !== null || !this.opts.openMs) this.set(target)
    else this.timer = this.timers.set(() => this.set(target), this.opts.openMs)
  }

  /** The cursor left the target, the panel or the bridge. Idempotent: a close
   *  already counting down isn't pushed back (`useHoverGuard` calls this on
   *  every move outside). */
  leave(): void {
    if (!this.inside && this.timer !== null) return
    this.inside = false
    this.cancel()
    if (this.pinned) return
    this.timer = this.timers.set(() => this.set(null), this.opts.closeMs ?? 160)
  }

  /**
   * Keep the panel open while true (e.g. its text box has focus). On unpin,
   * pass `insideNow` from the live `:hover` state when you can: leaving a
   * focused text box doesn't always fire the mouseout React builds
   * `onMouseLeave` from (seen in Chromium), so the tracked state can be stale.
   */
  pin(on: boolean, insideNow?: boolean): void {
    this.pinned = on
    if (insideNow !== undefined) this.inside = insideNow
    if (!on && !this.inside) this.leave()
  }

  /** Close now (a drag started, the panel's owner went away). */
  close(): void {
    this.cancel()
    this.pinned = false
    this.inside = false
    this.set(null)
  }

  dispose(): void {
    this.cancel()
  }

  private get timers(): HoverTimers {
    return this.opts.timers ?? windowTimers
  }

  private cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  private set(target: T | null): void {
    this.timer = null
    if (target === this.target) return
    this.target = target
    this.onChange(target)
  }
}
