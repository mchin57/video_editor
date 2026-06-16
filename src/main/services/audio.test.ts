import { describe, it, expect } from 'vitest'
import { buildAudioProxyArgs, buildWaveformArgs, dbToGain, buildAudioGraph, type AudioGraphItem } from './audio'

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

describe('buildWaveformArgs', () => {
  it('uses showwavespic at the given size', () => {
    const a = buildWaveformArgs('in.m4a', 'wave.png', 1600, 200).join(' ')
    expect(a).toContain('showwavespic=s=1600x200')
    expect(a).toContain('-frames:v 1')
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
  it('applies fades', () => {
    const res = buildAudioGraph([item({ startSec: 0, inSec: 0, outSec: 10, fadeInSec: 1, fadeOutSec: 2 })], null)!
    expect(res.filter).toContain('afade=t=in:st=0.00:d=1.00')
    expect(res.filter).toContain('afade=t=out:st=8.00:d=2.00')
  })
})
