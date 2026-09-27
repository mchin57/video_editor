# ffmpeg notes — verified behaviors & traps

Facts checked against the real binary (version noted per entry). **Check here
before assuming; add an entry whenever you verify a new codec/container/filter
behavior.** The unit tests pin arg *strings* only — they cannot catch a wrong
assumption about what ffmpeg does with them. Verification recipe: synthesize a
tiny input with lavfi in a scratch dir, run the actual command, inspect with
ffprobe / `alphaextract`+`signalstats` / raw pixel dumps.

## VP9/VP8 alpha in WebM (verified ffmpeg 8.1.1, 2026-07)

- **ffprobe reports `pix_fmt=yuv420p` for a VP9-alpha WebM.** Alpha lives in a
  Matroska side-band; the only probe signal is the stream tag `alpha_mode=1`.
  Detection: `pixFmtHasAlpha(pix_fmt) || tags.alpha_mode === '1'`
  (`ffprobeParse.ts`).
- **The native vp9/vp8 decoders silently DROP the alpha plane.** Decode with
  `-c:v libvpx-vp9` (or `libvpx` for VP8) placed BEFORE that input's `-i`
  (`alphaInputDecoder`, `shared/media.ts`). Verified: `alphaextract` YAVG=255
  (fully opaque) without forcing; exact encoded alpha with it. Applies to every
  ffmpeg consumer: proxy, export inputs, thumbnails, stills.
- Chromium's `<video>` decodes VP9-alpha WebM with transparency natively — no
  special handling needed on the renderer side.
- Encoding rawvideo `rgba` → `-c:v libvpx-vp9 -pix_fmt yuva420p` carries alpha
  fine (straight alpha, not premultiplied).
- Codecs like ProRes 4444 carry alpha in their native decoder — no forcing, and
  their alpha DOES show in `pix_fmt` (`yuva444p10le`).

## ASS animation tags (verified ffmpeg 8.1.1 / bundled libass, 2026-07)

Verified by rendering scratch ASS files over a lavfi color base and inspecting
frame dumps (`assBuilder.overlayEvents` maps `shared/textAnim.ts` onto these):

- **`\fad(inMs,outMs)`, `\move(x1,y1,x2,y2,t0,t1)`, `\t(t0,t1,\fscx\fscy)` all
  animate as documented** and compose with `\fn`/`fontsdir`, pill (BorderStyle
  3) and stroke/shadow tags. All ramps are linear — keep the CSS preview linear.
- **One `\move` per event.** Slide-in + slide-out therefore splits into
  entrance / static / exit Dialogue events; abutting events at the same
  computed position show no visible pop at the boundary.
- **Mid-line `{\1a&HFF&\3a&HFF&\4a&HFF&}` hides the rest of the line but keeps
  its layout space** — a partial reveal stays aligned with the full centered
  text (the typewriter mechanism). With a pill, hide only `\1a\4a`: the
  BorderStyle-3 box then renders FULL-SIZE from the start while glyphs type in
  (hiding `\3a` mid-line would blank the box for the unrevealed run instead).
- **`\k<cs>` karaoke flips a word from the secondary fill to primary at the
  START of its interval** (not the end). Un-highlighted words render in
  SecondaryColour — always set `\2c`/`\2a` inline (the style default is red).
  Whitespace can ride inside a syllable.
- **Vector drawings (`\p1`) compose with `\fad`, `\t(\fscx\fscy)` and `\frz`** —
  the sparkle mechanism. Verified by cropping a 48x48 window around one sparkle
  and reading `signalstats` YAVG per frame: black at the event start, a linear
  rise over the `\fad` in-window, a flat plateau while opaque, a linear fall
  over the fade-out, and exactly black again the frame the event ends. Both the
  straight-line star (`m 0 -10 l 2 -2 l 10 0 ...`) and the concave bezier form
  (`m 0 -10 b 0 -3 3 0 10 0 ...`) render; coordinates are pixels under `\p1`,
  and `\fscx`/`\fscy` scale the drawing like a glyph.
- **A higher `Layer` field draws on top within one ASS file** — sparkles are
  emitted at Layer 1 so they sit above the text (Layer 0) in the same burn.
- libass logs `Error opening memory font 'LICENSES.md'` for non-font files in
  `fontsdir` — noisy but harmless.

## Audio channels — one-sided sources & mono-fold (verified ffmpeg 8.1.1, 2026-07)

