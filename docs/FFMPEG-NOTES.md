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
  fingerprint (re-rendering the same settings reuses the asset).
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

## Partial outputs — the file exists (and lies) before ffmpeg is done (verified ffmpeg 8.1.1, 2026-09)

The media store decides "ready" by EXISTENCE (`existsSync(proxy.mp4)`), so
anything ffmpeg writes straight to its final name is a trap:

- **ffmpeg creates its output the moment encoding starts.** The exact proxy
  command (`buildProxyArgs` shape) on a 33s 1080x1920 source: 431ms in,
  `proxy.mp4` already existed at 786KB, laid out `ftyp free mdat` — the
  `+faststart` `moov` is written (and moved to the front) only at the very end —
  and ffprobe failed `moov atom not found`. In the app, a layer added in that
  window got `MediaError 4: PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN:
  FFmpegDemuxer: open context failed`, and the `<video>` NEVER retries: still
  failing well after the encode finished (`e2e/proxyReady.spec.ts`).
- **A partial WebM is worse — it OPENS.** A snapshot of a VP9-alpha proxy 3s into
  a 9s encode: ffprobe exit 0, the FULL 20.000s duration reported, but only 113
  of 600 frames decode. It would play truncated, with no error at all. (A flat
  test source hid this: its whole output fit the 32KB AVIO buffer, so the file
  stayed 0 bytes until the end — test with real content.)
- **A failed run leaves a valid-looking TRUNCATED file.** Exit 183 mid-stream
  (`-xerror` on a corrupt TS input): ffmpeg still finalized the mp4 — `moov`
  written, opens fine, 4.93s of a 10s source. A killed run (exit 143) leaves a
  torn, unopenable one. ffmpeg never deletes its output on failure.
- **Fix: `writeAtomically` (`services/atomicWrite.ts`)** — encode to
  `partialPath(final)` (`proxy.part.mp4`), rename onto the final name only after
  exit 0, delete the partial on failure. **Keep the real extension LAST** — the
  muxer is picked from it. Verified BYTE-IDENTICAL output under the `.part` name
  for mp4 (still `ftyp moov free mdat`, so faststart still applies), m4a (still
  the `ipod` muxer, `M4A ` brand), jpg and png. WebM bytes differ run-to-run even
  under one name (random segment UID), but the `.part` output decodes to
  identical frames incl. alpha, keeps `doctype=webm` + `ALPHA_MODE=1`, and with
  `-fflags +bitexact` both names are byte-identical.
- **image2 outputs (thumb.jpg, waveform.png, image.png) have a far smaller
  window**: image2 opens its file per packet, so the file appears only when the
  finished image is written (a 1.4s waveform run never showed its file while
  running, polled every 20ms). They go through `writeAtomically` anyway — a
  killed write would otherwise be kept forever by the `existsSync` skip, and
  `image.png` IS an image asset's "ready" signal.
- **Windows: `fs.rename` onto a target that is OPEN fails `EPERM`** — even a
  plain Node read handle blocks it. Harmless for ffmpeg outputs (the final
  name never exists when we rename). Transcripts and project documents DO
  replace an existing name (temp + rename, so a reader never sees a torn
  file), so they use `replaceFile` (`atomicWrite.ts`), which retries a short
  EPERM/EBUSY — readers only hold these files for a single read.
