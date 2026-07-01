# TODO / backlog

Deferred polish and features, newest-first. Not blocking; pick up as time allows.

## Codebase health

- [x] **De-duplication refactor.** Consolidated the patterns that had drifted into
  3–4 copies into shared homes — UI primitives (`components/ui.tsx`), a pointer-drag
  helper (`lib/pointerDrag.ts`), store array helpers (`lib/arrays.ts`), a shared
  text-style base + generic override resolver + unified `FRAME` (`shared/project.ts`,
  `shared/layers.ts`), ffmpeg filter/geometry helpers (`services/ffmpegFilters.ts`,
  `shared/layers.ts` `containBox`/`effectiveImageAspect`), and an IPC client that
  destructures `window.api` instead of re-wrapping it. Catalog: [`SHARED.md`](SHARED.md);
  guardrails for future work: root [`CLAUDE.md`](../CLAUDE.md). Behavior-preserving
  (tests + typecheck green throughout).
- [x] **Convert `Timeline.tsx` drag handlers to `startPointerDrag`.** The playhead scrub
  + the layer/caption/audio block drags now use the shared helper; the `edgeAutoScroll`
  rAF loop is stopped in the `onUp` callback and the live `scrollLeft` folding is preserved.
- [ ] **Finish the drag-helper sweep.** `Popout.tsx`, `LayersPanel.tsx`, and `Splitter.tsx`
  still hand-roll the pointermove/pointerup dance (small, no edge-scroll) — convert to
  `startPointerDrag` when next touched.

## Open

### Freeze frames, stills & image editing (`feature/freeze-stills-image-edit` branch)

- [x] **Freeze / pause a clip.** A video layer carries source-time `freezes`
  (`VideoContent.freezes`, `src/shared/project.ts`): at source second `atSec` the
  frame holds for `holdSec`, stretching only that clip (no ripple). `videoSourceTime`
  / `isFrozenAt` / `freezeExtraSec` (`src/shared/layers.ts`) make preview honor it
  (the `<video>` is treated as paused during a hold); export stretches PTS via
  `setpts=…+(gte(T-STARTT,atLocal)*holdSec)/TB+…` so the held frame repeats under cfr
  (`exporterArgs.ts`). Store actions `addFreeze`/`removeFreeze` extend `endSec`
  additively; Inspector "Freeze frames" section adds/removes holds at the playhead.
- [x] **Stills from a clip.** `src/main/services/still.ts` grabs the exact on-screen
  frame (same HDR tonemap / crop / color as preview) via `captureStillToLibrary`
  (imports a reusable image asset) or `captureStillToDisk` (Save dialog). UI is the
  draggable `StillsPopout` (capture, gallery, add-as-layer, save-to-disk).
- [x] **Basic image editing.** Image layers gain `crop` (0..1 fractions),
  `rotateQuarters` (90° steps) and `flipH`/`flipV` (`ImageContent`). Preview composites
  them (`PreviewStage`) and export mirrors them (`crop→transpose→flip→scale` in
  `exporterArgs.ts`). UI is the draggable `ImageEditPopout` (free crop box, rotate,
  flip, opacity).
- [x] **Tidier Inspector.** Sub-sections are collapsible with persisted open/closed
  state (`CollapsibleSection`); heavier tools (stills, image editing) live in
  draggable `Popout` panels rather than crowding the panel.
- [x] **Captions follow the audio lane.** "✨ Caption audio" (`CaptionAudioButton`)
  transcribes every audio clip (except those flagged "Exclude from captions") and
  projects each one independently from its own placement — so freeze-split extracted
  pieces caption correctly across the hold, and overlapping audio yields two
  overlapping captions. The old per-video-clip "Caption this clip" is gone; the
  header CC On/Off toggle stays.
