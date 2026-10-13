/**
 * PURE ffmpeg arg builder for the single-pass LAYER COMPOSITOR export.
 *
 * Unlike the old sequence-based exporter (normalize each clip → concat), the new
 * model composites the unified layer stack in one filter_complex: a black base
 * canvas the length of the project, then every visual layer overlaid in z-order —
 * videos and images scaled to their display box, positioned at their center, and
 * time-gated to their window; text layers burned via per-layer ASS so the full
 * back-to-front order (including text under video) is honored. Audio mixes all
 * audio clips + any unmuted video-layer audio. Geometry arrives already resolved
 * to OUTPUT pixels so this stays a pure string-assembler (unit-tested).
 */

import type { FfmpegCapabilities } from '@shared/ffmpeg'
import { presetFor } from '@shared/formats'
import { buildAudioGraph, type AudioGraphItem } from './audio'
import { cropFilter, f3, piecewiseLinearExpr, r, rotateFilter, speedRampPlayedExpr } from './ffmpegFilters'
import { normalizeDeg, rotatedBounds } from '@shared/rotation'
import type { AudioClip } from '@shared/project'
import { effectiveDenoise, effectiveOut } from '@shared/project'
import { clipGain, type GainContext } from '@shared/volumeLevels'

/**
 * Per-frame opacity animation for a visual: `sendcmd` (reading `cmdFile`,
 * written by the exporter from `buildOpacityCmdLines`) drives
 * `colorchannelmixer@<id> aa`, which MULTIPLIES the stream's existing alpha.
 * `cmdFile` is null for a constant non-1 opacity (the initial `aa=` suffices).
 */
export interface OpacityAnim {
  cmdFile: string | null
  id: string
  initial: number
}

/**
 * A layer keyframe resolved to OUTPUT pixels and ABSOLUTE output time: the
 * display box size and its center. Baked into per-frame `t` expressions
 * (`scale=…:eval=frame` after the setpts shift + `overlay` x/y with
 * `overlay_w/2` centering — all verified, see FFMPEG-NOTES "Keyframes").
 */
export interface ExportKeyframe {
  t: number
  w: number
  h: number
  cx: number
  cy: number
}

/**
 * A rotated keyframed layer is turned ONCE at a fixed size and then scaled per
 * frame: `rotate` sizes its output at configure time, so it can't follow a
 * per-frame resize. The pre-rotate size is the largest keyframe box (keyframes
 * scale uniformly, so every box shares one aspect — rotating at the biggest
 * keeps full detail), and the per-frame targets become each keyframe's ROTATED
 * bounds, which interpolate exactly like the boxes they bound. Verified — see
 * FFMPEG-NOTES "Layer rotation".
 */
const maxKfBox = (kfs: ExportKeyframe[]): { w: number; h: number } =>
  kfs.reduce((m, k) => (k.w * k.h > m.w * m.h ? { w: k.w, h: k.h } : m), { w: 0, h: 0 })
const rotatedKfs = (kfs: ExportKeyframe[], deg: number): ExportKeyframe[] =>
  kfs.map((k) => ({ ...k, ...rotatedBounds(k.w, k.h, deg) }))
/** A layer's rotation as the chains use it: normalised, 0 = none. */
const layerRot = (deg: number | undefined): number => (deg ? normalizeDeg(deg) : 0)
/** Centre-anchored static overlay position for a rotated layer (its output is
 *  the rotated bounds, so the top-left moves with the angle). */
const centredPos = (x: number, y: number, boxW: number, boxH: number): string =>
  `x='${f3(x + boxW / 2)}-overlay_w/2':y='${f3(y + boxH / 2)}-overlay_h/2'`

/** Even-rounded (yuv420-safe) per-frame dimension expression. */
const kfDimExpr = (kfs: ExportKeyframe[], dim: 'w' | 'h'): string =>
  `trunc((${piecewiseLinearExpr(kfs.map((k) => ({ t: k.t, v: k[dim] })))})/2)*2`

