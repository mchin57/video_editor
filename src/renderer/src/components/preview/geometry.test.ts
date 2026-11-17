/**
 * Which path a look takes in the preview, pinned: the three old sliders and the
 * colour wash keep main's CSS `filter` on the media element — the very string
 * `videoFillStyle` built before the colour table existed — and anything newer
 * (temperature, green / magenta, vibrance, a LUT at a strength) has NO CSS
 * filter: it is drawn through the table (`GradeCanvas`, `needsGradeTable`).
 */
import { describe, expect, it } from 'vitest'
import { needsGradeTable, type ColorLook } from '@shared/grade'
import type { MediaAsset } from '@shared/media'
import type { VideoContent } from '@shared/project'
import { lookCssFilter, tintFilterId, videoFillStyle } from './geometry'

const wash = { color: '#ffd999', amount: 0.5 }

/** Legacy looks and the CSS filter main drew for each (a literal, so a change shows). */
const LEGACY: { name: string; look: ColorLook; css: string | undefined }[] = [
  { name: 'nothing', look: {}, css: undefined },
  {
    name: 'neutral sliders (still a filter, as on main)',
    look: { color: { brightness: 0, contrast: 1, saturation: 1 } },
    css: 'brightness(1) contrast(1) saturate(1)'
  },
  {
    name: 'exposure, contrast, saturation',
    look: { color: { brightness: 0.2, contrast: 1.3, saturation: 1.4 } },
    css: 'brightness(1.2) contrast(1.3) saturate(1.4)'
  },
  {
    name: 'exposure below −1 is held at brightness(0)',
    look: { color: { brightness: -1.5, contrast: 1, saturation: 1 } },
    css: 'brightness(0) contrast(1) saturate(1)'
  },
  {
    name: 'the grade, then the wash',
    look: { color: { brightness: 0.15, contrast: 1.3, saturation: 1.4 }, tint: wash },
    css: `brightness(1.15) contrast(1.3) saturate(1.4) url(#${tintFilterId(wash)})`
  },
  { name: 'the wash alone', look: { tint: wash }, css: `url(#${tintFilterId(wash)})` },
  { name: 'a wash at 0 % draws nothing', look: { tint: { ...wash, amount: 0 } }, css: undefined },
  {
    name: 'newer controls stored at 0 stay legacy',
    look: { color: { brightness: 0.1, contrast: 1, saturation: 1, temperature: 0, greenMagenta: 0, vibrance: 0 } },
    css: 'brightness(1.1) contrast(1) saturate(1)'
  },
  {
    name: 'a LUT at strength 0 stays legacy',
    look: { color: { brightness: 0.1, contrast: 1, saturation: 1 }, lut: { file: 'a.cube', name: 'A', strength: 0 } },
    css: 'brightness(1.1) contrast(1) saturate(1)'
  }
]

const TABLE: { name: string; look: ColorLook }[] = [
  { name: 'temperature', look: { color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0.4 } } },
  { name: 'green / magenta', look: { color: { brightness: 0, contrast: 1, saturation: 1, greenMagenta: -0.3 } } },
  { name: 'vibrance', look: { color: { brightness: 0.2, contrast: 1, saturation: 1, vibrance: 0.5 } } },
  { name: 'a LUT', look: { tint: wash, lut: { file: 'a.cube', name: 'A', strength: 0.6 } } }
]

const clip = (look: ColorLook): VideoContent => ({
  kind: 'video',
  mediaId: 'm',
  inSec: 0,
  outSec: 2,
  mute: false,
  gainDb: 0,
  ...(look as Partial<VideoContent>)
})
const asset = { probe: { video: { displayWidth: 1080, displayHeight: 1920 } } } as unknown as MediaAsset

describe('lookCssFilter and the table switch', () => {
  it.each(LEGACY)('$name: the CSS path, main’s filter string', ({ look, css }) => {
    expect(needsGradeTable(look)).toBe(false)
    expect(lookCssFilter(look)).toBe(css)
    expect(videoFillStyle(clip(look), asset).filter).toBe(css)
    // With a crop too (the other branch of the fill style).
    const cropped = { ...clip(look), crop: { x: 0, y: 0, w: 540, h: 960 } }
    expect(videoFillStyle(cropped, asset).filter).toBe(css)
  })

  it.each(TABLE)('$name: the table path, no CSS filter at all', ({ look }) => {
    expect(needsGradeTable(look)).toBe(true)
    expect(lookCssFilter(look)).toBeUndefined()
    expect(videoFillStyle(clip(look), asset).filter).toBeUndefined()
  })
})