- **A "mono mic on one side" source probes as ordinary `stereo`** (2 channels,
  `channel_layout=stereo`) — the container gives no hint one channel is dead.
  The only signal is per-channel level: `astats=measure_perchannel=Peak_level`
  on the real MOV showed **ch1 peak −86.7 dB (dead), ch2 −1.6 dB (the signal)**.
  Detection lives in `detectMonoFoldChannel`/`parseChannelPeaks`/`monoFoldFrom`
  (`services/audio.ts`); a channel peaking below −60 dBFS is treated as silent.
- **`pan=stereo|c0=cN|c1=cN` mirrors channel N to both outputs.** Verified: after
  `pan=…c1`, both output channels read peak −1.6 dB (was −86.7/−1.6). This is the
  auto mono-fold applied in the proxies and the export mix (`monoFoldPan`).
- The fold is **idempotent** — re-applying it to an already-folded stream is a
  no-op (both channels already carry the signal), so it's safe that the audio
  proxy is folded *and* the export graph folds the same source again.
- `astats` logs to **stderr at info level**; `-v error` suppresses it. Capture
  stderr (not stdout) and don't lower the log level when probing channel peaks.

## Audio effects — echo, ensemble & chorus (verified ffmpeg 8.1.1, 2026-08)

Backing for the generated FX tracks (`shared/audioFx.ts` → `services/audioFx.ts`).
An effect track carries the **wet signal only** — it is mixed on top of the
untouched dry clip, so every recipe below is verified in its wet-only form.
Verified with a 5 ms 1 kHz click padded with silence, decoded to s16le and read
sample-by-sample (peaks quoted as a fraction of full scale; the dry click is
0.125).

- **`aecho=in_gain:out_gain:delays:decays` taps the INPUT — there is no
  feedback.** `aecho=1:1:300|600:0.5|0.25` on a burst gave peaks 0.125 at 0 ms,
  0.062 at 300 ms, 0.031 at 600 ms, and **nothing at 900 ms**. So N repeats with
  a decaying tail must be emitted as N explicit taps with geometric decays
  (`echoTaps`), not as one tap with feedback.
- **`in_gain=0` yields wet-only echo.** `aecho=0:1:300|600:0.5|0.25` left only
  the 300 ms and 600 ms taps; the dry click was gone entirely.
- **`aecho` extends the stream by the longest delay** — a 1.0 s trimmed clip came
  out 1.6 s with a 600 ms tap, so the echo rings out past the clip end instead of
  being chopped. This is why an FX clip is rendered as its own asset and gets its
  own (longer) timeline block rather than reusing the source's.
- **TRAP: the `chorus` filter is unusable in 8.1.1 — it ignores `delays` for
  voice placement.** `chorus=0:1:40|60|75:...` put all of its output at 1–6 ms
  instead of at 40/60/75 ms; raising the delays to `400|600|800` changed
  **nothing** (still 1–6 ms), while the output tail still grew by the longest
  delay — so the buffer is sized from `delays` but the taps are not placed from
  it. `in_gain=0` also failed to remove the dry. Do not use this filter.
- **ENSEMBLE (fixed detune) is built from primitives** — `asplit` into one branch per
  voice, each `asetrate=<shifted>,aresample=<base>,atempo=<base/shifted>,
  volume=<v>,adelay=<ms>:all=1`, recombined with `amix=inputs=N:normalize=0`.
  Verified three voices landed at exactly 18/27/35 ms with peaks 2048/1720/1392
  in s16 — i.e. the requested 0.50/0.42/0.34 gains, to the sample.
- **A real (swept) chorus is built from `vibrato`, not `chorus`.** `vibrato=f=<Hz>:d=<0..1>`
  is a delay line swept by an LFO, and it emits the modulated signal ONLY — no
  dry mixed back in — which is exactly what a wet-only effect track wants.
  Verified on a 1 kHz tone by measuring instantaneous frequency from
  interpolated zero crossings: depth 0.2/0.5/1.0 swept 22/54/108 cents
  peak-to-peak, centred on pitch (the unprocessed tone measured a flat 0), and
  the rate knob is accurate (asked 2 Hz / 5 Hz, measured 2.08 / 5.00). Level is
  preserved exactly.
- `vibrato` has **no phase control**, so several voices at the same `f` move in
  lockstep and collapse into one wobble. Give each voice a slightly different
  rate instead (`CHORUS_RATE_SPREAD`).
