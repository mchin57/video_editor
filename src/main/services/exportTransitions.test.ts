import { describe, it, expect } from 'vitest'
import type { Layer, LayerTransition } from '@shared/project'
import { makeVideoLayer } from '@shared/layers'
import { buildOpacityCmdLines } from './ffmpegFilters'
import {
  buildExportArgs,
  targetForPreset,
  type ExportBox,
  type ExportKeyframe,
  type ExportPlan,
  type ExportVideo,
  type ExportVisual
} from './exporterArgs'
import { platesByLayer } from './exportTransitions'
import { layerOpacityPoints } from '@shared/transitions'
import type { FfmpegCapabilities } from '@shared/ffmpeg'

const tr = (kind: LayerTransition['kind'], sec: number): LayerTransition => ({ kind, sec })
const layer = (id: string, start: number, end: number, patch: Partial<Layer> = {}): Layer => ({
  ...makeVideoLayer(id, 'm', start, end - start),
  ...patch
})
const vid: ExportVideo = {
  path: 'a.mp4',
  inSec: 0,
  len: 4,
  hdrChain: '',
  crop: null,
  colorEq: '',
  boxW: 1080,
  boxH: 1920,
  x: 0,
  y: 0,
  startSec: 0,
  endSec: 4,
  freezes: []
}
const plan = (over: Partial<ExportPlan>): ExportPlan => ({
  target: targetForPreset('reel'),
  totalDur: 8,
  visuals: [],
  audio: [],
  caps: { encoders: { h264_nvenc: false } } as unknown as FfmpegCapabilities,
  preferNvenc: false,
  ...over
})

const graphOf = (visuals: ExportVisual[]): string => {
  const args = buildExportArgs(plan({ visuals }), 'out.mp4')
  return args[args.indexOf('-filter_complex') + 1]
}
const boxOf = (v: ExportVideo): ExportBox => ({
  boxW: v.boxW,
  boxH: v.boxH,
  x: v.x,
  y: v.y,
  rotationDeg: v.rotationDeg,
  keyframes: v.keyframes
})
const card = (color: string, v: ExportVideo, startSec = 3.5, endSec = 4): ExportVisual => ({
  kind: 'plate',
  plate: { color, startSec, endSec, box: boxOf(v) }
})
/** The overlay of input/label `src` in `graph`: its position and gate. */
const overlayOf = (graph: string, src: string): string =>
  graph
    .split(';')
    .find((c) => c.includes(`[${src}]overlay=`))!
    .replace(/^.*overlay=/, '')

