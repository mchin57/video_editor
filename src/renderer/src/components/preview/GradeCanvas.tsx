/**
 * Preview ▸ a clip or picture drawn through its colour TABLE: the look that the
 * CSS filters can't draw (a newer control, a LUT — `needsGradeTable`,
 * shared/grade.ts) baked into the very table the export hands `lut3d`, and
 * drawn by WebGL (`gradeGl.ts`) into a `<canvas>` laid over the media element.
 *
 * The canvas takes the element's own fill style, inside the element's own
 * wrappers, so crop, flips, rotation, keyframed position / scale / opacity and
 * a picture's opacity apply to it exactly as they did to the element; the
 * element stays mounted underneath (playback, sync, audio and drift-resync are
 * unchanged) and is hidden only once the canvas has DRAWN its first frame
 * (`useGradeView`), so the worst case is a frame ungraded, never a frame of
 * nothing. Video is drawn every animation frame while it plays and on every
 * seek / load while paused.
 *
 * Contexts are RELEASED: Chromium keeps at most 16 WebGL contexts and, past
 * that, takes the least recently used — a graded picture still on screen, after
 * a run of graded clips came and went. So each source gets a canvas of its own
 * (made in the effect, inside a host `<div>` that carries the fill style), and
 * the cleanup gives its context back (`dispose` → `loseContext`) and drops it: a
 * released context can't draw again, so a canvas is never reused. A look that
 * stops needing the table keeps it for `TABLE_PATH_HOLD_MS` (`useTablePath`), so
 * a slider dragged THROUGH neutral doesn't drop and remake a context.
 *
 * If WebGL2 is unavailable or its context is lost, `onStatus('unavailable')`
 * tells the layer to show the element ungraded with `GradeNotice`; a source
 * WebGL can't take (a picture that won't load with CORS, an upload that
 * throws) reports `'failed'` the same way, logged; a LUT whose file can't be
 * read reports `'lut-missing'` and draws the rest of the look.
 */