- **TRAP: `vibrato` emits a ~0.5 full-scale burst at the very start of its
  output.** Reproducible with pure silence at that point in the stream, so it is
  not a reaction to input — but it does NOT reproduce when `vibrato` reads a
  file directly, only inside the effect graph, so it is some interaction with
  the preceding `atrim`/`asetpts`/`aformat` stages. A fade-in does not fix it:
  a 30 ms `afade=t=in` cut the burst from 9010 to 499 but introduced a fresh
  full-scale (16384) spike further in. **The fix is to prime the graph** —
  `adelay=<CHORUS_PRIME_MS>` before the voices and a matching
  `atrim=start=<...>` after the mix — so the transient lands in padding that is
  then discarded. Verified: output silent until the first real voice, voices
  landing at exactly their designed gains, and total duration still source +
  longest voice delay. Only the swept path is primed; echo and ensemble are
  clean and must stay byte-identical so their rendered assets keep their
  content hash.
- **`asetrate`+`aresample`+`atempo` shifts pitch without moving duration.** A
  1 kHz tone measured 998.8 Hz at ratio 1.0, 1006.3 Hz shifted up 0.6%, and
  993.8 Hz shifted down 0.6%, with durations 0.9990/0.9980/0.9990 s. Sub-1 ms
  drift over a second is what keeps the voices from phasing against each other.
  Round the shifted rate to an INTEGER and derive `atempo` from the rounded value
  (`base/shifted`), or the two stages disagree and the voice drifts. `rubberband`
  exists in this build and would be higher quality, but it is an optional
  link-time dependency — the `asetrate` path needs no capability gate.

## Speed (constant per-clip rate) (verified ffmpeg 8.1.1, 2026-07)

Verified by compositing a trimmed `testsrc` (burned-in counter) through the
exact compositor filter shapes and reading the counter off frame dumps:

- **`setpts=(PTS-STARTPTS)/S` plays the clip at S×** under the export's
  `-r 30 -fps_mode cfr` (0.5× consumed one source second per two output
  seconds; cfr duplicates/drops frames as needed).
- **Composes with freeze holds**: in
  `setpts=(PTS-STARTPTS)/S+(gte(T-STARTT\,atLocal)*hold)/TB+start/TB` the
  freeze threshold stays in SOURCE time (speed-independent) and the hold stays
  wall-clock. Post-hold frames land at `atLocal/S + hold + start` exactly.
- Freeze nuance (pre-existing, speed-independent): the export holds the last
  frame *before* `atLocal` (frames ≥ the threshold jump forward), while the
  preview's `videoSourceTime` shows the frame *at* `atSec` — a one-source-frame
  hairline between the two.
- **`atempo` halves/doubles duration exactly** (4s sine → 2.00s at
  `atempo=2.000`); each instance only accepts 0.5–2, so arbitrary tempos chain
  (`atempoChain`, `services/audio.ts` — 4 → `2,2`, 0.25 → `0.5,0.5`).

## Freeze holds & overlay EOF (verified ffmpeg 8.1.1, 2026-08)

A freeze hold is not a filter — it is a PTS gap. `setpts` pushes every frame
at/after the freeze's source point forward by `holdSec`, and the layer's
`overlay` framesync repeats its last delivered frame across the gap. That
mechanism only works while there are frames LEFT to push:

- **A hold parked at the clip's end has nothing to shift.** `addFreeze` clamps
  `atSec` to `outSec`, so "freeze the last frame" gives `atLocal === len` —
  and the input is read with `-t len`, whose last frame lands at
  `len − 1/fps`. `gte(T-STARTT,atLocal)` therefore never fires: the PTS shift
  is 0 and the stream simply ENDS at `startSec + len`, well before the layer's
  `endSec`.
- **`eof_action` decides what the viewer sees for the rest of the window.**
  With `pass` the main input (the black base canvas) is punched straight
  through — the frozen layer goes BLACK for the whole hold. With `repeat` (the
  ffmpeg default, and what the compositor now emits) the last frame is held
  until `enable` closes the window. Verified on the real 4K source that
  regressed: at t=8s of a 13s section with a 10.1s trailing hold, `pass` gave a
  black frame under the overlay and `repeat` gave the held background frame.