/**
 * A freeze hold's `gte(T-STARTT,…)` threshold, nudged clear of the very first
 * frame.
 *
 * A hold is a PTS gap: the threshold pushes every frame at/after it forward by
 * `holdSec`, and the overlay's framesync repeats the last frame BEFORE the gap
 * across it. A threshold of 0 catches frame 0 as well, so the whole stream
 * moves and there is no earlier frame left to repeat — the layer renders BLACK
 * for the length of the hold (`addFreeze` clamps `atSec` to `inSec`, so
 * "freeze the first frame" lands exactly here). Nudging past frame 0 — whose
 * `T-STARTT` is exactly 0 — makes frame 0 itself the held frame, which is also
 * what the preview's `videoSourceTime` clamps to. 1 ms clears the first frame
 * interval of any plausible source rate (up to 1000 fps) and is below `f3`'s
 * rounding, so mid-clip thresholds are untouched. Verified — see FFMPEG-NOTES
 * "Freeze holds & overlay EOF".
 */
const FIRST_FRAME_EPS = 0.001
const freezeAt = (atLocal: number): number => Math.max(FIRST_FRAME_EPS, atLocal)

/** Center-anchored per-frame overlay position expressions. */
const kfPosExprs = (kfs: ExportKeyframe[]): { x: string; y: string } => ({
  x: `(${piecewiseLinearExpr(kfs.map((k) => ({ t: k.t, v: k.cx })))})-overlay_w/2`,
  y: `(${piecewiseLinearExpr(kfs.map((k) => ({ t: k.t, v: k.cy })))})-overlay_h/2`
})

export interface Target {
  width: number
  height: number
}

/** Output size for a preset id (an unknown id falls back like `presetFor`). */
export function targetForPreset(preset: string): Target {
  const p = presetFor(preset)
  return { width: p.width, height: p.height }
}

/** A video layer resolved for compositing (geometry in output px). */
export interface ExportVideo {
  path: string
  /** Input seek + read duration (source seconds). */
  inSec: number
  len: number
  /** Precomputed HDR→SDR tonemap chain, or '' (none). */
  hdrChain: string
  /** Background-removed clip: keep the alpha channel (format=yuva420p) so the
   *  overlay blends the subject over lower layers instead of a black box. */
  hasAlpha?: boolean
  /** Decoder to force for this input (`-c:v <name>` before its `-i`), or null.
   *  VP8/VP9 alpha is a side-band the native decoders silently drop — see
   *  `alphaInputDecoder` (shared/media). Without it, `hasAlpha` composites an
   *  opaque rectangle. */
  inputDecoder?: string | null
  /** Source-pixel crop, or null. */
  crop: { x: number; y: number; w: number; h: number } | null
  /** Mirror the (cropped) picture. */
  flipH?: boolean
  flipV?: boolean
  /** Layer rotation, clockwise degrees about the box centre (absent/0 = none).
   *  Forces an alpha pipeline so the rotated corners are transparent. */
  rotationDeg?: number
  /** Precomputed eq filter (color correction), or '' (neutral). */
  colorEq: string
  /** Display box in output px. */
  boxW: number
  boxH: number
  /** Overlay top-left in output px. */
  x: number
  y: number
  /** Timeline window (seconds). */
  startSec: number
  endSec: number
  /** Freeze holds, in trimmed-stream time (atLocal = source atSec − inSec). */
  freezes: { atLocal: number; holdSec: number }[]
  /** Constant playback speed (1 = normal). PTS scale by 1/speed; freeze holds
   *  stay wall-clock; the cfr output resamples the frame rate. */
  speed?: number
  /** Speed-ramp profile as boundary points in trimmed-input time (u = source
   *  seconds since the in-point, spanning [0, len]; ≥ 2 points). When present
   *  it overrides `speed`: PTS follow the piecewise log-integral of 1/speed
   *  (`speedRampPlayedExpr`). The layer's own audio is dropped by the planner
   *  while ramped. */
  ramp?: { u: number; v: number }[]
  /** Position/scale keyframes (empty/absent = the static box above). */
  keyframes?: ExportKeyframe[]
  /** Keyframed opacity (absent = fully opaque). Forces an rgba pipeline. */
  opacity?: OpacityAnim
}