- [x] **Styleable captions (global + per-block override).** Captions carry a
  `CaptionStyle` (color, font family, size, center position, rotation, pill —
  `src/shared/project.ts`). `CaptionsConfig.style` is the lane-wide default; each
  `CaptionSegment.style?` is an optional override that exempts that block.
  `effectiveCaptionStyle()` resolves which to use; preview (`PreviewStage`) and
  export (`assBuilder` `\pos/\fs/\c/\frz/pill`, scaled in `exporter.ts`) both honor
  it. Clicking the **Captions** gutter label (`Timeline`) selects the lane-wide
  style; selecting a caption block edits/creates its override (drag-to-move in the
  preview too). Store: `setCaptionStyle` / `setCaptionSegmentStyle` /
  `clearCaptionSegmentStyle`. _Migration v6 seeds `style` from the old `yBaseline`._
  _Note: simultaneous (overlapping) captions still burn at their own positions; if
  two share the global position they'll overlap in export — move/override one._

### Layer compositing (`feature/layers` branch)

- [x] **Unified, type-agnostic layer stack.** Replaced the old sequential-clip
  timeline + separate text/image overlay arrays with a single `project.layers`
  array (`src/shared/project.ts`). Every visual — video, image, text, and any
  future kind — is a `Layer` with a generic `content` payload, an ABSOLUTE
  timeline window (`startSec`/`endSec`), a spatial transform (`x`/`y` center +
  `scale` zoom), and a `hidden` flag. Stacking is array order: index 0 = the
  Background (bottom), last = front; nothing renders behind the bottom layer and
  uncovered areas are black. Multiple video layers composite and play at once via
  a wall-clock master in `PreviewStage` (each `<video>` follows the clock like
  the audio followers). Pure helpers + tests in `src/shared/layers.ts`.
  - **Layers menu** (`components/LayersPanel.tsx`): lists the layers on screen at
    the playhead, front→back; follows the timeline (a layer drops out the moment
    the playhead leaves its span and the panel resizes); per-row visibility
    checkbox; drag the ⠿ handle to restack; Background pinned at the bottom.
  - **Move/zoom** any layer on the canvas (drag to move, corner handle/Inspector
    slider to zoom); out-of-frame is cropped by the stage.
  - **Timeline lanes** (`components/Timeline.tsx`): the blocks are grouped into
    labeled lanes (Clips / Text / Image, then Captions / Audio) with a fixed left
    gutter — a purely visual grouping over the unified stack (z-order lives in the
    Layers menu). Overlapping same-type blocks pack into rows (`lib/lanes.ts`).
  - **Drag-and-drop from the Library** onto the timeline drops a layer (or audio
    clip) at the cursor position; clips/images also have **＋ PH** (add at
    playhead) and **＋ End** (add to end) buttons in the Library.
  - **Per-clip captions**: a video layer's Inspector has "Caption this clip"
    (transcribes that clip, id-tagged segments, idempotent re-caption). The global
    show/hide toggle lives in the **Project settings** menu (`ProjectSettingsMenu`).
  - Audio clips and auto-captions stay on their own (non-visual) tracks.
- [x] **Export: composite the full layer stack.** `exporter.ts` now composites
  in a SINGLE ffmpeg pass (no more normalize+concat): a black base canvas the
  length of the project, then every visible layer overlaid back→front — videos
  and images scaled to their display box, positioned at their center, and
  time-gated to their window (`overlay …enable='between(t,…)'`, `setpts` shift
  for video offset); text layers burn via per-layer ASS so the full z-order
  (incl. text under video) is honored; captions burn on top. Audio mixes all
  audio clips + any unmuted video-layer audio (`buildAudioGraph`, no concat
  "dialogue" base). Pure builder `buildExportArgs` in `exporterArgs.ts`
  (unit-tested). _Remaining: the non-9:16 `square` preset reframes best-effort
  (linear logical→output map, fixed caption font); multi-HD-video passes can be
  slow (expected for compositing)._

### Platform profiles system