- `repeat` also matches the PREVIEW, whose `videoSourceTime` clamps to
  `outSec` past the end of the footage — so a layer whose stream runs short for
  any reason now freezes on its last frame on both sides instead of diverging.
- Mid-clip holds are unaffected: pixel dumps of a `setpts` freeze at
  `atLocal=2` of a 5s clip are byte-identical under `pass` and `repeat`.
- **The mirror case at the START needs the threshold nudged off zero.** A hold
  at `atSec === inSec` gives `atLocal === 0`, and frame 0's `T-STARTT` is
  exactly 0 — so `gte(T-STARTT,0.000)` catches frame 0 too, the *whole* stream
  shifts, and framesync has no earlier frame to repeat. `eof_action` cannot
  help a gap at the HEAD, and neither can it be papered over downstream: the
  layer renders black for the hold.
  **`freezeAt` clamps every threshold to ≥ 1 ms** (`FIRST_FRAME_EPS`,
  `exporterArgs.ts`), which leaves frame 0 in place and shifts frames 1..n — so
  frame 0 becomes the held frame, matching the preview's `videoSourceTime`
  clamp to `inSec`. 1 ms is below one frame interval at any plausible rate (up
  to 1000 fps) and below `f3`'s rounding, so mid-clip thresholds are untouched.
  Verified with a luma-ramp source (`g=min(40+N*3,255)`, so frame 0 ≠ black) at
  a 3 s head hold: corner green 0/0/0 during the hold before, 39/39/39 (frame
  0) after, and identical 56/219/255 afterwards. Holds at speed `2×` and under
  a ramped `setpts` behave the same — the threshold is compared in SOURCE time,
  so it is independent of the elapsed-PTS term. **`tpad=start_mode=clone` is
  NOT needed** and would have to compensate the speed/ramp terms; don't reach
  for it.

## Nested-composition intermediates (alpha pre-render) (verified ffmpeg 8.1.1, 2026-08)

A compound clip / layout-cell composition is exported by PRE-RENDERING it to an
intermediate the parent then composites as an ordinary video input. The
intermediate must carry ALPHA, or the comp would paint a black box over the
layers beneath it — the preview's `CompFill` is transparent wherever the comp
draws nothing, so an opaque intermediate breaks preview/export parity.

- **Transparent base canvas**: `color=c=black@0.0:s=WxH:r=30:d=N,format=yuva420p`
  as lavfi input 0, encoded out with `-c:v libvpx-vp9 -pix_fmt yuva420p`
  (`-b:v 0 -crf 24 -row-mt 1`). Verified the result carries real alpha:
  `alpha_mode=1` on the stream (ffprobe still reports `pix_fmt=yuv420p` — see
  the VP9/VP8 alpha entry above; that tag is the only signal).
- **Round-trip verified**: compositing that intermediate over a green base with
  `-c:v libvpx-vp9` forced before its `-i` gives red (`fd0000`) where the comp
  drew and **green (`007f00`) where it was transparent** — the parent shows
  through, matching the preview. Without the forced decoder the alpha plane is
  silently dropped and the uncovered area would come out black.
- Consequences baked into `buildExportArgs({ alpha: true })`: NVENC is skipped
  (H.264 has no alpha), `-pix_fmt yuv420p` is NOT appended (the encoder already
  sets `yuva420p`), audio goes out as **libopus** (WebM has no AAC), and
  `-movflags +faststart` is dropped (an mp4 moov-atom option; WebM has no such
  box).

## Speed ramps (keyframed variable speed) (verified ffmpeg 8.1.1, 2026-07)

Verified with a synthetic source whose per-frame LUMA equals its frame index
(`geq=lum='min(N,255)'`), reading `signalstats` YAVG back per output frame —
drives `speedRampPlayedExpr` (`ffmpegFilters.ts`) and the ramp branch in
`buildExportArgs`:

- **`log()` in ffmpeg expressions is the NATURAL log**, and `exp`/division/
  nested `if(lt(...))` all evaluate inside a `setpts` value. The piecewise
  log-integral of 1/speed (`C_i + log(v(x)/v_i)/m_i` per linear segment) maps
  source→output time **frame-exactly** (sub-millisecond vs the closed form,
  standalone and through the full compositor chain: base canvas + overlay
  `enable='between(...)'` + `-r 30 -fps_mode cfr`).
