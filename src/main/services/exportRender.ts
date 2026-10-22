/**
 * ONE composition render — the single implementation used for the root project
 * export AND (recursively, with `alpha`) for every nested comp intermediate.
 * Nested comps are pre-rendered to transparent VP9/WebM and fed back in as
 * ordinary video inputs (see FFMPEG-NOTES "Nested-composition intermediates"),
 * so the compositor itself never needs to know about nesting.
 *
 * A `CompositionRender` is one pass: it walks the layer stack back→front,
 * turning each visible layer into compositor steps (`exportLayer`, one exporter
 * per layer kind in exportLayers.ts / exportText.ts), adds the audio clips and
 * captions, lays out every burned text block in one Chromium pass, then runs
 * the encode. It owns the pass's working state — its temp dir, the visual and
 * audio lists, the text blocks waiting for layout, the numbering of the files
 * it writes, and the lazily created text renderer, which it frees on every way
 * out.
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Composition, Layer, Stabilize, VolumeLevel } from '@shared/project'
import type { FfmpegCapabilities } from '@shared/ffmpeg'
import type { ExportOptions } from '@shared/ipc'
import type { LoudnessSeries } from '@shared/loudness'
import { compositionDuration, MAX_COMP_DEPTH } from '@shared/compositions'
import { presetFor } from '@shared/formats'
import { frameToOutput, opacityKeyframePoints, stretchedBox, type FrameRect } from '@shared/layers'
import { seriesNeeded } from '@shared/volumeLevels'
import { getBundledFontsDir } from '../config'
import { audioProxyIfReady, getAsset } from './mediaStore'
import { ensureLoudness } from './loudness'
import type { ProjectSession } from './projectSession'
import { setProgress } from './jobs'
import { runFfmpeg } from './ffmpegRun'
import { buildOpacityCmdLines } from './ffmpegFilters'
import {
  buildExportArgs,
  buildFrameArgs,
  buildVidstabDetectArgs,
  buildVidstabTransformArgs,
  exportAudioClips,
  frameIndexAt,
  FILTER_GRAPH_FILE,
  withFilterGraphFile,
  type AudioClipSource,
  type ExportAudio,
  type ExportImage,
  type ExportKeyframe,
  type ExportPlan,
  type ExportVisual,
  type OpacityAnim,
  type StabilizeJob,
  type Target
} from './exporterArgs'
import { buildAss, type AssOverlay } from './assBuilder'
import { createTextRenderer, type TextImageSpec, type TextRenderer } from './textImage'
import type { LaidOutLine } from './textLayout'
import { exportLayer } from './exportLayers'
import { addCaptions, fullFrameImage } from './exportText'
import { createLogger } from '@shared/log'

const log = createLogger('export')

/** Canonical logical → output px for one render (`frameToOutput`). */
export type OutputMap = ReturnType<typeof frameToOutput>

/**
 * Everything a composition render needs that is NOT part of the composition
 * itself: the output target, the binaries, and the ROOT-level settings nested
 * clips still resolve against (a clip inside a comp inherits the project's
 * denoise/stabilize defaults, which only exist on the root document).
 */
export interface RenderCtx {
  /** The project the export started in: a switch mid-export doesn't move it. */
  session: ProjectSession
  target: Target
  caps: FfmpegCapabilities
  ffmpeg: string
  jobId: string
  opts: ExportOptions
  denoiseDefault: boolean
  stabilizeDefault: Stabilize | null
  /** The project's volume levels (root-only; nested clips join the same list). */
  volumeLevels: VolumeLevel[]
  /** Root temp dir; each composition render gets a numbered subdir under it. */
  tmpRoot: string
  /** Pre-rendered comp intermediates, keyed by content hash — an identical comp
   *  (e.g. the same clip in two cells) is rendered once per export. */
  cache: Map<string, string>
  /** Monotonic counter for unique per-render temp subdirs. */
  n: { v: number }
  /** The export job's cancel signal: kills every ffmpeg run of the render and
   *  stops it between steps (Chromium layout, nested pre-renders). */
  signal?: AbortSignal
  /** Stills render (`renderFrames`): skips the stabilization pre-pass and
   *  records here whether a clip wanted it. */
  stills?: { skippedStabilize: boolean }
}

