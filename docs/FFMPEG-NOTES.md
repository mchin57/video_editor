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