- **Single-quoting the whole setpts value (`setpts='(…)/TB'`) makes comma
  escaping unnecessary** — `if(lt(t,…),…)` and `gte(T-STARTT,1.5)*2` ride
  inside the quotes verbatim. (The unquoted constant-speed form keeps its
  `\,` escapes; both parse.)
- The ramp expression composes with the freeze `gte()*hold` sum and the
  `+start` shift exactly as the constant-speed form does (thresholds in
  source time, holds wall-clock).
- **Hold the total played time past the last boundary** instead of letting the
  last segment's `log` extrapolate — a decreasing ramp extrapolates `v(x)`
  toward ≤ 0, and `log` of that is NaN (undefined PTS) if a stray end frame
  lands past the trim.
- cfr placement rounds a shifted pts to the NEAREST output slot (an
  ungraded `-f null` run shows duplicate dts warnings for sub-slot spacing in
  sped-up segments; the real `-r 30 -fps_mode cfr` output resolves them by
  drop/dup — same as constant speed).
- No variable-tempo AUDIO path exists (atempo is fixed per instance); a ramped
  clip's own audio is dropped by the export planner and muted in the preview
  so the two sides agree.

## Keyframed layer motion (verified ffmpeg 8.1.1, 2026-07)

Verified with lavfi bases + frame dumps (drives `ExportKeyframe` handling in
`exporterArgs.ts`):

- **`scale=w='expr':h='expr':eval=frame` accepts `t`** and re-evaluates per
  frame; `overlay` tolerates the mid-stream resizing secondary input.
- **Filter `t` downstream of `setpts` is the SHIFTED time** — placing the
  animated scale after the compositor's setpts lets expressions use absolute
  output-timeline seconds (and composes with speed/freeze shifts for free).
- **`overlay` x/y expressions re-evaluate per frame with live
  `overlay_w`/`overlay_h`**, so `x='cx(t)-overlay_w/2'` keeps a resizing layer
  center-anchored exactly.
- **A keyframed still image needs `-loop 1 -t <dur>` + `fps=30`** — a plain
  `-i img.png` is a single held frame, so per-frame expressions never
  re-evaluate. The looped stream's pts start at 0 on the output clock; no
  setpts needed.
- Keep animated dimensions even (`trunc(expr/2)*2`) for yuv420 outputs.

## Keyframed opacity — sendcmd + colorchannelmixer (verified ffmpeg 8.1.1, 2026-07)

The "no clean per-frame alpha path" blocker is SOLVED. Verified with white-over-
black + `signalstats` YAVG readbacks (drives `buildOpacityCmdLines` /
`OpacityAnim` in `ffmpegFilters.ts`/`exporterArgs.ts`):

- **`colorchannelmixer` options carry the `T` (runtime) flag** — they accept
  commands even though the filter help prints no "commands" section. Address
  the instance as `colorchannelmixer@<id>` and drive `aa` from a
  `sendcmd=f=<file>` placed anywhere upstream in the same chain.
- **A `sendcmd` interval with the `[expr]` flag re-evaluates its argument
  EVERY FRAME within the interval**; `TI` is the 0..1 progress, so
  `lerp(a0,a1,TI)` is a smooth per-frame ramp (measured luma matched the
  prediction to ±1 code value). Cost is one colorchannelmixer — no geq, no
  second alpha stream.
- **`aa` MULTIPLIES the existing alpha** (it's the alpha-from-alpha
  coefficient), so animated opacity composes with a bg-removed clip's matte
  instead of replacing it. Needs an alpha-capable format first (`format=rgba`).
- **Interval boundaries are seamless** (the next interval's first frame takes
  over exactly), **but the LAST interval undershoots its end value** — the
  final frame fires at TI < 1 and the value then sticks. Emit a constant TAIL
  interval pinning the last keyframe's value (`buildOpacityCmdLines` does).
- Frames BEFORE the first interval hold the filter's initial `aa=` option —
  seed it with the first keyframe's value.
- **Composes with `setpts`**: sendcmd placed after the shift sees the shifted
  pts, so interval times are absolute output-timeline seconds (same convention
  as the keyframed-transform `t` expressions). Verified through the full
  compositor shape (base + overlay enable + `-r 30 -fps_mode cfr`).
- A still image needs the `-loop 1` + `fps=30` treatment (like transform
  keyframes) so there are frames for the commands to fire on.

## adelay after atrim — poisoned PTS kills the mux (verified ffmpeg 8.1.1, 2026-07)