/** A stills request: the timeline second asked for, the JPEG to write, and —
 *  filled in by the render — the second the frame actually shows (later times
 *  clamp to the last frame). */
export interface FrameRequest {
  timeSec: number
  path: string
  shownSec?: number
}

export type RenderOpts = { alpha: boolean; depth: number; frames?: FrameRequest[] }

/** A nested composition rendered to a transparent intermediate. */
export interface Prerendered {
  path: string
  /** Its duration (the comp's own length). */
  len: number
  /** Whether it carries an audio stream (its clips + unmuted layer audio). */
  hasAudio: boolean
}

/** A text block that burns through libass: laid out by Chromium with every
 *  other block of the pass, then written into `file`. */
interface BurnedBlock {
  spec: TextImageSpec
  overlay: AssOverlay
  file: string
}

/** Render `comp` to `output`. */
export async function renderComposition(
  comp: Composition,
  ctx: RenderCtx,
  output: string,
  o: RenderOpts
): Promise<string> {
  const pass = new CompositionRender(comp, ctx, o)
  // The text renderer is a hidden Chromium window, created on first use. Free it
  // on EVERY way out — a throw half-way (a clip with no source) would otherwise
  // leak one window per failed export or render_frame. Disposing twice is safe.
  try {
    return await pass.run(output)
  } finally {
    pass.disposeRenderer()
  }
}

export class CompositionRender {
  /** The project's output frame: a window centred on the canonical 1080×1920
   *  space (shared/frame.ts). Nested comps render through the same frame, so an
   *  intermediate is frame-shaped too. */
  readonly frame: FrameRect
  /** Canonical logical → output px: positions shift by the frame origin and
   *  every length scales by ONE uniform factor `s` (1 for every built-in format
   *  — the output is the frame, px for px). */
  readonly m: OutputMap
  readonly s: number
  /** Composite steps, back → front. */
  readonly visuals: ExportVisual[] = []
  readonly audio: ExportAudio[] = []
  /** Caption blocks rasterised to PNGs (gradient, colour emoji), composited
   *  above everything. */
  readonly captionOverlays: ExportImage[] = []
  /** The captions' ASS file, once any caption burns through libass. */
  captionsAss: string | undefined
  /** This pass's working dir (set by `run`). */
  private tmpDir = ''
  /** Text blocks — text layers and captions alike — that burn through libass.
   *  Chromium lays them ALL out in one pass after the walk (so each line burns
   *  where the preview put it), then their ASS files are written. */
  private readonly burned: BurnedBlock[] = []
  /** The export's Chromium (created lazily; disposed before encoding): it lays
   *  out every burned block, and rasterises the ones libass can't draw
   *  (gradients, colour emoji, fixed wrap widths) to PNGs. */
  private renderer: TextRenderer | null = null
  readonly fontsDir = getBundledFontsDir()
  /** Numbering of the files this pass writes into its temp dir. */
  private readonly seq = { text: 0, image: 0, stab: 0, opacity: 0 }

  constructor(
    readonly comp: Composition,
    readonly ctx: RenderCtx,
    readonly o: RenderOpts
  ) {
    this.frame = presetFor(ctx.opts.preset).frame
    this.m = frameToOutput(this.frame, ctx.target.width)
    this.s = this.m.s
  }

  get target(): Target {
    return this.ctx.target
  }

  get tmp(): string {
    return this.tmpDir
  }