import { useEffect, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react'
import { activeLut, bakeGradeTable, GRADE_TABLE_SIZE, needsGradeTable, type ColorLook } from '@shared/grade'
import { createLogger } from '@shared/log'
import { useLatest } from '@/hooks/useLatest'
import { useLutTable } from '@/hooks/useLut'
import { createGradeGl, MAX_GRADED_IMAGE_SIDE, type GradeGl, type GradeSource } from './gradeGl'

const log = createLogger('grade-preview')

/** How the colour-table preview is doing. */
export type GradeStatus = 'ok' | 'unavailable' | 'failed' | 'lut-missing'

/** Whether the canvas is drawing (the rest of) the look — false shows the plain element ungraded. */
const drawing = (s: GradeStatus): boolean => s === 'ok' || s === 'lut-missing'

/** How long a look stays on the table path after it stops needing it (see the header). */
export const TABLE_PATH_HOLD_MS = 250

/**
 * Whether a layer draws `look` through the colour table: `needsGradeTable`,
 * held for `TABLE_PATH_HOLD_MS` after it turns false, so a LUT's strength or a
 * newer control dragged through 0 keeps its canvas (and WebGL context) instead
 * of dropping it for one value and making a new one at the next.
 */
export function useTablePath(look: ColorLook): boolean {
  const wanted = needsGradeTable(look)
  const [held, setHeld] = useState(wanted)
  if (wanted && !held) setHeld(true)
  useEffect(() => {
    if (wanted || !held) return
    const t = setTimeout(() => setHeld(false), TABLE_PATH_HOLD_MS)
    return () => clearTimeout(t)
  }, [wanted, held])
  return wanted || held
}

/** What a layer drawing `look` needs: whether it takes the table path, how the
 *  canvas is doing, the callbacks to hand `GradeCanvas`, and whether the plain
 *  element is hidden — only once the canvas has DRAWN (so the worst case is a
 *  frame of the ungraded element, never a frame of nothing) and never while
 *  the canvas can't draw. */
export interface GradeView {
  graded: boolean
  status: GradeStatus
  hideElement: boolean
  onStatus: (s: GradeStatus) => void
  onDrawn: (drawn: boolean) => void
}

export function useGradeView(look: ColorLook): GradeView {
  const graded = useTablePath(look)
  const [status, setStatus] = useState<GradeStatus>('ok')
  const [drawn, setDrawn] = useState(false)
  return {
    graded,
    status,
    hideElement: graded && drawn && drawing(status),
    onStatus: setStatus,
    onDrawn: setDrawn
  }
}

/** The fields of a look that change its table, as a stable string. */
const lookKey = (look: ColorLook): string => JSON.stringify({ color: look.color, tint: look.tint, lut: look.lut })

/** The canvas fills its host, which carries the media element's own box. */
const CANVAS_CSS = 'position:absolute;inset:0;width:100%;height:100%;display:block'

export function GradeCanvas({
  look,
  video,
  imageSrc,
  style,
  onStatus,
  onDrawn
}: {
  look: ColorLook
  /** The clip's own `<video>` (already in the DOM, CORS-clean). */
  video?: RefObject<HTMLVideoElement | null>
  /** …or the picture's URL (loaded here with CORS, so WebGL may read it). */
  imageSrc?: string
  /** The media element's own fill style (a CSS `filter` in it is not applied: the table is the whole look). */
  style: CSSProperties
  onStatus: (s: GradeStatus) => void
  /** True once the canvas has drawn a picture; false again when it loses it (a lost context, the canvas gone). */
  onDrawn: (drawn: boolean) => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  /** The current source's canvas (made by the source effect). */
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const glRef = useRef<GradeGl | null>(null)
  /** The last baked table, uploaded to every context this component makes. */
  const tableRef = useRef<Float32Array | null>(null)
  /** How many tables have been baked — `data-bakes`, what a test waits on after changing the look. */
  const bakesRef = useRef(0)
  /** The current source can't be drawn by WebGL (a picture that won't load, an upload that throws). */
  const failedRef = useRef(false)
  /** Draws the current frame / picture (set by the source effect). */
  const redrawRef = useRef<() => void>(() => {})
  const status = useLatest(onStatus)
  const drawnCb = useLatest(onDrawn)
  const key = lookKey(look)
  const lutFile = activeLut(look.lut)?.file ?? null
  const lut = useLutTable(lutFile)
  /** Whether the look's LUT couldn't be read — what a (re)made context reports, not a blanket 'ok'. */
  const lutMissingNow = useLatest(lut.missing)

  // The canvas, its context and the source: made once per source, its context
  // remade after a loss, released (and the canvas dropped) on cleanup.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const canvas = document.createElement('canvas')
    canvas.dataset.testid = 'grade-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.cssText = CANVAS_CSS
    if (bakesRef.current) canvas.dataset.bakes = String(bakesRef.current)
    host.appendChild(canvas)
    canvasRef.current = canvas
    let source: GradeSource | null = video?.current ?? null
    let raf = 0
    let disposed = false
    failedRef.current = false
    const what = imageSrc ? 'picture' : 'clip'
    /** WebGL can't take this source: show the plain element ungraded, with the notice, and say why in the log. */
    const fail = (why: string, error?: unknown): void => {
      if (failedRef.current) return
      failedRef.current = true
      log.warn(`${why}: the ${what} shows ungraded in the preview`, error)
      delete canvas.dataset.drawn
      drawnCb.current(false)
      status.current('failed')
    }
    const size = (): [number, number] => {
      if (source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight]
      if (!source || !source.naturalWidth) return [0, 0]
      const k = Math.min(1, MAX_GRADED_IMAGE_SIDE / Math.max(source.naturalWidth, source.naturalHeight))
      return [Math.round(source.naturalWidth * k), Math.round(source.naturalHeight * k)]
    }
    const draw = (): void => {
      const gl = glRef.current
      if (!gl || !source || failedRef.current) return
      if (source instanceof HTMLVideoElement && source.readyState < 2) return
      if (source instanceof HTMLImageElement && !source.complete) return
      const [w, h] = size()
      let drew: boolean
      try {
        drew = gl.draw(source, w, h)
      } catch (error) {
        fail('WebGL could not read the frame', error)
        return
      }
      // The first picture: now the layer may hide its plain element (`data-drawn` is a test seam).
      if (drew && !canvas.dataset.drawn) {
        canvas.dataset.drawn = '1'
        drawnCb.current(true)
      }
    }
    const init = (): void => {
      glRef.current = createGradeGl(canvas)
      if (!glRef.current) {
        log.warn(`WebGL2 is unavailable: the ${what} shows ungraded in the preview`)
        status.current('unavailable')
        return
      }
      if (tableRef.current) glRef.current.setTable(GRADE_TABLE_SIZE, tableRef.current)
      status.current(failedRef.current ? 'failed' : lutMissingNow.current ? 'lut-missing' : 'ok')
      draw()
    }
    const onLost = (e: Event): void => {
      e.preventDefault() // lets the browser offer it back (webglcontextrestored)
      log.warn(`the WebGL context was lost: the ${what} shows ungraded in the preview`)
      // Its textures and program went with it; a restore makes new ones.
      glRef.current = null
      delete canvas.dataset.drawn
      drawnCb.current(false)
      status.current('unavailable')
    }
    const onRestored = (): void => init()
    /** The canvas is dropped, its picture with it: the layer shows its element until the next canvas draws. */
    const gone = (): void => {
      drawnCb.current(false)
      status.current('ok')
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    // While a video plays, draw each animation frame; paused, on each seek / load.
    const loop = (): void => {
      draw()
      raf = source instanceof HTMLVideoElement && !source.paused && !source.ended ? requestAnimationFrame(loop) : 0
    }
    const start = (): void => {
      if (!raf) raf = requestAnimationFrame(loop)
    }
    // A seek's frame can land a frame or two after `seeked`: draw now and again shortly.
    const kick = (): void => {
      draw()
      requestAnimationFrame(() => requestAnimationFrame(() => !disposed && draw()))
    }
    redrawRef.current = kick
    const events: [string, () => void][] = [
      ['play', start],
      ['playing', start],
      ['seeked', kick],
      ['loadeddata', kick],
      ['pause', kick]
    ]
    if (source instanceof HTMLVideoElement) for (const [ev, fn] of events) source.addEventListener(ev, fn)
    let img: HTMLImageElement | null = null
    if (imageSrc) {
      img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      img.onload = kick
      img.onerror = () => fail(`the picture ${imageSrc} could not be loaded for WebGL`)
      img.src = imageSrc
      source = img
    }
    init()
    if (source instanceof HTMLVideoElement && !source.paused) start()
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (source instanceof HTMLVideoElement) for (const [ev, fn] of events) source.removeEventListener(ev, fn)
      if (img) img.onload = img.onerror = null
      redrawRef.current = () => {}
      // Give the context back now (not at garbage collection), then drop its canvas.
      glRef.current?.dispose()
      glRef.current = null
      canvas.remove()
      if (canvasRef.current === canvas) canvasRef.current = null
      gone()
    }
  }, [video, imageSrc, status, drawnCb, lutMissingNow])

  // The table: baked when the look or its LUT changes — at most once a frame
  // while a slider drags (each change cancels the bake still waiting).
  const lutMissing = lut.missing
  const lutTable = lut.table
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const parsed = JSON.parse(key) as ColorLook
      tableRef.current = bakeGradeTable(parsed, lutTable)
      glRef.current?.setTable(GRADE_TABLE_SIZE, tableRef.current)
      redrawRef.current()
      if (glRef.current && !glRef.current.lost && !failedRef.current) status.current(lutMissing ? 'lut-missing' : 'ok')
      bakesRef.current++
      if (canvasRef.current) canvasRef.current.dataset.bakes = String(bakesRef.current)
    })
    return () => cancelAnimationFrame(id)
  }, [key, lutTable, lutMissing, status])

  return <div ref={hostRef} data-grade-host="" aria-hidden="true" style={{ ...style, filter: undefined }} />
}

/** The notice a layer shows when its look can't be drawn as it will export. */
export function GradeNotice({ status, lutName }: { status: GradeStatus; lutName?: string }): JSX.Element | null {
  if (status === 'ok') return null
  const text =
    status === 'unavailable'
      ? 'Colour preview off (WebGL unavailable) — the export still applies the grade'
      : status === 'failed'
        ? 'Colour preview off (WebGL couldn’t read this media) — the export still applies the grade'
        : `LUT “${lutName ?? 'LUT'}” is missing — shown without it`
  return (
    <div
      data-testid="grade-warning"
      role="status"
      className="pointer-events-none absolute top-1 left-1 z-10 max-w-[90%] rounded bg-amber-500/90 px-1.5 py-0.5 text-[9px] leading-tight font-medium text-black"
    >
      {text}
    </div>
  )
}
