import { describe, it, expect } from 'vitest'
import {
  buildAudioProxyArgs,
  buildExtractAudioArgs,
  buildWaveformArgs,
  dbToGain,
  buildAudioGraph,
  buildChannelStatsArgs,
  parseChannelPeaks,
  monoFoldFrom,
  monoFoldPan,
  type AudioGraphItem
} from './audio'

function item(over: Partial<AudioGraphItem> = {}): AudioGraphItem {
  return {
    inputLabel: '1:a',
    startSec: 0,
    inSec: 0,
    outSec: 10,
    gainDb: -14,
    fadeInSec: 0,
    fadeOutSec: 0,
    duck: false,
    ...over
  }
}

describe('buildAudioProxyArgs', () => {
  it('produces an aac proxy with no video', () => {
    const a = buildAudioProxyArgs('in.mp3', 'out.m4a').join(' ')
    expect(a).toContain('-vn')
    expect(a).toContain('-c:a aac')
    expect(a.endsWith('out.m4a')).toBe(true)
  })
})

describe('buildAudioProxyArgs mono-fold', () => {
  it('leaves stereo untouched when no fold channel', () => {
    expect(buildAudioProxyArgs('in.mp3', 'out.m4a').join(' ')).not.toContain('pan=')
  })
  it('folds the given channel to both sides', () => {
    const a = buildAudioProxyArgs('in.mov', 'out.m4a', 1).join(' ')
    expect(a).toContain('-af pan=stereo|c0=c1|c1=c1')
  })
})

describe('mono-fold detection helpers', () => {
  // Peak-only astats dump (the exact shape buildChannelStatsArgs produces).
  const stderr = [
    '[Parsed_astats_0 @ 0x0] Channel: 1',
    '[Parsed_astats_0 @ 0x0] Peak level dB: -86.661040',
    '[Parsed_astats_0 @ 0x0] Channel: 2',
    '[Parsed_astats_0 @ 0x0] Peak level dB: -1.599302'
  ].join('\n')

  it('parses per-channel peaks (index 0 = ch1)', () => {
    expect(parseChannelPeaks(stderr)).toEqual([-86.66104, -1.599302])
  })
  it('reads -inf as fully silent', () => {
    const peaks = parseChannelPeaks('Channel: 1\nPeak level dB: -inf\nChannel: 2\nPeak level dB: -2.0')
    expect(peaks[0]).toBe(-Infinity)
    expect(peaks[1]).toBe(-2)
  })
  it('folds from the one live channel of a one-sided stereo source', () => {
    expect(monoFoldFrom(parseChannelPeaks(stderr))).toBe(1) // right channel live
    expect(monoFoldFrom([-2, -90])).toBe(0) // left channel live
  })
  it('does not fold true stereo, mono, or dead silence', () => {
    expect(monoFoldFrom([-2, -3])).toBeNull() // both live
    expect(monoFoldFrom([-90, -90])).toBeNull() // both silent
    expect(monoFoldFrom([-2])).toBeNull() // mono
  })
  it('probes only the audio stream, peak-only, to a null sink', () => {
    const a = buildChannelStatsArgs('in.mov').join(' ')
    expect(a).toContain('-map 0:a:0')
    expect(a).toContain('astats=measure_perchannel=Peak_level:measure_overall=none')
    expect(a).toContain('-f null')
  })
  it('monoFoldPan mirrors one channel to both', () => {
    expect(monoFoldPan(0)).toBe('pan=stereo|c0=c0|c1=c0')
    expect(monoFoldPan(1)).toBe('pan=stereo|c0=c1|c1=c1')
  })
})

describe('buildExtractAudioArgs', () => {
  it('extracts a lossless WAV with no video', () => {
    const a = buildExtractAudioArgs('clip.mp4', 'out.wav').join(' ')
    expect(a).toContain('-vn')
    expect(a).toContain('-c:a pcm_s16le')
    expect(a.endsWith('out.wav')).toBe(true)
  })
})

describe('buildWaveformArgs', () => {
  it('scales width with duration (~120 px/s), clamped to [2000, 6000]', () => {
    expect(buildWaveformArgs('in.m4a', 'w.png', 10).join(' ')).toContain('showwavespic=s=2000x') // 1200 → clamp 2000
    expect(buildWaveformArgs('in.m4a', 'w.png', 40).join(' ')).toContain('showwavespic=s=4800x')
    expect(buildWaveformArgs('in.m4a', 'w.png', 120).join(' ')).toContain('showwavespic=s=6000x') // 14400 → clamp 6000
    expect(buildWaveformArgs('in.m4a', 'w.png', 40).join(' ')).toContain('-frames:v 1')
  })
})

describe('dbToGain', () => {
  it('converts dB to linear gain', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 5)
    expect(dbToGain(-6)).toBeCloseTo(0.501, 2)
    expect(dbToGain(-20)).toBeCloseTo(0.1, 5)
  })
})

describe('buildAudioGraph', () => {
  it('returns null with no dialogue and no items', () => {
    expect(buildAudioGraph([], null)).toBeNull()
  })
  it('trims, delays, gains each clip and mixes with the dialogue', () => {
    const res = buildAudioGraph([item({ startSec: 2, inSec: 1, outSec: 5 })], '0:a')!
    expect(res.outLabel).toBe('aout')
    expect(res.filter).toContain('[1:a]atrim=1.000:5.000')
    expect(res.filter).toContain('adelay=2000|2000')
    expect(res.filter).toContain('amix=inputs=2')
    expect(res.filter).not.toContain('sidechaincompress')
  })
  it('sidechains ducked clips under the non-ducked sources', () => {
    const res = buildAudioGraph([item({ duck: true })], '0:a')!
    expect(res.filter).toContain('asplit=2[nd_sc][nd_mix]')
    expect(res.filter).toContain('sidechaincompress')
  })
  it('no sidechain when a ducked clip has nothing to duck against', () => {
    const res = buildAudioGraph([item({ duck: true })], null)!
    expect(res.filter).not.toContain('sidechaincompress')
    expect(res.outLabel).toBe('aout')
  })
  it('mono-folds a one-sided clip before trimming, else leaves it alone', () => {
    const folded = buildAudioGraph([item({ foldChannel: 1 })], null)!
    expect(folded.filter).toContain('[1:a]pan=stereo|c0=c1|c1=c1,atrim=')
    const plain = buildAudioGraph([item()], null)!
    expect(plain.filter).not.toContain('pan=')
  })
  it('applies fades', () => {
    const res = buildAudioGraph([item({ startSec: 0, inSec: 0, outSec: 10, fadeInSec: 1, fadeOutSec: 2 })], null)!
    expect(res.filter).toContain('afade=t=in:st=0.00:d=1.00')
    expect(res.filter).toContain('afade=t=out:st=8.00:d=2.00')
  })
})
