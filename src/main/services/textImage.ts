/**
 * Renders gradient-filled text to a transparent, output-sized PNG so the
 * exporter can composite it as an overlay — ASS/libass has no gradient support,
 * so gradient text (and captions) can't burn through the normal ass= path.
 *
 * We draw the text with the SAME CSS the preview uses (gradient via
 * background-clip:text, stroke via -webkit-text-stroke + paint-order, shadow via
 * text-shadow, optional pill) inside a hidden, transparent Electron window
 * positioned off-screen, then capturePage() → PNG. One window is reused for the
 * whole export. All geometry is in OUTPUT px (the exporter pre-scales).
 *
 * If rendering fails the caller falls back to a flat-colour ASS burn, so a
 * gradient never breaks an export.
 */

import { BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pillRadiusPx, type GradientStyle, type PillStyle, type ShadowStyle, type StrokeStyle } from '@shared/project'
import { FONTS, resolveFont } from '@shared/fonts'

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
  /** Clockwise rotation in degrees. */
  rotationDeg?: number
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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
function buildHtml(spec: TextImageSpec, W: number, H: number, fontsDir: string | null): string {
  const def = resolveFont(spec.fontFamily)
  const pillOn = spec.pill.enabled
  const span: string[] = [
    `font-family:"${def.label}",system-ui,sans-serif`,
    'font-weight:normal',
    `font-size:${spec.fontSizePx}px`,
    'line-height:1.1'
  ]
  // Gradient fill via background-clip:text, else a flat colour.
  if (spec.gradient) {
    span.push(
      `background:linear-gradient(${spec.gradient.angle}deg,${spec.gradient.from},${spec.gradient.to})`,
      '-webkit-background-clip:text',
      'background-clip:text',
      '-webkit-text-fill-color:transparent',
      'color:transparent'
    )
  } else {
    span.push(`color:${spec.color}`)
  }
  if (!pillOn && spec.stroke && spec.stroke.widthPx > 0) {
    span.push(
      `-webkit-text-stroke:${spec.stroke.widthPx}px ${spec.stroke.color}`,
      'paint-order:stroke fill'
    )
  }
  if (spec.shadow && (spec.shadow.distancePx > 0 || spec.shadow.blur > 0)) {
    const d = spec.shadow.distancePx
    span.push(`text-shadow:${d}px ${d}px ${spec.shadow.blur}px ${spec.shadow.color}`)
  }
  // Pill: an inline wrapper so box-decoration-break clones a padded, rounded
  // background onto each wrapped line (per-line, hugging each line's width). The
  // inner text is position:relative so all glyphs paint in the positioned phase,
  // above every line's background — otherwise a lower line's padding bleeds up
  // and paints over the line above. Matches PreviewStage.StyledText.
  const pillCss = pillOn
    ? `background:${spec.pill.color};padding:${spec.pill.padPx}px;` +
      `border-radius:${pillRadiusPx(spec.pill.padPx)}px;` +
      `-webkit-box-decoration-break:clone;box-decoration-break:clone`
    : ''
  if (pillOn) span.push('position:relative')
  const rot = spec.rotationDeg ? ` rotate(${spec.rotationDeg}deg)` : ''
  const box = [
    'position:absolute',
    `left:${spec.xCenter}px`,
    `top:${spec.yCenter}px`,
    `transform:translate(-50%,-50%)${rot}`,
    spec.widthPx != null ? `width:${spec.widthPx}px` : 'max-width:88%',
    'text-align:center',
    'white-space:pre-wrap'
  ]
  const inner = `<span class="txt">${esc(spec.text)}</span>`
  const content = pillOn ? `<span class="pill">${inner}</span>` : inner
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
${fontFaceCss(fontsDir)}
.box{${box.join(';')}}
.pill{${pillCss}}
.txt{${span.join(';')}}
</style></head><body><div class="box">${content}</div></body></html>`
}

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

/** A reusable off-screen text rasteriser for one export run. */
export interface TextRenderer {
  /** Render `spec` to `outPath` (a .png). Throws on failure. */
  render: (spec: TextImageSpec, outPath: string) => Promise<void>
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
      // Normalise away any HiDPI scaling so the PNG is exactly output-sized.
      const sized = img.getSize().width === width ? img : img.resize({ width, height })
      await fsp.writeFile(outPath, sized.toPNG())
    },
    dispose() {
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }
  }
}
