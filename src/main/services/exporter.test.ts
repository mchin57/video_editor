/**
 * The exporter's ORCHESTRATION, pinned: for projects that use every layer kind
 * and most options, the exact ffmpeg argument lists it runs and every file it
 * writes for them (ASS subtitles, opacity command files), plus what it asks
 * the text renderer to rasterise and lay out. `exporterArgs.test.ts` pins the
 * arg builders; this pins how a project is turned into their input, which had
 * no test. Anything the exporter would do differently shows up as a snapshot
 * diff — the safety net for refactoring `exporter.ts`.
 *
 * Everything outside the exporter is stubbed: no real ffmpeg, Chromium or
 * media store. Paths are normalised (`<tmp>`, `<out>`) so the snapshot is
 * machine-independent.
 */
import { mkdtempSync, promises as fsp, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FfmpegCapabilities } from '@shared/ffmpeg'
import type { MediaAsset, ProbeInfo, VideoStreamInfo } from '@shared/media'
import { createEmptyComposition, createEmptyProject, type AudioClip, type Layer, type Project } from '@shared/project'
import { makeGraphicsLayer, makeImageLayer, makeTextLayer, makeVideoLayer } from '@shared/layers'
import { angleMark, newMark } from '@shared/graphics'
import { makeLayoutLayer } from '@shared/layouts'
import { openSession } from './projectSession'

const scratch = mkdtempSync(join(tmpdir(), 'reel-exporter-test-'))
const tmpRoot = join(scratch, 'tmp')

// --- Stubs ------------------------------------------------------------------

/** Every ffmpeg run: its args, and the files in its working dir at that moment. */
const runs: { args: string[]; files: Record<string, string> }[] = []
/** What the text renderer was asked to do. */
const rendered: unknown[] = []
const laidOut: unknown[] = []
/** Graphics marks rasterised: each call's size, frame count and last SVG. */
const svgRendered: unknown[] = []
/** Overlay animations streamed (pose): size, frame count and the middle frame's SVG. */
const streamed: {
  width: number
  height: number
  count: number
  mid: string
  distinct: number
  drawn: number[]
}[] = []
/** Overlay encodes: their args and how many frames reached the encoder. */
const encodes: { args: string[]; frames: number }[] = []