  async run(output: string): Promise<string> {
    const { ctx, o, comp } = this
    ctx.signal?.throwIfAborted()
    this.tmpDir = join(ctx.tmpRoot, `r${ctx.n.v++}`)
    await fsp.mkdir(this.tmpDir, { recursive: true })

    for (const l of comp.layers) {
      if (!l.hidden) await exportLayer(this, l)
    }
    if (!this.visuals.some((v) => v.kind !== 'text')) {
      throw new Error('Timeline has no video or image layer — add one first.')
    }
    await this.addAudioClips()
    await addCaptions(this)
    await this.writeBurnedText()

    const visEnd = comp.layers.reduce((m, l) => (l.hidden ? m : Math.max(m, l.endSec)), 0)
    const audioEnd = this.audio.reduce((m, a) => Math.max(m, a.startSec + Math.max(0.01, a.outSec - a.inSec)), 0)
    const totalDur = Math.max(visEnd, audioEnd, 0.1)

    // The off-screen renderer has written all its PNGs to disk by now; free it
    // before the (long) encode.
    this.disposeRenderer()

    await fsp.mkdir(dirname(output), { recursive: true })
    const plan: ExportPlan = {
      target: ctx.target,
      totalDur,
      visuals: this.visuals,
      audio: this.audio,
      captionsAss: this.captionsAss,
      topOverlays: this.captionOverlays,
      fontsDir: this.fontsDir ?? undefined,
      caps: ctx.caps,
      preferNvenc: ctx.opts.preferNvenc,
      alpha: o.alpha
    }
    let args: string[]
    if (o.frames) {
      const frames = o.frames.map((f) => ({ index: frameIndexAt(f.timeSec, totalDur), path: f.path }))
      o.frames.forEach((f, k) => (f.shownSec = frames[k].index / 30))
      args = buildFrameArgs(plan, frames)
    } else args = buildExportArgs(plan, output)
    // Only the top-level export drives the job bar; nested pre-renders would
    // rewind it (weighting them across N+1 passes is a Stage 5 item). Stills have no job.
    const progress = o.depth === 1 && !o.frames ? (pr: number): void => setProgress(ctx.jobId, pr) : undefined
    ctx.signal?.throwIfAborted()
    // The graph goes in a file next to the ASS / command files (cwd = tmpDir):
    // a long one would overflow the Windows command line.
    const scripted = withFilterGraphFile(args)
    if (scripted.graph !== null) await fsp.writeFile(join(this.tmpDir, FILTER_GRAPH_FILE), scripted.graph, 'utf8')
    await runFfmpeg(ctx.ffmpeg, scripted.args, totalDur, progress, this.tmpDir, ctx.signal)
    return output
  }

  disposeRenderer(): void {
    this.renderer?.dispose()
    this.renderer = null
  }

  /** Name for the next ASS file this pass writes (`text_N.ass`). */
  nextTextFile(): string {
    return `text_${this.seq.text++}.ass`
  }

  /** Queue a text block to burn through libass into `file` (written once the
   *  whole pass has been laid out). */
  burn(spec: TextImageSpec, overlay: AssOverlay, file: string): void {
    this.burned.push({ spec, overlay, file })
  }

  /** Write `overlays` to `file` in this pass's temp dir as ASS. */
  async writeAss(file: string, overlays: AssOverlay[]): Promise<void> {
    await fsp.writeFile(join(this.tmpDir, file), buildAss(overlays, this.ctx.target, this.s), 'utf8')
  }

  private textRenderer(): TextRenderer {
    this.renderer ??= createTextRenderer(this.ctx.target.width, this.ctx.target.height, this.tmpDir, this.fontsDir)
    return this.renderer
  }

  /** Rasterise one text/caption spec (already scaled to output px) to a PNG and
   *  wrap it as a full-frame overlay. Used for gradient fills, colour emoji and
   *  text with an explicit wrap width — cases libass can't render — matching
   *  the preview CSS. */
  async renderTextImage(spec: TextImageSpec, startSec: number, endSec: number): Promise<ExportImage> {
    const pngPath = join(this.tmpDir, `grad_${this.seq.image++}.png`)
    await this.textRenderer().render(spec, pngPath)
    return fullFrameImage(pngPath, startSec, endSec, this.ctx.target)
  }