/** An image layer resolved for compositing (geometry in output px). */
export interface ExportImage {
  path: string
  boxW: number
  boxH: number
  x: number
  y: number
  startSec: number
  endSec: number
  /** 0..1 */
  opacity: number
  /** Optional crop in 0..1 source fractions (applied before rotation/scale). */
  crop?: { x: number; y: number; w: number; h: number } | null
  /** 90° clockwise rotation steps (0..3). */
  rotateQuarters?: number
  flipH?: boolean
  flipV?: boolean
  /** Free layer rotation, clockwise degrees about the box centre, applied
   *  AFTER the box is sized (absent/0 = none). */
  rotationDeg?: number
  /** Position/scale keyframes (empty/absent = static). A keyframed image input
   *  becomes `-loop 1` + `fps=30` so it is a real frame stream `t` can drive. */
  keyframes?: ExportKeyframe[]
  /** Keyframed opacity (absent = the static `opacity` above). The exporter has
   *  already multiplied the static base opacity into these values. Also forces
   *  the `-loop 1` + `fps=30` frame stream (commands fire per frame). */
  opacityAnim?: OpacityAnim
}

/** A visual layer, in back→front order. Text is burned via its own ASS file. */
export type ExportVisual =
  | { kind: 'video'; video: ExportVideo }
  | { kind: 'image'; image: ExportImage }
  | { kind: 'text'; assFile: string }

/** An audio source to mix (a video layer's audio, or an audio clip). */
export interface ExportAudio {
  path: string
  inSec: number
  outSec: number
  startSec: number
  gainDb: number
  fadeInSec: number
  fadeOutSec: number
  duck: boolean
  denoise?: boolean
  /** Mirror this stereo channel to both sides (one-sided source), or null. See
   *  `AudioStreamInfo.monoFoldChannel`. */
  foldChannel?: number | null
  /** Pitch-preserving tempo (a re-timed video layer's own audio; 1 = normal). */
  tempo?: number
}

/** What the export reads for one audio clip's media. */
export interface AudioClipSource {
  /** File to mix from (an audio asset's proxy when ready, else the original). */
  path: string
  durationSec: number
  /** Mono-fold channel (`AudioStreamInfo.monoFoldChannel`), or null. */
  foldChannel: number | null
}

/**
 * A composition's audio clips as mix sources. Each clip's gain resolves
 * through `clipGain` (shared/volumeLevels.ts) — THE call the preview makes
 * too, so a clip in a volume level exports at exactly the gain it previews
 * at; a clip in no level keeps its own `gainDb`, byte-for-byte as before
 * levels existed. A muted clip is dropped before it ever becomes an input
 * (`volume=0` would still decode the whole source to add silence to amix),
 * and so is one whose media is unknown.
 */
export function exportAudioClips(
  clips: AudioClip[],
  sourceOf: (mediaId: string) => AudioClipSource | null,
  gain: Omit<GainContext, 'durationOf'>,
  denoiseDefault: boolean
): ExportAudio[] {
  const ctx: GainContext = { ...gain, durationOf: (id) => sourceOf(id)?.durationSec ?? 0 }
  const out: ExportAudio[] = []
  for (const a of clips) {
    const g = clipGain(a, clips, ctx)
    if (!g.audible) continue
    const src = sourceOf(a.mediaId)
    if (!src) continue
    out.push({
      path: src.path,
      inSec: a.inSec,
      outSec: effectiveOut(a, src.durationSec),
      startSec: a.startSec,
      gainDb: g.gainDb,
      fadeInSec: a.fadeInSec,
      fadeOutSec: a.fadeOutSec,
      duck: a.duck,
      denoise: effectiveDenoise(a, denoiseDefault),
      foldChannel: src.foldChannel
    })
  }
  return out
}

export interface ExportPlan {
  target: Target
  /** Project duration (seconds) — length of the black base canvas. */
  totalDur: number
  /** Visual layers, back (index 0 = background) → front. */
  visuals: ExportVisual[]
  audio: ExportAudio[]
  /** Relative ASS filename for the caption track (burned on top), if any. */
  captionsAss?: string
  /** Pre-rendered, output-sized PNGs composited ON TOP of the captions (e.g.
   *  gradient-filled captions, which can't burn via libass). */
  topOverlays?: ExportImage[]
  /** Bundled-fonts directory passed to libass (`fontsdir`) so burned text uses
   *  the same faces the preview shows. Absent = libass falls back to fontconfig. */
  fontsDir?: string
  caps: FfmpegCapabilities
  preferNvenc: boolean
  /**
   * Render for use as a NESTED COMPOSITION intermediate: a TRANSPARENT base
   * canvas encoded as VP9/WebM `yuva420p`, so the parent composites the comp
   * over its lower layers exactly like the preview's `CompFill` (which is
   * transparent where the comp draws nothing) instead of over a black box.
   * Read back with `-c:v libvpx-vp9` before its `-i` (see FFMPEG-NOTES
   * "VP9/VP8 alpha"), i.e. `inputDecoder: alphaInputDecoder(...)`.
   * Absent/false = the ordinary opaque H.264 project export.
   */
  alpha?: boolean
}