describe('the dip card (export twin of the preview card): a colour placed like the clip', () => {
  it('a static box: a colour source the box’s size, shifted to the window, overlaid where the clip is, half-open', () => {
    const pip: ExportVideo = { ...vid, boxW: 432, boxH: 768, x: 540, y: 96 }
    const graph = graphOf([
      { kind: 'video', video: { ...vid, path: 'main.mp4', endSec: 8 } },
      card('#000000', pip),
      { kind: 'video', video: { ...pip, path: 'a.mp4' } }
    ])
    expect(graph).toContain(
      'color=c=0x000000:s=432x768:r=30:d=0.500,setsar=1,format=yuv420p,setpts=PTS-STARTPTS+3.500/TB[pp1];' +
        "[v0][pp1]overlay=540:96:enable='gte(t,3.500)*lt(t,4.000)'[v1];"
    )
    // The clip itself goes over the card, at the same place.
    expect(graph).toContain("[v1][pv2]overlay=540:96:enable='between(t,0.000,4.000)'")
    // A card is not an input: still one base canvas + two clips.
    expect(buildExportArgs(plan({ visuals: [card('#000000', pip)] }), 'o.mp4').filter((a) => a === '-i')).toHaveLength(
      1
    )
  })

  it('a rotated and a keyframed box are placed by the clip’s own steps (rotation, per-frame scale, position)', () => {
    const kfs: ExportKeyframe[] = [
      { t: 3.5, w: 300, h: 300, cx: 300, cy: 1500 },
      { t: 4.5, w: 600, h: 600, cx: 700, cy: 1500 }
    ]
    for (const clip of [
      { ...vid, boxW: 432, boxH: 768, x: 324, y: 576, rotationDeg: 30 },
      { ...vid, boxW: 300, boxH: 300, x: 150, y: 1350, keyframes: kfs },
      { ...vid, boxW: 300, boxH: 300, x: 150, y: 1350, keyframes: kfs, rotationDeg: -15 }
    ] as ExportVideo[]) {
      const graph = graphOf([card('#ffffff', clip), { kind: 'video', video: clip }])
      const chains = graph.split(';')
      const src = chains.find((c) => c.startsWith('color=c=0xFFFFFF'))!
      const pic = chains.find((c) => c.startsWith('[1:v]'))!
      // The steps after the shift are character for character the clip's own.
      const afterShift = (c: string): string => c.slice(c.indexOf('/TB') + 3).replace(/,format=rgba.*$|\[p\w+\]$/, '')
      expect(afterShift(src)).toBe(afterShift(pic))
      expect(afterShift(src)).not.toBe('')
      // A rotation needs alpha first, as the clip's chain has it.
      if (clip.rotationDeg) expect(src).toContain('format=yuva420p,setpts')
      // Same position expression as the clip.
      const pos = (o: string): string => o.replace(/:enable=.*$/, '')
      expect(pos(overlayOf(graph, 'pp0'))).toBe(pos(overlayOf(graph, 'pv1')))
    }
  })

  it('platesByLayer: one card box per covered clip, from the clip exporter’s geometry, under the lower tile', async () => {
    const a = layer('A', 0, 4, { transitionOut: tr('dipWhite', 0.5) })
    const b = layer('B', 3.5, 8, { transitionIn: tr('dipWhite', 0.5) })
    const boxes: Record<string, ExportBox> = {
      A: boxOf({ ...vid, boxW: 432, boxH: 768, x: 540, y: 96 }),
      B: boxOf({ ...vid, boxW: 432, boxH: 768, x: 108, y: 1056, rotationDeg: 10 })
    }
    const resolve = async (l: Layer): Promise<ExportBox | null> => boxes[l.id] ?? null
    expect([...(await platesByLayer([a, b], resolve))]).toEqual([
      [
        'A',
        [
          { kind: 'plate', plate: { color: '#ffffff', startSec: 3.5, endSec: 4, box: boxes.A } },
          { kind: 'plate', plate: { color: '#ffffff', startSec: 3.5, endSec: 4, box: boxes.B } }
        ]
      ]
    ])
    // A box the exporter can't place (missing source) is left out.
    const onlyA = async (l: Layer): Promise<ExportBox | null> => (l.id === 'A' ? boxes.A : null)
    expect((await platesByLayer([a, b], onlyA)).get('A')).toHaveLength(1)
    // No dips, no steps.
    expect((await platesByLayer([layer('A', 0, 4), layer('B', 4, 8)], resolve)).size).toBe(0)
    const da = { ...a, transitionOut: tr('dissolve', 0.5) }
    const db = { ...b, transitionIn: tr('dissolve', 0.5) }
    expect((await platesByLayer([da, db], resolve)).size).toBe(0)
  })
})

describe('the transition ramp in the opacity command file', () => {
  it('a dissolve ramps the incoming clip 0 → 1 over the overlap and pins 1 after', () => {
    const pts = layerOpacityPoints(layer('B', 3.5, 8, { transitionIn: tr('dissolve', 0.5) }))!
    expect(buildOpacityCmdLines('op0', pts)).toBe(
      [
        "3.500-3.750 [expr] colorchannelmixer@op0 aa 'lerp(0.000,0.500,TI)';",
        "3.750-4.000 [expr] colorchannelmixer@op0 aa 'lerp(0.500,1.000,TI)';",
        "4.000-8.000 [expr] colorchannelmixer@op0 aa 'lerp(1.000,1.000,TI)';",
        "8.000-3608.000 [expr] colorchannelmixer@op0 aa '1.000';",
        ''
      ].join('\n')
    )
  })

  it('a dip-out holds the clip hidden for the second half', () => {
    const pts = layerOpacityPoints(layer('A', 0, 4, { transitionOut: tr('dipBlack', 0.5) }))!
    expect(buildOpacityCmdLines('op1', pts)).toBe(
      [
        "0.000-3.500 [expr] colorchannelmixer@op1 aa 'lerp(1.000,1.000,TI)';",
        "3.500-3.750 [expr] colorchannelmixer@op1 aa 'lerp(1.000,0.000,TI)';",
        "3.750-4.000 [expr] colorchannelmixer@op1 aa 'lerp(0.000,0.000,TI)';",
        "4.000-3604.000 [expr] colorchannelmixer@op1 aa '0.000';",
        ''
      ].join('\n')
    )
  })
})
