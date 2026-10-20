/** Preview ▸ text: `TextBlock` + `StyledText`, the ONE renderer for text layers and captions, the inline editor, and sparkles. */

import { useLayoutEffect, useRef, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { TextStyleBase } from '@shared/project'
import { textBoxCss, textFillCss, textPillCss, type TextDeco } from '@shared/textStyle'
import { KARAOKE_DIM_OPACITY } from '@shared/textAnim'
import { sparkleStateAt, type Sparkle } from '@shared/sparkle'
import { useProject } from '@/state/projectStore'
import { cqw, cqh } from './frame'

/** Fill + outline + shadow for the glyphs — the shared definition
 *  (`shared/textStyle.ts`) the export rasteriser also draws with. */
const fillStyle = (s: TextDeco): CSSProperties => textFillCss(s, cqw) as CSSProperties
/** Unrevealed typewriter glyphs: keep their layout space, hide every paint —
 *  the CSS mirror of the ASS `\1a\3a\4a &HFF&` reveal (the pill, a separate
 *  box, stays; only fill/outline/shadow vanish — verified parity). */
function hiddenGlyphStyle(s: TextDeco): CSSProperties {
  const css = fillStyle(s)
  css.color = 'transparent'
  css.WebkitTextFillColor = 'transparent'
  css.textShadow = 'none'
  if (css.WebkitTextStroke) css.WebkitTextStroke = String(css.WebkitTextStroke).replace(/ .*$/, ' transparent')
  delete css.backgroundImage
  delete css.filter
  return css
}
/** Text glyphs with their fill/stroke/shadow, wrapped in a per-line pill when
 *  enabled (`textPillCss`; with a pill the glyph spans are `position:relative`
 *  so every line's text paints above every line's background).
 *
 *  `reveal` (typewriter: characters visible) and `litWords` (word-by-word
 *  karaoke: words highlighted) come from the shared `textAnimStateAt`, so the
 *  preview matches the ASS burn frame-for-frame. */
export function StyledText({
  s,
  text,
  reveal,
  litWords
}: {
  s: TextDeco
  text: string
  reveal?: number | null
  litWords?: number | null
}): JSX.Element {
  let inner: React.ReactNode
  if (reveal != null && reveal < text.length) {
    inner = (
      <>
        <span style={fillStyle(s)}>{text.slice(0, reveal)}</span>
        <span style={hiddenGlyphStyle(s)}>{text.slice(reveal)}</span>
      </>
    )
  } else if (litWords != null) {
    let w = 0
    inner = text.split(/(\s+)/).map((tok, i) => {
      if (tok.length === 0 || /^\s+$/.test(tok)) return tok
      const lit = w++ < litWords
      return (
        <span key={i} style={{ ...fillStyle(s), opacity: lit ? 1 : KARAOKE_DIM_OPACITY }}>
          {tok}
        </span>
      )
    })
  } else {
    inner = <span style={fillStyle(s)}>{text}</span>
  }
  if (!s.pill.enabled) return <>{inner}</>
  return <span style={textPillCss(s.pill, cqw) as CSSProperties}>{inner}</span>
}
/**
 * ONE text block — a text layer and a caption render through this same box
 * (`textBoxCss`, the definition the export rasteriser and line layout share).
 * Centred on (x, y) by TRANSFORM, never `left`: an absolutely positioned box
 * only shrink-wraps into the space right of its `left`, which is how captions
 * (placed at `left: x%`) came to wrap at half the frame. Transform order is
 * translate → rotate (captions) → scale (text layers), so a scaled layer lays
 * out unscaled and grows as a whole, exactly as the export sizes it.
 */
export function TextBlock({
  s,
  x,
  y,
  wrap,
  rotationDeg = 0,
  scale = 1,
  opacity,
  zIndex,
  className,
  onPointerDown,
  onDoubleClick,
  handleTarget,
  children
}: {
  s: Pick<TextStyleBase, 'fontFamily' | 'fontSizePx'>
  x: number
  y: number
  wrap: { widthPx?: number; wrapWidthPx: number }
  rotationDeg?: number
  scale?: number
  opacity?: number
  zIndex: number
  className: string
  onPointerDown: (e: ReactPointerEvent) => void
  onDoubleClick?: () => void
  /** Tag the box for the stage's resize-handle measuring (selected layer). */
  handleTarget?: boolean
  children: React.ReactNode
}): JSX.Element {
  const rot = rotationDeg ? ` rotate(${rotationDeg}deg)` : ''
  const sc = scale !== 1 ? ` scale(${scale})` : ''
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      data-resizebox={handleTarget ? '' : undefined}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: `translate(calc(${cqw(x)} - 50%), calc(${cqh(y)} - 50%))${rot}${sc}`,
        transformOrigin: 'center',
        opacity: opacity != null && opacity < 1 ? opacity : undefined,
        zIndex,
        ...(textBoxCss(s, wrap, cqw) as CSSProperties)
      }}
      className={`select-none ${className}`}
    >
      {children}
    </div>
  )
}
/**
 * Editing a text layer IN PLACE on the preview (#18): double-click its text and
 * the glyphs become this plain-text editable span, in the same box at the same
 * font and size. Typing goes here, so it can never reach the app's single-key
 * shortcuts (S split, T new text, Space play — the shortcut handler skips
 * editable targets). Every keystroke updates the layer live, inside a store
 * gesture, so the whole session is ONE undo step (none if nothing changed).
 * Enter is a new line; Escape or clicking away finishes. Pointer presses stay
 * inside (no layer drag starts while editing).
 */