/**
 * One clip's motion-stabilization pre-pass (ffmpeg vidstab, two passes). Pass 1
 * (`vidstabdetect`) analyses the trimmed segment and writes a transforms file;
 * pass 2 (`vidstabtransform`) applies the smoothed camera path into a video-only
 * intermediate that the compositor then treats as an ordinary input. The trim
 * (`inSec`/`len`) is baked in here, so the composite reads the intermediate from
 * 0. `trfFile`/`outFile` are resolved relative to ffmpeg's cwd (the temp dir),
 * matching the ASS handling, so no Windows path escaping is needed.
 */
export interface StabilizeJob {
  input: string
  inSec: number
  len: number
  /** Detector sensitivity (clamped 1..10). */
  shakiness: number
  /** Smoothing half-window in frames (clamped >= 1). */
  smoothing: number
  /** HDR→SDR tonemap to fold into the transform pass (so the intermediate is
   *  already SDR), or '' for none. */
  hdrChain: string
  /** Relative transforms-file name written by pass 1, read by pass 2. */
  trfFile: string
  /** Relative output (stabilized intermediate) name. */
  outFile: string
}

const clampInt = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(n)))

/** Pass 1: analyse camera motion → transforms file (writes no real output). */
export function buildVidstabDetectArgs(j: StabilizeJob): string[] {
  const shakiness = clampInt(j.shakiness, 1, 10)
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-ss',
    f3(j.inSec),
    '-t',
    f3(Math.max(0.01, j.len)),
    '-i',
    j.input,
    '-vf',
    `vidstabdetect=shakiness=${shakiness}:accuracy=15:result=${j.trfFile}`,
    '-f',
    'null',
    '-'
  ]
}

/** Pass 2: apply the smoothed path (auto-zooming to hide the corrected edges)
 *  plus a light sharpen, encoding the stabilized intermediate. */
export function buildVidstabTransformArgs(j: StabilizeJob): string[] {
  const smoothing = Math.max(1, Math.round(j.smoothing))
  const vf = [
    j.hdrChain,
    `vidstabtransform=input=${j.trfFile}:smoothing=${smoothing}:optzoom=1:zoom=0:interpol=bicubic`,
    'unsharp=5:5:0.8:3:3:0.4',
    'format=yuv420p'
  ]
    .filter(Boolean)
    .join(',')
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-ss',
    f3(j.inSec),
    '-t',
    f3(Math.max(0.01, j.len)),
    '-i',
    j.input,
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-an',
    j.outFile
  ]
}

/**
 * Escape an absolute path for use as an ffmpeg filtergraph OPTION VALUE (e.g.
 * the `ass` filter's `fontsdir`). Backslashes become forward slashes and the
 * Windows drive colon is escaped so the option parser doesn't treat it as an
 * option separator: `C:\fonts` → `C\:/fonts`.
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

/**
 * Assemble the full ffmpeg command for the compositor. `output` and any
 * `assFile` references are resolved relative to ffmpeg's cwd (the temp dir).
 */
