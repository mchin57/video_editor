/**
 * The export's Chromium: a hidden, transparent Electron window that draws text
 * blocks with the SAME CSS the preview uses (`shared/textStyle.ts`). Two jobs:
 *
 *  - RENDER gradient text/captions (and fixed-width text) to a transparent,
 *    output-sized PNG composited as an overlay — libass has no gradients.
 *  - LAY OUT every block libass burns (text layers and captions alike): line
 *    breaks, line positions and pill boxes come back from here, so each line
 *    burns exactly where the preview put it (see `textLayout.ts`).
 *
 * One window is reused for the whole export. All geometry is in OUTPUT px (the
 * exporter pre-scales). If it fails the caller falls back (a flat ASS burn for
 * a render, newline-only lines for a layout), so text never breaks an export.
 */

import { BrowserWindow, type NativeImage } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { GradientStyle, PillStyle, ShadowStyle, StrokeStyle } from '@shared/project'
import { FONTS } from '@shared/fonts'
import { cssText, textBoxCss, textFillCss, textPillCss, type CssLength } from '@shared/textStyle'
import { groupLines, MEASURE_BLOCKS_SCRIPT, type LaidOutLine, type RawBlockMeasure } from './textLayout'

/** One text element to rasterise (geometry already in output px). */
export interface TextImageSpec {
  text: string
  /** Center position in output px. */
  xCenter: number
  yCenter: number
  fontFamily: string
  fontSizePx: number
  /** Flat colour (used only if no gradient). */
  color: string
  /** Gradient fill (background-clip:text). Absent = flat `color`. */
  gradient?: GradientStyle
  pill: PillStyle
  stroke?: StrokeStyle | null
  shadow?: ShadowStyle | null
  /** Explicit wrap-box width in output px (from a text side-resize). Absent = hug. */
  widthPx?: number
  /** Auto-wrap width in output px when there is no `widthPx` — the preview's
   *  frame-relative wrap (`textWrapWidth`), scaled like everything else. */
  wrapWidthPx: number
  /** Output px per logical px of decoration, for the default legibility shadow
   *  (a logical constant; every other length arrives pre-scaled). Default 1. */
  decoScale?: number
  /** Clockwise rotation in degrees. */
  rotationDeg?: number
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const px: CssLength = (n) => `${n}px`

/**
 * The three declaration blocks of one text block — the box, the pill wrapper,
 * the glyph span — built from the SAME shared definitions the preview renders
 * with (`shared/textStyle.ts`), in output px. The box is centred by transform,
 * like the preview's `TextBlock`: positioning it by `left` would cap its
 * shrink-wrap at the space right of its centre (the old half-frame wrap).
 */
function blockCss(spec: TextImageSpec, rotate: boolean): { box: string; pill: string; txt: string } {
  const rot = rotate && spec.rotationDeg ? ` rotate(${spec.rotationDeg}deg)` : ''
  // NOTE: the font lives on the BOX (inside textBoxCss), never on the glyph
  // span. The pill is an inline span BETWEEN the two, and an inline box's
  // background is sized from ITS OWN font metrics — with the font only on the
  // glyph span the pill inherited the default 16px and the glyphs spilled out
  // of it (measured: 16px pill vs 76px text).
  const box = [
    'position:absolute',
    'left:0',
    'top:0',
    `transform:translate(calc(${spec.xCenter}px - 50%),calc(${spec.yCenter}px - 50%))${rot}`,
    cssText(textBoxCss(spec, { widthPx: spec.widthPx, wrapWidthPx: spec.wrapWidthPx }, px))
  ].join(';')
  return {
    box,
    pill: spec.pill.enabled ? cssText(textPillCss(spec.pill, px)) : '',
    txt: cssText(textFillCss(spec, px, spec.decoScale ?? 1))
  }
}

const blockMarkup = (spec: TextImageSpec): string => {
  const inner = `<span class="txt">${esc(spec.text)}</span>`
  return spec.pill.enabled ? `<span class="pill">${inner}</span>` : inner
}

/** `@font-face` rules for every bundled font, loaded from disk (file://). */
function fontFaceCss(fontsDir: string | null): string {
  if (!fontsDir) return ''
  return FONTS.map(
    (f) =>
      `@font-face{font-family:"${f.label}";font-weight:normal;font-style:normal;` +
      `src:url("${pathToFileURL(join(fontsDir, f.file)).href}") format("truetype");}`
  ).join('')
}

/** Build the standalone HTML page that draws one text element on a transparent
 *  W×H canvas, positioned by its center. */
export function buildHtml(
  spec: TextImageSpec,
  W: number,
  H: number,
  fontsDir: string | null
): string {
  const css = blockCss(spec, true)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
${fontFaceCss(fontsDir)}
.box{${css.box}}
.pill{${css.pill}}
.txt{${css.txt}}
</style></head><body><div class="box">${blockMarkup(spec)}</div></body></html>`
}

/**
 * One page holding EVERY block to lay out (each `[data-block]`, unrotated —
 * rotation is applied by the burn about the block centre), for
 * `MEASURE_BLOCKS_SCRIPT`. Same CSS as `buildHtml`, so the line breaks,
 * leading and pill boxes measured here are the ones the preview draws.
 */
export function buildLayoutHtml(specs: TextImageSpec[], W: number, H: number, fontsDir: string | null): string {
  const blocks = specs
    .map((spec, i) => {
      const css = blockCss(spec, false)
      const markup = blockMarkup(spec)
        .replace('<span class="pill">', `<span class="pill" style='${css.pill}'>`)
        .replace('<span class="txt">', `<span class="txt" style='${css.txt}'>`)
      return `<div data-block="${i}" style='${css.box}'>${markup}</div>`
    })
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
${fontFaceCss(fontsDir)}
</style></head><body>${blocks}</body></html>`
}

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

/**
 * The capture has to be exactly output-sized. A HiDPI display hands back a
 * uniform multiple of it, which is safe to scale down — but any OTHER size means
 * the window wasn't the size we asked for and the picture is CROPPED, not
 * scaled. Resizing that would stretch a partial frame; the old code checked only
 * the WIDTH, so a window clamped to the display height sailed through and the
 * export lost every overlay below the cut with nothing raised anywhere.
 *
 * Throwing instead hands control to the caller's fallback, which burns the text
 * flat through libass — a lost gradient or wrap width, but text that is THERE.
 */
export function normaliseCapture(img: NativeImage, width: number, height: number): NativeImage {
  const { width: w, height: h } = img.getSize()
  if (w === width && h === height) return img
  // Cross-multiplied aspect compare, with a pixel of rounding tolerance.
  if (w > 0 && h > 0 && Math.abs(w * height - h * width) <= Math.max(w, h)) {
    return img.resize({ width, height })
  }
  throw new Error(`text capture was ${w}x${h}, expected ${width}x${height} (cropped, not scaled)`)
}

/** A reusable off-screen text rasteriser for one export run. */
export interface TextRenderer {
  /** Render `spec` to `outPath` (a .png). Throws on failure. */
  render: (spec: TextImageSpec, outPath: string) => Promise<void>
  /** Lay every block out with the preview's CSS and report its lines (one
   *  page, one pass). Throws on failure. */
  layout: (specs: TextImageSpec[]) => Promise<LaidOutLine[][]>
  dispose: () => void
}

export function createTextRenderer(
  width: number,
  height: number,
  tmpDir: string,
  fontsDir: string | null
): TextRenderer {
  let win: BrowserWindow | null = null
  let n = 0

  function ensureWin(): BrowserWindow {
    if (win && !win.isDestroyed()) return win
    win = new BrowserWindow({
      width,
      height,
      x: -32000,
      y: -32000,
      show: false,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      useContentSize: true,
      webPreferences: { offscreen: false, backgroundThrottling: false }
    })
    win.setIgnoreMouseEvents(true)
    // MUST re-assert the size: the BrowserWindow constructor CLAMPS width/height
    // to the display work area, so on any ordinary landscape monitor a 1080x1920
    // reel window is born short (measured: 1080x1032 on a 1920x1080 screen) and
    // capturePage then returns a picture cropped at that height — silently
    // deleting every overlay below it from the export. `setContentSize` is not
    // clamped, and the size survives `showInactive()`.
    win.setContentSize(width, height)
    return win
  }

  return {
    async render(spec, outPath) {
      const w = ensureWin()
      const htmlPath = join(tmpDir, `gradient_src_${n++}.html`)
      await fsp.writeFile(htmlPath, buildHtml(spec, width, height, fontsDir), 'utf8')
      await w.loadFile(htmlPath)
      // Wait for the bundled faces to load so the text isn't captured in a
      // fallback font.
      await w.webContents.executeJavaScript(
        '(async()=>{try{await document.fonts.ready}catch{}; return true})()'
      )
      w.showInactive()
      await delay(70) // let a frame paint after show
      const img = await w.webContents.capturePage()
      await fsp.writeFile(outPath, normaliseCapture(img, width, height).toPNG())
    },
    async layout(specs) {
      if (specs.length === 0) return []
      const w = ensureWin()
      const htmlPath = join(tmpDir, `layout_${n++}.html`)
      await fsp.writeFile(htmlPath, buildLayoutHtml(specs, width, height, fontsDir), 'utf8')
      await w.loadFile(htmlPath)
      const raw = (await w.webContents.executeJavaScript(MEASURE_BLOCKS_SCRIPT)) as RawBlockMeasure[]
      if (!Array.isArray(raw) || raw.length !== specs.length) throw new Error('text layout: block count mismatch')
      return raw.map(groupLines)
    },
    dispose() {
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }
  }
}