- The partial name is fixed per file (a crash's leftover is overwritten by the
  next attempt's `-y`), so two writers of one file would share it —
  `mediaStore` coalesces them with `singleFlight` (per asset for
  `ensureProxy`, per path for thumb/waveform/image). That is per-process: two
  app instances on one data dir are not coordinated (there is no
  single-instance lock).
- **A run can exit 0 having written nothing** ("Output file is empty, nothing
  was encoded"). `writeAtomically` checks the partial exists before renaming
  and says so, instead of failing the rename with ENOENT on `*.part.*`.

## Stills: no input seek (verified ffmpeg 8.1.1, 2026-10)

- **`-ss 0` before `-i` on a JPEG still drops its only frame.** On iPhone
  JPEGs (image2/mjpeg, probed as 1 frame at 25 fps, duration 0.04) the thumb
  command printed "No filtered frames for output stream" and "Output file is
  empty, nothing was encoded" and exited **0**. Every JPEG thumbnail failed, so
  library cards showed the ▶ placeholder; the old global store never had a
  thumb for any image either. PNGs survived the same seek.
- **Without `-ss` every still works** (JPEG and PNG tested), so
  `buildThumbnailArgs(..., still)` omits it for image assets. Videos keep
  `-ss 0`, unchanged.

## Quick cut — frame-exact pieces by re-encode (verified ffmpeg 8.1.1, 2026-10-14)

Backing for `services/quickCut.ts` (`buildCutArgs`): `-ss in` BEFORE `-i`,
`-t len` after it, `-fps_mode passthrough`, re-encoded.

- **A stream copy can't do it.** iPhone H.264 keyframes sit ~0.97 s apart
  (IMG_1593: 0, 0.967, 1.933, …), so `-c copy` would snap a trim by up to a
  second. Re-encoding with an input seek is frame-exact.
- **Pieces split at one point share no frame and lose none.** IMG_8420 (VFR,
  avg 59.94 fps, 435 frames) cut at 3.217 s: piece 1 had 193 frames, piece 2
  242 (= 435). Piece 1 holds exactly the frames with pts < 3.217 (the last is
  3.203); piece 2 starts with the 3.220 frame — its first frame matched the
  source's 3.220 frame at PSNR 46.8 dB, vs 15.3 dB against the 3.203 frame.
- **Rotation is baked in, not carried.** A `rotation=-90` 1920×1080 source
  comes out 1080×1920 with no display matrix; `-map_metadata 0` copies the
  `creation_time` tag and does NOT bring the rotation back.
- **HDR tags:** a fully tagged 10-bit HLG HEVC source cut with `hevc_nvenc
  -profile:v main10 -pix_fmt p010le` keeps `bt2020 / arib-std-b67 / bt2020nc`
  even without explicit flags; the args still pass the probe's tags
  (`-color_primaries/-color_trc/-colorspace`, skipping `unknown`) because
  iPhone files are often only partly tagged (see `hdrToSdrChain`). ffprobe's
  `unknown` is not an accepted option value, so it is never passed.
  `-display_rotation` is an INPUT option in 8.1.1 (it errors as an output one).
- **Alpha WebM:** with `-c:v libvpx-vp9` before `-i` and VP9 `yuva420p` out,
  the cut keeps `ALPHA_MODE=1` and the alpha itself (alphaextract: transparent
  half 0, opaque half 255; 60 frames for 2 s).
- **Speed / size:** NVENC CQ 18 at preset p6: a 2.5 s 1080×1920 60 fps cut in
  0.9 s, ~36 Mbps (source 23); a 2.8 s 30 fps cut ~21 Mbps (source 16). A cut
  is a new original, so it errs large.

## Merge clips — per-segment inputs + concat filter (verified ffmpeg 8.1.1, 2026-10-16)

Backing for `services/merge.ts` (`buildMergeArgs`): one input per segment
(`-ss in -t len -i file`, the libvpx decoder first for an alpha WebM), each
normalized `scale…decrease,pad,setsar=1,fps=F,format=…,setpts=PTS-STARTPTS,
trim=duration=len`; audio `aresample=48000,aformat=fltp/stereo,apad,
asetpts,atrim=duration=len`, or `anullsrc…,atrim` for a clip without audio;
then `concat=n=N:v=1:a=1`. Synthetic lavfi sources, 2026-10-16:

- **Lengths add up exactly.** rot.mp4 [0.5, 2.5) + a silent 60 fps clip
  [0, 2) + rot.mp4 [1, 3) → video and audio both 6.000 s, 360 frames at 60
  fps. Volume per second: tone, tone, −91 dB, −91 dB, tone, tone — the
  silence lands exactly on the silent clip.
- **Windows are frame-exact.** The merge's first frame matched the source's
  0.5 s frame at PSNR 58 dB (26 dB against the next frame); the third
  segment's first frame matched source 1.0 s at 61 dB.
- **Rotation is baked in by the filter graph.** A 1920×1080 `rotation=90`
  source comes out 1080×1920 with no display matrix (autorotate applies to
  `-filter_complex` inputs too).
- **Alpha:** an alpha WebM (left half opaque) + an opaque H.264 clip, out as
  VP9 `yuva420p`: `alpha_mode=1`; alphaextract 255/0 on the WebM's halves,
  255 across the opaque clip; a landscape clip letterboxed into the portrait
  frame with `pad=…:color=black@0` has alpha 0 in the bars and 255 in the
  picture.
- **HDR + SDR:** a tagged HLG HEVC 10-bit clip through `hdrToSdrChain`, then
  the normal chain, concatenated with an SDR clip → 8-bit bt709 H.264, 4.000 s,
  black (Y 16) letterbox. **All HLG:** `format=yuv420p10le` + `hevc_nvenc
  main10 p010le` with the tags passed → `Main 10`, `bt2020 / arib-std-b67 /
  bt2020nc` kept.
- **Trap:** a synthetic 10-bit HEVC made WITHOUT x265 VUI tags (ffprobe shows
  transfer/primaries `unknown`) made the tone-map's `zscale` fail with "no path
  between colorspaces" even though `tin/pin/min` are given; tagged via
  `-x265-params colorprim=…:transfer=…:colormatrix=…:range=limited` it worked.
  Real iPhone HDR is tagged; this only matters for synthetic test media.

## Loudness series — momentary loudness + per-step peak in one pass (verified ffmpeg 8.1.1, 2026-10)

Backing for `cache/<id>/loudness.json` (`services/loudness.ts` →
`shared/loudness.ts`; volume levels read it). The chain is
`[pan fold,]aresample=48000,asetnsamples=n=4800:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level,ebur128=metadata=1,ametadata=mode=print:file=<name>`
on `-map 0:a:0 -vn -f null -`: 0.35 s for a 3:13, 950 MB 4K HEVC recording.

- **One metadata frame per 0.1 s, only at 48 kHz.** `asetnsamples=n=4800` makes
  every frame exactly 0.1 s only when the stream is 48 kHz, so resample FIRST
  (a 44.1 kHz source gave the same clean 0.1 s cadence after `aresample=48000`).
  `ebur128=metadata=1` then tags each frame with `lavfi.r128.M`: the 400 ms
  block ENDING at that frame's end — frame k (pts k·0.1) covers
  `(k·0.1 − 0.3, k·0.1 + 0.1]`. Checked on a tone→silence edge: the first M
  short of a full tone block lands exactly where that alignment predicts.
  Frames 0–2 carry M = −120.691 (no full block yet: ebur128's floor) and
  digital silence prints `nan`; the series stores both as `null`.
- **`astats` with `reset=1` gives the peak of each 0.1 s frame**
  (`lavfi.astats.Overall.Peak_level`, `-inf` for digital silence → `null`).
  The max of a window's steps matched `astats` run directly on the trimmed
  window exactly (−14.48 for 60–85 s, −22.16 for 30–40 s of the recovery
  teleprompter file).
- **`ebur128`'s own peak metadata is a running MAXIMUM** — with
  `peak=true+sample`, `lavfi.r128.true_peaks_ch0` and `sample_peaks_ch0` stayed
  at the first half's 0.125 through a later section 14 dB quieter. Useless for
  a window's peak, hence `astats`.
- **Gated windows from the series match ebur128 on the window.** BS.1770 gating
  (absolute −70, relative −10; block power 10^((M+0.691)/10)) over the blocks
  wholly inside the window reproduced ebur128's integrated loudness of
  `aresample=48000,atrim=IN:OUT,asetpts=N/SR/TB` to its printed 0.1 on five
  windows of the recovery file (−40.7, −59.2, −36.9, −34.9, −61.6) and on a
  synthesized two-level tone (`e2e/loudness.spec.ts`).
- **Mono is measured as mono, not upmixed.** A mono source's stereo proxy
  (`-ac 2`, or `aformat=channel_layouts=stereo`) has the SAME integrated
  loudness (−36.9 either way: the upmix puts −3 dB in each channel) but a peak
  3.01 dB LOWER (−17.49 vs −14.48). The export mixes an extracted video clip's
  ORIGINAL (`audioProxyIfReady` only exists for audio assets), and an all-mono
  mix stays mono, so the source's own peak is the safe bound for a cap.
  For an imported mono AUDIO file that bound is ~3 dB conservative: the export
  mixes its stereo proxy (`audio.m4a`, `-ac 2`), whose peak is 3.01 dB below
  the mono source the series measured, so a peak-capped clip lands ~3 dB short
  of what the ceiling would allow (see "Volume levels" below). By contrast a duplicated-to-both-channels signal (`pan=stereo|c0=c0|c1=c0`)
  IS 3 LU louder (−33.9) — which is why a one-sided stereo source must be
  measured AFTER the mono-fold pan (`e2e/loudness.spec.ts`: folded ≈ +3 LU).
- **Print file on Windows: pass a bare file name and run ffmpeg with that
  directory as its cwd.** An unescaped absolute path (`file=C:/…`) is a
  filtergraph parse error (the drive colon splits the option).

## Volume levels — exported clips land on the target (verified ffmpeg 8.1.1, 2026-10-13)

`clipGain` (`shared/volumeLevels.ts`) turns a clip's window loudness from the
series into the `volume=` the export applies (`exportAudioClips`). Checked on a
real export (`e2e/volumeLevels.spec.ts`, which re-runs it): three mono 48 kHz
WAVs side by side in Default (−16 LUFS), each stretch of the AAC output then
measured on its own with `atrim,asetpts,ebur128`:

- a 1 kHz tone at −18 dBFS peak (series −21.8 LUFS; its own gain −10 dB is
  unused in the level) → **−16.0 LUFS**;
- the same tone 18 dB down (−39.8 LUFS) → **−16.0 LUFS** — two clips 18 LU
  apart land on the same number;
- 10 ms bursts at −12 dBFS every 0.4 s (series −31.07 LUFS, peak −12.04): +15.1
  wanted, the −1 dBFS cap allows +11.04 → "short by 4.03 dB"; measured
  **−20.0 LUFS** = −31.07 + 11.04, exactly as predicted. Output peak −3.94.
- The preview's applied gains (`appliedGain` on the followers) equal the
  helper's prediction to 0.1 dB in the same spec.

Things the check showed:

- **A gain is a pure loudness shift.** `volume=` before `amix` (normalize=0)
  and the AAC encode moves the integrated loudness by the gain to within the
  0.1 LU `ebur128` prints; the 0.2 s trimmed off each stretch's edges doesn't
  matter for steady material.
- **An audio asset is mixed from its stereo proxy, so its cap is 3 dB
  conservative.** The series measures the mono source (peak −12.04); the
  export reads `audio.m4a` (`-ac 2` upmix: same loudness, peak 3 dB lower),
  hence −3.94 rather than −1 at the output. Same loudness, so the match itself
  is exact. A mono VIDEO original is mixed as-is: the same pulses inside an mp4,
  run through the exporter's chain at +11.04 dB, peaked at **−0.93 dBFS**
  (the AAC encode overshoots the −1 dBFS ceiling by ~0.07 dB — still well
  clear of 0).

## EXIF orientation — only on the first FRAME (verified ffmpeg 8.1.1, 2026-10)

- **An iPhone JPEG is stored landscape; its orientation is frame side data,
  not stream side data.** `IMG_8432.JPG` (iPhone 14 Pro, upright portrait):
  `-show_streams` gives 4032×3024, no `side_data_list`, no `rotate` tag. Only
  the decoded frame carries it: `3x3 displaymatrix`, `rotation=-90`.
- **ffmpeg applies it when decoding** (autorotate), so the display PNG, the
  thumbnail and any filter graph fed the original see the upright 3024×4032
  picture. A probe that reads only the stream is wrong for these files, and
  every size taken from it (layer box, thumb, export box) squashes the photo.
  Before the fix the export drew the 3:4 PNG into a 540×406 (4:3) box.
- **All eight EXIF orientations** (APP1 tag 0x0112 spliced into a lavfi
  64×48 JPEG): 1→0, 2→−180, 3→−180, 4→0, 5→−90, 6→−90, 7→90, 8→90; 5–8 decode
  48×64, 1–4 decode 64×48. A mirrored orientation reports a rotation too, and
  ±90 always means "swap width and height".
- **How the probe reads it:** add `-read_intervals %+#1 -show_entries
  frame_side_data=side_data_type,rotation` to `-show_format -show_streams`.
  The streams/format JSON is unchanged (only `refs` and `nb_read_frames` are
  added). Do **not** use `-show_frames`: it prints every EXIF tag, iPhone
  MakerNote included (~10 KB). PNG, GIF, WebP, BMP, TIFF and AVIF probe fine
  with the same args (exit 0, a frame with no display matrix). HEIC was not
  tested (no sample; it goes through the mov demuxer, where rotation is stream
  side data).
- Only stills get the frame read (by extension, `kindFromExt`); videos keep the
  stream-only probe. Whether ffmpeg also honours a FRAME display matrix on video
  was not checked.

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


## whisper input level — fold + boost before transcribing (verified ffmpeg 8.1.1 / whisper-cli ggml-small.en, 2026-10-15)

The transcription wav (`whisper.ts`, args from `buildTranscribeExtractArgs`)
is read by BOTH whisper and the `silencedetect=noise=-30dB` pass behind
`decodeStartSec` / `endAtSilence`, so its level matters even though whisper's
own log-mel is fairly level-invariant.

- **A quiet source loses whole sentences.** Real teleprompter take at
  −37.7 LUFS (series scale), peak −19 dBFS: plain `-ac 1` gave a wav peaking at
  −25 dBFS, silencedetect chopped the speech into sub-0.15s bursts, and
  `decodeStartSec` returned 22.85s — whisper decoded only the last 8s
  (16 words). Folded + boosted 17.7 dB: first silence_end 2.97s, decoding from
  2.47s, 69 entries — the whole script.
- **`-ac 1` averages a one-sided stereo source with its dead channel** (−6 dB).
  Fold first with `monoFoldPan` (as the mix does); the identical pair then
  averages to the channel's own level.
- **Gain is static, from the loudness series** (`transcribeGainDb`: target
  −20 LUFS, boost only, capped at +24 dB; no series / silence = no boost).
  Not `dynaudnorm`: it lifts the gaps between words, which silencedetect needs.
- **`alimiter=limit=0.891:level=0`** holds a boosted peak at −1.1 dBFS
  (without it: 0.0 dBFS, clipped in s16). `level=0` matters — the default
  auto-level adds its own make-up gain. Verified `level=0` adds none: −19.19 +
  17.7 dB → −1.55 dBFS out.

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
- **`-ml 1` splits annotations into one entry per word** (verified 2026-10-13,
  current app args, four library clips). Real raw entries: `(birds` `chirping)`;
  `(inhaling` `and` `exhaling)`; `[` `Pause` `]` (the brackets as entries of
  their own); `♪` `I` `could` `break` `you` `to` `say` `the` `last` `♪` followed
  by `(dramatic` `music)`. A whole-string noise regex matched none of them, so
  they became caption words. Fixed in the parser (`annotationMask`,
  `whisperParse.ts`), on both the DTW and segment paths. Only marks at an
  entry's edge count (`friend(s)` is a word). An entry opening with `(` or `[`
  starts a span and the first later entry ending with the matching closer ends
  it; everything between is dropped. The search gives up at the next opener or
  after `MAX_ANNOTATION_ENTRIES` (12; the longest real span is the 10-entry
  lyric line), and then only the stray opener goes — it never pairs with a
  later annotation's mark across the speech between. `♪` opens and closes
  alike, so a run of them is paired in order, and an odd run drops the one
  stray whose pairing swallows the fewest entries. Speech between two real
  annotations is kept; what the parser cannot tell apart from an annotation
  (two strays that happen to pair up, or a stray `♪` beside a lyric line whose
  pairing is a tie) can still be dropped. Dropped
  entries keep their DTW time, so they still end the word before them. Rerun on
  the four clips: only the annotation entries above went (plus `(clicking)`),
  and every spoken word on the DTW path was kept.
- **`-sns` (`--suppress-nst`) is NOT the fix.** Tried on the same four clips: it
  cleans clips with speech but rewrites real words ("Sorry." lost; "what your"
  became "why you're"), and on clips with no speech it invents a sentence
  ("I'm gonna get a box." over birdsong). Do not use it.
- Transcripts are cached at the project's `transcripts/<id>.json` with no re-run flag.
  `TRANSCRIPT_VERSION` (`shared/transcript.ts`) is the cache version: any other
  version is treated as stale and re-transcribed. Change the whisper flags or
  the parse and you must bump it, or every existing transcript keeps its old
  words forever.
- **`-ml 1` + `-dtw` floods stdout quadratically: never leave it an undrained
  pipe** (verified 2026-10). With both flags, whisper-cli re-prints every
  earlier word segment each time a new one lands (`-np` does not stop it: it
  only silences logs). An ~80-word, 40s clip printed 3,240 lines (129 KB) with
  `-dtw`, against 92 lines without it. `runWhisper` used to pipe stdout and
  never read it, so past ~60 words the pipe filled and whisper blocked forever
  at 0% CPU: captioning "hung". The same command ran in 7s with stdout sent to
  a file. Results come from the `-ojf` file, so stdout is spawned `'ignore'`
  (regression test: `whisper.test.ts`).

## libass text metrics — why burned text did not match the preview (verified ffmpeg 8.1.1 / bundled libass, 2026-09)

Measured by rendering hand-written ASS with the bundled fonts on a flat grey
canvas and reading the pixels, against the same text laid out by Chromium
(the preview / rasteriser) at the same size.

- **`\fs` is NOT the em size.** libass scales a face so its OS/2 Windows
  metrics (`usWinAscent + usWinDescent`) equal `\fs`; CSS `font-size` is the
  em. Burning `\fs` = the CSS size drew every face too small, by its own factor:
  Montserrat 0.64x (1.562 em line box), Poppins 0.57x, Anton 0.58x, Pacifico
  0.52x, Bebas 0.77x. With `\fs = cssPx × (winAscent + winDescent) / unitsPerEm`
  (`assFontSize`, metrics in `shared/fonts.ts`, pinned to the TTFs by
  `fonts.test.ts`) ink width matches Chromium within ±2% on six faces.
- **Line pitch for `\N` = that same Windows height** (118.7px for Montserrat at
  76px CSS; the preview's leading is 1.25em = 95px), and **`\fscy` scales the
  pitch with the glyphs** — there is no way to set libass leading. Hence one
  event per line, placed where Chromium put it (`textLayout.ts`), with
  `WrapStyle: 2` (verified: no wrapping at all, even past the frame edge).
- **`\an5` centres the line box on `\pos`**; the baseline sits
  `cssPx × (winAscent − winDescent) / (2 × unitsPerEm)` below it
  (`assBaselineBelowPos`).
- **Chromium's text box (Windows / DirectWrite)** is the typo metrics when
  USE_TYPO_METRICS is set, else the Windows metrics (Bebas, Archivo Black),
  ascent and descent each rounded to whole px. Canvas
  `measureText().fontBoundingBoxAscent` equals the laid-out baseline offset —
  what the layout pass reads. Faces taller than the leading (Poppins 1.40em,
  Pacifico 1.76em) have OVERLAPPING line boxes; line grouping must go by the
  box top, not its bottom.
- **BorderStyle-3 box = the line's Windows box + `\bord` on every side**, square
  corners, one per line (adjacent lines' boxes overlap); `\xbord`/`\ybord`
  split the padding. **The alpha byte inside `\3c&HAA…` is ignored** (a
  `#000000cc` pill burned solid black); `\3a` carries it. Pills are now `\p1`
  rounded-rect drawings of the box Chromium measured, with `\1a`.
- **`\bord` is drawn wholly outside the glyph**; a CSS `-webkit-text-stroke` of
  the same width with `paint-order: stroke fill` shows only half (8px CSS →
  3.5–4px visible). Burn `\bord = width / 2`.
- **An empty leading `{\k100}` is a delay** (the next syllable lights 1s later)
  — how a karaoke line waits for the words on the lines before it.
- **`\org(x,y)` + `\frz` on separate events rotates them as one block** about
  the shared origin (a rotated multi-line caption).
- **`\p1` drawings with `\an5` centre their bbox on `\pos`** (400x130 path →
  exactly 400x130 at the right place), `\1a&H33&` = 80% opaque.
- Known limit: karaoke's unlit words dim only their FILL (`\2a`); the outline
  and shadow stay full strength, where the preview fades the whole word.

After: libass burn vs the preview's CSS (Chromium at output size), line by
line — tops/bottoms ≤1px, centres ≤0.5px, widths 0.995–1.007, same line
count, pill boxes identical. `e2e/textParity.spec.ts` pins it on real exports.

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

## Matte decode — windowed seek, frame rate & audio (verified ffmpeg 8.1.1, 2026-09)

Background removal mattes ONE source window (`-ss`/`-t` before `-i`) as raw
frames piped through the model, then re-encodes them with the window's audio
(`removeBackgroundArgs.ts`).

- **Output `-r` after an input `-ss` mis-cadences a rate change.** A 60 fps
  source whose frame N has gray level N, decoded with `-ss 3.5 -t 2 -i src
  -r 30 -f rawvideo`, gave **62** frames starting `210 211 212 213 215 217…`
  (the first few at the source rate) and ending ~3 source frames (50 ms) late.
  The **`fps=30` filter** gives exactly 60 frames, `210 212 214…` — frame k is
  source `W + k/30` — and is equally exact from 29.97 and 30 fps sources, and
  at `fps=60`. So the matte sets its rate with the filter, placed FIRST so an
  HDR tonemap / scale only runs on kept frames (HDR chain verified: 60 frames
  for a 2 s window). End to end on a real 59.92 fps rotated iPhone clip, a
  matte of source 12–16 s matches the source at offset 0 (mean |ΔRGB| over
  foreground 4.1) vs ≈22 at ±1 frame.
- **Two inputs, one of them a slow pipe, mux fine.** Encoding `-f rawvideo -i
  pipe:0` (the model's frames) with `-ss W -t D -i source -map 0:v:0 -map
  1:a:0 -c:a libopus` does not choke on the audio arriving far ahead of the
  video — verified with a 150 s window fed at a fraction of the demux speed.
  The audio is sample-accurate to the window: beeps on every whole second of
  the source, window start 2.5 → onsets at 0.500 / 1.500 / 2.500 in the matte.
  Opus resamples 44.1 kHz → 48 kHz on its own; the Opus stream reads ~8 ms
  longer than the video (4.008 vs 4.000) — harmless, the layer's `outSec`
  stays the window length.
- The WebM keeps `alpha_mode=1` and the exact alpha with an audio stream
  alongside. DirectML and CPU inference give the same matte (alpha-plane PSNR
  55 dB between the two).
- **ffmpeg creates its output file when it STARTS.** `existsSync(out)` is not
  "done": a half-written faststart mp4 has no `moov` yet, and Chromium's
  `<video>` fails it permanently with `DEMUXER_ERROR_COULD_NOT_OPEN`. This is
  why the matte job awaits the alpha proxy before handing the clip back. (The
  library's own `proxyReady = existsSync(proxy)` still has this race for
  ordinary imports — tracked as a bug.)

## Layer rotation — free angle (verified ffmpeg 8.1.1, 2026-09)

Verified with lavfi solid boxes over a red base and pixel samples, then again
through the real exporter (`e2e/rotationExport.spec.ts`). Drives
`rotateFilter` (`ffmpegFilters.ts`) and the rotated chains in `exporterArgs.ts`:

- **`rotate=a=<rad>` with a POSITIVE angle turns CLOCKWISE** on screen: a
  400×200 box at +30° puts its +x end at (+cos, +sin) with y down. That matches
  CSS `rotate()`, so `Layer.rotationDeg` goes to ffmpeg with no sign flip
  (libass is the opposite: `\frz` is counter-clockwise, hence `\frz-deg`).
- **`ow='ceil(rotw(a)/2)*2':oh='ceil(roth(a)/2)*2':c=none`** grows the frame to
  the rotated bounds and leaves the corners TRANSPARENT, but only if the input
  already has alpha (`format=yuva420p` / `rgba` first). Odd rotated sizes also
  rendered fine with yuva420p; the chain rounds up to even anyway.
- **Alpha survives `rotate`**: a source whose left half is alpha 0, turned 90°,
  shows the base through the (now top) transparent half. So bg-removed clips
  keep their matte.
- **`rotate` sizes its output ONCE, at configure time**, so it can't follow a
  per-frame `scale=…:eval=frame` upstream of it. Keyframed layers therefore
  rotate at a fixed size (the largest keyframe box) and THEN scale per frame to
  each keyframe's rotated bounds. Checked: a 90°-rotated box scaled 1→2× over
  1s stays centred and covers exactly 200×400 → 400×800.
- **Position**: the rotated output is the rotated bounds, so a rotated layer is
  overlaid by its CENTRE (`x='cx-overlay_w/2'`), static or keyframed.
- **Text**: libass rotates each line about the block centre (`\org`), and a
  `\move` inside that event is turned about the fixed `\org` as well. So a
  rotated `slideUp` travels along the text's OWN axis (measured: mid-slide ink
  offset = rotateVec(0, 45px, 30°) within 1px), and the preview matches that by
  rotating its slide offset. The libass burn and the Chromium raster of the
  same rotated block agree to within 1.5px at the ink centroid; the extreme
  glyph tips differ by 3–6px (anti-aliasing).
- Sparkles on rotated text are placed by rotating their offsets in the
  exporter (`rotateVec`), not with `\org`. Checked by eye: preview
  screenshot vs export frame at 60°, same scatter along the letters.

## Straight-line motion — text in libass (verified ffmpeg 8.1.1 / bundled libass, 2026-09)

Verified with `\p1` box drawings (font-independent) burned over lavfi, then
through the real exporter (`e2e/motionExport.spec.ts`). Drives `placeTag` /
`slideEvents` in `assBuilder.ts` and `moveSlice` in `shared/motion.ts`:

- **`\move(x1,y1,x2,y2,t1,t2)` holds** at (x1,y1) before `t1` and at (x2,y2)
  after `t2` (ms from the event start). A box moving 200→600 over 500–1500ms
  of a 2s event read 200 / 400 / 600 at 0.25 / 1.0 / 1.75s. So a straight move
  with holds either side is ONE windowed `\move` on each event; no split.
- **A `\move` under a fixed `\org` + `\frz` travels along the ROTATED axis**:
  +100px in x at `\frz-90` (90° clockwise) rendered as +97.5px down at 97.5% of
  the move. So a rotated block's screen-space travel `d` is written as `R⁻¹·d`
  (`local` in `assBuilder`), and libass turns it back. Checked end to end: a
  30°-rotated text layer moving 480px right burns a straight horizontal path.
- **The complex `\fade(a1,a2,a3,t1,t2,t3,t4)` continues a partial fade
  exactly**, multiplying with a colour's own alpha like `\fad` does: one event
  with `\fad(2000,0)` vs the same split at 1s into two events with
  `\fade(255,128,128,0,1000,…)` / `\fade(128,0,0,0,1000,…)` agreed within 1
  level at six sample times over a 50%-alpha colour. That is what lets a slide
  that overlaps a move split into straight pieces without a fade glitch.
- `\p1` drawings are placed from their own bounds, not the origin: a box drawn
  from −20..20 lands 20px up-left of its `\pos`. Irrelevant to relative checks,
  but sample inside the box when you pixel-test a drawing.
- Rasterised (PNG) text that moves is rendered at the frame CENTRE and travels
  on the image keyframe path (`overlay` x/y expressions), so a move that
  starts off-frame isn't clipped out of the PNG.

## Renaming a file ffmpeg is reading (verified ffmpeg 8.1.1 / Node 24 / Windows 11, 2026-10)

Library Rename (`renameMedia`, docs/MEDIA-POINTERS.md "Rename") renames the
user's original with `fs.rename`. Checked in a scratch dir with a 20 s lavfi
clip read by `ffmpeg -re -i clip.mp4 -f null -`:

- **While ffmpeg reads the file, `fs.rename` fails with `EBUSY`** (errno
  −4082, "resource busy or locked") — for a different name and for a
  case-only change alike. ffmpeg opens its inputs without
  `FILE_SHARE_DELETE`, so Windows refuses the move. After ffmpeg exits the same
  rename succeeds. `renameFailureMessage` maps `EBUSY` (and `EPERM`/`EACCES`,
  what other locking or protected files give) to a plain "in use — by another
  program, or the editor is still reading it" message (the editor's own
  thumbnail/waveform/mono-fold/silence passes read originals without a job);
  `renameMedia` also refuses up front while a job that registered the media in
  `createJob(…, { uses })` is running, or a loudness pass is measuring it.
- **A file Node itself has open does NOT block a rename** (libuv opens with
  `FILE_SHARE_DELETE`): a `fs.open` handle held across the call didn't stop it.
- **`fs.rename` silently REPLACES an existing target on Windows** (libuv uses
  `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`): renaming `a.txt` onto an
  existing `b.txt` succeeded and `b.txt` then held `a`'s bytes. A rename must
  check the target itself — `renameMedia` stats it first.
- **Case-only renames work** (`clip.mp4` → `CLIP.mp4` and back), and
  `existsSync`/`stat` of the other-case name finds the file itself (same
  `ino`). So "the target exists" is true for a case-only change; `renameMedia`
  compares `ino` (bigint stat) to tell "the same file" from "another file".

## Single-frame renders of the export graph (verified ffmpeg 8.1.1, 2026-10)

`render_frame` (`buildFrameArgs`) runs the export's own inputs and chains and
keeps single frames of the final composite. It was checked against a miniature
of the real graph: a 60 s base, a trimmed overlaid clip with `setpts` and
`eof_action=repeat`, an ASS burn with `fontsdir` holding a `\fad` line and a
`\k` line, a PNG top overlay and an aac mix. Every candidate frame was
hash-compared (`framemd5`, yuv420p) against a lossless full render.

- **Frame index.** Output frame n has pts n/30, and `ass` and `enable` see
  t = n/30. So the frame on screen at T is **floor(T·30)** (`frameIndexAt` adds
  1e-6 for float noise). The base `color=…:d=D` emits **ceil(D·30)** frames, so
  later times clamp to frame ceil(D·30) − 1.
- **Use `trim=start_frame=N:end_frame=N+1` on the final label.** It is an
  exact integer index, and the existing `-r 30 -fps_mode cfr` stays. With
  `split` you get several frames in one pass, each with its own
  `-map … -frames:v 1 … out.jpg`. Hashes matched the reference at frames 150,
  307, 630 and 1650. That covers the `\fad` mid-ramp (307 and 308 differ) and
  karaoke state: `\k` lights a word at its start.
- **Output `-ss` rounds to the NEAREST frame.** `-ss 10.25 -frames:v 1` gave
  frame 308, but 307 is the one on screen at 10.25.
- **`select` duplicates under `-fps_mode cfr`.** `select='eq(n,150)+…'` gave
  frame 150 four times. It needs `-fps_mode passthrough`, and `-r 30` with
  passthrough is an error.
- **An unmapped audio graph is fatal**: "Filter 'anull:default' has output 1
  (aout) unconnected". Stills mode drops the audio inputs and graph entirely
  (`audio: []`). Video hashes are unchanged without them.
- **JPEG output.** mjpeg with `-pix_fmt yuv420p` writes yuvj420p with the range
  converted (black Y=0). At `-q:v 2` the JPEG is about 46 dB from lossless
  frame n, and about 25 dB from n±1, so the right frame is unambiguous. A trim
  past the end yields zero frames, and ffmpeg fails with exit −22 ("Non
  full-range YUV is non-standard"), which is why the index is clamped.
- **Downscale after the trim.** `render_frame` appends `,scale=W:H:flags=bicubic`
  to each trimmed branch, fitting 1280 px on the long side (`STILL_MAX_SIDE`).
  Checked in e2e: a 1080×1920 project gives a 720×1280 JPEG with the caption
  where the lane puts it.
- **Cost** (median of 3, 20 Mb/s 1080×1920 source): about 0.35 s at t=5 and
  about 1.7 s at t=55; four frames in one pass take about 1.7 s. The full
  render took 10.3 s. Decoding up to t dominates, so late frames cost the most.
  Text layout (Chromium) and nested-comp pre-renders come on top, the same as
  for an export. The stabilization pre-pass is skipped for stills.

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
