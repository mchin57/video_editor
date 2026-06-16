import { describe, it, expect } from 'vitest'
import { buildAudioProxyArgs, buildWaveformArgs, dbToGain, buildMusicMixGraph } from './audio'
import type { MusicConfig } from '@shared/project'

function music(over: Partial<MusicConfig> = {}): MusicConfig {
  return { mediaId: 'm', volumeDb: -14, duck: false, fadeOutSec: 0, muteVideo: false, ...over }
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

describe('buildMusicMixGraph', () => {
  it('music-only when muteVideo (no clip audio)', () => {
    const { filter, outLabel } = buildMusicMixGraph(music({ muteVideo: true }), '0:a', '1:a', 10)
    expect(outLabel).toBe('music')
    expect(filter).toContain('[1:a]atrim=0:10.00')
    expect(filter).not.toContain('amix')
  })
  it('mixes music + clip audio when not ducking', () => {
    const { filter, outLabel } = buildMusicMixGraph(music(), '0:a', '1:a', 10)
    expect(outLabel).toBe('aout')
    expect(filter).toContain('amix=inputs=2')
    expect(filter).not.toContain('sidechaincompress')
  })
  it('splits clip audio and sidechains when ducking', () => {
    const { filter } = buildMusicMixGraph(music({ duck: true }), '0:a', '1:a', 10)
    expect(filter).toContain('[0:a]asplit=2[a_sc][a_mix]')
    expect(filter).toContain('sidechaincompress')
    expect(filter).toContain('[ducked][a_mix]amix')
  })
  it('adds a fade-out when fadeOutSec > 0', () => {
    const { filter } = buildMusicMixGraph(music({ fadeOutSec: 1.5 }), '0:a', '1:a', 10)
    expect(filter).toContain('afade=t=out:st=8.50:d=1.50')
  })
})