- [ ] **Platform profiles** — replace the hardcoded Instagram-specific UI with a profile system. Each profile bundles export presets, checklist rules, safe-zone guides, default overlay styles, and aspect ratio. Profiles can be toggled on/off; their features (checklist, safe-zone overlay, hook-zone marker, keyword bank) only appear in the UI when the profile is active.
  - **Built-in profiles to ship with:**
    - `Instagram Reels` — current behavior: 9:16 1080×1920, 30–90s rule, hook-zone marker, safe-zone overlay, caption keyword checker, Reel/Story/Carousel presets.
    - `General` — no platform-specific rules; just timeline + export. Useful as a blank slate.
  - **Custom profiles** — user can create, name, duplicate, and delete profiles; each stores its own set of rules and presets in `settings.json`.
  - **UI:** add a menu bar (File / Edit / Profile / …) across the top of the app window — standard dropdown tabs. `Profile` menu lists available profiles with a checkmark on the active one, plus "New profile…" and "Manage profiles…" actions.
  - Where to start: `src/shared/export.ts` (profile type), `src/main/services/projectStore.ts` (persist active profile), `src/renderer/src/state/store.ts` (the `useEditor` store — add the active profile here; note there is no `editorStore.ts`), new `ProfileMenu` component. Conditionalize the checklist (`ChecklistModal.tsx` + `lib/checklist.ts`) and the safe-zone + hook-zone overlays (currently inline `<div>`s in `PreviewStage.tsx`, driven by `SAFE_ZONES`/`HOOK_WINDOW_SEC`) on the active profile's flags — there are no `ReelChecklist`/`SafeZoneOverlay`/`HookZoneMarker` components today. The shared `FRAME` (`shared/layers.ts`) and the `resolveOverride` tri-state pattern (`shared/project.ts`) make profile-scoped defaults straightforward.

### Text updates

> Research/spec for the Fonts + Colors sections: [`research-text-fonts-colors.md`](research-text-fonts-colors.md).
> Implemented on the `feature/text-fonts-colors` branch (see notes below).

#### Fonts
- [x] **Expand bundled font library** — 14 OFL/Apache fonts ship in `resources/fonts/`
  (committed; added to `electron-builder.yml` `extraResources` and served to the
  renderer via `reelmedia://fonts/<file>`). The catalog is `src/shared/fonts.ts`
  (id → file → libass `assName`), the single source of truth for picker, preview
  `@font-face`, and export. Caption: Montserrat ExtraBold/Black, Poppins
  ExtraBold/Black, Barlow Semi Condensed. Hook/Display: Anton, Bebas Neue, Archivo
  Black, Barlow Condensed. Stylized: Permanent Marker, Bangers, Pacifico,
  Shrikhand, Abril Fatface. _Key fix: `assBuilder` previously ignored `fontFamily`
  entirely (always Arial) — it now emits `\fn<assName>\b0` and the exporter passes
  `fontsdir` to every `ass=` filter (Windows path-escaped). `fontFamily` now stores
  a bundled-font **id**; migration v7 normalises legacy CSS-stack values._
- [x] **Font picker UI** — `FontPicker.tsx`: scrollable, grouped by category, each
  option previewed in its own font. Used by both text layers and captions (replaces
  the old free-text caption "Font family" box). Preview drops the hardcoded
  `font-extrabold` so each face renders at its real weight.

#### Colors & styling
_All apply to **both** text overlays and captions via the shared
`TextStyleControls` component + a shared `TextDecoration` on `TextContent` /
`CaptionStyle`._
- [x] **Gradient text** — 2-stop angle-configurable linear gradient (+7 presets).
  Preview via `background-clip:text`; export rasterises the text to a transparent
  full-frame PNG via an off-screen window (`textImage.ts`) and composites it
  (gradient text layers keep z-order; gradient captions burn on top). Falls back to
  a flat ASS burn if rasterising fails.
- [x] **Brand color presets** — `Settings.brandColors` (seeded palette) persisted in
  `settings.json`; swatch strip in the style controls (click to apply, ＋ to save,
  right-click to remove). _Global for now; move under the active profile when the
  Platform-profiles system lands._