vi.mock('../config', () => ({
  getSubdir: () => tmpRoot,
  getBundledFontsDir: () => '/fonts'
}))
vi.mock('./ffmpeg', () => ({
  getBinaries: async () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
  getCapabilities: async (): Promise<FfmpegCapabilities> => ({
    found: true,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    version: '8.1',
    encoders: { h264_nvenc: true, hevc_nvenc: true, libx264: true, libx265: true, aac: true },
    filters: { ass: true, subtitles: true, zscale: true, tonemap: true, sidechaincompress: true, showwavespic: true },
    nvencAvailable: true,
    usable: true,
    problems: []
  })
}))
vi.mock('./ffmpegRun', () => ({
  runFfmpeg: async (_ffmpeg: string, args: string[], _dur: number, _progress: unknown, cwd?: string) => {
    const files: Record<string, string> = {}
    if (cwd) {
      for (const f of readdirSync(cwd).sort()) {
        const p = join(cwd, f)
        // ASS / opacity command files, and the compositor's graph (graph.txt).
        if (statSync(p).isFile() && (/\.(ass|cmd)$/.test(f) || f === 'graph.txt')) files[f] = readFileSync(p, 'utf8')
      }
    }
    runs.push({ args, files })
  },
  // The pose overlay's encoder: counts the PNGs it is fed, then "exits".
  startFfmpeg: (_ffmpeg: string, args: string[]) => {
    const stdin = new PassThrough()
    let frames = 0
    stdin.on('data', () => frames++)
    const exited = new Promise<void>((resolve) => stdin.on('end', () => resolve()))
    void exited.then(() => encodes.push({ args, frames }))
    return { child: { stdin, kill: () => {} }, exited, stderrTail: () => '' }
  }
}))
vi.mock('./jobs', () => ({
  createJob: () => ({ id: 'job1', signal: undefined }),
  failJob: () => {},
  finishJob: () => {},
  setProgress: () => {}
}))
vi.mock('./atomicWrite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./atomicWrite')>()), // the session's single-flights are real
  assertWritableDir: async () => {},
  writeAtomically: async (final: string, write: (part: string) => Promise<void>) => write(`${final}.part.mp4`)
}))
vi.mock('./loudness', () => ({ ensureLoudness: async () => null }))
// Detected poses: one person walking right across 'vid' (1080×1920), 10 fps.
vi.mock('./poseDetect', () => ({
  getPose: async (mediaId: string) =>
    mediaId === 'vid'
      ? {
          version: 1,
          mediaId: 'vid',
          startSec: 0,
          durationSec: 10,
          fps: 10,
          frameCount: 100,
          width: 1080,
          height: 1920,
          model: 'test',
          tracks: [
            {
              id: 1,
              first: 0,
              weight: 1,
              frames: Array.from({ length: 100 }, (_, f) =>
                Array.from({ length: 26 }, (_, k) => [200 + f * 5 + k * 3, 600 + k * 40, 0.9]).flat()
              )
            }
          ]
        }
      : null
}))
vi.mock('./textImage', () => ({
  createTextRenderer: () => ({
    render: async (spec: unknown, out: string) => {
      rendered.push({ spec, out })
      writeFileSync(out, 'png')
    },
    layout: async (specs: { text: string; xCenter: number; yCenter: number; fontSizePx: number }[]) => {
      laidOut.push(specs)
      // One line per newline-separated run, centred where the block is.
      return specs.map((s) => {
        let start = 0
        return s.text.split('\n').map((line, i) => {
          const l = { start, end: start + line.length, cx: s.xCenter, baseline: s.yCenter + i * s.fontSizePx }
          start += line.length + 1
          return l
        })
      })
    },
    streamSvgs: async (
      count: number,
      svgAt: (i: number) => string,
      width: number,
      height: number,
      onPng: (png: Buffer, i: number) => Promise<void>
    ) => {
      // How many DIFFERENT pictures the frames are (the real rasteriser only
      // captures a change), and which frames draw anything.
      const svgs = Array.from({ length: count }, (_, i) => svgAt(i))
      const drawn = svgs.flatMap((svg, i) => (svg.includes('<path') ? [i] : []))
      streamed.push({ width, height, count, mid: svgs[Math.floor(count / 2)], distinct: new Set(svgs).size, drawn })
      for (let i = 0; i < count; i++) await onPng(Buffer.from(`png${i}`), i)
    },
    renderSvgs: async (svgs: string[], width: number, height: number, outPaths: string[]) => {
      svgRendered.push({ width, height, count: svgs.length, last: svgs[svgs.length - 1] })
      for (const out of outPaths) writeFileSync(out, 'png')
    },
    dispose: () => {}
  })
}))

// Media: a fixture map, with a real file for the image's display PNG.
const video = (v: Partial<VideoStreamInfo> = {}): VideoStreamInfo => ({
  codec: 'h264',
  width: 1080,
  height: 1920,
  displayWidth: 1080,
  displayHeight: 1920,
  rotationDeg: 0,
  avgFps: 30,
  rFps: 30,
  isVfr: false,
  pixFmt: 'yuv420p',
  colorTransfer: 'bt709',
  colorPrimaries: 'bt709',
  colorSpace: 'bt709',
  isHdr: false,
  ...v
})
const probe = (p: Partial<ProbeInfo>): ProbeInfo => ({
  durationSec: 10,
  container: 'mov,mp4',
  video: video(),
  audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
  ...p
})
const ASSETS: Record<string, { originalPath: string; fileName: string; probe: ProbeInfo }> = {
  vid: { originalPath: 'C:/media/vid.mp4', fileName: 'vid.mp4', probe: probe({}) },
  wide: {
    originalPath: 'C:/media/wide.mov',
    fileName: 'wide.mov',
    probe: probe({ video: video({ width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080 }) })
  },
  hdr: {
    originalPath: 'C:/media/hdr.mov',
    fileName: 'hdr.mov',
    probe: probe({
      video: video({
        codec: 'hevc',
        pixFmt: 'yuv420p10le',
        isHdr: true,
        colorTransfer: 'arib-std-b67',
        colorPrimaries: 'bt2020',
        colorSpace: 'bt2020nc'
      }),
      audio: { codec: 'aac', sampleRate: 48000, channels: 2, monoFoldChannel: 1 }
    })
  },
  alpha: {
    originalPath: 'C:/media/matte.webm',
    fileName: 'matte.webm',
    probe: probe({ container: 'matroska,webm', video: video({ codec: 'vp9', hasAlpha: true }), audio: null })
  },
  img: {
    originalPath: 'C:/media/photo.jpg',
    fileName: 'photo.jpg',
    probe: probe({
      durationSec: 0,
      container: 'image2',
      audio: null,
      video: video({ codec: 'mjpeg', width: 4000, height: 3000, displayWidth: 4000, displayHeight: 3000 })
    })
  },
  song: { originalPath: 'C:/media/song.m4a', fileName: 'song.m4a', probe: probe({ durationSec: 30, video: null }) }
}
const imagePng = join(scratch, 'img.png')
writeFileSync(imagePng, 'png')
vi.mock('./mediaStore', () => ({
  assertMediaUsable: async () => {},
  getAsset: async (id: string) => (ASSETS[id] ? ({ id, ...ASSETS[id] } as unknown as MediaAsset) : null),
  audioProxyIfReady: (id: string) => (id === 'song' ? 'C:/cache/song/audio.m4a' : null),
  ensureImagePath: async () => imagePng
}))

