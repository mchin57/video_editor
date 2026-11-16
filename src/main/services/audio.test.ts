import { describe, it, expect } from 'vitest'
import {
  atempoChain,
  buildAudioProxyArgs,
  buildExtractAudioArgs,
  buildWaveformArgs,
  dbToGain,
  buildAudioGraph,
  buildChannelStatsArgs,
  parseChannelPeaks,
  monoFoldFrom,
  monoFoldPan,
  audioItemPlayedSec,
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

describe('atempoChain', () => {
  it('is empty for 1 or invalid tempos', () => {
    expect(atempoChain(1)).toEqual([])
    expect(atempoChain(0)).toEqual([])
    expect(atempoChain(NaN)).toEqual([])
  })
  it('emits a single stage inside the [0.5, 2] filter range', () => {
    expect(atempoChain(1.5)).toEqual(['atempo=1.500'])
    expect(atempoChain(0.5)).toEqual(['atempo=0.500'])
    expect(atempoChain(2)).toEqual(['atempo=2.000'])
  })
  it('factors out-of-range tempos into compliant stages', () => {
    expect(atempoChain(4)).toEqual(['atempo=2.000', 'atempo=2.000'])
    expect(atempoChain(0.25)).toEqual(['atempo=0.500', 'atempo=0.500'])
    expect(atempoChain(3)).toEqual(['atempo=2.000', 'atempo=1.500'])
  })
  it('feeds the graph between the trim and the delay', () => {
    const g = buildAudioGraph([item({ tempo: 2, startSec: 1 })], null)!
    expect(g.filter).toContain('asetpts=N/SR/TB,atempo=2.000,adelay=1000|1000')
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
    // asetpts AFTER adelay is load-bearing: ffmpeg 8.1.1's atrim→adelay emits a
    // garbage-PTS frame that overflows the mp4 muxer's DTS fixup mid-export —
    // see docs/FFMPEG-NOTES.md "adelay after atrim".
    expect(res.filter).toContain('adelay=2000|2000,asetpts=N/SR/TB')
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
  it('pins a flat clip’s whole chain exactly (no volume line = no extra filter)', () => {
    const flat = buildAudioGraph([item({ startSec: 2, inSec: 1, outSec: 5, gainDb: -6, fadeInSec: 0.5 })], null)!
    expect(flat.filter).toBe(
      '[1:a]atrim=1.000:5.000,asetpts=N/SR/TB,adelay=2000|2000,asetpts=N/SR/TB,volume=0.501,afade=t=in:st=2.00:d=0.50[ac0];[ac0]anull[aout]'
    )
    expect(
      buildAudioGraph([item({ startSec: 2, inSec: 1, outSec: 5, gainDb: -6, fadeInSec: 0.5, volumeLine: [] })], null)
    ).toEqual(flat)
  })
  it('a volume line rides after the static gain, re-chunked to 64 samples, before the fades', () => {
    const res = buildAudioGraph(
      [
        item({
          startSec: 2,
          inSec: 1,
          outSec: 5,
          gainDb: -6,
          fadeInSec: 0.5,
          volumeLine: [
            { t: 3, db: 0 },
            { t: 4, db: -12 }
          ]
        })
      ],
      null
    )!
    expect(res.filter).toBe(
      "[1:a]atrim=1.000:5.000,asetpts=N/SR/TB,adelay=2000|2000,asetpts=N/SR/TB,volume=0.501,asetnsamples=n=64:p=0,volume=volume='if(lt(t,3.000),1.000000,if(lt(t,4.000),pow(10,(0.000+-12.000*(t-3.000)/1.000)/20),0.251189))':eval=frame,afade=t=in:st=2.00:d=0.50[ac0];[ac0]anull[aout]"
    )
  })
})

describe('buildAudioGraph — re-timed audio clips (#58)', () => {
  it('a 2× clip: atempo after the trim, fade-out ending at its PLAYED end', () => {
    // Source 0..10 at 2× plays 5 s from t=1: the fade-out ends at 6, not 11.
    const g = buildAudioGraph([item({ startSec: 1, tempo: 2, fadeOutSec: 1 })], null)!
    expect(g.filter).toBe(
      '[1:a]atrim=0.000:10.000,asetpts=N/SR/TB,atempo=2.000,adelay=1000|1000,asetpts=N/SR/TB,volume=0.200,afade=t=out:st=5.00:d=1.00[ac0];[ac0]anull[aout]'
    )
    expect(audioItemPlayedSec(item({ tempo: 2 }))).toBe(5)
    expect(audioItemPlayedSec(item({ tempo: 0.5 }))).toBe(20)
  })

  it('holds: the tempo-adjusted stream is cut and padded with silence, then concatenated', () => {
    const g = buildAudioGraph(
      [
        item({
          startSec: 0.5,
          tempo: 0.5,
          denoise: true,
          holds: [
            { atPlayedSec: 9, holdSec: 2 },
            { atPlayedSec: 3, holdSec: 1.5 }
          ]
        })
      ],
      null
    )!
    expect(g.filter.split(';')).toEqual([
      '[1:a]atrim=0.000:10.000,asetpts=N/SR/TB,atempo=0.500,afftdn=nf=-25,asplit=3[ac0h0s][ac0h1s][ac0h2s]',
      '[ac0h0s]atrim=0.000:3.000,asetpts=N/SR/TB,apad=pad_dur=1.500[ac0h0]',
      '[ac0h1s]atrim=3.000:9.000,asetpts=N/SR/TB,apad=pad_dur=2.000[ac0h1]',
      '[ac0h2s]atrim=start=9.000,asetpts=N/SR/TB[ac0h2]',
      '[ac0h0][ac0h1][ac0h2]concat=n=3:v=0:a=1,adelay=500|500,asetpts=N/SR/TB,volume=0.200[ac0]',
      '[ac0]anull[aout]'
    ])
    // 20 s of stream + 3.5 s of holds.
    expect(audioItemPlayedSec(item({ tempo: 0.5, holds: [{ atPlayedSec: 3, holdSec: 1.5 }] }))).toBe(21.5)
  })

  it('a hold at the head is a later start; one at or past the end adds nothing to cut', () => {
    const g = buildAudioGraph(
      [
        item({
          startSec: 1,
          fadeInSec: 0.5,
          fadeOutSec: 1,
          holds: [
            { atPlayedSec: 0, holdSec: 2 },
            { atPlayedSec: 10, holdSec: 3 }
          ]
        })
      ],
      null
    )!
    expect(g.filter).not.toContain('asplit')
    expect(g.filter).toContain('adelay=3000|3000')
    // The fades stay on the clip's timeline span (start 1, end 1 + 10 + 5).
    expect(g.filter).toContain('afade=t=in:st=1.00:d=0.50')
    expect(g.filter).toContain('afade=t=out:st=15.00:d=1.00')
  })

  it('two holds at one moment are one cut', () => {
    const g = buildAudioGraph(
      [
        item({
          holds: [
            { atPlayedSec: 4, holdSec: 1 },
            { atPlayedSec: 4, holdSec: 0.5 }
          ]
        })
      ],
      null
    )!
    expect(g.filter).toContain('asplit=2')
    expect(g.filter).toContain('apad=pad_dur=1.500')
  })

  it('a clip with no tempo and no holds keeps the chain it always had', () => {
    const plain = buildAudioGraph([item({ startSec: 2, fadeOutSec: 1 })], null)!.filter
    expect(buildAudioGraph([item({ startSec: 2, fadeOutSec: 1, tempo: 1, holds: [] })], null)!.filter).toBe(plain)
  })
})