  /** Rasterise SVGs (graphics marks, or the frames of one draw-on) at
   *  `width`×`height` px to `graphics_N…png` files in this pass's temp dir;
   *  returns their paths (`pattern` names them for an image2 sequence input). */
  async renderSvgImages(svgs: string[], width: number, height: number): Promise<{ paths: string[]; pattern: string }> {
    const n = this.seq.image++
    const name = (i: number): string => `graphics_${n}_${String(i).padStart(3, '0')}.png`
    const paths = svgs.map((_, i) => join(this.tmpDir, name(i)))
    await this.textRenderer().renderSvgs(svgs, width, height, paths)
    return { paths, pattern: join(this.tmpDir, `graphics_${n}_%03d.png`) }
  }

  /**
   * Pre-render a nested composition to a transparent intermediate for the
   * caller to position. Cached by comp content, so the same comp used twice
   * renders once. Null past the depth cap or for an empty comp (nothing to
   * composite).
   */
  async prerender(nested: Composition): Promise<Prerendered | null> {
    const { ctx, o } = this
    if (o.depth >= MAX_COMP_DEPTH) return null
    // Whole-source audio clips (`outSec <= 0`) end at their source duration,
    // which only the media store knows — resolve just those before measuring.
    const durs = new Map<string, number>()
    for (const a of nested.audioClips) {
      if (a.outSec <= 0 && !durs.has(a.mediaId)) {
        durs.set(a.mediaId, (await getAsset(a.mediaId, this.ctx.session))?.probe.durationSec ?? 0)
      }
    }
    const len = compositionDuration(nested, (id) => durs.get(id) ?? 0)
    if (len <= 0.01) return null
    const key = createHash('sha1')
      .update(JSON.stringify(nested))
      // A nested clip's gain depends on the project's levels too.
      .update(JSON.stringify(ctx.volumeLevels))
      .update(`|${ctx.target.width}x${ctx.target.height}`)
      .digest('hex')
    let file = ctx.cache.get(key)
    if (!file) {
      file = join(ctx.tmpRoot, `comp_${key.slice(0, 12)}.webm`)
      await renderComposition(nested, ctx, file, { alpha: true, depth: o.depth + 1 })
      ctx.cache.set(key, file)
    }
    // The intermediate carries the comp's own audio (its clips + unmuted layer
    // audio, mixed by the nested render) whenever the comp had any.
    const hasAudio = nested.audioClips.length > 0 || nested.layers.some((l) => hasOwnAudio(l))
    return { path: file, len, hasAudio }
  }

  /** A layer's position/scale keyframes, resolved for the compositor: display
   *  box per keyframe (same stretchedBox math as the static path) in output px,
   *  at absolute output times. */
  keyframes(l: Layer, aspect: number): ExportKeyframe[] {
    return (l.keyframes ?? []).map((k) => {
      const b = stretchedBox(aspect, k.scale, l.stretchX ?? 1, l.stretchY ?? 1)
      return { t: l.startSec + k.tSec, w: b.w * this.s, h: b.h * this.s, cx: this.m.x(k.x), cy: this.m.y(k.y) }
    })
  }

  /**
   * Keyframed OPACITY: a per-visual sendcmd file drives `colorchannelmixer aa`
   * per frame (verified — FFMPEG-NOTES "Keyframed opacity"). `base` folds an
   * image layer's static opacity into the animated values; a single point
   * needs no command file (the initial `aa=` covers a constant).
   */
  async opacityAnim(l: Layer, base = 1): Promise<OpacityAnim | undefined> {
    const pts = opacityKeyframePoints(l)
    if (!pts) return undefined
    const n = this.seq.opacity++
    const scaled = base !== 1 ? pts.map((p) => ({ t: p.t, o: p.o * base })) : pts
    const oid = `op${n}`
    const lines = buildOpacityCmdLines(oid, scaled)
    let cmdFile: string | null = null
    if (lines) {
      cmdFile = `opacity_${n}.cmd`
      await fsp.writeFile(join(this.tmpDir, cmdFile), lines, 'utf8')
    }
    return { cmdFile, id: oid, initial: scaled[0].o }
  }

