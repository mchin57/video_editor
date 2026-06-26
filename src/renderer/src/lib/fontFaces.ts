/**
 * Inject an `@font-face` rule for every bundled font so the preview (and the
 * font picker) render with the EXACT faces the export burns. Each rule maps one
 * static TTF to a CSS family named after the font's label, served over the
 * `reelmedia://fonts/<file>` protocol. `font-weight: normal` everywhere — each
 * file already carries its real weight, so the browser never synthesises bold.
 *
 * `fontCssFamily(id)` (shared/fonts) returns the matching `"<label>", …` stack.
 */

import { FONTS } from '@shared/fonts'
import { fontUrl } from '@/ipc/client'

let injected = false

/** Idempotently add the `@font-face` rules to the document head. */
export function ensureFontFaces(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const css = FONTS.map(
    (f) =>
      `@font-face{font-family:"${f.label}";font-style:normal;font-weight:normal;` +
      `font-display:swap;src:url("${fontUrl(f.file)}") format("truetype");}`
  ).join('\n')
  const style = document.createElement('style')
  style.setAttribute('data-fonts', 'bundled')
  style.textContent = css
  document.head.appendChild(style)
}
