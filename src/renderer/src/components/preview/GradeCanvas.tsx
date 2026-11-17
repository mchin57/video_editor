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
 * unchanged) and is hidden only while the canvas draws. Video is drawn every
 * animation frame while it plays and on every seek / load while paused.
 *
 * If WebGL2 is unavailable or its context is lost, `onStatus('unavailable')`
 * tells the layer to show the element ungraded with `GradeNotice`; a LUT whose
 * file can't be read reports `'lut-missing'` and draws the rest of the look.
 */

import { useEffect, useRef, type CSSProperties, type JSX, type RefObject } from 'react'
import { activeLut, bakeGradeTable, GRADE_TABLE_SIZE, type ColorLook } from '@shared/grade'
import { createLogger } from '@shared/log'
import { useLatest } from '@/hooks/useLatest'
import { useLutTable } from '@/hooks/useLut'
import { createGradeGl, MAX_GRADED_IMAGE_SIDE, type GradeGl, type GradeSource } from './gradeGl'

const log = createLogger('grade-preview')

/** How the colour-table preview is doing. */
export type GradeStatus = 'ok' | 'unavailable' | 'lut-missing'

/** The fields of a look that change its table, as a stable string. */
const lookKey = (look: ColorLook): string => JSON.stringify({ color: look.color, tint: look.tint, lut: look.lut })

export function GradeCanvas({
  look,
  video,
  imageSrc,
  style,
  onStatus
}: {
  look: ColorLook
  /** The clip's own `<video>` (already in the DOM, CORS-clean). */
  video?: RefObject<HTMLVideoElement | null>
  /** …or the picture's URL (loaded here with CORS, so WebGL may read it). */
  imageSrc?: string
  /** The media element's own fill style. */
  style: CSSProperties
  onStatus: (s: GradeStatus) => void
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<GradeGl | null>(null)
  /** The last baked table, re-uploaded when a lost context comes back. */
  const tableRef = useRef<Float32Array | null>(null)
  /** Draws the current frame / picture (set by the source effect). */
  const redrawRef = useRef<() => void>(() => {})
  const status = useLatest(onStatus)
  const key = lookKey(look)
  const lutFile = activeLut(look.lut)?.file ?? null
  const lut = useLutTable(lutFile)
  /** Whether the look's LUT couldn't be read — what a (re)made context reports, not a blanket 'ok'. */
  const lutMissingNow = useLatest(lut.missing)

  // The context and the source: made once per source, remade after a context loss.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let source: GradeSource | null = video?.current ?? null
    let raf = 0
    let disposed = false
    const size = (): [number, number] => {
      if (source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight]
      if (!source || !source.naturalWidth) return [0, 0]
      const k = Math.min(1, MAX_GRADED_IMAGE_SIDE / Math.max(source.naturalWidth, source.naturalHeight))
      return [Math.round(source.naturalWidth * k), Math.round(source.naturalHeight * k)]
    }
    const draw = (): void => {
      const gl = glRef.current
      if (!gl || !source) return
      if (source instanceof HTMLVideoElement && source.readyState < 2) return
      if (source instanceof HTMLImageElement && !source.complete) return
      const [w, h] = size()
      gl.draw(source, w, h)
    }
    const init = (): void => {
      glRef.current?.dispose()
      glRef.current = createGradeGl(canvas)
      if (!glRef.current) {
        log.warn('WebGL2 is unavailable: the clip shows ungraded in the preview')
        status.current('unavailable')
        return
      }
      if (tableRef.current) glRef.current.setTable(GRADE_TABLE_SIZE, tableRef.current)
      status.current(lutMissingNow.current ? 'lut-missing' : 'ok')
      draw()
    }
    const onLost = (e: Event): void => {
      e.preventDefault() // lets the browser offer it back (webglcontextrestored)
      log.warn('the WebGL context was lost: the clip shows ungraded in the preview')
      status.current('unavailable')
    }
    const onRestored = (): void => init()
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
      if (img) img.onload = null
      redrawRef.current = () => {}
      glRef.current?.dispose()
      glRef.current = null
    }
  }, [video, imageSrc, status, lutMissingNow])

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
      if (glRef.current && !glRef.current.lost) status.current(lutMissing ? 'lut-missing' : 'ok')
      // How many tables this canvas has drawn with — what a test waits on after changing the look.
      const canvas = canvasRef.current
      if (canvas) canvas.dataset.bakes = String(Number(canvas.dataset.bakes ?? 0) + 1)
    })
    return () => cancelAnimationFrame(id)
  }, [key, lutTable, lutMissing, status])

  return <canvas ref={canvasRef} data-testid="grade-canvas" aria-hidden="true" style={style} />
}

/** The notice a layer shows when its look can't be drawn as it will export. */
export function GradeNotice({ status, lutName }: { status: GradeStatus; lutName?: string }): JSX.Element | null {
  if (status === 'ok') return null
  const text =
    status === 'unavailable'
      ? 'Colour preview off (WebGL unavailable) — the export still applies the grade'
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
