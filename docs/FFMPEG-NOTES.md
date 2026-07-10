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