export function buildExportArgs(plan: ExportPlan, output: string): string[] {
  const { target, totalDur, visuals, audio, captionsAss, fontsDir, caps, preferNvenc, alpha } = plan
  const W = target.width
  const H = target.height
  // Appended to every `ass=` filter so libass finds the bundled faces. The value
  // is single-quoted AND the drive colon escaped — ffmpeg's filtergraph parser
  // rejects a bare/escaped-only Windows path here ("No option name near '/...'").
  const assOpts = fontsDir ? `:fontsdir='${escapeFilterPath(fontsDir)}'` : ''

  // Input indices: 0 = base canvas (black, or transparent for a nested-comp
  // intermediate), then videos, then images, then top overlays, then audio.
  const videos = visuals.flatMap((v) => (v.kind === 'video' ? [v.video] : []))
  const images = visuals.flatMap((v) => (v.kind === 'image' ? [v.image] : []))
  const topImages = plan.topOverlays ?? []
  const videoIdx = new Map<ExportVideo, number>()
  const imageIdx = new Map<ExportImage, number>()
  let idx = 1
  for (const v of videos) videoIdx.set(v, idx++)
  for (const im of images) imageIdx.set(im, idx++)
  for (const im of topImages) imageIdx.set(im, idx++)
  const audioBase = idx

  // A nested comp's base is fully TRANSPARENT so the parent sees through the
  // areas the comp doesn't cover (matching the preview's CompFill); the format
  // has to carry alpha all the way through the overlay chain.
  const inputs: string[] = alpha
    ? ['-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H}:r=30:d=${f3(totalDur)},format=yuva420p`]
    : ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=${f3(totalDur)}`]
  for (const v of videos) {
    if (v.inputDecoder) inputs.push('-c:v', v.inputDecoder)
    inputs.push('-ss', f3(v.inSec), '-t', f3(Math.max(0.01, v.len)), '-i', v.path)
  }
  for (const im of images) {
    // A keyframed (transform OR opacity) image must be a real frame stream
    // (not a single held frame) so the per-frame scale/overlay expressions —
    // and sendcmd commands — have frames to evaluate on.
    if ((im.keyframes && im.keyframes.length > 0) || im.opacityAnim) {
      inputs.push('-loop', '1', '-t', f3(Math.max(0.04, im.endSec)), '-i', im.path)
    } else {
      inputs.push('-i', im.path)
    }
  }
  for (const im of topImages) inputs.push('-i', im.path)
  for (const a of audio) inputs.push('-i', a.path)

  // Video filtergraph: overlay/ass each visual onto the running composite.
  const chains: string[] = []
  let prev = '0:v'
  let step = 0
  for (const vis of visuals) {
    const out = `v${step++}`
    if (vis.kind === 'video') {
      const v = vis.video
      const i = videoIdx.get(v)!
      const kfs = v.keyframes && v.keyframes.length > 0 ? v.keyframes : null
      const pre: string[] = []
      if (v.hdrChain) pre.push(v.hdrChain)
      if (v.crop) pre.push(cropFilter(v.crop))
      if (v.flipH) pre.push('hflip')
      if (v.flipV) pre.push('vflip')
      const rot = layerRot(v.rotationDeg)
      // Keyframed layers scale per-frame AFTER the setpts shift (so the scale
      // expressions see output-timeline t); static layers keep the one-shot
      // scale here (exact strings pinned by tests). A rotated keyframed layer
      // is pre-scaled to its largest keyframe box instead (see `maxKfBox`).
      if (!kfs) pre.push(`scale=${r(v.boxW)}:${r(v.boxH)}:flags=bicubic`)
      else if (rot) {
        const mb = maxKfBox(kfs)
        pre.push(`scale=${r(mb.w)}:${r(mb.h)}:flags=bicubic`)
      }
      if (v.colorEq) pre.push(v.colorEq)
      // Freeze holds stretch PTS: each pushes all frames at/after its source point
      // forward by holdSec, so the held frame repeats (under -fps_mode cfr) instead
      // of advancing. Commas inside gte() are escaped for the filtergraph parser.
      // T-STARTT = seconds since this input's first frame, so the threshold is
      // origin-independent (input -ss can start raw timestamps at inSec, not 0).
      // Speed divides the elapsed PTS (0.5× doubles the spacing → slow-mo under
      // cfr); freeze thresholds compare SOURCE time so they're speed-independent,
      // and holdSec stays wall-clock (verified — see FFMPEG-NOTES "Speed").
      const speed = v.speed && v.speed > 0 ? v.speed : 1
      const ramp = v.ramp && v.ramp.length >= 2 ? v.ramp : null
      let setpts: string
      if (ramp) {
        // Speed RAMP: played time is the piecewise log-integral of 1/speed in
        // trimmed-input seconds; freeze thresholds stay in source time and
        // holds wall-clock, exactly as in the constant-speed form. The whole
        // value is single-quoted, so the commas inside if()/gte() need no
        // backslash escaping (verified — see FFMPEG-NOTES "Speed ramps").
        const rampExpr = speedRampPlayedExpr(ramp)
        const freezeSum = v.freezes
          .map((f) => `gte(T-STARTT,${f3(freezeAt(f.atLocal))})*${f3(f.holdSec)}`)
          .join('+')
        const inner = freezeSum ? `${rampExpr}+${freezeSum}` : rampExpr
        setpts = `setpts='(${inner}+${f3(v.startSec)})/TB'`
      } else {
        const elapsed = speed !== 1 ? `(PTS-STARTPTS)/${f3(speed)}` : 'PTS-STARTPTS'
        const freezeSum = v.freezes
          .map((f) => `gte(T-STARTT\\,${f3(freezeAt(f.atLocal))})*${f3(f.holdSec)}`)
          .join('+')
        setpts = freezeSum
          ? `setpts=${elapsed}+(${freezeSum})/TB+${f3(v.startSec)}/TB`
          : `setpts=${elapsed}+${f3(v.startSec)}/TB`
      }
      pre.push('setsar=1', v.hasAlpha || rot ? 'format=yuva420p' : 'format=yuv420p', setpts)
      if (rot) pre.push(rotateFilter(rot))
      if (kfs) {
        const sk = rot ? rotatedKfs(kfs, rot) : kfs
        pre.push(`scale=w='${kfDimExpr(sk, 'w')}':h='${kfDimExpr(sk, 'h')}':eval=frame:flags=bicubic`)
      }
      if (v.opacity) {
        // Keyframed opacity: sendcmd sits AFTER the setpts shift so its
        // interval times see absolute output-timeline pts; colorchannelmixer's
        // `aa` MULTIPLIES existing alpha (bg-removed clips keep their matte).
        pre.push('format=rgba')
        if (v.opacity.cmdFile) pre.push(`sendcmd=f=${v.opacity.cmdFile}`)
        pre.push(`colorchannelmixer@${v.opacity.id}=aa=${f3(v.opacity.initial)}`)
      }
      chains.push(`[${i}:v]${pre.join(',')}[pv${i}]`)
      const pos = kfs ? kfPosExprs(kfs) : null
      // `eof_action=repeat` HOLDS the layer's last frame once its (`-t`-limited)
      // input runs out, until `enable` closes the window at endSec. That is what
      // makes a freeze hold sitting at the clip's END work: such a hold shifts no
      // frames forward (nothing follows it), so the stream just stops early and
      // only the repeat keeps the held frame on screen — `eof_action=pass` punched
      // the base canvas (black) through instead. It also matches the preview,
      // whose `videoSourceTime` clamps to `outSec` past the end of the footage.
      const vxy = pos
        ? `x='${pos.x}':y='${pos.y}'`
        : rot
          ? centredPos(v.x, v.y, v.boxW, v.boxH)
          : `${r(v.x)}:${r(v.y)}`
      chains.push(
        `[${prev}][pv${i}]overlay=${vxy}:enable='between(t,${f3(v.startSec)},${f3(v.endSec)})':eof_action=repeat[${out}]`
      )
    } else if (vis.kind === 'image') {
      const im = vis.image
      const i = imageIdx.get(im)!
      const op = Math.max(0, Math.min(1, im.opacity))
      // Order: crop (source fractions) → rotate (90° steps) → flip → scale to box.
      const steps: string[] = []
      if (im.crop) {
        const c = im.crop
        steps.push(`crop=iw*${f3(c.w)}:ih*${f3(c.h)}:iw*${f3(c.x)}:ih*${f3(c.y)}`)
      }
      const q = ((im.rotateQuarters ?? 0) % 4 + 4) % 4
      if (q === 1) steps.push('transpose=1')
      else if (q === 2) steps.push('transpose=1', 'transpose=1')
      else if (q === 3) steps.push('transpose=2')
      if (im.flipH) steps.push('hflip')
      if (im.flipV) steps.push('vflip')
      const ikfs = im.keyframes && im.keyframes.length > 0 ? im.keyframes : null
      const oanim = im.opacityAnim
      const irot = layerRot(im.rotationDeg)
      if (ikfs) {
        // The -loop 1 input already runs on the output clock from 0, so the
        // per-frame scale expressions read absolute timeline t directly.
        if (irot) {
          const mb = maxKfBox(ikfs)
          steps.push(`scale=${r(mb.w)}:${r(mb.h)}`)
        }
        steps.push('format=rgba')
        if (!oanim && op < 0.999) steps.push(`colorchannelmixer=aa=${op.toFixed(3)}`)
        steps.push('fps=30')
        if (irot) steps.push(rotateFilter(irot))
        const sk = irot ? rotatedKfs(ikfs, irot) : ikfs
        steps.push(`scale=w='${kfDimExpr(sk, 'w')}':h='${kfDimExpr(sk, 'h')}':eval=frame`)
      } else {
        steps.push(`scale=${r(im.boxW)}:${r(im.boxH)}`, 'format=rgba')
        if (!oanim && op < 0.999) steps.push(`colorchannelmixer=aa=${op.toFixed(3)}`)
        if (irot) steps.push(rotateFilter(irot))
        if (oanim) steps.push('fps=30') // real frame stream for the commands
      }
      if (oanim) {
        // Keyframed opacity (the exporter baked the static base opacity into
        // the values): sendcmd intervals are absolute output seconds — the
        // looped stream runs on the output clock from 0.
        if (oanim.cmdFile) steps.push(`sendcmd=f=${oanim.cmdFile}`)
        steps.push(`colorchannelmixer@${oanim.id}=aa=${f3(oanim.initial)}`)
      }
      chains.push(`[${i}:v]${steps.join(',')}[pi${i}]`)
      const ipos = ikfs ? kfPosExprs(ikfs) : null
      const ixy = ipos
        ? `x='${ipos.x}':y='${ipos.y}'`
        : irot
          ? centredPos(im.x, im.y, im.boxW, im.boxH)
          : `${r(im.x)}:${r(im.y)}`
      chains.push(`[${prev}][pi${i}]overlay=${ixy}:enable='between(t,${f3(im.startSec)},${f3(im.endSec)})'[${out}]`)
    } else {
      chains.push(`[${prev}]ass=${vis.assFile}${assOpts}[${out}]`)
    }
    prev = out
  }
  if (captionsAss) {
    const out = `v${step++}`
    chains.push(`[${prev}]ass=${captionsAss}${assOpts}[${out}]`)
    prev = out
  }
  // Top overlays (pre-rendered, output-sized PNGs) composite above captions.
  for (const im of topImages) {
    const i = imageIdx.get(im)!
    const out = `v${step++}`
    chains.push(`[${i}:v]scale=${r(im.boxW)}:${r(im.boxH)},format=rgba[pt${i}]`)
    chains.push(
      `[${prev}][pt${i}]overlay=${r(im.x)}:${r(im.y)}:enable='between(t,${f3(im.startSec)},${f3(im.endSec)})'[${out}]`
    )
    prev = out
  }
  const videoMap = `[${prev}]`

  // Audio: mix all sources (no concat "dialogue" base in the layer model).
  const audioItems: AudioGraphItem[] = audio.map((a, k) => ({
    inputLabel: `${audioBase + k}:a`,
    startSec: a.startSec,
    inSec: a.inSec,
    outSec: a.outSec,
    gainDb: a.gainDb,
    fadeInSec: a.fadeInSec,
    fadeOutSec: a.fadeOutSec,
    duck: a.duck,
    denoise: a.denoise,
    foldChannel: a.foldChannel,
    tempo: a.tempo
  }))
  const graph = audioItems.length > 0 ? buildAudioGraph(audioItems, null) : null
  if (graph) chains.push(graph.filter)

  const nvenc = !alpha && preferNvenc && caps.encoders.h264_nvenc
  // An alpha intermediate must go out as VP9/WebM `yuva420p` — H.264 has no
  // alpha, and NVENC is skipped entirely for it.
  const videoArgs = alpha
    ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24', '-row-mt', '1']
    : nvenc
      ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20']

  const mapArgs = ['-map', videoMap]
  if (graph) mapArgs.push('-map', `[${graph.outLabel}]`)

  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    ...inputs,
    '-filter_complex',
    chains.join(';'),
    ...mapArgs,
    ...videoArgs,
    '-r',
    '30',
    '-fps_mode',
    'cfr',
    // yuva420p is already set inside `videoArgs` for the alpha path.
    ...(alpha ? [] : ['-pix_fmt', 'yuv420p']),
    ...(graph ? (alpha ? ['-c:a', 'libopus', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '192k']) : []),
    // faststart is an mp4 moov-atom optimisation; WebM has no such box.
    ...(alpha ? [] : ['-movflags', '+faststart']),
    '-progress',
    'pipe:1',
    '-nostats',
    output
  ]
}