export function InlineTextEditor({
  initial,
  color,
  onChange,
  onDone
}: {
  initial: string
  color: string
  onChange: (text: string) => void
  onDone: () => void
}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    // Uncontrolled: React never re-renders the text under the caret.
    el.textContent = initial
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    useProject.getState().beginGesture()
    return () => useProject.getState().endGesture()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per editing session
  }, [])
  return (
    <span
      ref={ref}
      data-testid="inline-text-editor"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      // Chromium keeps a placeholder "\n" at the end once a line break is typed
      // (so an empty last line has height); it is not part of the text.
      onInput={(e) => onChange((e.currentTarget.textContent ?? '').replace(/\n$/, ''))}
      onBlur={onDone}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="inline-block min-w-[1ch] cursor-text rounded bg-black/40 outline-none ring-2 ring-sky-400"
      style={{ whiteSpace: 'pre-wrap', color, caretColor: '#38bdf8', userSelect: 'text' }}
    />
  )
}
/** The same four-point star the ASS burn draws (`SPARKLE_PATH`), as SVG. Both
 *  are a radius-10 unit star, so preview and export show the same shape. */
const SPARKLE_SVG_PATH = 'M0,-10 L2,-2 L10,0 L2,2 L0,10 L-2,2 L-10,0 L-2,-2 Z'
/**
 * The sparkle layer of a text overlay, drawn ABOVE the glyphs (matching the
 * burn, which puts sparkles on ASS Layer 1). Positions come from the shared
 * `sparklesFor`, and each sparkle's twinkle from `sparkleStateAt` — playhead
 * driven like every other animation here, so scrubbing stays exact.
 *
 * Offsets are placed from the text block's centre in `cqw`/`cqh`, INSIDE the
 * layer's scaled box, so the layer scale multiplies them exactly as the export
 * does by computing sparkles at the output-scaled font size. Both dimensions
 * use `cqw` so the star stays round (logical px are square).
 */
export function Sparkles({
  sparkles,
  color,
  tLocal
}: {
  sparkles: Sparkle[]
  color: string
  tLocal: number
}): JSX.Element {
  return (
    <>
      {sparkles.map((s, i) => {
        const st = sparkleStateAt(s, tLocal)
        if (st.opacity <= 0) return null
        return (
          <svg
            key={i}
            viewBox="-10 -10 20 20"
            aria-hidden
            data-sparkle=""
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: cqw(s.sizePx * 2),
              height: cqw(s.sizePx * 2),
              transform: `translate(-50%,-50%) translate(${cqw(s.x)}, ${cqh(s.y)}) rotate(${s.rotDeg}deg) scale(${st.scale})`,
              opacity: st.opacity,
              pointerEvents: 'none',
              overflow: 'visible'
            }}
          >
            <path d={SPARKLE_SVG_PATH} fill={color} />
          </svg>
        )
      })}
    </>
  )
}