- **An `atrim`'d stream fed into a non-zero `adelay` emits ONE frame with a
  near-INT64_MAX PTS at the delay boundary.** The mp4 muxer then "fixes" every
  following packet to `prev+1` (a stream of Non-monotonic DTS warnings),
  silently counting up until it hits INT64_MAX ~11–17s later and the whole
  export dies with `-22 (Invalid argument)`. Three traps in one:
  - the failure timestamp is FAR from the cause (poison at the delay boundary,
    death ~15s later);
  - short clips/tests pass — output ends before the counter overflows;
  - the stderr tail only shows the final warnings, whose `current:` values
    point at the death time, not the poison time.
- `asetpts=N/SR/TB` *before* adelay does NOT help; `adelay=…:all=1` does NOT
  help. **Renormalizing AFTER (`adelay=…,asetpts=N/SR/TB`) is clean and
  sample-accurate** (silencedetect: silence ends at exactly the delay;
  duration exact). Reproduces from pure lavfi `sine` — not a media/container
  quirk. Fix lives in `buildAudioGraph` (`services/audio.ts`); the ordering is
  pinned in `audio.test.ts`.

## Progress parsing

- `-progress pipe:1` emits `out_time_us` AND `out_time_ms` — **both are
  microseconds** (historical ffmpeg quirk, kept for compat). `runFfmpeg`
  divides by 1e6 for either key.

## Filtergraph / options

- libass `fontsdir` in an `ass=` filter needs the value single-quoted AND the
  Windows drive colon escaped (`escapeFilterPath`); a bare path is a parse
  error ("No option name near ...").
- Commas inside filter expressions (e.g. `gte(T-STARTT\,x)`) must be escaped
  for the filtergraph parser.
- `-ss` before `-i` is input seeking (fast); it composes with a forced input
  decoder (`-c:v libvpx-vp9 -ss … -i …` works).
- zscale on partially-tagged HDR needs explicit input characteristics
  (`tin`/`pin`/`min`) or it errors with "no path between colorspaces"
  (`hdrToSdrChain`).

## Text rasterisation — the capture window is CLAMPED (verified Electron 38 / Windows 11, 2026-09)

Not an ffmpeg trap, but it lives here because it silently corrupts export output
and the recipe for catching it is the same: render, then look at the pixels.

Gradient text, side-resized text (`widthPx`) and gradient captions can't burn
through libass, so they rasterise to a transparent PNG via a hidden
`BrowserWindow` + `capturePage()` (`services/textImage.ts`).

- **`new BrowserWindow({ width, height })` CLAMPS to the display work area.** A
  1080x1920 reel window on an ordinary 1920x1080 monitor is born **1080x1032**
  (measured: work area 1920x1032). `capturePage()` then returns a 1080x1032
  picture — correct width, cropped height.
- **The result is a silent, partial export.** Every overlay below the cut simply
  is not in the output. Nothing throws: the window loads, the fonts load, the
  capture succeeds, the PNG is written, ffmpeg composites it. The bug shipped
  because the size guard compared **width only** (`getSize().width === width`),
  which a height-clamped capture passes. A text layer at y≈1110 vanished from
  every export while showing perfectly in the preview.
- **Fix: `win.setContentSize(width, height)` after construction.** It is *not*
  clamped, and the size survives `showInactive()`. Verified across a reused
  window (the renderer keeps one for the whole export): three consecutive
  renders all captured a full 1080x1920 with alpha intact (a 50%-alpha probe
  block read back as `[0,128,0,128]`, empty areas `[0,0,0,0]`).
- `webPreferences.offscreen: true` does **not** help on its own — the window is
  still constructed at the clamped size (measured 1080x1032). It is the
  constructor, not the presentation mode.
- **Never `resize()` a mismatched capture.** A crop is not a scale; resizing
  stretches a partial frame. `normaliseCapture` passes an exact match, scales
  only a *uniform* multiple (real HiDPI), and otherwise THROWS — which drops the
  caller into its flat-colour ASS fallback, so the text is degraded but present.
  Verified end-to-end: with the fix disabled, "Sick" still burned (via ASS)
  instead of disappearing.


### Pill geometry — inline backgrounds and the layer scale (verified 2026-09)

Two separate parity breaks in the same overlay, both invisible until the crop
bug above was fixed and rasterised text actually reached the output.