const { exportProject, renderFrames } = await import('./exporter')

// --- Fixtures -----------------------------------------------------------------

const text = (
  id: string,
  start: number,
  end: number,
  patch: Record<string, unknown> = {},
  layer: Partial<Layer> = {}
): Layer => {
  const l = makeTextLayer(id, start, end)
  return { ...l, ...layer, content: { ...l.content, ...patch } as Layer['content'] }
}
const audioClip = (id: string, mediaId: string, patch: Partial<AudioClip> = {}): AudioClip => ({
  id,
  mediaId,
  kind: 'music',
  startSec: 0,
  inSec: 0,
  outSec: 4,
  gainDb: -6,
  fadeInSec: 0.5,
  fadeOutSec: 1,
  duck: false,
  ...patch
})

/** Every layer kind and most options in one project. */
function everything(): Project {
  const p = createEmptyProject('p1', 'Everything')

  const v1 = makeVideoLayer('V1', 'vid', 0, 4)
  v1.rotationDeg = 12
  v1.stretchX = 1.2
  v1.keyframes = [
    { tSec: 0, x: 540, y: 960, scale: 1 },
    { tSec: 2, x: 600, y: 900, scale: 1.3, opacity: 0.5 }
  ]
  v1.content = {
    ...(v1.content as Extract<Layer['content'], { kind: 'video' }>),
    inSec: 1,
    outSec: 5,
    crop: { x: 0, y: 200, w: 1080, h: 1500 },
    flipH: true,
    color: { brightness: 0.1, contrast: 1.2, saturation: 0.9 },
    tint: { color: '#ffd999', amount: 0.5 },
    freezes: [{ atSec: 2, holdSec: 0.5 }],
    speed: 1.5,
    gainDb: -3
  }

  const v2 = makeVideoLayer('V2', 'hdr', 4, 3)
  v2.content = {
    ...(v2.content as Extract<Layer['content'], { kind: 'video' }>),
    stabilize: { shakiness: 6, smoothing: 20 }
  }

  const v3 = makeVideoLayer('V3', 'wide', 7, 3)
  v3.content = {
    ...(v3.content as Extract<Layer['content'], { kind: 'video' }>),
    speedRamp: [
      { atSec: 0, speed: 1 },
      { atSec: 1.5, speed: 2.5 },
      { atSec: 3, speed: 0.5 }
    ]
  }

  const img = makeImageLayer('I1', 'img', 1, 6)
  img.rotationDeg = -8
  img.keyframes = [
    { tSec: 0, x: 540, y: 700, scale: 0.5, opacity: 0 },
    { tSec: 1, x: 540, y: 700, scale: 0.5 }
  ]
  img.content = {
    kind: 'image',
    mediaId: 'img',
    opacity: 0.8,
    crop: { x: 0.1, y: 0, w: 0.8, h: 1 },
    rotateQuarters: 1,
    flipV: true
  }

  // A layout: one clip cell, one cell holding a nested composition.
  const lay = makeLayoutLayer('L1', 'split-lr', 2, 4)
  const layC = lay.content as Extract<Layer['content'], { kind: 'layout' }>
  const cellComp = createEmptyComposition()
  cellComp.layers = [makeVideoLayer('CV', 'alpha', 0, 3), text('CT', 0, 3, { text: 'In the cell' })]
  lay.content = {
    ...layC,
    cells: [
      { ...layC.cells[0], mediaId: 'wide', inSec: 1, outSec: 4, mute: false },
      { ...layC.cells[1], mediaId: null, comp: cellComp }
    ]
  }

  // A compound clip with its own audio.
  const inner = createEmptyComposition()
  inner.layers = [makeVideoLayer('IV', 'vid', 0, 2)]
  inner.audioClips = [audioClip('IA', 'song', { outSec: 2 })]
  const compound: Layer = {
    id: 'C1',
    hidden: false,
    startSec: 5,
    endSec: 7,
    x: 600,
    y: 900,
    scale: 0.8,
    content: { kind: 'compound', comp: inner }
  }

  const hidden = makeVideoLayer('H', 'vid', 0, 2)
  hidden.hidden = true

  p.layers = [
    v1,
    v2,
    v3,
    img,
    lay,
    compound,
    hidden,
    // Text: animated with sparkles and a straight-line move; a gradient; colour
    // emoji; a fixed wrap width; a rotated, scaled, stroked, pilled block; empty.
    text(
      'T1',
      0,
      3,
      {
        text: 'Swim faster\nthis season',
        animation: { in: 'typewriter', inSec: 0.8, out: 'fadeOut', outSec: 0.4 },
        effects: { sparkle: { density: 4, color: '#ffe08a' } }
      },
      {
        keyframes: [
          { tSec: 0, x: 540, y: 600, scale: 1 },
          { tSec: 2, x: 540, y: 400, scale: 1 }
        ]
      }
    ),
    text('T2', 1, 4, {
      text: 'Gradient',
      gradient: { from: '#ff0000', to: '#0000ff', angle: 90 },
      effects: { sparkle: { density: 6, color: '#ffffff' } }
    }),
    text('T3', 2, 5, { text: 'Race day 🏊‍♂️🔥' }),
    text('T4', 3, 6, { text: 'A long line that wraps at a fixed width', widthPx: 500 }),
    text(
      'T5',
      4,
      8,
      {
        text: 'Hook',
        pill: { enabled: true, color: '#000000cc', padPx: 18 },
        stroke: { color: '#ffffff', widthPx: 4 },
        shadow: { color: '#000000', blurPx: 8, offsetX: 2, offsetY: 3 }
      },
      { rotationDeg: 15, scale: 1.4 }
    ),
    text('T6', 0, 2, { text: '   ' })
  ]

  p.captions = {
    ...p.captions,
    enabled: true,
    segments: [
      { id: 'S1', startSec: 0, endSec: 2, text: 'first caption', words: [], enabled: true },
      {
        id: 'S2',
        startSec: 2,
        endSec: 4,
        text: 'gradient caption',
        words: [],
        enabled: true,
        style: { ...p.captions.style, gradient: { from: '#00ff00', to: '#ffff00', angle: 0 } }
      },
      { id: 'S3', startSec: 4, endSec: 6, text: 'off', words: [], enabled: false }
    ]
  }

  p.audioClips = [
    audioClip('A1', 'song', { startSec: 1, inSec: 2, outSec: 8, volumeLevelId: 'default' }),
    audioClip('A2', 'song', { startSec: 6, outSec: 0, mute: true }),
    audioClip('A3', 'hdr', { kind: 'extracted', startSec: 4, inSec: 0, outSec: 3, denoise: true, duck: true })
  ]
  p.denoiseDefault = true
  return p
}

