import { describe, it, expect } from 'vitest'
import { buildLoudnessArgs, createLimiter, parseLoudnessPrint } from './loudness'

describe('createLimiter', () => {
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }
  const ticks = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await Promise.resolve()
  }

  it('never runs more than `max` at once, even when a newcomer arrives as a slot is handed over', async () => {
    // Sweep the newcomer's arrival across every microtask offset around the
    // moment a finishing task wakes the one waiting: one offset lands between
    // the wake-up and the woken task taking its slot.
    for (let offset = 0; offset < 12; offset++) {
      const limit = createLimiter(2)
      let active = 0
      let most = 0
      const task = (gate: Promise<void>) => (): Promise<void> => {
        active++
        most = Math.max(most, active)
        return gate.finally(() => active--)
      }
      const gates = [deferred(), deferred(), deferred(), deferred()]
      const runs = [limit(task(gates[0].promise)), limit(task(gates[1].promise)), limit(task(gates[2].promise))]
      await ticks(3)
      expect(active).toBe(2)
      gates[0].resolve()
      await ticks(offset)
      runs.push(limit(task(gates[3].promise)))
      await ticks(12)
      expect(most, `newcomer at microtask offset ${offset}`).toBeLessThanOrEqual(2)
      for (const g of gates) g.resolve()
      await Promise.all(runs)
      expect(active).toBe(0)
    }
  })

  it('runs every task, in arrival order once slots free up', async () => {
    const limit = createLimiter(1)
    const order: number[] = []
    await Promise.all([1, 2, 3, 4].map((n) => limit(async () => void order.push(n))))
    expect(order).toEqual([1, 2, 3, 4])
  })
})

describe('buildLoudnessArgs', () => {
  it('measures the first audio stream at 48 kHz in 0.1 s frames, printing to a bare file name', () => {
    expect(buildLoudnessArgs('C:\\clips\\a.mp4', 'loudness.print.txt')).toEqual([
      '-hide_banner', '-nostdin', '-nostats',
      '-i', 'C:\\clips\\a.mp4',
      '-map', '0:a:0',
      '-vn',
      '-af',
      'aresample=48000,asetnsamples=n=4800:p=0,' +
        'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level,' +
        'ebur128=metadata=1,ametadata=mode=print:file=loudness.print.txt',
      '-f', 'null', '-'
    ])
  })

  it('mono-folds before measuring when the probe found a dead channel', () => {
    const args = buildLoudnessArgs('in.mov', 'p.txt', 1)
    const af = args[args.indexOf('-af') + 1]
    expect(af.startsWith('pan=stereo|c0=c1|c1=c1,aresample=48000,')).toBe(true)
  })
})

/** Frames in the exact layout of a real print log (ffmpeg 8.1.1: a 440 Hz sine
 *  at 44.1 kHz, then digital silence, through `buildLoudnessArgs`'s chain).
 *  Values are from that run, except one M nudged off a rounding tie. */
const frame = (n: number, ptsTime: string, peak: string, m: string): string =>
  [
    `frame:${n}    pts:${n * 4800}   pts_time:${ptsTime}`,
    `lavfi.astats.Overall.Peak_level=${peak}`,
    `lavfi.r128.M=${m}`,
    'lavfi.r128.S=-120.691',
    'lavfi.r128.I=-70.000',
    'lavfi.r128.LRA=0.000',
    'lavfi.r128.LRA.low=0.000',
    'lavfi.r128.LRA.high=0.000'
  ].join('\n')

describe('parseLoudnessPrint', () => {
  it('turns each frame into one 0.1 s step of momentary loudness + peak', () => {
    const text = [
      frame(0, '0', '-18.063423', '-120.691'),
      frame(1, '0.1', '-18.063423', '-120.691'),
      frame(2, '0.2', '-18.063423', '-120.691'),
      frame(3, '0.3', '-18.063423', '-21.757'),
      frame(4, '0.4', '-77.025396', '-23.017'),
      frame(5, '0.5', '-inf', 'nan')
    ].join('\n') + '\n'
    expect(parseLoudnessPrint(text)).toEqual({
      version: 1,
      stepSec: 0.1,
      startSec: 0,
      // −120.691 is ebur128's "no full block yet" floor; nan is digital silence.
      momentary: [null, null, null, -21.76, -23.02, null],
      // -inf is digital silence.
      peak: [-18.06, -18.06, -18.06, -18.06, -77.03, null]
    })
  })

  it('reads CRLF logs and records a non-zero first timestamp', () => {
    const text = [frame(0, '0.021333', '-6', '-120.691'), frame(1, '0.121333', '-6.5', '-30')].join('\r\n')
    const s = parseLoudnessPrint(text)
    expect(s.startSec).toBe(0.021)
    expect(s.momentary).toEqual([null, -30])
    expect(s.peak).toEqual([-6, -6.5])
  })

  it('yields an empty series for an empty log', () => {
    expect(parseLoudnessPrint('')).toMatchObject({ momentary: [], peak: [] })
  })
})