- **An inline box's background is sized from ITS OWN font metrics.** The pill is
  a `<span>` *between* the positioning box and the text span. `buildHtml`
  declared `font-family`/`font-size` on the innermost text span only, so the
  pill inherited the document default **16px** and painted a box 16px + 2x18px
  padding = **52px** tall behind 108.89px glyphs — measured exactly 52px in the
  export. The text sat outside its own background. The preview never had this
  because it declares the font on the wrapper div, which the pill inherits.
  Fix: declare the font on `.box`, never on `.txt`. Pinned in
  `textImage.test.ts`.
- **Decorations must scale by `layer.scale` too, not just the output scale.**
  The preview scales a resized overlay with `transform: scale(layer.scale)`, so
  padding/stroke/shadow grow with the glyphs; the export computes absolute
  output px and was multiplying only by `sy`. A 1.43x overlay burned with a pill
  sized for the unscaled text. `decorationScale(layerScale, outputScale)`
  (`services/textScale.ts`) is now the one factor, and its test pins the real
  invariant: the pill-to-font ratio survives the trip unchanged.
- **`line-height` has to match the preview's.** It sets the line box the pill
  background is drawn around. The preview uses Tailwind `leading-tight`; read
  out of the built stylesheet as `--leading-tight: 1.25` (the export had 1.1).
- Measuring it: export a frame, scan for the pill's bounding box, compare its
  **aspect** with the preview's (aspect is scale-independent, so it compares
  across the CSS-scaled stage and the 1080x1920 output). Before: 5.346. After:
  1.598, against a preview of 1.596.


## whisper word timings (verified whisper.cpp / whisper-cli, ggml-small.en, 2026-09)

The caption pipeline transcribes the WHOLE original once per media asset
(`whisper.ts`), and clip trims are applied afterwards in the renderer
(`renderer/lib/captions.ts`). There is no per-clip audio slice — do not go
looking for an `-ss` in the transcription path.

- **`-ml 1 -sow -oj` offsets are SEGMENT bounds, not word bounds.** Entries tile
  edge to edge, so the leading words of a segment get smeared back across
  whatever silence precedes the speech, and the word before a pause absorbs the
  whole pause. Measured on real media: the offsets put the first word at 0.00s
  when nothing is spoken until 2.42s (ffmpeg `silencedetect` independently said
  2.338s). The error decays monotonically — 2.42s, 2.18s, 1.86s … under 0.25s
  after about eight words — which is exactly why captions dropped words mostly
  at the START of a trimmed clip and only occasionally at the end.
- **Real word timings come from `-dtw <preset>`, which needs `-ojf`.** Per-token
  `t_dtw` appears only in `--output-json-full`; plain `-oj` emits no `tokens`.
- **`-nfa` is MANDATORY alongside `-dtw`.** Flash attention is ON by default and
  silently disables DTW: the binary prints `dtw_token_timestamps is not
  supported with flash_attn - disabling` and every `t_dtw` comes back `-1`, so
  the change looks like it did nothing. Cost of `-nfa`: about 17% (3108ms to
  3649ms on a 12s clip).
- **`t_dtw` is in CENTIseconds** (1 unit = 10ms), unlike `offsets`, which are
  milliseconds. Divide by 100.
- **A preset that does not match the model yields GARBAGE and still exits 0.**
  `-dtw base.en` against a `small.en` model put the first word at 5.66s and then
  collapsed four consecutive words onto 8.18s, with no warning. An unrecognised
  name is safer by comparison — it aborts with exit 3. So `dtwPreset()` returns
  null rather than guess, and `parseWhisperTranscript` gates the result
  (complete, monotonic, not collapsed) before trusting it.
- **Preset names use dots, not dashes:** `large.v3` is accepted and `large-v3`
  is rejected, yet model FILES are named `ggml-large-v3.bin`. Valid presets:
  tiny, tiny.en, base, base.en, small, small.en, medium, medium.en, large.v1,
  large.v2, large.v3, large.v3.turbo.
- **`t_dtw` is `-1` on whisper's own control tokens** (`[_BEG_]`, `[_TT_nnn]`);
  read past them to the first real text token.