- [x] **Semi-transparent pill backgrounds** — pill control now splits into a 6-hex
  color + a 0–100% opacity slider (recombined into the 8-hex `PillStyle.color`).
- [x] **Stroke / outline control** — width + color fields → `\bord`/`\3c`
  (suppressed while a pill is on, since BorderStyle=3 owns those tags). Default 8px
  black; preview via `-webkit-text-stroke` + `paint-order`.
- [x] **Drop shadow control** — distance + color + softness → `\shad`/`\4c`/`\blur`
  (libass has no independent x/y offset). Preview via `text-shadow`.

#### Text animation effects
- [ ] **Per-overlay entrance animation** — add an `animation` field to text overlays with these presets (rendered in preview via CSS animation; burned to video on export by rendering the animated frames via a canvas/offscreen approach or an ffmpeg `fade`/`drawtext` trick):
  - **Fade in** — opacity 0→1 over the first 0.3s. Universal default.
  - **Slide in from bottom** — translates up into position. Most common caption entrance.
  - **Typewriter** — characters reveal one-by-one. Popular for hook text.
  - **Bounce** — overshoots position slightly then settles. Fun/casual tone.
  - **Word-by-word highlight** — karaoke-style; each word lights up as it's spoken (driven by whisper word timestamps). High engagement for spoken-word content.
- [ ] **Exit animation** — matching fade-out or slide-out at the end of the overlay's duration.

#### Other
- [ ] **Beat sync** — detect transients/beats in the music track and expose them as snap points on the timeline ruler, so cuts and text entrance animations can be snapped to the beat automatically.
- [ ] **Text style templates** — save a full combination of font + size + color + pill + stroke + animation as a named "style" that can be applied to any overlay in one click. Stored in `settings.json`; surfaced in the Inspector as a style picker above the individual controls. _The natural unit to save/apply is `TextStyleBase` (`shared/project.ts`) — the shape `TextContent` and `CaptionStyle` already share via `TextStyleControls`._
- [ ] **Text-behind-subject effect** — composite a text layer between the subject and background using the auto background removal mask (see subject-aware crop item). Requires the segmentation feature to be built first.

### Not planned / missing features

- [x] **Delete button applies to all timeline objects** — both the `Del` keybind
  (`App.tsx`) and the toolbar 🗑 button (`Timeline.tsx`) delete whatever is selected,
  checking `selectedLayerId` → `selectedCaptionId` → `selectedAudioId` in priority
  order (`deleteSelected`/`canDelete`). The button's disabled state reflects any
  selection, not just a layer. (Layers cover both text and image content.)

- [x] **Library clip preview** — preview a clip from the library without placing it.
  Hovering a video card pops out a large floating preview beside it (`PreviewPopout`,
  `Library.tsx`): portaled to `<body>` so library/timeline overflow can't clip it,
  anchored to the card's rect (flips to the other side near the viewport edge), sized
  to the clip aspect (≤560px tall), looping **with sound**, and dismissed on mouse-leave.
  `pointer-events-none` keeps the cursor "on" the card. Unmuted autoplay is enabled via
  `autoplayPolicy: 'no-user-gesture-required'` (main-window `webPreferences`, `index.ts`).
  Audio cards toggle inline play/pause on click (`AudioThumb` — ♪ shows ▶/⏸ on hover,
  drives a hidden `<audio>`).

