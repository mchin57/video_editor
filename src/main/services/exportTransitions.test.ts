import { describe, it, expect } from 'vitest'
import type { Layer, LayerTransition } from '@shared/project'
import { makeVideoLayer } from '@shared/layers'
import { buildOpacityCmdLines } from './ffmpegFilters'
import { buildExportArgs, targetForPreset, type ExportPlan, type ExportVideo } from './exporterArgs'
import { plateFilter, platesByLayer } from './exportTransitions'
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

describe('the dip plate (export twin of the preview plate)', () => {
  it('is one full-frame drawbox, alpha-writing, gated to its window', () => {
    expect(plateFilter({ color: '#ffffff', startSec: 3.5, endSec: 4 })).toBe(
      "drawbox=x=0:y=0:w=iw:h=ih:color=0xFFFFFF:t=fill:replace=1:enable='between(t,3.500,4.000)'"
    )
  })

  it('lands on the composite right before the layer it goes under', () => {
    const args = buildExportArgs(
      plan({
        visuals: [
          { kind: 'video', video: vid },
          { kind: 'plate', plate: { color: '#000000', startSec: 3.5, endSec: 4 } },
          { kind: 'video', video: { ...vid, path: 'b.mp4', startSec: 3.5, endSec: 7.5 } }
        ]
      }),
      'out.mp4'
    )
    const graph = args[args.indexOf('-filter_complex') + 1]
    // Over the first clip's composite, and the second clip goes over the plate.
    expect(graph).toContain(
      "[v0]drawbox=x=0:y=0:w=iw:h=ih:color=0x000000:t=fill:replace=1:enable='between(t,3.500,4.000)'[v1];"
    )
    expect(graph).toContain("[v1][pv2]overlay=0:0:enable='between(t,3.500,7.500)'")
    // A plate is not an input: still one base canvas + two clips.
    expect(args.filter((a) => a === '-i')).toHaveLength(3)
  })

  it('is grouped by the layer it goes under (none for a stack without dips)', () => {
    const a = layer('A', 0, 4, { transitionOut: tr('dipWhite', 0.5) })
    const b = layer('B', 3.5, 8, { transitionIn: tr('dipWhite', 0.5) })
    expect([...platesByLayer([a, b])]).toEqual([
      ['A', [{ kind: 'plate', plate: { color: '#ffffff', startSec: 3.5, endSec: 4 } }]]
    ])
    expect(platesByLayer([layer('A', 0, 4), layer('B', 4, 8)]).size).toBe(0)
    const da = { ...a, transitionOut: tr('dissolve', 0.5) }
    const db = { ...b, transitionIn: tr('dissolve', 0.5) }
    expect(platesByLayer([da, db]).size).toBe(0)
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
