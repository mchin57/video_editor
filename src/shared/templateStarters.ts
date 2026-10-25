/**
 * The built-in starter templates (shared/templates.ts). They live in code, not
 * on disk: the gallery lists them first, and choosing a sound for one saves a
 * user copy (`basedOn`) that stands in for it.
 *
 * Every piece sits clear of Instagram's Reel UI (the caption along the bottom,
 * the button rail on the right — `INSTAGRAM_SAFE_ZONES`), in the canonical
 * 1080×1920 space.
 */

import type { Layer, TextContent } from './project'
import { DEFAULT_SHADOW, PROJECT_VERSION } from './project'
import { FRAME } from './frame'
import { TEMPLATE_FORMAT_VERSION, type ReelTemplate } from './templates'

/** A text layer for a starter: centred horizontally at `y`, from `start` to `end`. */
function text(
  id: string,
  start: number,
  end: number,
  y: number,
  content: Omit<TextContent, 'kind' | 'pill'> & { pill?: TextContent['pill'] }
): Layer {
  return {
    id,
    hidden: false,
    startSec: start,
    endSec: end,
    x: FRAME.width / 2,
    y,
    scale: 1,
    content: { kind: 'text', pill: { enabled: false, color: '#000000cc', padPx: 18 }, ...content }
  }
}

const shadow = { ...DEFAULT_SHADOW }

export const BUILT_IN_TEMPLATES: readonly ReelTemplate[] = [
  {
    id: 'builtin-right-back',
    name: "We'll be right back",
    formatVersion: TEMPLATE_FORMAT_VERSION,
    projectVersion: PROJECT_VERSION,
    clipEffect: {
      holdSec: 3,
      zoom: { scale: 1.3, dx: 0, dy: 0 },
      color: { brightness: 0, contrast: 1.1, saturation: 0.7 },
      tint: { color: '#e8c290', amount: 0.65 }
    },
    layers: [
      text('t1', 0.3, 3, 1180, {
        text: "We'll be right back",
        fontFamily: 'abril-fatface',
        fontSizePx: 84,
        color: '#ffffff',
        shadow,
        animation: { in: 'fadeIn', inSec: 0.3, out: 'none', outSec: 0.3 }
      })
    ],
    audio: [
      {
        label: 'Sting',
        file: null,
        clip: { startSec: 0, inSec: 0, outSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0.3, duck: false, kind: 'music' }
      }
    ]
  },
  {
    id: 'builtin-follow',
    name: 'Follow for more',
    formatVersion: TEMPLATE_FORMAT_VERSION,
    projectVersion: PROJECT_VERSION,
    clipEffect: null,
    layers: [
      text('t1', 0, 3, 820, {
        text: 'FOLLOW FOR MORE',
        fontFamily: 'bebas-neue',
        fontSizePx: 130,
        color: '#ffffff',
        stroke: { widthPx: 8, color: '#000000' },
        animation: { in: 'bounce', inSec: 0.45, out: 'fadeOut', outSec: 0.3 }
      }),
      text('t2', 0.3, 3, 960, {
        text: '@yourhandle',
        fontFamily: 'montserrat-extrabold',
        fontSizePx: 56,
        color: '#ffffff',
        shadow,
        animation: { in: 'fadeIn', inSec: 0.3, out: 'fadeOut', outSec: 0.3 }
      })
    ],
    audio: []
  },
  {
    id: 'builtin-link-in-bio',
    name: 'Link in bio',
    formatVersion: TEMPLATE_FORMAT_VERSION,
    projectVersion: PROJECT_VERSION,
    clipEffect: null,
    layers: [
      text('t1', 0, 3, 760, {
        text: 'LINK IN BIO',
        fontFamily: 'bebas-neue',
        fontSizePx: 150,
        color: '#ffffff',
        stroke: { widthPx: 8, color: '#000000' },
        animation: { in: 'bounce', inSec: 0.45, out: 'fadeOut', outSec: 0.3 }
      }),
      {
        id: 'g1',
        hidden: false,
        startSec: 0.3,
        endSec: 3,
        x: FRAME.width / 2,
        y: FRAME.height / 2,
        scale: 1,
        content: {
          kind: 'graphics',
          marks: [
            {
              id: 'm1',
              tool: 'arrow',
              points: [
                { x: 540, y: 880 },
                { x: 540, y: 1130 }
              ],
              color: '#ffffff',
              widthPx: 14,
              atSec: 0,
              reveal: 'draw'
            }
          ]
        }
      }
    ],
    audio: []
  },
  {
    id: 'builtin-lower-third',
    name: 'Lower-third name tag',
    formatVersion: TEMPLATE_FORMAT_VERSION,
    projectVersion: PROJECT_VERSION,
    clipEffect: null,
    layers: [
      text('t1', 0, 4, 1180, {
        text: 'Coach Name',
        fontFamily: 'montserrat-extrabold',
        fontSizePx: 72,
        color: '#ffffff',
        pill: { enabled: true, color: '#000000cc', padPx: 20 },
        animation: { in: 'slideUp', inSec: 0.35, out: 'fadeOut', outSec: 0.3 }
      }),
      text('t2', 0.15, 4, 1290, {
        text: 'Triathlon coach',
        fontFamily: 'montserrat-extrabold',
        fontSizePx: 44,
        color: '#e5e7eb',
        shadow,
        animation: { in: 'slideUp', inSec: 0.35, out: 'fadeOut', outSec: 0.3 }
      })
    ],
    audio: []
  },
  {
    id: 'builtin-before-after',
    name: 'Before / after labels',
    formatVersion: TEMPLATE_FORMAT_VERSION,
    projectVersion: PROJECT_VERSION,
    clipEffect: null,
    layers: [
      text('t1', 0, 5, 300, {
        text: 'BEFORE',
        fontFamily: 'montserrat-black',
        fontSizePx: 64,
        color: '#ffffff',
        pill: { enabled: true, color: '#000000cc', padPx: 18 }
      }),
      text('t2', 0, 5, 1100, {
        text: 'AFTER',
        fontFamily: 'montserrat-black',
        fontSizePx: 64,
        color: '#ffffff',
        pill: { enabled: true, color: '#000000cc', padPx: 18 }
      })
    ],
    audio: []
  }
]

/** Whether `id` names a built-in template. */
export const isBuiltInTemplate = (id: string): boolean => BUILT_IN_TEMPLATES.some((t) => t.id === id)