- **DTW times a word's START only.** Its end is inferred from the next word's
  start, so the word before a pause is stretched across the pause. The cap
  (`MAX_WORD_SEC`, 1.2s) stops it spanning a long pause, but even capped, the
  stretch moves the word's midpoint — which decides which side of a cut owns it
  — past a cut the word really sits before. Measured: "months." spoken
  10.49–10.59s, stretched to 11.69s, dropped from a clip ending at 11.03s. So
  each word's end is pulled back to the start of the next silence silencedetect
  reports (`endAtSilence`, never later). Across a real 8-clip project the
  median caption on-screen time moved only 0.88s → 0.84s.
- **whisper DROPS a file's opening sentence when junk precedes the speech.**
  Verified on a teleprompter recording: a 0.1s click at 0s, 5s of room tone,
  then "Ramp up gradually." — gone under every flag combination, including the
  pre-DTW args, and the DTW alignment then stretched the next sentence ("We
  all know this") back over the missing one's audio, 1.5s early. Muting only
  the click brought it back; separately, a clean 12s lead dropped it where 8s
  kept it. Mid-file gaps are harmless — the same 5s gap after 12s of prior
  speech kept the sentence — so only the head is skipped: `-ot` starts
  decoding `LEAD_IN_SEC` (0.5s) before the first sound run of at least
  `MIN_SOUND_SEC` (0.15s), found with the same silencedetect pass.
- **`-ot` keeps every reported time in whole-file time** — entry offsets AND
  `t_dtw` — so nothing downstream shifts (verified: with `-ot 3733` and
  `-ot 4550`, identical DTW times for every word).
- 20s of DIGITAL silence mid-file made whisper hallucinate a sentence that was
  never spoken. Real recordings carry room tone and this has not been seen in
  one; whisper's own `--vad` (needs a silero model we do not ship) is the
  general answer if it ever is.
- **Bracketed annotations leak through `-ml 1`.** `(birds chirping)` arrives as
  two entries, `(birds` and `chirping)`, so a whole-string noise regex matches
  neither. Real transcripts in the library carry these as caption words. `-sns`
  (`--suppress-nst`) exists and is untried. STILL OPEN.
- Transcripts are cached at `media/<id>/transcript.json` with no re-run flag.
  `TRANSCRIPT_VERSION` (`shared/transcript.ts`) is the cache version: any other
  version is treated as stale and re-transcribed. Change the whisper flags or
  the parse and you must bump it, or every existing transcript keeps its old
  words forever.

## Non-9:16 output frames — sizes & off-canvas overlays (verified ffmpeg 8.1.1, 2026-09)

- **Every built-in format encodes at its derived size.** The real exporter, on
  real sample media, produced h264_nvenc yuv420p at 1080×1920, 1080×1080,
  1080×1350, 1920×1080 and 2520×1080 (the widest, 21:9); libx264
  `-preset medium` was checked separately at 2520×1080. Sizes come from
  `defineAspect` (short side 1080, even dims — yuv420 needs even).
- **`overlay` with a NEGATIVE offset crops the input; it does not clamp or
  shift it.** A 1080×1920 input at `y=-420` on a 1080-tall canvas shows input
  rows 420..1499 at output rows 0..1079. Checked with a four-band clip whose
  band edges land on exactly the predicted output rows (`e2e/aspectRatio.spec.ts`,
  landscape + square exports), and with solid red at x=720, y=−420 on 2520×1080.
  This is what makes "keep the clip's size when the format changes" free: the
  exporter maps canonical → output (`frameToOutput`) and hands ffmpeg the
  off-canvas coordinates as-is.
- Trap for synthetic tests: `h264_nvenc` refuses tiny frames ("Frame Dimension
  less than the minimum supported value" at 64×64). Irrelevant to real
  exports (every canvas is ≥1080) — synthesize test canvases at ≥256 px, or
  use libx264.

## Known constraints (product decisions, not bugs)

- The export composites at a hardcoded **30fps CFR** (`r=30` base canvas +
  `-r 30`, `exporterArgs.ts`); 60fps sources are resampled. Revisit when
  platform profiles land — the fps is a second, implicit contract next to the
  1080×1920 logical space.
- Windows caps a spawned command line at ~32K chars; every layer adds a few
  hundred to `-filter_complex`. Large layer stacks will need
  `-filter_complex_script` (graph read from a file) — adopt it *before*
  debugging a cryptic spawn failure on a big project.
- Preview `<audio>`/`<video>` volume clamps at 1.0, so positive `gainDb` is
  audible only in the export (`volume=` filter). Known preview/export parity
  gap; needs WebAudio gain routing if it ever matters.
