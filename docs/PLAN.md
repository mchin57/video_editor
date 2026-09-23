# Local Reels Video Editor — Implementation Plan (Electron + TypeScript)

## Context

The user is a triathlon coach using Instagram Reels for client acquisition (strategy documented in `C:\Users\57tuc\Desktop\Code\coaching_webapp\obsidian_notes\Instagram Strategy\`). He films on iPhone and edits on this Windows PC. He wants a **local video editing program** that supports all major formats, prioritizes iPhone footage, and bakes in the features his strategy notes say drive Reel performance:

- 9:16 vertical output, 30–90s sweet spot, hook text in the **first 3 seconds**
- Text overlays mandatory (~half of viewers watch muted); Instagram OCRs on-screen text and transcribes speech for ranking → captions and spoken keywords matter algorithmically
- Safe zones: bottom ~25% and right rail are covered by Instagram UI
- Clean, watermark-free H.264 exports; hybrid-carousel 3–5s video-slide exports

`C:\Users\57tuc\Desktop\Code\video_editor` is empty (greenfield, not a git repo). User explicitly okayed departing from his Python/React webapp stack if something fits better.

## Stack decision: Electron desktop app, TypeScript end-to-end

**Why this over a React+Python local web app** (the rejected first draft): single language and toolchain (shared TS types between UI and engine instead of pydantic models mirrored by hand), a real installable desktop app (native file dialogs, drag-drop from Explorer, packaged .exe — no "start two servers, open a browser tab"), job progress pushed over IPC instead of HTTP polling, and ffmpeg orchestration via `child_process` is equally capable in Node. The one thing Python did better — faster-whisper — is replaced by **whisper.cpp** spawned as a child process (same pattern as ffmpeg); the i9-14900K runs `small.en` several times faster than realtime on CPU, with an optional CUDA/Vulkan build upgrade path. React skills carry over fully.

- **Scaffold**: electron-vite (React + TS template), Tailwind CSS 4, electron-builder (NSIS installer) for packaging.
- **Hardware leverage**: RTX 4070 Ti Super → `h264_nvenc` exports (libx264 fallback); i9 → CPU whisper.cpp.
- **Not installed yet** (verified): ffmpeg, Node. Setup: `winget install Gyan.FFmpeg OpenJS.NodeJS.LTS` (Gyan **full** build has h264_nvenc, libx264, libass, zscale — conda-forge/static builds often lack NVENC).

## Key technical decisions

| Decision | Choice | Why |
|---|---|---|
| Preview | **H.264 proxy files** generated on import | Browsers/Chromium can't reliably decode iPhone HEVC on Windows. Originals kept for export. HDR sources get the same tonemap as export → preview colors match output. |
| Media serving to renderer | Tiny **localhost HTTP server in main process** (express/serve-static on 127.0.0.1, random port) | `<video>` seeking needs HTTP Range; serve-static handles it for free. (Electron `protocol.handle` with manual Range parsing is the no-server alternative; localhost server is the simpler, known-robust choice.) |
| Jobs | **JobManager in main process** (registry, concurrency limits, cancel); progress pushed via `webContents.send` | Proxy/transcribe/export are long-running; IPC push beats polling. |
| Export | **Per-clip intermediate renders → concat demuxer → one final pass** | Handles mixed resolution/framerate/HDR per clip; debuggable artifacts; avoids giant-filtergraph quoting hell. Intermediates: near-lossless H.264 + **PCM audio** in .mov (AAC encoded once at the end → no concat gaps/clicks). |
| Text on export | **One ASS file** (captions + hook overlays) burned via `ass=` filter, `PlayResX=1080 PlayResY=1920` | Same logical pixel space as preview → identical coordinates/sizes drive both; same TTF files given to libass via `fontsdir`. |
| Transcription | **whisper.cpp** binary (child process), `small.en` model (~460MB, downloaded on first use), word-level timestamps (`-ml 1` / full JSON output) | Local, no Python runtime; CPU is fast enough for 30–90s reels; CUDA/Vulkan builds optional later. |
| Persistence | **JSON files**, atomic writes (temp + rename); media library folder keyed by content hash | One user, tens of projects; inspectable, no migrations. Default data dir `%USERPROFILE%\Documents\VideoEditor\` (configurable). |
| Renderer state | **zustand** (project doc + bounded undo snapshot stack; separate high-frequency playback store) | Minimal; avoids re-render storms from playhead updates. Typed IPC bridge via contextBridge preload. |

## Repo layout

```
video_editor/
├── package.json, electron.vite.config.ts, electron-builder.yml, tsconfig*.json
├── resources/fonts/             # TTFs burned by libass AND loaded by renderer (e.g. Montserrat ExtraBold)
└── src/
    ├── shared/                  # types shared by main + renderer (the big single-language win)
    │   ├── project.ts           # Project, Clip, TextOverlay, CaptionSegment, MusicTrack
    │   ├── media.ts             # MediaAsset, ProbeInfo (codec/HDR/rotation/VFR/audio)
    │   ├── jobs.ts              # Job, JobStatus, JobType, progress events
    │   └── export.ts            # ExportPreset definitions (Reel/Story/Square/CarouselSlide)
    ├── main/
    │   ├── index.ts             # window, app lifecycle, media HTTP server startup
    │   ├── ipc.ts               # ipcMain.handle registrations (typed, thin → services)
    │   └── services/
    │       ├── ffmpeg.ts        # binary discovery (FFMPEG_PATH → PATH → winget Links glob),
    │       │                    #   capability probe (-encoders/-filters: h264_nvenc, libx264,
    │       │                    #   ass, zscale, sidechaincompress), run with -progress pipe:1
    │       ├── ffprobe.ts       # probe → ProbeInfo (HDR transfer, displaymatrix rotation, VFR)
    │       ├── mediaStore.ts    # import: hash → copy to library, thumb, filmstrip, waveform
    │       ├── proxy.ts         # proxy mp4 generation (incl. tonemap for HDR sources)
    │       ├── jobs.ts          # JobManager: queue, concurrency (NVENC serialized), cancel,
    │       │                    #   progress → webContents.send('job:progress')
    │       ├── transcribe.ts    # whisper.cpp: binary+model download/locate, wav extract, run,
    │       │                    #   parse word timestamps → transcript.json
    │       ├── assBuilder.ts    # overlays + caption segments → styled .ass
    │       ├── exporter.ts      # 3-phase export orchestration (normalize → concat → final)
    │       ├── projectStore.ts  # JSON load/save, atomic write, autosave endpoint
    │       └── mediaServer.ts   # express static server for proxies/thumbs/waveforms (Range OK)
    ├── preload/index.ts         # contextBridge: typed invoke/on wrappers
    └── renderer/src/
        ├── App.tsx, main.tsx, index.css (Tailwind 4)
        ├── ipc/client.ts        # typed wrappers over window.api
        ├── state/editorStore.ts # zustand: project doc, selection, undo/redo
        ├── state/playbackStore.ts
        ├── lib/
        │   ├── coords.ts        # logical 1080x1920 space + safe-zone rects (bottom y≥1440, right x≥972)
        │   ├── timelineMath.ts  # pure: timeline t ↔ (clip, sourceTime); trim/split/reorder ops
        │   ├── captions.ts      # word timestamps → Reels-style segments (≤3 words/~14 chars,
        │   │                    #   break on >0.35s gaps, min 0.4s display); source→timeline time map
        │   ├── captionStyles.ts # style presets; SINGLE SOURCE of numbers also used by assBuilder
        │   └── checklist.ts     # pure rules engine for the Reel checklist
        └── components/
            ├── library/   MediaLibrary, ImportDropzone
            ├── preview/   PreviewStage, VideoSurface, OverlayLayer, CaptionLayer,
            │              SafeZoneOverlay, CropTool
            ├── timeline/  Timeline, ClipItem, TimeRuler, Playhead, HookZoneMarker, MusicTrackRow
            ├── inspector/ ClipInspector, TextOverlayInspector, CaptionEditor, MusicPanel
            ├── export/    ExportDialog, JobProgressBar
            └── checklist/ ReelChecklist
```

Data dir (default `%USERPROFILE%\Documents\VideoEditor\`):
`media/{hash}/original.* | proxy.mp4 | thumb.jpg | filmstrip/ | waveform.png | probe.json | transcript.json` · `projects/{id}.json` · `exports/` · `tmp/{jobId}/` · `bin/whisper/` (binary + models) · `settings.json` (keyword bank, default styles, ffmpeg path override).

## Project data model (sketch)

Project JSON: `clips[]` (mediaId, inSec/outSec trim, crop rect in source px aspect-locked to output, mute/gain), `overlays[]` (text, start/end, x/y in **logical 1080×1920 px**, font/size/color/pill), `captions` (enabled, style preset, yBaseline above safe zone, editable segments with word timings), `music` (mediaId, volumeDb, duck, fadeOutSec). `probe.json` per asset: codec, dimensions, rotation (displaymatrix), VFR flag (`r_frame_rate ≠ avg_frame_rate`), HDR (`color_transfer ∈ {smpte2084, arib-std-b67}`), audio specs.

## Core pipelines

### Import (per file; native dialog or drag-drop)
1. Hash file → copy to `media/{hash}/original.ext` (dedupe), ffprobe → `probe.json`. Reject if no video stream.
2. Proxy job: thumbnail, 10-frame filmstrip, waveform PNG (`showwavespic`), then proxy:
   `ffmpeg -i original.mov -vf "{TONEMAP,}scale=...720p,fps=30,format=yuv420p" -c:v libx264 -preset veryfast -crf 23 -c:a aac -ar 48000 -ac 2 -movflags +faststart proxy.mp4`
   (rotation auto-applied by ffmpeg; proxies always libx264 — keeps NVENC free for exports).
3. **HDR→SDR tonemap chain** (inserted only for PQ/HLG sources; identical on proxy and export — this is the preview-fidelity contract):
   `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`
4. Progress parsed from `-progress pipe:1` (`out_time_us` / duration) → IPC events.

### Preview composition (renderer)
- Stage div is literally 1080×1920 CSS px scaled by `transform: scale(containerWidth/1080)` → overlay/caption stored coordinates are used directly as inline styles; the **same numbers** go into ASS on export.
- Safe-zone overlay (toggleable): bottom 25% (y ≥ 1440) + right rail (x ≥ 972); rects shared with checklist via `coords.ts`.
- Playback: timeline t → (clip, sourceTime) via `timelineMath.ts`; two stacked `<video>` elements (active plays, inactive pre-seeked to next clip's in-point, swapped at boundary for near-gapless playback); rAF loop reads `video.currentTime` as the clock.
- Crop simulated with CSS translate+scale; export uses the identical rect (`crop=w:h:x:y,scale=1080:1920`) — exact by construction.
- Trim/split/reorder/delete as pure functions (unit-tested). Undo/redo = bounded snapshot stack of the (small) project doc. Autosave debounced 1s. `HookZoneMarker` shades 0–3s on the ruler.

### Export (job, 3 phases; weighted progress ~70/30)
1. **Per-clip normalize** → `tmp/{job}/clip_NN.mov`: fast `-ss` before input + accurate trim after; `-vf "{TONEMAP,}crop=W:H:X:Y,scale=1080:1920:flags=lanczos,fps=30,format=yuv420p,setsar=1" -fps_mode cfr` (kills iPhone VFR); audio `aresample=async=1:first_pts=0` → 48k stereo **pcm_s16le** (muted/audio-less clips get `anullsrc` so every intermediate has identical streams); video `h264_nvenc -preset p5 -rc vbr -cq 12` (fallback `libx264 -crf 12`).
2. **ASS generation** (`assBuilder.ts`): one subs.ass, `PlayResX 1080 / PlayResY 1920`; per-overlay style (BorderStyle=3 box for the pill — square corners in v1, preview renders with radius 0 to match) + caption style (large bold centered, Outline, MarginV from yBaseline); one Dialogue event per overlay/caption segment.
3. **Concat + burn + mix + encode** — run with `cwd = tmp/{job}` and **relative paths only** (avoids Windows `C:` colon breakage inside filter args; spawn with arg arrays, never shell):
   concat demuxer → `[0:v]ass=subs.ass:fontsdir=fonts[v]`; audio graph: music `atrim/asetpts/volume/afade=out`, optional `sidechaincompress` (music ducked by voice sidechain), `amix=normalize=0` + `alimiter` → `-c:v h264_nvenc -preset p5 -rc vbr -cq 19 -b:v 12M -maxrate 16M -bufsize 24M -profile:v high -pix_fmt yuv420p -r 30` + explicit bt709 color tags + `-c:a aac -b:a 192k -ar 48000 -movflags +faststart`. libx264 fallback: `-crf 18 -preset slow`.

**Presets** (`shared/formats.ts`, originally planned in `shared/export.ts`): **Reel** 1080×1920 (spec above) · **Story** (same) · **Square** 1080×1080 · **Carousel slide** (Reel spec over a chosen 3–5s time range). _Since grown into a registry of ten formats (aspect → preset inheritance; 4:5, 3:4, 2:3, 16:9, 4:3, 21:9 added), each a frame window centred on the canonical 1080×1920 space — see TODO.md._

### Captions
Transcribe job: extract 16kHz mono wav via ffmpeg → run whisper.cpp (`small.en`, word timestamps, JSON out) → `transcript.json` (source-time word list). First run downloads binary/model with a visible "downloading model" job phase. Renderer maps source→timeline time through clip trims, groups words into Reels-style segments, all editable in `CaptionEditor` (text, merge/split, retime, per-segment toggle). Preview via `CaptionLayer`; export burns the same numbers via ASS. Default yBaseline sits just above the 1440px safe line.

### Reel checklist (pure renderer logic, live)
duration ∈ [30,90]s · a hook overlay starting ≤3s · captions enabled & covering ≥80% of detected speech · transcript ∪ overlay text contains ≥1 keyword from configurable bank (seeded from his notes: triathlon, Ironman 70.3, swim technique, …; case-insensitive) · all text bounding boxes outside safe zones. Each rule → pass/warn/fail + fix hint in `ReelChecklist` panel.

## Milestones (each independently verifiable)

| # | Scope | Done when |
|---|---|---|
| M0 | `winget install Gyan.FFmpeg OpenJS.NodeJS.LTS`; electron-vite scaffold + Tailwind; ffmpeg discovery + capability probe; media server | App window opens; status footer shows ffmpeg path, NVENC=yes |
| M1 | Import (dialog + drag-drop) + probe + proxy job + player + safe-zone overlay | Real iPhone HDR HEVC .mov imports; proxy plays with correct colors (vs Photos app) and orientation; scrubbing instant |
| M2 | Timeline (trim/split/reorder/delete), playback engine, crop tool, hook overlays + 3s marker, undo, autosave | 3-clip sequence incl. cropped landscape clip + hook title; app restart restores project |
| M3 | Export pipeline + Reel preset + NVENC fallback | Export passes ffprobe spec checks (below); overlay position matches preview via 1-frame extract comparison |
| M4 | whisper.cpp integration + caption editor + ASS burn | 45s spoken clip → editable word-accurate captions; styled burn above safe zone matches preview |
| M5 | Music track, volume, ducking, fade, mute-original, waveform row | Music audibly ducks under speech and fades out; voice unchanged |
| M6 | Checklist + keyword-bank settings + Story/Square/Carousel presets; electron-builder NSIS installer + icon | Checklist flips live while editing; all presets export to spec; installable .exe builds |

Build order: M1's services (`ffmpeg.ts`, `ffprobe.ts`, `jobs.ts`, `mediaStore.ts`, `proxy.ts`) are the foundation; M3 reuses the runner/probe; M4–M5 extend `assBuilder.ts` and the audio graph. Tests: vitest for `timelineMath`, `captions`, `checklist`, `coords`, ffprobe parsing (fixture JSONs from a real iPhone clip), ffmpeg command builders (string assertions), assBuilder golden files.

## Key risks → mitigations

1. **Wrong/missing ffmpeg build** → discovery prefers explicit Gyan path (env override → PATH → winget Links); hard capability check (`ass`, `zscale` required), soft NVENC→libx264 fallback surfaced in UI.
2. **HDR washed out** → probe-driven tonemap identical on proxy + export; explicit bt709 output tags; ffprobe verification step.
3. **A/V drift from iPhone VFR** → `fps=30` + `-fps_mode cfr` + `aresample=async=1:first_pts=0` per intermediate; clap-test at end of timeline; stream durations within 50ms.
4. **Preview↔export text drift** → shared logical 1080×1920 space (`PlayResX/Y`), same TTFs both sides (`fontsdir`), style numbers single-sourced in `captionStyles.ts`; M3 includes 1-frame extraction comparison.
5. **Windows path quoting in filters** → ffmpeg runs with `cwd=tmp/{job}` and relative paths; spawn arg arrays (no shell); hash-based ASCII media filenames.
6. **whisper.cpp distribution** → download prebuilt Windows binary + model on first use with visible progress; CPU build is the reliable baseline (small.en ≫ realtime on i9); GPU build optional later. If prebuilt binaries prove flaky, fallback: ship CPU binary in `resources/`.
7. **`<video>` seeking** → proxies are `+faststart` and served over localhost HTTP with Range support; verified by scrubbing in M1.
8. **NVENC contention** (proxy + export simultaneously) → JobManager serializes GPU encodes; proxies always libx264.
9. **Electron renderer file access** → all media via the localhost server, not file:// (avoids sandbox/security-config pitfalls).

## Verification (end-to-end with real footage)

1. Copy an iPhone HEVC HDR .mov (+ one landscape clip) to the PC; import both.
2. `ffprobe -show_streams original.mov` → confirm hevc, HDR transfer (`arib-std-b67`/`smpte2084`), rotation side data, VFR.
3. Preview colors vs Windows Photos; orientation upright; instant scrubbing.
4. Build 2 clips + hook text in first 3s + captions + ducked music → export Reel preset.
5. Spec-check export with ffprobe: `h264/High/1080x1920/yuv420p`, both frame rates `30/1`, `nb_frames ≈ duration×30` (CFR proof), bt709 across primaries/transfer/space, `aac/48000/stereo`, ~10–14 Mbps, A/V stream durations within 50ms, moov-before-mdat (faststart byte check).
6. Clap-sync test at the end of the timeline (drift accumulates → end is the sensitive point).
7. Upload export as an IG Reel draft: captions readable above the IG UI; checklist all-green beforehand.

## Out of scope for v1 (noted for later)

Multi-track compositing, transitions beyond hard cuts, rounded pill corners on export (ASS BorderStyle limitation), trial-reel A/B variant exports, direct Instagram publishing, GPU whisper build.