  /**
   * Motion stabilization runs as a per-clip two-pass (vidstab) BEFORE
   * compositing, baking in the trim so the composite reads the stabilized
   * intermediate from 0. The HDR tonemap is folded into the transform pass (so
   * the intermediate is already SDR). Pre-pass ffmpegs don't drive the job
   * progress bar — it stays at 0 until the main encode; a long analysis is a
   * silent wait (acceptable for v1).
   */
  async stabilize(srcPath: string, inSec: number, len: number, hdrChain: string, stab: Stabilize): Promise<string> {
    const n = this.seq.stab++
    const job: StabilizeJob = {
      input: srcPath,
      inSec,
      len,
      shakiness: stab.shakiness,
      smoothing: stab.smoothing,
      hdrChain,
      trfFile: `stab_${n}.trf`,
      outFile: `stab_${n}.mp4`
    }
    const { ffmpeg, signal } = this.ctx
    await runFfmpeg(ffmpeg, buildVidstabDetectArgs(job), 0, undefined, this.tmpDir, signal)
    await runFfmpeg(ffmpeg, buildVidstabTransformArgs(job), 0, undefined, this.tmpDir, signal)
    return join(this.tmpDir, job.outFile)
  }

  /**
   * Audio clips (music / voiceover / extracted), trimmed + placed by the graph.
   * Gains resolve through `clipGain` (volume levels — the preview's own call);
   * only clips in a level need a loudness series, so a project without levels
   * measures nothing and exports exactly as before. Muted clips are looked up
   * too (an effect track may follow one) but `exportAudioClips` drops them.
   */
  private async addAudioClips(): Promise<void> {
    const { comp, ctx } = this
    const sources = new Map<string, AudioClipSource | null>()
    const series = new Map<string, LoudnessSeries | null>()
    for (const a of comp.audioClips) {
      if (!sources.has(a.mediaId)) {
        const asset = await getAsset(a.mediaId, ctx.session)
        sources.set(
          a.mediaId,
          asset
            ? {
                path: audioProxyIfReady(a.mediaId, ctx.session) ?? asset.originalPath,
                durationSec: asset.probe.durationSec,
                foldChannel: asset.probe.audio?.monoFoldChannel ?? null
              }
            : null
        )
      }
      const need = seriesNeeded(a, comp.audioClips, ctx.volumeLevels)
      if (need && !series.has(need)) series.set(need, await ensureLoudness(need, ctx.session))
    }
    this.audio.push(
      ...exportAudioClips(
        comp.audioClips,
        (id) => sources.get(id) ?? null,
        { levels: ctx.volumeLevels, seriesOf: (id) => series.get(id) ?? null },
        ctx.denoiseDefault
      )
    )
  }

  /** Lay every burned block out in ONE Chromium pass, with the preview's CSS,
   *  then write the ASS files. If the layout pass fails the blocks still burn
   *  (newline-only lines, no auto-wrap — `fallbackLines`), at the right size. */
  private async writeBurnedText(): Promise<void> {
    if (this.burned.length === 0) return
    let laid: LaidOutLine[][] | null = null
    try {
      laid = await this.textRenderer().layout(this.burned.map((b) => b.spec))
    } catch (error) {
      log.warn('text layout pass failed; burning newline-only lines', error)
      laid = null
    }
    const byFile = new Map<string, AssOverlay[]>()
    this.burned.forEach((b, i) => {
      const overlay = laid ? { ...b.overlay, lines: laid[i] } : b.overlay
      byFile.set(b.file, [...(byFile.get(b.file) ?? []), overlay])
    })
    for (const [file, overlays] of byFile) await this.writeAss(file, overlays)
  }
}

/** Whether a layer contributes its own audio to a composition's mix (used to
 *  decide if a pre-rendered intermediate has an audio stream to map). */
function hasOwnAudio(l: Layer): boolean {
  if (l.content.kind === 'video') return !l.content.mute
  if (l.content.kind === 'layout') return l.content.cells.some((cell) => !cell.mute && !!cell.mediaId)
  if (l.content.kind === 'compound') return true // resolved by its own render
  return false
}