- [ ] **Scrub bar on the library preview popout** — add a progress/scrub bar to the
  hover `PreviewPopout` (`Library.tsx`) so a clip can be quickly moved through without
  placing it on the timeline. Bar shows `currentTime/duration` (via the video's
  `timeupdate`); click/drag to seek (`video.currentTime = frac * duration`), ideally
  pausing the loop while scrubbing.
  - **Key blocker (why it's not trivial):** the popout is currently
    `pointer-events-none` and is dismissed by the card's `onMouseLeave`, so the cursor
    can't enter the popout to grab the bar without instantly closing it. Need to make
    the popout interactive and keep it open while the cursor is over *either* the card
    *or* the popout — e.g. a shared hover group with a small close delay (timeout
    cleared on re-enter) so moving from card→popout doesn't dismiss, plus an invisible
    "bridge" over the gap. Watch for re-introducing the hover flicker the
    `pointer-events-none` design was added to avoid.
  - _Possible extra: scrub-on-hover (seek by horizontal cursor position over the bar)
    and a current-time / duration readout._

- [ ] **Multi-clip layout formats (split screen, panels)** — place multiple clips side-by-side or in a grid within a single frame at a given timeline position. Built-in layout presets to ship:
  - **Split screen (2-up):** left/right or top/bottom, each half fills its cell.
  - **3-panel (landscape strip):** three equal columns.
  - **3-panel (portrait stack):** three equal rows.
  - **3-panel (1 large + 2 small):** large cell left, two stacked cells right (and mirrored variant).
  - **4-panel grid:** 2×2 equal quadrants.
  - Each layout is a named preset that defines N cells, each with a rect in logical 1080×1920 space. On export, each cell maps to an ffmpeg `crop+scale+overlay` chain composited onto a black (or custom color) background. Preview renders each cell as a positioned/sized `<video>` element within `PreviewStage`.
  - Data model: a `LayoutClip` type in `shared/project.ts` — a timeline segment that holds an array of `{ mediaId, inSec, outSec, cell: CellRect }` entries plus a `layoutPresetId`. Layout clips sit in their own timeline lane.

- [ ] **Custom layout editor** — a drag-and-drop canvas for creating and saving custom multi-clip layouts beyond the built-in presets. User can add cells, resize/reposition them freely within the 1080×1920 frame, set a background color or image, and save the result as a named preset that appears alongside the built-in ones. Saved presets stored in `settings.json` under `customLayouts[]`. Implementation: a `LayoutEditor` modal with a scaled-down 1080×1920 canvas; cells are resizable/draggable divs; outputs a `LayoutPreset` definition identical in shape to the built-ins so the rest of the pipeline is unaffected.

- [ ] **Clip-audio locking** — allow a video clip to be locked to an audio clip so they move and split together. When locked, dragging either clip moves both by the same delta; splitting either at the playhead splits both at the same timeline position. UI: a small lock icon between the video and audio lanes on overlapping clips; click to toggle. Data model: add an optional `lockedAudioId` field on `Clip` (and `lockedClipId` on `MusicTrack`) referencing the paired asset. Logic lives in `timelineMath.ts` — move/split ops check for a lock and apply the same operation to the paired track before returning the new project state. Undo/redo snapshots capture both changes atomically.
  - **Open question:** when one locked clip is deleted, should the other be deleted automatically, or just unlocked and left in place? Could be a preference (always delete both / always just unlock / ask each time).

- [x] **Split audio clips on the timeline** — audio clips support split-at-playhead like video clips. Each split yields two independent segments with their own `inSec`/`outSec` (outer fades preserved, the seam is hard); they can then be moved/trimmed/deleted separately. Pure `splitAudioClip` in `lib/timeline.ts` (unit-tested) → `splitAudioAt` store action (undo-snapshotted via `commit`). Wired to both the ✂ Split button and the **S** keybind, which now act on whichever is selected (audio clip or video clip — selection is mutually exclusive). Whole-source clips (`outSec<=0`) resolve their end from the source duration; the keybind reads it from the library via a ref.

- [x] **"Extract audio from clip" via File menu** — File ▸ "Extract audio from clip…" picks any video and pulls its audio into the project library as a standalone audio asset (no timeline placement needed), ready to drag onto the music track. `media:extractAudioDialog` IPC → `extractAudioToLibrary` (`mediaStore.ts`): probe-guards "no audio track", extracts lossless WAV (`-vn -c:a pcm_s16le`, `buildExtractAudioArgs`), content-addresses it under `<data>/extracted/<hash>.wav` (idempotent re-extraction), then reuses `importFile` (new optional `displayName`) + background `ensureProxy` for the AAC proxy/waveform. Progress shows via the jobs pipeline; `useExtractAudio` adds the result to `mediaIds`.

- [x] **Project-scoped media library** — the library now reflects only the current project's media, not a global pool. New project = empty library; opening a `.reel` auto-populates from its `mediaIds` (legacy files without one are backfilled from referenced clips/images/audio in `migrateProject`). The `media/{hash}/` store on disk stays global; each project's `mediaIds: string[]` scopes what the panel shows. The library's × removes from the project list only (kept on disk; other projects may reference it). Implemented via `Project.mediaIds` (`shared/project.ts`), `getProjectMedia(ids)` + `media:listForProject` IPC, `useProject.addMedia/removeMedia`, and `useLibrary` keyed on `project.mediaIds`.

- [ ] **Auto background removal (subject-aware crop)** — detect the primary subject (person) in a clip using a segmentation model and remove or replace the background automatically. Likely approach: run a lightweight portrait segmentation model (e.g. MediaPipe Selfie Segmentation or ONNX rembg) frame-by-frame as a job in the main process, output an alpha-masked overlay, then composite via ffmpeg `overlay` + `alphaextract`/`alphamerge`. User can choose to replace the background with a solid color, blur, or a custom image. Useful for creating clean talking-head Reels without needing a physical green screen.

- [x] **Color correction controls** — per-clip exposure/contrast/saturation (Inspector sliders; preview CSS filter mirrors export `eq`).
- [x] **Motion stabilization (project default + per-clip override)** — mirrors the
  noise-filter shape. `Project.stabilizeDefault` (`Stabilize | null`, null = off) is
  the project-wide default; `VideoContent.stabilize` is **tri-state** (`undefined` =
  inherit the default, `null` = force off, a `{shakiness, smoothing}` object = force
  on with these settings). `effectiveStabilize`/`stabilizeOverridden`
  (`shared/project.ts`) resolve it. Export runs a vidstab **two-pass** _before_
  compositing on the resolved setting: `vidstabdetect` (pass 1) writes a transforms
  file, `vidstabtransform` + `unsharp` (pass 2) renders a trimmed, SDR, stabilized
  intermediate that the single-pass compositor then reads from 0 (HDR tonemap folded
  into the pre-pass; trim/freezes preserved). Pure builders
  `buildVidstabDetectArgs`/`buildVidstabTransformArgs` (`exporterArgs.ts`,
  unit-tested); orchestrated by `stabilizeClip` in `exporter.ts`. UI: project default
  in the Inspector's "Project settings" (toggle + shakiness/smoothing); per-clip a
  Default/On/Off segmented control (sliders when forced on); overridden video clips
  show a small **S** badge (green = on, struck = off) on their timeline block.
  _Migration v8 seeds `stabilizeDefault=null`. Export-only — preview is unaffected; a
  long analysis shows no progress until the encode starts._
- [ ] **LUT (.cube) support** — import a `.cube` LUT file and apply it per clip on export via ffmpeg `lut3d` filter. Preview approximation via CSS or a canvas-based LUT lookup. Useful for cinematic grades and consistent brand look across clips.
- [ ] **Speed ramping** — no variable speed or slow-mo support. Common in short-form video; would require ffmpeg `setpts` + `atempo` per clip segment and timeline representation of speed curves. _(Large.)_
- [ ] **Keyframe animation** — no way to animate overlay position, scale, or opacity over time. Would require a keyframe store per overlay property and interpolation in both preview and ASS export. _(Large.)_
- [x] **Snap-to-grid / magnetic timeline** — block move/trim snaps to clip/audio boundaries, playhead, and 0 (`lib/snap.ts`).
- [x] **Waveform-based audio editing** — split-on-silence (`silencedetect` → speech segments) + per-clip denoise (`afftdn` on export).
- [x] **Project-wide noise filter + per-clip override** — `Project.denoiseDefault` (off by default) is the lane-wide noise-reduction default; each `AudioClip.denoise` is now **tri-state** (`undefined` = inherit the default, `true`/`false` = force on/off and exempt the clip). `effectiveDenoise`/`denoiseOverridden` (`shared/project.ts`) resolve it; export applies the resolved value. UI: project default lives in the Inspector's no-selection "Project settings"; the audio-clip Inspector has a Default/On/Off segmented control; overridden clips show a small **N** badge (green = on, struck = off) on their timeline block. _Migration v8 seeds `denoiseDefault=false` and normalises legacy redundant `denoise:false` → inherit._
- [x] **Storyboard / script integration** — Script drawer; lines pin to the playhead and show as ruler markers (click to seek).
- [x] **Edge-scroll during timeline drag** — dragging a clip, caption, or audio block
  near the left/right edge of the track auto-scrolls the timeline (rAF loop, scroll
  speed proportional to edge proximity within ~40px). Shared `edgeAutoScroll` helper
  (`Timeline.tsx`) used by all three drag handlers; each now folds the live
  `scrollLeft` delta into its time delta (`deltaFor`) so the dragged block keeps
  tracking the cursor as the view scrolls, and re-applies position on each scroll
  tick. Loop cancels on `pointerup`.

- [ ] **Canvas waveform (crisp at any zoom / sample-level).** Audio waveforms are pre-rendered PNGs (`showwavespic`), now scaled to clip length so they're crisp at realistic zoom — but a raster image still softens at extreme zoom. The DAW-style fix: decode the audio to a multi-resolution **peak cache**, then render the waveform on a `<canvas>` that redraws per zoom/scroll, switching from min/max peak envelopes to individual samples at extreme zoom. Bigger feature; overkill for Reels but the "infinite zoom" answer. Start: a peaks extractor (ffmpeg → raw PCM → min/max buckets) + a `<WaveformCanvas>` lane renderer.
- [x] **Left track-header gutter** — a fixed (non-scrolling) column down the left of the timeline; each lane (Clips / Text / Image / Captions / Audio) gets a full-height tinted rounded "bubble" header, like Premiere/Resolve. The track content scrolls horizontally beside it (gutter stays pinned and is kept vertically in sync with the track scroll). Built in `Timeline.tsx`; persisted in the `timelineView` localStorage view.
	- [x] Resize a lane by click-dragging its header bubble vertically (or the bottom-edge handle); the drag adjusts height-per-row so clips scale with the lane. Minimize/expand by double-clicking the bubble (or the ▾/▸ chevron). Collapsed lanes shrink to a thin tinted strip, hide their blocks + resize handle. Per-lane `{ rowH, collapsed }` persisted in the `timelineView` localStorage view.
- [ ] **Per-lane mute / solo** — the gutter header bubbles exist but have no mute or solo buttons yet. Would require adding a `mutedLanes` set to the project or view state, then skipping those layers during preview playback and export. Data-model change needed before the UI can wire up.

### Explicitly out of scope for v1 (revisit post-launch)

- [ ] **Transitions beyond hard cuts** — no dissolves, fades, or wipes. ASS/libass can't do video transitions; would need ffmpeg `xfade` filter wired into the export pipeline.
- [ ] **Direct Instagram publishing** — export only; no Instagram API integration.
- [ ] **GPU whisper build** — transcription is CPU-only (`small.en`); GPU/CUDA build is optional upgrade.
- [ ] **Multi-cam editing** — out of scope for single-creator Reels workflow.

- [x] **Stack overlapping blocks vertically in the timeline lanes.** Done via
  greedy interval packing (`lib/lanes.ts` `packRows`) for the text, caption, and
  audio lanes; lanes lay out vertically by row count and the track grows to fit.

### Packaging & distribution

- [x] **Bundle ffmpeg + whisper.cpp for distribution.** Chose the bundle route
  (over a first-run downloader) so a clean machine needs zero setup. Engines ship
  as electron-builder `extraResources` under `<resources>/bin/{ffmpeg,whisper}`:
  ffmpeg.exe + ffprobe.exe (Gyan full build), whisper-cli.exe + DLLs, and the
  `ggml-small.en.bin` model (~1 GB installer total). `scripts/collect-binaries.mjs`
  (run by `build:win`, also `npm run collect-binaries`) stages them from the dev
  machine into the gitignored `resources/bin/`. Runtime discovery prefers the
  bundle: `getBundledBinDir()` in `config.ts`, wired into `ffmpeg.ts` candidates
  and `whisper.ts` `discoverWhisper`, falling back to the system install in dev.
  _GPL ffmpeg / MIT whisper notices called out in the README._

- [x] **Auto-update** — `electron-updater` wired in `src/main/services/updater.ts`
  (called from `index.ts` `whenReady`, packaged-only). Polls the `publish` feed on
  launch, auto-downloads, and prompts "Restart now / Later" on
  `update-downloaded`; errors are logged and swallowed. Feed configured as GitHub
  Releases (`publish:` in `electron-builder.yml`). _Action needed before first
  release: confirm `publish.owner`/`repo` (defaults `mchin57/reel-editor`), create
  the repo, and publish with `build:win -- --publish always` + a `GH_TOKEN`._
  Stable/beta channels deferred.

- [ ] **Custom app icon.** electron-builder logs "default Electron icon is used —
  application icon is not set". Add `resources/icon.ico` (256px) and reference it
  in `electron-builder.yml` (`win.icon`) so the installer, taskbar, and window use
  a real icon.

- [~] **Code-sign the installer (Norton/SmartScreen false positives).** Signing
  pipeline is wired and **env-var driven**: electron-builder signs when `CSC_LINK`
  + `CSC_KEY_PASSWORD` are set, unsigned otherwise. `scripts/make-selfsigned-cert.ps1`
  (`npm run make-cert`) generates a throwaway self-signed `.pfx` so signed builds
  work today — but a self-signed cert does **not** clear SmartScreen/Norton
  (untrusted publisher). _Remaining for real trust: buy an OV/EV cert or set up
  **Azure Trusted Signing** (recommended — new OV/EV certs ship on hardware tokens
  that can't export a `.pfx`), then point `CSC_LINK` at it or add
  `win.azureSignOptions`. No code change needed._ See README → Code-signing.
## Manual TODO

Hands-on steps that can't be done in code — needed to actually ship the macOS build and hand it to a friend.

- [ ] **Push the repo to GitHub** so the macOS CI build can run. The `Build macOS` workflow (`.github/workflows/build-mac.yml`) runs on pushes to `main`/`prototype` and on demand via Actions → "Run workflow". Confirm the `mchin57/reel-editor` repo exists (it's also the auto-update `publish:` target).
- [ ] **Grab the DMG from the workflow artifacts** (Actions → the run → Artifacts → `ReelEditor-macOS-dmg`) and send it over. The build is **unsigned** and ships **no** ffmpeg.
- [ ] **(Friend, on the Mac) `brew install ffmpeg`** — required. The Mac build bundles no engines, so without it the app reports no encoder. Homebrew installs to `/opt/homebrew/bin`, which runtime discovery probes directly even for a Finder-launched `.app`.
- [ ] **(Friend, on the Mac) Clear the Gatekeeper quarantine** on the unsigned app — right-click → **Open** the first time, or `xattr -dr com.apple.quarantine "/Applications/Reel Editor.app"`.
- [ ] **(Optional) Captions on the Mac** — drop a `whisper-cli` binary + a `ggml-*.bin` model into `~/Documents/VideoEditor/bin/whisper/` (under `Release/`, `bin/`, `build/bin/`, or the folder root). Skip if captions aren't needed. Bundling it instead would need a macOS port of `scripts/collect-binaries.mjs`.
- [ ] **(Optional) Sign + notarize the Mac build** for a no-prompt install — needs an Apple Developer account ($99/yr); add the cert + notarization creds as GitHub secrets and remove `CSC_IDENTITY_AUTO_DISCOVERY: false` from the workflow. Until then the right-click-Open step is the workaround.

## Done

(empty)
