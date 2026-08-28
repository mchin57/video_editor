import { describe, expect, it } from 'vitest'
import { defaultFxSettings } from '@shared/audioFx'
import { buildAudioFxArgs, buildAudioFxFilter, FX_SAMPLE_RATE, pitchStages } from './audioFx'

// The exact strings below were run through ffmpeg 8.1.1 and the OUTPUT
// inspected sample-by-sample (docs/FFMPEG-NOTES.md "Audio effects"): the echo
// put taps at exactly 260/520/780 ms with geometric ratios and no dry signal at
// 0 ms; the chorus put voices at exactly 11/21/32 ms at the designed gains,
// also with no dry. Treat a diff here as a behavior change, not a formatting one.

describe('buildAudioFxFilter — echo', () => {
  const filter = buildAudioFxFilter(defaultFxSettings('echo'), 1, 3)

  it('matches the verified filter string', () => {
    expect(filter).toBe(
      '[0:a]atrim=1.000:3.000,asetpts=N/SR/TB,' +
        'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,' +
        'aecho=0:1:260|520|780:0.4500|0.2025|0.0911[fx]'
    )
  })

  it('drops the dry signal — an effect track carries the wet signal only', () => {
    expect(filter).toContain('aecho=0:1:')
  })

  it('emits one tap per repeat rather than relying on feedback', () => {
    const [, delays] = /aecho=0:1:([^:]+):/.exec(filter)!
    expect(delays.split('|')).toHaveLength(3)
  })
})

describe('buildAudioFxFilter — chorus', () => {
  const filter = buildAudioFxFilter(defaultFxSettings('chorus'), 1, 3)

  it('matches the verified filter string', () => {
    expect(filter).toBe(
      '[0:a]atrim=1.000:3.000,asetpts=N/SR/TB,' +
        'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[src];' +
        '[src]asplit=3[v0][v1][v2];' +
        '[v0]asetrate=48130,aresample=48000,atempo=0.997299,volume=0.5500,adelay=11:all=1,asetpts=N/SR/TB[o0];' +
        '[v1]asetrate=47742,aresample=48000,atempo=1.005404,volume=0.4840,adelay=21:all=1,asetpts=N/SR/TB[o1];' +
        '[v2]asetrate=48390,aresample=48000,atempo=0.991940,volume=0.4180,adelay=32:all=1,asetpts=N/SR/TB[o2];' +
        '[o0][o1][o2]amix=inputs=3:normalize=0[fx]'
    )
  })

  it('renormalises PTS after every adelay (an atrim\u2019d stream poisons the mux otherwise)', () => {
    const delays = filter.match(/adelay=\d+:all=1,asetpts=N\/SR\/TB/g) ?? []
    expect(delays).toHaveLength(3)
    expect(filter).not.toMatch(/adelay=\d+:all=1(?!,asetpts)/)
  })

  it('mixes without normalising, so the per-voice gains are what land', () => {
    expect(filter).toContain('amix=inputs=3:normalize=0')
  })

  it('never reaches ffmpeg\u2019s own chorus filter, which ignores its delays', () => {
    expect(filter).not.toMatch(/(^|[,;[])chorus=/)
  })
})

describe('pitchStages', () => {
  it('derives atempo from the ROUNDED rate so the voice cannot drift', () => {
    const stages = pitchStages(14)
    const shifted = Number(/asetrate=(\d+)/.exec(stages.join(','))![1])
    const tempo = Number(/atempo=([\d.]+)/.exec(stages.join(','))![1])
    expect(Number.isInteger(shifted)).toBe(true)
    expect(tempo).toBeCloseTo(FX_SAMPLE_RATE / shifted, 6)
  })

  it('raises the rate to sharpen and lowers it to flatten', () => {
    expect(Number(/asetrate=(\d+)/.exec(pitchStages(20).join(','))![1])).toBeGreaterThan(FX_SAMPLE_RATE)
    expect(Number(/asetrate=(\d+)/.exec(pitchStages(-20).join(','))![1])).toBeLessThan(FX_SAMPLE_RATE)
  })

  it('is a no-op at zero detune rather than emitting an identity chain', () => {
    expect(pitchStages(0)).toEqual([])
  })
})

describe('buildAudioFxArgs', () => {
  it('renders lossless WAV at the working rate so import can proxy it', () => {
    const args = buildAudioFxArgs(defaultFxSettings('echo'), 'in.wav', 1, 3, 'out.wav')
    expect(args).toContain('-c:a')
    expect(args).toContain('pcm_s16le')
    expect(args.slice(args.indexOf('-ar'), args.indexOf('-ar') + 2)).toEqual(['-ar', '48000'])
    expect(args[args.length - 1]).toBe('out.wav')
  })

  it('maps the effect output, not the untouched input', () => {
    const args = buildAudioFxArgs(defaultFxSettings('chorus'), 'in.wav', 0, 2, 'out.wav')
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2)).toEqual(['-map', '[fx]'])
  })
})