/** Paths in a recorded run, made machine-independent. */
function normalise(value: unknown): unknown {
  const s = JSON.stringify(value)
    .split(JSON.stringify(scratch).slice(1, -1))
    .join('<scratch>')
    .split(scratch.replace(/\\/g, '/'))
    .join('<scratch>')
    // A stills render's temp folder is named by a fresh id.
    .replace(/frames-[0-9a-f-]{36}/g, 'frames-<id>')
  return JSON.parse(s)
}

beforeEach(() => {
  openSession(join(scratch, 'project')) // the export runs against an open project (media itself is stubbed)
  runs.length = 0
  rendered.length = 0
  laidOut.length = 0
  svgRendered.length = 0
  streamed.length = 0
  encodes.length = 0
})

afterAll(async () => {
  await fsp.rm(scratch, { recursive: true, force: true })
})

// --- Tests --------------------------------------------------------------------

describe('exporter orchestration', () => {
  it('exports a project using every layer kind', async () => {
    const out = join(scratch, 'out', 'everything.mp4')
    await exportProject(everything(), { preset: 'reel', preferNvenc: true }, out)
    expect(normalise({ runs, rendered, laidOut })).toMatchSnapshot()
  })

  it('exports in another format (square, software encode)', async () => {
    const out = join(scratch, 'out', 'square.mp4')
    await exportProject(everything(), { preset: 'square', preferNvenc: false }, out)
    expect(normalise({ runs, rendered, laidOut })).toMatchSnapshot()
  })

  it('renders stills through the same graph, skipping stabilization', async () => {
    const r = await renderFrames(everything(), 'reel', [0.5, 3.2, 99], join(scratch, 'frames'))
    expect(normalise({ result: r, runs, rendered, laidOut })).toMatchSnapshot()
  })

  it('exports a graphics layer: one overlay per mark, following the layer keyframes', async () => {
    const p = createEmptyProject('p3', 'Graphics')
    const g = makeGraphicsLayer('G', 1, 4)
    g.keyframes = [
      { tSec: 0, x: 540, y: 960, scale: 1 },
      { tSec: 2, x: 600, y: 900, scale: 1.5, opacity: 0.5 }
    ]
    const box = newMark('rect', 'R', { x: 300, y: 300 }, { x: 600, y: 500 }, 0.5)
    g.content = {
      kind: 'graphics',
      marks: [
        newMark('arrow', 'A', { x: 200, y: 1400 }, { x: 500, y: 1100 }, 0),
        { ...box, fill: '#ffd60a66', radiusPx: 20, reveal: 'fade' },
        { ...angleMark('N', { x: 540, y: 900 }, { x: 800, y: 900 }, { x: 540, y: 600 }, 1), reveal: 'draw' },
        // Appears after the layer ends: never on screen, so not exported.
        newMark('line', 'X', { x: 0, y: 0 }, { x: 100, y: 0 }, 5)
      ]
    }
    p.layers = [makeVideoLayer('V', 'vid', 0, 5), g]
    await exportProject(p, { preset: 'reel', preferNvenc: true }, join(scratch, 'out', 'graphics.mp4'))
    const last = runs[runs.length - 1]
    const args = `${last.args.join(' ')} ${last.files['graph.txt']}`
    // Arrow and rectangle are one PNG each; the angle's draw-on is 13 frames.
    expect(svgRendered.map((r) => (r as { count: number }).count)).toEqual([1, 1, 13])
    expect(args).toMatch(/-framerate 30 -i \S+graphics_2_%03d\.png/)
    expect(args).toContain('fade=t=in:st=1.500:d=0.400:alpha=1')
    expect(normalise({ runs, svgRendered })).toMatchSnapshot()
  })

  it('exports a pose overlay: one frame per output frame, composited with the clip’s box', async () => {
    const p = createEmptyProject('p4', 'Pose')
    const v = makeVideoLayer('V', 'vid', 0, 4)
    v.x = 600
    v.scale = 0.8
    v.content = {
      ...(v.content as Extract<Layer['content'], { kind: 'video' }>),
      inSec: 2,
      outSec: 6,
      pose: { show: true, people: [{ tracks: [1], color: '#ff00ff' }], angles: ['leftKnee'], widthPx: 6 }
    }
    p.layers = [v]
    await exportProject(p, { preset: 'reel', preferNvenc: true }, join(scratch, 'out', 'pose.mp4'))
    // 4s at 30 fps = 120 frames, rendered at the clip box (0.8 × 1080×1920) …
    expect(streamed).toHaveLength(1)
    expect(streamed[0]).toMatchObject({ width: 864, height: 1536, count: 120 })
    // … from the clip's SOURCE time (frame 60 = 2s in = source 4s = pose frame 40).
    expect(streamed[0].mid).toContain('stroke="#ff00ff"')
    expect(streamed[0].mid).toMatch(/viewBox="0 0 1080 1920"/)
    // … and every frame reached the qtrle encoder.
    expect(encodes).toHaveLength(1)
    expect(encodes[0].frames).toBe(120)
    expect(encodes[0].args.join(' ')).toMatch(/-c:v qtrle -pix_fmt argb \S+overlay_\d+\.mov$/)
    // The overlay is the clip's second input, with the clip's own placement.
    const last = runs[runs.length - 1]
    const graph = last.files['graph.txt']
    expect(last.args.join(' ')).toMatch(/-i C:\/media\/vid\.mp4 -ss 0\.000 -t 4\.000 -i \S+overlay_\d+\.mov/)
    expect(graph).toContain(
      '[2:v]scale=864:1536:flags=bicubic,setsar=1,format=yuva420p,setpts=PTS-STARTPTS+0.000/TB[pv2]'
    )
    const at = (i: number): string | undefined => graph.match(new RegExp(`\\[pv${i}\\]overlay=([^:]+:[^:]+):`))?.[1]
    expect(at(2)).toBeDefined()
    expect(at(2)).toBe(at(1))
    expect(normalise({ runs, streamed, encodes })).toMatchSnapshot()
  })

  it('a still of a pose clip draws only the frames it shows', async () => {
    const p = createEmptyProject('p5', 'Pose still')
    const v = makeVideoLayer('V', 'vid', 0, 4)
    v.content = {
      ...(v.content as Extract<Layer['content'], { kind: 'video' }>),
      pose: { show: true, people: [{ tracks: [1], color: '#ff00ff' }], angles: [], widthPx: 6 }
    }
    p.layers = [v]
    await renderFrames(p, 'reel', [2], join(scratch, 'pose-frames'))
    // Still one frame per output frame (so the overlay lines up in time) …
    expect(streamed[0].count).toBe(120)
    // … but only the ones around 2s are drawn; the rest are one cached blank.
    expect(streamed[0].drawn).toEqual([59, 60, 61])
    expect(streamed[0].distinct).toBe(4)
  })

  it('a graphics mark whose moment is before its tile’s start shows from the start, mid-reveal', async () => {
    const p = createEmptyProject('p6', 'Trimmed marks')
    const g = makeGraphicsLayer('G', 2, 5)
    const line = (id: string, atSec: number, reveal: 'pop' | 'fade' | 'draw') => ({
      ...newMark('line', id, { x: 100, y: 500 }, { x: 900, y: 500 }, atSec),
      reveal
    })
    g.content = {
      kind: 'graphics',
      marks: [line('D', -0.2, 'draw'), line('F', -0.1, 'fade'), line('P', -3, 'draw')]
    }
    p.layers = [makeVideoLayer('V', 'vid', 0, 5), g]
    await exportProject(p, { preset: 'reel', preferNvenc: true }, join(scratch, 'out', 'trimmed.mp4'))
    // The draw-on cut half-way renders only its remaining 6 frames + the finished
    // mark; one whose reveal is long over is a plain still.
    expect(svgRendered.map((r) => (r as { count: number }).count)).toEqual([7, 1, 1])
    const last = runs[runs.length - 1]
    const graph = last.files['graph.txt']
    // All three show from the tile's start; the fade began 0.1s before it.
    expect(graph.match(/enable='between\(t,2\.000,5\.000\)'/g)?.length).toBeGreaterThanOrEqual(3)
    expect(graph).toContain('fade=t=in:st=1.900:d=0.400:alpha=1')
    expect(graph).toContain('tpad=stop_mode=clone:stop_duration=2.767,setpts=PTS-STARTPTS+2.000/TB')
  })

  it('refuses a timeline with no picture', async () => {
    const p = createEmptyProject('p2', 'Text only')
    p.layers = [text('T', 0, 2, { text: 'Only text' })]
    await expect(
      exportProject(p, { preset: 'reel', preferNvenc: true }, join(scratch, 'out', 'x.mp4'))
    ).rejects.toThrow(/no video or image layer/)
  })
})
