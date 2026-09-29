# TODO / backlog

Deferred polish and features, newest-first. Not blocking; pick up as time allows.

## Codebase health

- [ ] **IPC hardening pass (pre-distribution).** The renderer-facing IPC surface is
  unvalidated: `writeProjectFile(project, path)` is an arbitrary-path write primitive,
  `importPaths` an arbitrary read, and the window runs `sandbox: false`. Fine for a
  local tool; before shipping to strangers, validate paths against known roots (data
  dir / previously-dialog-approved paths), consider re-enabling the sandbox, and add a
  CSP. Tracked from the 2026-07 code review.

## Bugs

- [ ] **Media-store leftovers from the proxy-ready fix** (see Bugs fixed ▸ "A clip read as ready while its proxy was still encoding"). (1) **Nothing re-kicks a proxy that failed or was interrupted** (app quit mid-encode, ffmpeg error). The asset correctly stays not-ready, but only a manual re-import rebuilds it. Candidate: have `hydrate` call `ensureProxy` for a not-ready asset. `ensureProxy` is already coalesced, so a refetch can't double-encode; but a source that always fails would then retry on every refetch, so it needs a per-session failure memo. (2) **`asset.json` is still written in place.** A concurrent `readAsset` in the sub-millisecond truncate-then-write window parses nothing and drops the asset from that one refetch. The temp+rename fix does not transfer directly: on Windows, `fs.rename` onto a file a reader holds open fails `EPERM` (verified, FFMPEG-NOTES "Partial outputs"). So it needs a retry, or a reader that tolerates a torn read.
- [ ] **Deleted or MOVED files break the library** — if a media file is deleted from disk via File Explorer while the app is running, the library doesn't detect the missing file. Unclear whether it crashes the entire library or just that one card. Two parts to fix: (1) **graceful missing-file handling** — when a media asset's original or proxy is not found on disk, show a "missing" badge on the library card and a placeholder on the timeline block instead of erroring; the rest of the library should continue working normally. (2) **optional file-watch** — use `fs.watch` or a periodic existence-check on import/project-load to detect deletions proactively and mark assets missing without requiring a restart. Missing assets should block export with a clear error listing which files need to be re-imported. _Also hit by a MOVED file (2026-09-23): the library stores a pointer to the original (`originalPath`), not a copy — only proxies live in the data dir — so a clip moved from Downloads kept playing but transcription failed with ffmpeg "Error opening input", and export would too. Re-importing from the new location does NOT relink it: `importFile` (`mediaStore.ts`) matches the content hash and returns the old record with the stale path. Fix: when an existing record's `originalPath` is gone and the re-imported path has the same hash, update `originalPath` and save (unit-test it). The one affected record was relinked by hand; its original is kept as `asset.json.bak`._
- [ ] **Remove background processes the whole source file, not just the selected segment** — after cutting a 1:30 clip into several pieces, running "Remove background" on one 8s piece matted the entire 1:30 source instead. The `matte` job in `removeBackground.ts` is fed the source media and evidently ignores the layer's `inSec`/`outSec` window (this is also why it feels far slower than expected — it's doing ~11x the work). Fix: pass the layer's trim window into the job (`-ss`/`-t` on the decode side of the ffmpeg frame reader in `removeBackgroundArgs.ts`, so only those frames are read and run through RVM), and produce a new transparent asset covering only that segment. Decide and pin the replacement behavior: the resulting layer should keep the segment's `startSec`/timeline position with `inSec=0`/`outSec=new duration`, and honor `speed`/`freezes`/`crop` correctly (the trim mapping must go through the shared `videoSourceTime` helpers per CLAUDE.md, not be re-derived inline). Add a regression test on the arg builder (window → `-ss`/`-t`) and verify the real output duration with ffprobe against the actual binary. Interacts with the Cancel and GPU items below.
- [ ] **Non-speech annotations leak in as caption words** — `-ml 1` splits a bracketed annotation across entries, so `(birds chirping)` arrives as `(birds` + `chirping)` and the whole-string noise regex in `whisperParse.ts` matches neither piece. Real transcripts in the library carry `(birds`, `chirping)`, `(dramatic`, `music)`, `[`, `Pause`, `]` as caption words. whisper-cli has `-sns` (`--suppress-nst`) to suppress non-speech tokens at the source; the alternative is tracking bracket depth across entries in the parser. Verify against the real binary before wiring it (see FFMPEG-NOTES "whisper word timings").
- [~] **Preview plays positive gain through a WebAudio GainNode** — `HTMLMediaElement.volume` clamps at 1.0, so `gainDb > 0` used to play at unity in the preview while the export applied the full boost via `volume=`. This was previously recorded here as BLOCKED on the renderer origin, with an `app://` migration as the prerequisite. **That diagnosis was wrong.** The real blocker was that `reelmedia://` was registered without the `corsEnabled` privilege, so the scheme could not do CORS *at all* — which is why `crossOrigin="anonymous"` failed to load whatever `Access-Control-Allow-Origin` the handler sent, and why the plain element was tainted into measured silence. Adding `corsEnabled` (done while fixing bundled-font loading, which was broken by the same omission) unblocked it with no origin change. Re-measured from the production `file://` page afterwards, on all three proxy kinds (`audio.m4a`, `proxy.mp4`, alpha `proxy.webm`): each reaches `canplay` with `crossOrigin`, and a GainNode on it measures +6 dB as exactly 2x the unity peak, gain 0 as true silence. Routing is LAZY and one-way — an element stays on plain `element.volume` until it needs more than unity, because `createMediaElementSource` can only be called once per element and cannot be undone, so the common attenuation path is left exactly as it was; a routing failure falls back to the clamped `volume` rather than going silent. `e2e/previewGain.spec.ts` pins both routes via the `appliedGain`/`isRouted`/`previewAudioState` seams. _Unverified: not yet confirmed BY EAR in `npm run dev` that a +6 dB clip is audibly louder than the same clip at 0 dB. The graph is measured correct; a human still has to listen._
- [~] **Mute an audio clip** — a per-clip `AudioClip.mute` (schema v21, purely additive: absent = audible). Deliberately separate from `gainDb` so muting is reversible — dragging the slider to -40 dB loses whatever level was set, and -40 dB is not silent anyway. The preview and the export reach silence differently and both ask the shared `audioClipAudible`: the preview holds the clip at gain 0 so it keeps following the playhead and unmuting mid-playback is instant, while the export drops the clip from the mix entirely rather than decoding a source that contributes nothing. Inspector gets a checkbox (the volume slider disables while muted, so it can't look like it still does something); the timeline tile dims its waveform, strikes through its label and shows a 🔇 badge sharing a row with the denoise badge. `e2e/audioMute.spec.ts` covers the round trip through the real control, that unmuting restores the LEVEL rather than unity, that a muted boost is silent on the GainNode path too (a different code path from the attenuated one), and the tile badge. _Unverified: not smoke-tested in `npm run dev` — muting a real clip and confirming by ear, and that a muted clip is absent from a real export._

## Open

### Platform profiles system

- [ ] **Platform profiles** — replace the hardcoded Instagram-specific UI with a profile system. Each profile bundles export presets, checklist rules, safe-zone guides, default overlay styles, and aspect ratio. Profiles can be toggled on/off; their features (checklist, safe-zone overlay, hook-zone marker, keyword bank) only appear in the UI when the profile is active.
  - **Built-in profiles to ship with:**
    - `Instagram Reels` — current behavior: 9:16 1080×1920, 30–90s rule, hook-zone marker, safe-zone overlay, caption keyword checker, Reel/Story/Carousel presets.
    - `General` — no platform-specific rules; just timeline + export. Useful as a blank slate.
  - **Custom profiles** — user can create, name, duplicate, and delete profiles; each stores its own set of rules and presets in `settings.json`.
  - **UI:** add a menu bar (File / Edit / Profile / …) across the top of the app window — standard dropdown tabs. `Profile` menu lists available profiles with a checkmark on the active one, plus "New profile…" and "Manage profiles…" actions.
  - Where to start: `src/shared/formats.ts` (profile type — presets already `definePreset` an aspect plus platform extras such as `safeZones`, so a profile is a natural next level up), `src/main/services/projectStore.ts` (persist active profile), `src/renderer/src/state/store.ts` (the `useEditor` store — add the active profile here; note there is no `editorStore.ts`), new `ProfileMenu` component. Conditionalize the checklist (`ChecklistModal.tsx` + `lib/checklist.ts`) and the hook-zone overlay (an inline `<div>` in `PreviewStage.tsx`, driven by `HOOK_WINDOW_SEC`) on the active profile's flags; the safe-zone guides and the checklist's safe-zone rule already follow the preset's `safeZones`. There are no `ReelChecklist`/`SafeZoneOverlay`/`HookZoneMarker` components today. The shared `FRAME` (`shared/frame.ts`) and the `resolveOverride` tri-state pattern (`shared/project.ts`) make profile-scoped defaults straightforward.

### Text updates

> Research/spec for the Fonts + Colors sections: [`research-text-fonts-colors.md`](research-text-fonts-colors.md).
> Implemented on the `feature/text-fonts-colors` branch (see notes in Done section below).

#### Text animation effects

- [~] **Per-overlay entrance animation** — `TextContent.animation` (migration v10)
  with all five presets: fade in, slide in from bottom, typewriter, bounce, and
  word-by-word highlight. The shared timing/geometry source of truth is
  `src/shared/textAnim.ts` (`textAnimStateAt` + constants, unit-tested); the
  preview computes a per-frame state from the playhead (scrub-exact — no CSS
  animations) and the export maps the same constants onto ASS tags in
  `assBuilder.overlayEvents` (`\fad`/`\move`/`\t` scale pop/`\k` karaoke/
  per-step alpha-reveal events — every mechanism verified against ffmpeg 8.1.1
  frame dumps, see FFMPEG-NOTES "ASS animation tags"). Word-by-word distributes
  evenly across the overlay window (text overlays have no whisper timing; the
  spoken-word karaoke variant belongs to captions if ever needed). Inspector:
  Entrance/Exit dropdowns + durations in the Text section. _Limitations:
  rasterised text (gradient fill / fixed wrap width) does not animate —
  `effectiveTextAnimation` resolves to none on both sides so preview and export
  agree; the Inspector disables the controls there and says why._
  _Unverified: not yet smoke-tested through `npm run dev` (Inspector → preview
  → real export with media); the generated ASS was verified standalone against
  the real ffmpeg, and unit tests pin the event strings._
- [~] **Exit animation** — same field: fade out or slide out (down), with the
  in+out windows clamped proportionally when they exceed the overlay duration.
  Slide-in + slide-out splits into entrance/static/exit ASS events (one `\move`
  per event). Same unverified caveat as above.

#### Other

- [ ] **Text free-distort resize mode** — stage objects are now resizable (edge/corner handles in `PreviewStage`): media edges distort, text sides re-wrap and corners scale the font. A follow-up is a per-text-layer "free distort" mode where the edges *squish the glyphs* non-uniformly (via the layer's already-reserved `stretchX`/`stretchY`, which text currently ignores). Open question: where the mode toggle lives in the UI/menus. The model + `resizeBox` math already support it.
- [ ] **Beat sync** — detect transients/beats in the music track and expose them as snap points on the timeline ruler, so cuts and text entrance animations can be snapped to the beat automatically.
- [ ] **Text style templates** — save a full combination of font + size + color + pill + stroke + animation as a named "style" that can be applied to any overlay in one click. Stored in `settings.json`; surfaced in the Inspector as a style picker above the individual controls. _The natural unit to save/apply is `TextStyleBase` (`shared/project.ts`) — the shape `TextContent` and `CaptionStyle` already share via `TextStyleControls`._
- [ ] **Text-behind-subject effect** — composite a text layer between the subject and background using the auto background removal mask (see subject-aware crop item). Requires the segmentation feature to be built first.

### Background removal follow-ups

- [ ] **Cancel button for "Remove background"** — the RVM matte job runs on CPU and can take minutes on a long clip, with no way out once started. Add a Cancel button on the running job (Inspector button state + the job's progress row). Needs a real kill path, not just hiding the UI: the `matte` job in `removeBackground.ts` must abort its frame loop (check an abort flag/`AbortSignal` between frames), kill any spawned ffmpeg decode/encode processes on that route (use `runFfmpeg` from `services/ffmpegRun.ts` per CLAUDE.md — every spawn needs a kill path), and delete the partial output WebM so no half-written asset lands in the library. Wire through the existing jobs pipeline (`jobs.ts` cancel, if present; otherwise add a `job:cancel` IPC). Also worth showing an ETA/percent so the user can decide whether to cancel. _Checked 2026-09-23: there is no cancel anywhere today — `jobs.ts` has no cancel, and the `canceled` job status exists but is never set; the only way out is closing the app / Ctrl+C. That leaves the partial `<data>/tmp/nobg-*.webm` behind (the startup sweep deletes `tmp`, so nothing accumulates), and the two ffmpeg children exited on their own once their pipes broke (none were left running)._

- [ ] **Run background removal on the GPU (investigate, then implement)** — the RVM matte job currently runs on CPU via `onnxruntime-node`; the original note already flagged GPU execution providers as the later optimization. Dev machine has an RTX 4070 Ti Super. Investigate: (1) which execution providers the installed `onnxruntime-node` Windows build actually ships — verify against the real package, don't assume (DirectML works on any Windows GPU and would also cover friends' machines; CUDA is faster on NVIDIA but needs the CUDA/cuDNN runtime bundled, which is large); (2) set `executionProviders` on the `InferenceSession` in `removeBackground.ts` with an automatic CPU fallback if the GPU provider fails to load, and surface which one is in use; (3) benchmark CPU vs GPU on a real clip, since per-frame tensor upload and the recurrent RVM state can eat the gain; (4) check installer size impact before bundling anything (installer is already ~1 GB). Pairs with the Cancel-button item above. _Measured 2026-09-23: a killed run on a 1080×1920 30fps clip did 253 frames in 77s = **3.3 fps** end to end (~4.5 min per 30s of footage). The VP9-alpha encode step alone, same args, ran ~30 fps — so the time is inference + per-pixel JS, not the encode. `onnxruntime-node` 1.27 ships `DirectML.dll` in its win32 binaries, and `InferenceSession.create` passes no `executionProviders`, so it runs on CPU. Also cheap to fix: `rawFrames` in `removeBackground.ts` rebuilds the frame buffer with `Buffer.concat` on every ~64KB pipe chunk — about 300MB of copying per 6MB frame; write chunks into one preallocated frame buffer instead. Nothing on disk caches or slows the job; the only reuse is the in-memory session per app run._

- [ ] **Global job-status indicator (start with background removal)** — while "Remove background" runs, its progress only shows where the job was started, so it disappears if you select another layer or panel. Show running-job status somewhere always visible, e.g. in the header next to the project settings dropdown (`ProjectSettingsMenu`): a small pill with the job name, percent/ETA and a Cancel button (reuses the Cancel item above), clickable to expand a list when several jobs run. Build it against the generic jobs pipeline (`jobs.ts` progress events already pushed over IPC) rather than a matte-specific hook, so proxy generation, transcription, extract-audio and export show up in the same place. Check what the existing export progress and proxy-job UI already do and fold them in rather than adding a fourth indicator.

### Layer rotation

- [ ] **Rotate video clips (like images)** — image layers have `rotateQuarters` (90° steps) and flips, but video layers have neither. Add rotation to `VideoContent`: 90° steps and flips first (mirrors `ImageContent`, so the existing `crop→transpose→flip→scale` export chain in `exporterArgs.ts` and the preview transform in `PreviewStage` can be reused), then free-angle rotation shared with the text-rotation item above. Rotation must interact correctly with the existing per-clip `crop` (crop is in source pixels — decide whether it applies before or after rotate and pin it in a test), keyframed transforms, freezes/speed, and the alpha (background-removed) VP9 path. Any rotate-aspect math belongs with `containBox`/`effectiveImageAspect` in `shared/layers.ts` (see `docs/SHARED.md`) so images and video share it. Consider one shared rotation model across video, image and text layers instead of three separate ones. Verify the ffmpeg chain (transpose/rotate with alpha, non-square fill colour) against the real binary per `docs/FFMPEG-NOTES.md` before wiring.

### Text updates (continued)

- [ ] **Font size slider** — font size is only a numeric field today. Add a slider alongside it (numeric field stays for precise entry, the two stay in sync) for both text overlays and captions. Belongs in the shared `TextStyleControls` component so both get it, using the existing shared numeric-field/slider primitives in `components/ui.tsx` (check `docs/SHARED.md` first). Preview and export already read the same `fontSize`, so this is UI-only: pick a sensible range (e.g. 24–400 logical px), and keep dragging live via `liveUpdate` + `commitLive` so a whole drag is one undo step.

- [ ] **Free rotation for text overlays** — `CaptionStyle` already has a rotation field, but text overlay layers (`TextContent`) have no rotation control, unlike image layers (which support 90° `rotateQuarters` steps). Add a free-angle rotation field to `TextContent`, matching what captions already have — not just 90° steps. Since text layers and captions now share one path (2026-09-23), most of the plumbing exists: the preview `TextBlock` already takes `rotationDeg`, the export laid-out block (`textBlockSpec` → `AssOverlay.rotationDeg`) already rotates every line and pill about the block centre via `\org` + `\frz`, and the raster path rotates too — this is mostly the `TextContent` field (+ migration), passing it through in `StackLayer`/`exporter`, and the UI. UI: a rotation handle on the preview canvas (drag to rotate) plus a numeric angle field in the Inspector, consistent with how captions already expose rotation.

### Insert menu & shapes

- [ ] **"Insert" menu + basic shapes** — add an "Insert" dropdown to the menu bar (alongside File / Edit) with options to place primitive shapes onto the timeline as visual layers. Each shape is a new `ShapeContent` layer kind in `shared/project.ts`. The layer sits in the Image lane and supports the same move/resize/restack/keyframe controls as image layers. Preview renders via inline SVG in `PreviewStage`; export rasterises the SVG to a transparent PNG overlay burned before the ASS pass (most reliable cross-shape ffmpeg path).
  - **Shapes to include:**
    - **Rectangle** — width + height independently adjustable; corner radius slider for rounded variant.
    - **Square** — constrained equal width/height; corner radius slider.
    - **Circle** — uniform diameter.
    - **Oval / ellipse** — independent width + height axes.
    - **Arrow** — direction (up/down/left/right + diagonal variants), head size, shaft width.
  - **Per-shape Inspector controls:** fill color + opacity, stroke color + width, overall layer opacity. Width/height shown as logical px (1080×1920 space) with a lock-aspect toggle.
  - "Insert" menu items each drop a shape at the playhead centered in frame with a 2s default duration and white fill.
- [~] **Multi-clip layout formats (split screen, panels) — shipped as a `layout` LAYER kind.**
  All 7 planned presets (`split-lr`/`split-tb`/`cols-3`/`rows-3`/`big-left`/
  `big-right`/`grid-2x2`) live in `src/shared/layouts.ts` with the pure geometry
  (`layoutCellRect` applies the layer's move/zoom; `coverCrop` is the export twin
  of the preview's `object-fit: cover`). _Design deviation from the sketch below:
  instead of a separate `LayoutClip` array, a layout is a `LayoutContent` layer in
  the unified stack (migration v14) — cells `{ mediaId, inSec, outSec, mute, rect }`
  compile to ORDINARY compositor `ExportVideo` entries (the already-verified
  crop→scale→overlay chain; zero new ffmpeg mechanisms), and empty cells let lower
  layers show through rather than forcing a background color._ Cells play 1× from
  the layout's start, time-gated to `min(cell span, layer window)` (audio clamps
  identically). UI: the header **Format ▾ menu** (next to File/View; also holds
  the project aspect-ratio picker, moved out of Project settings). "Add layout"
  opens a **visual preset picker** (`LayoutPickerModal` — every preset drawn at
  the current aspect ratio). The Format menu holds only the aspect ratio + "Add
  layout at playhead". Everything else lives in **Inspector ▸ Layout**
  (`LayoutCells`): a "Change layout" button reopens the picker to reshape, and
  each cell has an assign/change/clear picker, is a **drop target** (drag a
  library clip onto it — same payload as the timeline — to assign, overwriting),
  and once filled shows the shared `ClipCard` (thumbnail + hover preview, no
  add-to-timeline) with trim + mute. A fuchsia Layout timeline lane appears
  when one exists; corner-only resize handles (cells ignore stretch); preview
  outlines empty slots while selected. e2e: `e2e/layout.spec.ts`.
  _Limitations: no keyframes on layout layers; start-edge trim shifts the window
  (cells re-anchor to the new start) rather than trimming cell sources; no
  per-cell canvas dragging._ _Unverified: not yet smoke-tested through
  `npm run dev` with real media (cell playback sync, real export of a filled
  grid)._
  Original sketch:
  - **Split screen (2-up):** left/right or top/bottom, each half fills its cell.
  - **3-panel (landscape strip):** three equal columns.
  - **3-panel (portrait stack):** three equal rows.
  - **3-panel (1 large + 2 small):** large cell left, two stacked cells right (and mirrored variant).
  - **4-panel grid:** 2×2 equal quadrants.
- [ ] **Custom layout editor** — a drag-and-drop canvas for creating and saving custom multi-clip layouts beyond the built-in presets. User can add cells, resize/reposition them freely within the 1080×1920 frame, set a background color or image, and save the result as a named preset that appears alongside the built-in ones. Saved presets stored in `settings.json` under `customLayouts[]`. Implementation: a `LayoutEditor` modal with a scaled-down 1080×1920 canvas; cells are resizable/draggable divs; outputs a `LayoutPreset` definition identical in shape to the built-ins so the rest of the pipeline is unaffected.
- [~] **Clip-audio locking — shipped as LINK GROUPS over every timeline tile (not just a clip↔audio pair).**
  `linkGroupId` on `Layer`/`CaptionSegment`/`AudioClip` (one id space, migration
  v16) makes any set of tiles behave as one; the whole model lives in the new
  `src/renderer/src/lib/links.ts` (`timelineTiles` is the flat per-tile record
  every op works against) with `lib/links.test.ts` + `e2e/link.spec.ts` covering
  it. UI: **Ctrl/Cmd-click** tiles to multi-select, **🔗 Link** / **⛓ Unlink** on
  the timeline bar next to play/pause (Link needs ≥2 linkable tiles; Unlink needs
  one linked tile and breaks that whole group); linked tiles show a 🔗 badge.
  - **Selection is all-or-nothing** — clicking one member selects the group,
    everywhere (timeline, stage, Layers panel → `useUi.selectTile`). A click
    without a drag narrows a Ctrl-built multi-selection back to one tile.
  - **Move** = one shared delta (`moveItemsBy`): relative offsets AND each tile's
    own duration are preserved; the clamp applies to the set, so dragging into 0
    stops the group on its earliest tile instead of squashing it. Dragging a
    multi-selection of *unlinked* tiles moves them together too.
  - **Split** happens at the playhead for every member it crosses; members it
    misses (offset in time) are left whole. The right-hand halves become their own
    group so the two sides of a cut can be edited apart. Every tile kind except a
    layout can now be cut — video (source trim + freezes), text/image
    (`splitStaticLayer`: entrance animation left, exit right) and captions
    (`splitCaptionSegment`: word timings partition, text rebuilt) — which also
    means the ✂ Split button and **S** now work on a lone text/image/caption tile.
    Transform keyframes are partitioned across any layer split, re-basing the
    right half and pinning the transform at the seam (this also fixes a video
    split silently restarting a keyframed layer's motion at the cut).
  - **Delete** takes the whole group (the old open question, answered: one undo
    step, always both — a group is only ever removed as a whole).
  - **Trim** is a shared delta too (`trimItemsBy`): dragging either edge of any
    member moves that edge on every member by the same TIMELINE delta, each
    converting it through its own mapping (a 2× clip gives back 2s of source per
    timeline second, an audio clip 1s; freeze holds stay wall-clock). The delta is
    clamped to what the most constrained member can give — measured from the
    `achieved` value the new per-kind `trimLayerEdge`/`trimCaptionEdge`/
    `trimAudioEdge` helpers report — so a member running out of source can't
    desync the group.
  - **A clip added with audio lands LINKED** (`addVideoLayer`, so both a timeline
    drop and the Library's ＋ PH / ＋ End): the video layer and the audio clip
    extracted from it share a fresh group, and deleting the clip no longer orphans
    its audio. `extractLayerAudio` deliberately doesn't link — extracting is how
    you go get the audio to treat separately.
  - **Per-tile ops that can't translate are still disabled while linked:** the
    Inspector's absolute start/end + trim in/out, speed & speed ramps, freeze
    holds, extract audio, split-on-silence — with a banner saying why. A linked
    audio clip's **Start (s)** DOES work: for audio that's a move, so it shifts
    the group. **Layout layers can't be linked at all.**
  - _Not done:_ ripple/roll trim across a group (trimming a member's edge doesn't
    push neighbouring tiles); no per-project toggle for the auto-link default.
  - _Unverified:_ not yet smoke-tested through `npm run dev` — the interaction
    guarantees are Playwright-covered against the real app, but the visuals
    (badge, banner, disabled states) and the manual items added to
    `docs/TIMELINE.md` still want a human pass.
- [~] **Auto mono-fold one-sided audio (mic-on-one-channel)** — footage from a mic wired to a single side imports as stereo with one dead channel, so it plays out of one ear (and reads as silent). **Shortcut shipped:** at import, stereo sources get a one-shot per-channel peak probe (`astats`, `detectMonoFoldChannel` in `audio.ts`); when exactly one channel is live, `AudioStreamInfo.monoFoldChannel` records it and both the preview proxies (`buildProxyArgs`/`buildAudioProxyArgs`) and the export mix (`buildAudioGraph`/`ExportAudio.foldChannel`) mirror that channel to both sides via `monoFoldPan` (`pan=stereo|c0=cN|c1=cN`, verified ffmpeg 8.1.1 — see FFMPEG-NOTES). Automatic, non-toggleable, no UI. _Unverified: not yet smoke-tested through `npm run dev` end-to-end (import → listen); the ffmpeg commands are verified but the live app wiring (persisted `monoFoldChannel` → `ensureProxy` → preview) needs a human audio check._ **Full version (backlog):** make it a per-source override — `channelMode: 'auto' | 'stereo' | 'fold'` on the audio clip/asset using the existing `resolveOverride`/`OverrideToggle` pattern, default `auto` = current behavior, with a Default/On/Off control in the Inspector. Live-toggleable preview needs a WebAudio route (`MediaElementSource → ChannelSplitter/Merger`) in `AudioFollower`/`VideoLayerView` since today volume is set straight on the element and the proxy fold is baked per-asset (not reversible without a re-transcode).
- [ ] **Noise reduction quality (research + replace)** — the current `afftdn` filter sounds unnatural / artifacts on voice. Research alternatives before implementing: RNNoise (`arnndn` filter in ffmpeg, ML-based, much cleaner on speech), DeepFilterNet (external binary, state-of-the-art but requires bundling), or a two-stage `highpass + afftdn` with conservative settings. Test each against real iPhone audio before choosing. Update `buildAudioGraph` in `audio.ts` once a winner is picked.
- [ ] **LUT (.cube) support** — import a `.cube` LUT file and apply it per clip on export via ffmpeg `lut3d` filter. Preview approximation via CSS or a canvas-based LUT lookup. Useful for cinematic grades and consistent brand look across clips.
- [~] **Speed ramping — keyframed speed CURVES shipped (on top of constant per-clip speed).**
  `VideoContent.speedRamp` (`SpeedKeyframe[]`, migration v13): speed keyframes are
  SOURCE-time anchored (like freezes, so trims/splits keep the motion), piecewise-
  linear between keyframes, held flat outside. The timeline↔source mapping is the
  closed-form log/exp integral of 1/speed in the NEW shared `src/shared/speed.ts`
  (`playedBetween`/`sourceAfterPlayed`/`videoSpeedAtSource`, unit-tested incl.
  numeric-integration cross-check); `videoSourceTime`/`playedVideoDuration`/
  `videoTimelineTime`, trim/split, and the edge-drag delta conversion all resolve
  through it (invariant `window = playedBetween(in,out) + Σholds`). Preview:
  per-tick `playbackRate` from the profile. Export: quoted piecewise
  `setpts='(C_i+log(v(x)/v_i)/m_i …)/TB'` via `speedRampPlayedExpr`
  (`ffmpegFilters.ts`) composing with freeze `gte()` terms — frame-exact against
  ffmpeg 8.1.1 through the full compositor chain (FFMPEG-NOTES "Speed ramps").
  UI: "＋ Speed keyframe at playhead" + per-keyframe speed list in the clip
  Inspector (constant-speed controls disable under a ramp); `×~` timeline badge.
  e2e: `e2e/speedRamp.spec.ts` (Inspector flow + ramped trim-drag invariant).
  _Limitations: a ramped clip's own audio is muted in preview AND dropped from
  the export mix (no variable-tempo audio path — atempo is fixed per instance);
  easing is linear-only._ _Unverified: not yet smoke-tested through
  `npm run dev` with real media (ramp feel during playback, export A/B against
  preview motion)._
- [ ] **Audio clips should support the full clip feature set** — `AudioClip` currently only has basic gain/fade/duck/denoise. All temporal and playback features available to video clips should be mirrored on audio clips and baked into the exported audio asset:
  - **Constant speed** — `atempo` chain (0.25×–4×; chain multiple filters since a single `atempo` only supports 0.5×–2×).
  - **Keyframed tempo ramps** — piecewise-linear tempo keyframes matching the video speed-ramp model (`src/shared/speed.ts`); each segment encoded with its own `atempo` value on export. Preview via `AudioBufferSourceNode.playbackRate` or a pitch-preserving worklet.
  - **Freeze holds** — hold the audio at a source timestamp for a given duration (silence or loop the held moment); mirrors `VideoContent.freezes` in behavior.
  - All settings should be stored directly on the `AudioClip` object in `project.json` (no separate sidecar) so the clip is fully self-contained. The natural time to build this is alongside video speed-ramp easing curves, since both need the same variable-tempo audio pipeline.
  Previous constant-speed notes: `VideoContent.speed` (0.25×–4×, absent = 1, migration v11): the timeline↔source mapping is generalized in the SHARED helpers — `videoSpeed`/`playedVideoDuration` (`shared/project.ts`/`layers.ts`), `videoSourceTime`/`isFrozenAt` scale by speed while freeze holds stay wall-clock, and `trimVideoStart`/`trimVideoEnd`/`splitVideoLayer` (`lib/timeline.ts`) keep the invariant `window=(out−in)/speed+Σholds` (edge-drag deltas are played time × speed). Preview: `<video>.playbackRate` (Chromium time-stretches like atempo). Export: `setpts=(PTS-STARTPTS)/S` composing with the freeze expression (source-time thresholds, wall-clock holds) + `atempoChain` for an unmuted layer's own audio — all verified against ffmpeg 8.1.1 frame dumps/durations (FFMPEG-NOTES "Speed"). UI: preset buttons + free field in the clip Inspector; ×N badge on the timeline block. _Limitations: audio-lane clips (incl. the auto-extracted pair and "Extract audio", which is disabled at ≠1×) always play 1× — AudioClip has no tempo; speed curves/ramps within a clip are the remaining large piece._ _Unverified: not yet smoke-tested through `npm run dev` with real media (drag-trim feel at ≠1×, A/V sync on a real clip's unmuted audio)._
- [~] **Keyframe animation — position + scale + OPACITY shipped for video/image layers; text keyframes remain backlogged.**
  _Opacity update (v15):_ `LayerKeyframe.opacity` (absent = 1; multiplies an image's
  base opacity) interpolates through `layerTransformAt(...).opacity`; preview applies
  it as CSS opacity on the layer box, export drives it per-frame via
  `sendcmd [expr]` intervals → `colorchannelmixer@id aa` (which MULTIPLIES existing
  alpha, so bg-removed mattes compose; constant tail interval pins the final value) —
  the long-standing "no clean per-frame alpha path" blocker is solved and verified
  against ffmpeg 8.1.1 (FFMPEG-NOTES "Keyframed opacity"). UI: per-keyframe % input
  in Inspector ▸ Keyframes; canvas drags preserve the opacity in effect. Exporter
  writes `opacity_N.cmd` files next to the ASS files. _Unverified: not yet
  smoke-tested through `npm run dev` (fade feel + real export A/B)._
  _Original notes:_ `Layer.keyframes` (`LayerKeyframe[]` — `tSec` relative to `startSec`, so moving the block keeps the motion; migration v12). Interpolation is LINEAR with hold outside the range, resolved through the shared `layerTransformAt` (+`upsertKeyframe`) in `shared/layers.ts`. Preview evaluates it per playhead tick; canvas drags / corner-resizes on a keyframed layer write a keyframe at the playhead. Export bakes the same ramps into per-frame `t` expressions: `scale=…:eval=frame` AFTER the setpts shift (so absolute timeline time, composing with speed/freezes) + `overlay` x/y with `overlay_w/2` centering; keyframed still images become `-loop 1` + `fps=30` frame streams — every mechanism verified against ffmpeg 8.1.1 frame dumps (FFMPEG-NOTES "Keyframed layer motion"). UI: Inspector ▸ Keyframes (add-at-playhead, list with seek/remove, clear); base X/Y/Zoom disable while keyframed. _Limitations: no opacity keyframes (no clean per-frame alpha path in one ffmpeg pass — needs sendcmd or a slow geq); text layers excluded (they animate via `TextContent.animation`); easing is linear-only._ _Unverified: not yet smoke-tested through `npm run dev` with real media (drag-writes-keyframe feel, export A/B against preview motion)._
- [ ] **Merge clips** — select two or more video clips on the timeline and merge them into a single new media asset in the library, which then replaces the original clips as one contiguous block. Useful for locking a multi-clip sequence before applying effects or to simplify a crowded timeline. Implementation: a "Merge selected clips" toolbar button / right-click action triggers a mini-export job — runs the same per-clip normalize + concat pipeline as the main export but outputs a single proxy-quality H.264 `.mp4` (no ASS burn, no music mix), imports the result into the library as a new asset, removes the source clips from the timeline, and places the merged asset at the first clip's `startSec`. The original source files remain in the library untouched. Edge cases: clips must be on the same lane and contiguous (or the gaps become black frames in the merge — warn the user); freeze holds and speed changes should be baked into the merged output.
- [ ] **Canvas waveform (crisp at any zoom / sample-level).** Audio waveforms are pre-rendered PNGs (`showwavespic`), now scaled to clip length so they're crisp at realistic zoom — but a raster image still softens at extreme zoom. The DAW-style fix: decode the audio to a multi-resolution **peak cache**, then render the waveform on a `<canvas>` that redraws per zoom/scroll, switching from min/max peak envelopes to individual samples at extreme zoom. Bigger feature; overkill for Reels but the "infinite zoom" answer. Start: a peaks extractor (ffmpeg → raw PCM → min/max buckets) + a `<WaveformCanvas>` lane renderer.
- [ ] **Per-lane mute / solo** — the gutter header bubbles exist but have no mute or solo buttons yet. Would require adding a `mutedLanes` set to the project or view state, then skipping those layers during preview playback and export. Data-model change needed before the UI can wire up.

### Explicitly out of scope for v1 (revisit post-launch)

- [ ] **Transitions beyond hard cuts** — no dissolves, fades, or wipes. ASS/libass can't do video transitions; would need ffmpeg `xfade` filter wired into the export pipeline.
- [ ] **Direct Instagram publishing** — export only; no Instagram API integration.
- [ ] **GPU whisper build** — transcription is CPU-only (`small.en`); GPU/CUDA build is optional upgrade.
- [ ] **Multi-cam editing** — out of scope for single-creator Reels workflow.

### Portable project bundles

- [ ] **Self-contained project folder (portable save)** — package the project file and all its media into a single transferable folder so a project can be moved between computers and opened in its exact state. Proposed format: a `<ProjectName>.reel/` folder containing `project.json` plus a `media/` subfolder with copies of every imported file (original + proxy). On open, the app detects a `.reel/` folder, resolves media paths relative to it rather than the global `%USERPROFILE%\Documents\VideoEditor\media\` store, and imports any missing assets into the local library automatically.
  - **Export (pack):** File → "Save as portable folder…" — walks `project.mediaIds`, copies each `media/{hash}/original.*` and `proxy.mp4` into the bundle's `media/` dir, writes `project.json` with relative paths.
  - **Import (unpack):** File → "Open…" detects a `.reel/` folder, re-hashes the bundled originals into the local media store (deduplicating if already present), and rewrites `mediaIds` to match local hashes.
  - **Size note:** bundles include original files so can be large (raw iPhone footage). An optional "proxy-only" pack mode could be a follow-on for sharing lightweight review copies.

### Packaging & distribution

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

- [ ] **Push to GitHub** so the macOS CI build can run. The repo exists
  (`mchin57/video_editor`) and is wired as `origin`; `electron-builder.yml`
  `publish:` points at it. Nothing has been pushed yet — the owner runs every
  `git push` (see CLAUDE.md). NOTE the `Build macOS` workflow triggers on
  `push: [main, prototype]`, and **`prototype` no longer exists** (branch
  cleanup) while the work lives on `feat/linked-timeline-groups` — so pushing
  that branch builds nothing. Push `main` (it fast-forwards to the feature
  branch cleanly), retarget the workflow, or use Actions → "Run workflow".
- [ ] **Grab the DMG from the workflow artifacts** (Actions → the run → Artifacts → `ReelEditor-macOS-dmg`) and send it over. The build is **unsigned** and ships **no** ffmpeg.
- [ ] **(Friend, on the Mac) `brew install ffmpeg`** — required. The Mac build bundles no engines, so without it the app reports no encoder. Homebrew installs to `/opt/homebrew/bin`, which runtime discovery probes directly even for a Finder-launched `.app`.
- [ ] **(Friend, on the Mac) Clear the Gatekeeper quarantine** on the unsigned app — right-click → **Open** the first time, or `xattr -dr com.apple.quarantine "/Applications/Reel Editor.app"`.
- [ ] **(Optional) Captions on the Mac** — drop a `whisper-cli` binary + a `ggml-*.bin` model into `~/Documents/VideoEditor/bin/whisper/` (under `Release/`, `bin/`, `build/bin/`, or the folder root). Skip if captions aren't needed. Bundling it instead would need a macOS port of `scripts/collect-binaries.mjs`.
- [ ] **(Optional) Sign + notarize the Mac build** for a no-prompt install — needs an Apple Developer account ($99/yr); add the cert + notarization creds as GitHub secrets and remove `CSC_IDENTITY_AUTO_DISCOVERY: false` from the workflow. Until then the right-click-Open step is the workaround.

## Done

### Codebase health

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
- [x] **Finish the drag-helper sweep.** `Popout.tsx` and `LayersPanel.tsx` were the last two hand-rolled
  pointermove/pointerup pairs and now use `startPointerDrag`; `grep` confirms no
  `addEventListener('pointermove')` survives outside `lib/pointerDrag.ts`. `edgeAutoScroll` moved there
  from `Timeline.tsx` in the same pass, so all the drag plumbing lives in one module. Popout also lost a
  now-write-only `dragging` ref (the grab offset rides in the drag's own closure).
  (`Splitter.tsx` was deleted with the dockable-panel refactor — the dock's sashes replaced it.)
  _Smoke-tested by the owner in `npm run dev` (2026-09-04): both converted drags work — the Popout
  header (Stills / image editor) and the Layers-panel ⠿ restack. Layers reordering is now covered by
  `e2e/layersReorder.spec.ts`; the Popout header drag remains manual-only._

### Dockable panels (`feature/hard-batch-wt` branch)

- [~] **VS Code-style dockable panel system.** Library / Preview / Layers /
  Inspector / Timeline are dockview-react panels: resizable (40px soft min),
  drag-rearrangeable (splits + tab groups), closable, reopenable via the new
  **View ▾** header menu. Layout persists in the versioned `dockLayout`
  localStorage key (old `panelSizes` retired). Panel manifest + persistence in
  `lib/dockLayout.ts` (add-a-panel recipe: `docs/SHARED.md`); host
  `components/Dock.tsx`; chrome wrapper `components/DockPanel.tsx`.
  **View ▸ Set default layout** captures the current arrangement as the user's
  own default (`dockDefaultLayout` key); **Reset layout** restores it (falling
  back to the built-in arrangement) and **Forget saved default** discards it.
  Startup resolves session → user default → built-in, all through `applyLayout`
  (`state/dock.ts`). Verified: unit tests (manifest/persistence/registry
  parity, both layout keys independent), e2e (`e2e/dock.spec.ts`: tab-close →
  View-menu reopen, reset-to-saved-default vs built-in, forget default; full
  suite green), scripted app runs (default layout matches the old arrangement,
  timeline spans full width at the bottom, close/reflow, reset, session +
  saved default both survive an app restart and Reset in a fresh process
  restores the saved default). **Unverified — needs a human `npm run dev` pass
  with real media:** pointer drag-rearranging tabs into splits/stacks, HTML5
  drags (library→timeline, OS-file drop) crossing dockview tab bars (mitigate
  via `onUnhandledDragOver` if drop targets light up), preview aspect-fit at
  extreme panel shapes, resize-to-extreme sashes, and whether the manifest's
  per-panel minimum sizes survive a `fromJSON` restore. Note: closing the
  Preview panel unmounts its media elements — playback clock keeps running,
  audio is silent until reopened.

### Freeze frames, stills & image editing (`feature/freeze-stills-image-edit` branch)

### Freeze frames, stills & image editing

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

### Layer compositing

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
  (unit-tested). _Remaining: multi-HD-video passes can be slow (expected for
  compositing). (The old non-9:16 "square reframes best-effort" note is closed —
  formats are now centred frame windows, see Bugs ▸ "Picking Square…".)_
- [x] **Nested compositions (compound clips) — edit any clip or panel as its own
  timeline.** A `Composition` (`layers`+`audioClips`+`captions`) is the editable
  core `Project` now extends; a **compound layer** (`CompoundContent`) or a
  **layout cell** (`LayoutCell.comp`) carries one inline (migrations v17/v18,
  absence-tolerant). ONE implementation serves every depth: the store's
  `editPath` + `commitComp` mean all ~40 timeline actions edit the ACTIVE
  composition (empty path = the root, byte-identical to before), every panel
  renders through the `activeComp` selector, the preview recurses via
  `StackLayer`/`CompFill`, and the exporter's `renderComposition` calls itself
  for nested comps. Traversal lives in `src/shared/compositions.ts`
  (`resolveCompAtPath`/`updateCompAtPath`/`compositionDuration`/
  `syncCompoundWindows`/depth cap — inline ownership makes cycles impossible).
  Export pre-renders each comp to a **transparent VP9/WebM** intermediate
  (verified: FFMPEG-NOTES "Nested-composition intermediates") so a comp
  composites over lower layers exactly like the preview instead of a black box;
  intermediates are content-hash cached. UI: ✎ Edit on a layout cell, "🧩 Edit
  as compound clip" on any unlinked tile, a breadcrumb to step back out.
  Verified end-to-end in `npm run dev` with real media: editing a panel as its
  own timeline, its picture AND audio reaching the master timeline, and a real
  nested export. 7 e2e specs cover enter/exit, nested render, both Edit entry
  points, the window ripple, and the nested audio track.
  _A nested comp's audio track reaching the parent mix was the one real bug
  found in testing: `CompFill` rendered the comp's layers but not its
  `audioClips`, so a muted-clip + extracted-audio panel went silent one level
  up (its video layers still carried their own audio, hence the confusing
  asymmetry). Compounding it, layout cells default to `mute: true` — right for
  a single clip, wrong for a comp that mixes its own audio — with no UI to
  see it. Fixed by one shared `CompAudioTrack`, opening the cell gate on
  conversion, a "mute this panel" toggle, and migration v18 for comps converted
  before the fix._
  _Known gaps (deliberate, v1): an un-entered comp's CAPTIONS don't preview
  (they burn into the export's pre-render); comps are untrimmed (the block window IS the comp
  duration, kept in sync by `syncCompoundWindows`); compound layers ignore
  transform keyframes; nested pre-renders don't drive the export progress bar
  (needs weighting across the N+1 passes); the intermediate cache is per-export
  (a cross-export cache keyed on comp content would skip re-renders); "bake a
  comp to a flat library asset" and a shared/reusable comp registry (edit once,
  update everywhere) remain future work._

### Text updates — fonts, colors & styling

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
- [x] **Sparkles (composable "Text effects" section)** — a decoration toggle on a text layer, deliberately SEPARATE from Entrance/Exit so the two combine: with a typewriter entrance the sparkles follow the reveal letter by letter, with a fade (or anything else) they scatter across the text. That makes both originally-requested effects fall out of one control, and every future effect added here works with every entrance for free. Amount + colour are the only knobs. Amount is defined as sparkles **on screen at once** (density x 10, up to 100) rather than a birth rate, so the look holds steady as an overlay gets longer instead of thinning out. `shared/sparkle.ts` is the single source of truth: placement is deterministic (seeded from the text, so sparkles never reshuffle between preview, export and re-renders) and derived ONLY from text + font size + window, because **neither side may measure glyphs** — the DOM and libass disagree and cannot consult each other. The seed must stay resolution-independent (the preview passes a logical font size, the export one pre-scaled to output px); a test pins that halving the font size halves every offset while timing and rotation are untouched. Export burns one `\p1` vector drawing per sparkle on ASS **Layer 1**, above the glyphs; unlike animations they survive the rasterised-PNG path (a gradient/wrapped overlay gets a sparkle-only ASS over its image). _Verified: `\p1` drawings compose with `\fad`/`\t(\fscx\fscy)`/`\frz` (FFMPEG-NOTES "ASS animation tags"), and the ACTUALLY GENERATED ass renders with the sparkle rising from its event start, peaking at mid-life and hitting baseline exactly as the event ends; `e2e/sparkle.spec.ts` covers the toggle, the preview paint, and playhead-driven (not wall-clock) timing._ _Verified end-to-end by the owner (2026-08-29): sparkles over real footage in the preview and burned into a real export; the density scale was raised ~10x off the back of it._

### Timeline & playback

- [x] **Stack overlapping blocks vertically in the timeline lanes.** Done via
  greedy interval packing (`lib/lanes.ts` `packRows`) for the text, caption, and
  audio lanes; lanes lay out vertically by row count and the track grows to fit.
- [x] **Left track-header gutter** — a fixed (non-scrolling) column down the left of the timeline; each lane (Clips / Text / Image / Captions / Audio) gets a full-height tinted rounded "bubble" header, like Premiere/Resolve. The track content scrolls horizontally beside it (gutter stays pinned and is kept vertically in sync with the track scroll). Built in `Timeline.tsx`; persisted in the `timelineView` localStorage view.
  - [x] Resize a lane by click-dragging its header bubble vertically (or the bottom-edge handle); the drag adjusts height-per-row so clips scale with the lane. Minimize/expand by double-clicking the bubble (or the ▾/▸ chevron). Collapsed lanes shrink to a thin tinted strip, hide their blocks + resize handle. Per-lane `{ rowH, collapsed }` persisted in the `timelineView` localStorage view.
- [x] **Snap-to-grid / magnetic timeline** — block move/trim snaps to clip/audio boundaries, playhead, and 0 (`lib/snap.ts`).
- [x] **Edge-scroll during timeline drag** — dragging a clip, caption, or audio block
  near the left/right edge of the track auto-scrolls the timeline (rAF loop, scroll
  speed proportional to edge proximity within ~40px). Shared `edgeAutoScroll` helper
  (`Timeline.tsx`) used by all three drag handlers; each now folds the live
  `scrollLeft` delta into its time delta (`deltaFor`) so the dragged block keeps
  tracking the cursor as the view scrolls, and re-applies position on each scroll
  tick. Loop cancels on `pointerup`.
- [x] **Playhead follow modes** — Off / Page / Center segmented control in the
  timeline toolbar (next to Zoom; there is no menu bar yet). A `useEffect`
  watching `time` while playing adjusts `scrollLeft`: Center keeps the playhead
  mid-view every tick (user horizontal wheel is swallowed while active so it
  can't fight the auto-scroll; scrollbar drags are re-asserted away next frame);
  Page jumps the view so the playhead lands back at the left edge whenever it
  exits. Persisted as `timelineFollow` in localStorage. e2e: `e2e/follow.spec.ts`.
- [x] **Snap selected clip to end of previous clip** — ⇤ Snap on the timeline bar and the **N** keybind.
  The pure part is `snapToPreviousDelta` (`lib/links.ts`, not `lib/timeline.ts` as first sketched: it is a
  whole-SET operation over the flattened tile model and belongs next to the `moveItemsBy` it feeds, and
  timeline.ts is imported BY links.ts so the dependency only runs one way). It returns a delta, or `null`
  when already flush — which is also what disables the button and skips the undo step.
  - Works on a link group / multi-selection: the EARLIEST member is the anchor and its LANE is the one
    searched, so the set moves as one and every relative offset survives.
  - The delta is signed: a gap closes leftwards, but an OVERLAP closes rightwards, because a tile that
    starts before the anchor and ends after it is still "the previous clip". Considering only tiles that
    END before the anchor would skip an overlapping neighbour and snap to some earlier one instead.
  - With nothing before it in the lane, it snaps to 0.
  Needed a `lane` on `Tile` (`TileLane`). Rather than leave that as a second copy of the grouping
  `Timeline.tsx` already derived inline, both now go through `layerLane`/`audioLane` in `lib/links.ts`,
  and `LANE_STYLE` is `satisfies Record<TileLane, …>` so a new band without colours is a compile error.
  _Verified: 10 unit cases in `links.test.ts` + `e2e/snapToPrevious.spec.ts`
  (button, keybind, N ignored while a field has focus, disabled-when-flush, snap-to-0, single undo step,
  linked pair keeping its offset) — driven against the BUILT app with real pointer/keyboard events._
  _Touches neither preview nor export, so the ffmpeg smoke-test gate does not apply; what a human may still
  want to judge is whether the LANE is the right notion of "previous clip" for their editing habits._

### Audio

- [x] **Sound effects — generated echo, ensemble & chorus tracks** — the Inspector’s "Sound effects" section (on a video layer and on an audio clip) renders an effect’s **wet signal only** and drops it on the timeline as its own `AudioClip` (`kind: 'fx'`, `AudioClip.fx` provenance, migration v19), mixed over the untouched dry clip. Rendering to a real asset rather than resolving the effect at export time is what makes preview and export identical — the preview plays the very samples the export mixes — and it means the track draws its own waveform and moves/trims/fades/splits with no new code (export needed **zero** changes). Content-addressed, so re-rendering the same settings reuses the file on disk. Selecting an effect track re-edits and re-renders it in place, from the clip it was BUILT from. Effect tracks join the source’s link group, are excluded from captions, and live in a new **FX lane** that appears only when one exists. Model + tap/voice math in `shared/audioFx.ts`; ffmpeg args in `services/audioFx.ts`. _Two verified traps (docs/FFMPEG-NOTES.md "Audio effects"): `aecho` has **no feedback**, so N repeats are N explicit geometric taps; and ffmpeg’s own **`chorus` filter is unusable** — it ignores its `delays` entirely (everything lands at 1–6 ms whether you ask for 40|60|75 or 400|600|800), so the stacking effects are built from primitives: **ensemble** (fixed detune) via `asplit` + per-voice `asetrate`/`aresample`/`atempo`/`volume`/`adelay` + `amix`, and **chorus** (the real thing — an LFO-swept detune, the shimmer a chorus pedal makes) via `vibrato`, whose sweep depth and rate are both verified accurate. `vibrato` also bursts at its output start, so the chorus chain is primed with silence that is trimmed off again (a fade-in does NOT fix it — it relocates the click and adds a worse one). Migration v20 renames the original fixed-detune effect from "chorus" to "ensemble", carrying its settings so existing tracks keep sounding as rendered; the ensemble filter string is byte-identical to the old chorus one, so already-rendered assets keep their content hash._ _Verified: the generated filter strings run through real ffmpeg with the output inspected sample-by-sample (echo taps at exactly 260/520/780 ms with geometric ratios; chorus voices at exactly 11/21/32 ms at the designed gains; no dry signal in either); `e2e/audioFx.spec.ts` drives the real Inspector through a real render onto the FX lane._ _Verified end-to-end by the owner (2026-08-29): adding, cutting, re-rendering and listening to effect tracks in the app, and a real export carrying an FX track through the mix._
- [x] **Waveform-based audio editing** — split-on-silence (`silencedetect` → speech segments) + per-clip denoise (`afftdn` on export).
- [x] **Project-wide noise filter + per-clip override** — `Project.denoiseDefault` (off by default) is the lane-wide noise-reduction default; each `AudioClip.denoise` is now **tri-state** (`undefined` = inherit the default, `true`/`false` = force on/off and exempt the clip). `effectiveDenoise`/`denoiseOverridden` (`shared/project.ts`) resolve it; export applies the resolved value. UI: project default lives in the Inspector's no-selection "Project settings"; the audio-clip Inspector has a Default/On/Off segmented control; overridden clips show a small **N** badge (green = on, struck = off) on their timeline block. _Migration v8 seeds `denoiseDefault=false` and normalises legacy redundant `denoise:false` → inherit._
- [x] **Split audio clips on the timeline** — audio clips support split-at-playhead like video clips. Each split yields two independent segments with their own `inSec`/`outSec` (outer fades preserved, the seam is hard); they can then be moved/trimmed/deleted separately. Pure `splitAudioClip` in `lib/timeline.ts` (unit-tested) → `splitAudioAt` store action (undo-snapshotted via `commit`). Wired to both the ✂ Split button and the **S** keybind, which now act on whichever is selected (audio clip or video clip — selection is mutually exclusive).
- [x] **"Extract audio from clip" via File menu** — File ▸ "Extract audio from clip…" picks any video and pulls its audio into the project library as a standalone audio asset (no timeline placement needed), ready to drag onto the music track. `media:extractAudioDialog` IPC → `extractAudioToLibrary` (`mediaStore.ts`): probe-guards "no audio track", extracts lossless WAV (`-vn -c:a pcm_s16le`, `buildExtractAudioArgs`), content-addresses it under `<data>/extracted/<hash>.wav` (idempotent re-extraction), then reuses `importFile` (new optional `displayName`) + background `ensureProxy` for the AAC proxy/waveform. Progress shows via the jobs pipeline; `useExtractAudio` adds the result to `mediaIds`.

### Library & media

- [x] **Project-scoped media library** — the library now reflects only the current project's media, not a global pool. New project = empty library; opening a `.reel` auto-populates from its `mediaIds` (legacy files without one are backfilled from referenced clips/images/audio in `migrateProject`). The `media/{hash}/` store on disk stays global; each project's `mediaIds: string[]` scopes what the panel shows. The library's × removes from the project list only (kept on disk; other projects may reference it).
- [x] **Library clip preview** — preview a clip from the library without placing it.
  Hovering a video card pops out a large floating preview beside it (`PreviewPopout`,
  `Library.tsx`): portaled to `<body>` so library/timeline overflow can't clip it,
  anchored to the card's rect (flips to the other side near the viewport edge), sized
  to the clip aspect (≤560px tall), looping **with sound**, and dismissed on mouse-leave.
  Unmuted autoplay is enabled via `autoplayPolicy: 'no-user-gesture-required'` (main-window `webPreferences`, `index.ts`).
  Audio cards toggle inline play/pause on click (`AudioThumb`).
- [x] **Scrub bar on the library preview popout** — the hover `PreviewPopout`
  (`Library.tsx`) is now interactive: bottom-gradient scrub bar with a
  current/total readout, click/drag to seek (rAF-smoothed progress; the loop
  pauses while scrubbing and resumes on release). An invisible bridge div spans
  the card→popout gap to prevent premature dismissal. e2e: `e2e/popoutScrub.spec.ts`.
- [x] **Import folder into library** — a directory anywhere in an import path list is now walked and its
  media imported. Expansion happens in ONE place (`expandImportPaths`, `services/importScan.ts`, called by
  `importMany`), so the File menu, the OS drag-drop onto the window and the `importPaths` IPC all handle a
  folder identically — dropping a folder needed no new code at all. Recursive by default (depth-capped, and
  a 500-file limit so a mis-dropped tree cannot queue thousands of probes), skipping `node_modules`/`.git`/
  recycle bins and the junk real media folders carry (macOS `._` resource forks share their file's
  extension, so the extension filter alone would import them). Order is stable and duplicates collapse.
  The extension filter applies only INSIDE a walked directory: an explicitly picked file is always
  attempted, since the dialog offers an "All files" filter. UI: File ▸ Import folder… (`importFolderDialog`,
  an `openDirectory` picker). _Verified: `importScan.test.ts` (10 cases) runs against a real temp tree._
  _Smoke-tested by the owner in `npm run dev` (2026-09-04): importing a real folder works._

### Video & export

- [x] **Auto background removal (subject-aware crop)** — the Inspector's "Remove background" runs the RVM video-matting model (`onnxruntime-node`, bundled ONNX under `resources/models`) over the source clip frame-by-frame as a `matte` job and saves the result as a new transparent VP9 (`yuva420p`) WebM in the library. Alpha is carried end-to-end through proxy, preview, and export. Service: `removeBackground.ts` + `removeBackgroundArgs.ts` (unit-tested). _(CPU inference; GPU providers are a later optimization.)_
- [x] **Color correction controls** — per-clip exposure/contrast/saturation (Inspector sliders; preview CSS filter mirrors export `eq`).
- [x] **Motion stabilization (project default + per-clip override)** — mirrors the
  noise-filter shape. `Project.stabilizeDefault` (`Stabilize | null`, null = off) is
  the project-wide default; `VideoContent.stabilize` is tri-state. Export runs a vidstab
  two-pass before compositing. Pure builders `buildVidstabDetectArgs`/`buildVidstabTransformArgs`
  (`exporterArgs.ts`, unit-tested). UI: project default in "Project settings"; per-clip
  Default/On/Off segmented control; overridden clips show a small **S** badge.
  _Migration v8 seeds `stabilizeDefault=null`._

### Storyboard & script

- [x] **Storyboard / script integration** — Script drawer; lines pin to the playhead and show as ruler markers (click to seek).

### UI

- [x] **Delete button applies to all timeline objects** — both the `Del` keybind
  (`App.tsx`) and the toolbar 🗑 button (`Timeline.tsx`) delete whatever is selected,
  checking `selectedLayerId` → `selectedCaptionId` → `selectedAudioId` in priority
  order (`deleteSelected`/`canDelete`). The button's disabled state reflects any selection.

### Packaging & distribution

- [x] **Bundle ffmpeg + whisper.cpp for distribution.** Engines ship as electron-builder
  `extraResources` under `<resources>/bin/{ffmpeg,whisper}`: ffmpeg.exe + ffprobe.exe
  (Gyan full build), whisper-cli.exe + DLLs, and the `ggml-small.en.bin` model.
  `scripts/collect-binaries.mjs` stages them from the dev machine into the gitignored
  `resources/bin/`. Runtime discovery prefers the bundle, falling back to the system install in dev.
- [x] **Auto-update** — `electron-updater` wired in `src/main/services/updater.ts`.
  Polls the `publish` feed on launch, auto-downloads, and prompts "Restart now / Later"
  on `update-downloaded`. Feed configured as GitHub Releases (`publish:` in `electron-builder.yml`).
  _Action needed before first release: confirm `publish.owner`/`repo`, create the repo,
  publish with `build:win -- --publish always` + a `GH_TOKEN`._

### Bugs fixed

- [x] **A clip read as ready while its proxy was still encoding: a layer added in that window stayed blank until reload (branch `claude/practical-lederberg-a1a39f`).**
  Reported 2026-09-28 on a 33s 1080x1920 60fps iPhone clip. `mediaStore` decided `proxyReady` with `existsSync(proxy)`, but ffmpeg creates its output the moment encoding starts. So any library refetch mid-encode (e.g. importing another file) flipped the clip to ready, and the Library enabled its add buttons. A layer added in that window got a preview `<video>` that failed for good with `MediaError 4: DEMUXER_ERROR_COULD_NOT_OPEN` (a faststart mp4 has no `moov` until the end), and it never retried.
  The same gate hid three siblings:
  - a partial alpha `proxy.webm` OPENS and plays truncated;
  - the exporter's `existsSync(audio.m4a) ? proxy : original` would have picked up a partial audio proxy;
  - a failed or killed encode left a truncated file that read as ready forever, even across re-imports.
  **Fix:**
  - Every existence-gated generator (proxy, alpha proxy, audio proxy, thumb, waveform, display PNG) now encodes to a `.part` name. It renames onto the final name only on exit 0, and deletes the partial on failure (`writeAtomically`, `services/atomicWrite.ts`).
  - `ensureProxy` coalesces concurrent calls for one asset into a single build, which resolves only once the proxy is complete.
  - The best-effort artifacts are coalesced per path, because `hydrate` regenerates them on every refetch.
  _Verified:_
  - `e2e/proxyReady.spec.ts` against the built app, on an iPhone-shaped HLG 1080x1920@60 clip. The unfixed build reproduced the exact MediaError 4 through the Library button; the fixed build was green 5/5.
  - A throwaway smoke put every changed generator through the built app on `samples/` media (HEVC-HDR and H.264 mp4, alpha WebM, WAV, PNG). All artifacts opened in Chromium, and no `.part` file was left.
  - Unit tests, plus all 86 e2e specs green.
  - **Marked done by the owner 2026-09-28.** Traps recorded in FFMPEG-NOTES "Partial outputs".
  _Still open separately:_ no auto-retry of an interrupted proxy, and the non-atomic `asset.json` (see Bugs).

- [x] **Captions dropped words near the start (and sometimes the end) of a cut clip — fixed in two rounds (branches `fix/caption-word-timings`, `fix/caption-opening-sentence`).**
  _The original hypothesis — that each clip was sliced to its own `inSec`→`outSec` audio file before whisper saw it — was WRONG. `whisper.ts` transcribes the whole original once per media; the trim is applied afterwards in the renderer._
  **Round one — smeared word times.** whisper ran with `-ml 1 -sow -oj`, whose per-entry `offsets` are SEGMENT bounds that tile edge to edge and smear a segment's leading words back over the silence before the speech (measured 2.42s early on `IMG_8743.MOV`), so the trim filter in `captions.ts` discarded words that were really inside the clip. Fixed with DTW token timestamps (`-dtw <preset> -nfa -ojf`, pure `whisperArgs.ts`) behind a sanity gate that falls back to the offsets — a mismatched preset yields garbage at exit 0. A word the cut splits goes to the side holding more of it, with a small edge tolerance and a minimum on-screen time.
  **Round two — owner report on the `return to run` project.** whisper had dropped a file's opening sentence ("Ramp up gradually.") outright, under every flag combination, because the recording opens with a 0.1s click and 5s of room tone; DTW then stretched the next sentence back over its audio, 1.5s early. Decoding now starts 0.5s before the first sustained sound (`decodeStartSec` → `-ot`). The same clip lost its last word ("months.") because DTW times word starts only, so the word before a pause was stretched across it and its midpoint crossed the cut; each word now ends where silencedetect says its sound stops. `TRANSCRIPT_VERSION` re-transcribes stale caches.
  _Verified against the real binary over all 8 clips / 6 sources of that project (every speech run inside every clip captioned, no word lost), unit + all 79 e2e specs green, and **confirmed by the owner in `npm run dev`**. Traps recorded in FFMPEG-NOTES "whisper word timings". Still open separately: non-speech annotations leaking in as caption words (see Bugs)._

- [x] **Burned text did not match the preview — text layers AND captions (branch `fix/text-export-parity`, stacked on `fix/aspect-ratio-formats`).**
  Measured on `main` with the bundled fonts: every libass-burned block (plain text that was never side-resized, and every caption) came out smaller than the preview — Montserrat at 0.64x its preview width, other faces 0.52–0.77x — because libass sizes a face so its Windows line height, not its em, equals `\fs`. Fixing only the size would have left lines 1.3–1.9x the font size apart (libass leading is that same metric, and `\fscy` scales it too), baselines off by up to 9px per face, pills square, too tall and opaque (the alpha inside `\3c` is ignored), outlines twice as thick (libass draws `\bord` wholly outside; CSS shows half), and libass wrapping on its own glyph widths. The preview had its own bugs: captions were placed by `left:`, so they wrapped at half the frame; gradient text had its text-shadow painted over the gradient; and a pill still showed an outline the Inspector says is "off while pill on". Commits `3eb3378`/`305327c` fixed the pill geometry and font loading for RASTERISED text only — this was the libass path.
  **Now text layers and captions are one thing end to end.** One definition of the block (`shared/textStyle.ts`: box, 1.25 leading, one frame-relative wrap width for both, paint, pill) drives the preview's single `TextBlock` and the export's rasteriser. For the libass burn, Chromium lays every block out with that same CSS (one pass per comp, `TextRenderer.layout` → `textLayout.ts`) and each LINE burns as its own event exactly where Chromium put it (`WrapStyle: 2`), with `\fs`/baseline corrected by each face's metrics (`FontDef.win`, pinned to the TTFs), the pill drawn as the rounded box Chromium measured (with its alpha), and half-width outlines. Animations carry across lines (typewriter reveals line by line; karaoke lines open with an empty `\k` delay — verified). Captions rotate as a block (`\org`). If the layout pass fails, text still burns at the right size (newline-only lines, no auto-wrap). Gradient text now takes its shadow as a `drop-shadow` filter and no default shadow, in the preview too. See FFMPEG-NOTES "libass text metrics".
  **This changes how existing exports look** — text and captions burn larger, now matching what the preview always showed; captions may wrap differently in the preview (at the full width, as the export does).
  _Verified against the real binary: libass burn vs the preview's CSS rendered at output size, line by line — tops/bottoms ≤1px, centres ≤0.5px, widths 0.995–1.007, same line counts — for Montserrat (explicit newline), Poppins + translucent pill (auto-wrapped), Anton, Pacifico at 1.3x, and an auto-wrapped caption; `e2e/textParity.spec.ts` pins this on a real export. Preview-vs-export screenshots at 3x agree on the default shadow, outline, translucent two-line pills and a tilted two-line caption; multi-line typewriter and karaoke render correctly. Known limit: karaoke's unlit words dim only their fill in the export (libass `\k` can't key the outline/shadow); a bounce pops each line about its own centre. _Verified end-to-end by the owner in `npm run dev` with real media (2026-09-27)._

- [x] **Picking Square in Format ▸ Aspect ratio left the preview 9:16 — fixed, plus ten standard formats (branch `fix/aspect-ratio-formats`).**
  The preview stage was hard-coded `aspect-[9/16]`, and the export mapped the 1080×1920 space onto 1080×1080 with a NON-uniform `sy = 0.5625` — every square export was squashed, not cropped. **Model now:** layers stay in the canonical 1080×1920 space; a format is a window CENTRED on it (`shared/frame.ts`), so switching format changes one field (`project.preset`) and moves no layer — switch back and everything is where it was. The preview draws the frame at the format's aspect and crops to it (`frameCanvasStyle`); the export maps canonical → output uniformly (`frameToOutput`, verified off-canvas overlay behaviour in FFMPEG-NOTES "Non-9:16 output frames"). A clip whose aspect differs from the frame keeps its size and is cropped by it; it stays movable and resizable — resize handles that would land outside the frame are pinned to its edge (`data-pinned`) and still resize correctly, because the drag math works on deltas against the real box. **Formats** live in the `shared/formats.ts` registry, built in two levels: `defineAspect(16, 9)` derives size (short side 1080, even dims), orientation, label and frame from the ratio alone; `definePreset` extends an aspect with a name and platform extras (Instagram safe zones on Reel/Story/Carousel). Shipped: Reel, Story, Carousel (9:16) · Feed post (4:5) · Portrait (3:4) · Pin (2:3) · Square (1:1) · Landscape (16:9) · Classic (4:3) · Cinematic (21:9); the Format select groups them Vertical / Square / Horizontal. Adding one is an `ASPECTS` line plus an `EXPORT_PRESETS` line. Things that follow the format: layouts stretch onto the frame (Split L|R is two 960×1080 halves in 16:9), compound clips and nested comps render through the same frame, new clips drop in FITTED to it (`fitScale`; scale 1 means "fits the canonical 9:16", so in other formats a new clip's scale is not 1), the crop tool crops to the project's ratio ("Crop to 16:9") and keeps the clip's size relative to the frame (`setVideoCrop`/`rescaleForAspect`), and the Inspector reads position and zoom frame-relative (100% = fits). Also: safe-zone guides and the checklist's safe-zone rule only apply to presets that carry zones; slide-animation travel scales by the output scale rather than `target.height / 1920`; the crop editor now re-seeds its box on each open (it was seeded once, at app start). Migration v22 normalises an unknown preset id to Reel. Identity in 9:16: every `exporterArgs` string test is unchanged.
  _Verified: vitest (formats/frame/fit/layout/checklist/ASS units) and `e2e/aspectRatio.spec.ts` — the Format select reshapes the preview with layer JSON byte-identical across reel→landscape→square→reel, an overflowing clip's pinned handles resize it and the body drags by the right logical delta, "Crop to 16:9" fills a 16:9 frame and "Remove crop" re-fits, and real landscape + square exports are the right size and crop (band-exact pixel samples that a squash would fail). Driven through the BUILT app with `samples/` media: preview screenshots and exported frames agree in 9:16, 1:1, 4:5, 16:9 and 21:9 (NVENC). _Verified end-to-end by the owner in `npm run dev` with real media (2026-09-27)._

- [x] **Drop overlay stuck on screen** — if a file drag left the window without dropping, the "drop here" overlay never cleared. Fixed via the depth-counted `useDragDepth` hook (`lib/dragDepth.ts`); the Timeline's drop ring had the same latent bug and uses it too.
- [x] **Audio waveform not rendering on timeline audio blocks** — root cause was Tailwind preflight's `img { max-width: 100% }` clamping the inline `width: >100%` (used to window the full-source waveform to the trimmed span) while the negative `left` still applied — so any clip with `inSec > 0` pushed its waveform entirely outside the overflow-hidden block. Fixed with `max-w-none` on the img (`Timeline.tsx`); regression spec `e2e/waveform.spec.ts`.
- [x] **The bottom-most layer was pinned as "Background" and could never be restacked.** Found by the
  owner (2026-09-04) while smoke-testing the drag-helper sweep: dragging in the Layers panel "did
  nothing". The drag was fine — the row simply WAS the pinned Background, which showed a `▦` instead of a
  `⠿` handle. The pin turned out to be UI-only: `backgroundId = stack[0].id` lived entirely in
  `LayersPanel.tsx`, and nothing in the preview, the exporter, `shared/layers.ts` or the schema treats
  `layers[0]` specially; git history shows it arrived with the panel's first commit and no doc recorded a
  reason. It cost the common case dearly: a single-clip Reel has exactly one layer, which was therefore
  "the Background" — unmovable, with nothing placeable beneath it — and a two-layer project offered one
  draggable row and so nothing to reorder.
  **Dropped it** (owner picked option (a)): every visible layer now has a handle and restacks, the
  bottom-most included. The store side needed no change — `reorderLayers` already takes the visible set
  front→back and `applyVisibleOrder` permutes those layers within their own slots, so handing it the full
  set is exactly what it was built for. The `▦`/"bg" row treatment is gone with the pin.
  _Verified: `e2e/layersReorder.spec.ts` (7 cases) covers the restack, raising the bottom-most layer, and
  the two-layer case the owner actually hit; restoring the pin fails exactly the four pin-dependent tests._
  _Not addressed: the ⠿ handle is a 14px target on a 30px row and the rest of the row only selects, which
  is the other half of the "it does nothing" impression. Widening the drag affordance to the whole row
  (checkbox and label staying clickable) is a separate, still-open UI question._
- [x] **Font size input clamps on every keystroke** — was a whole CLASS of field, not one: 13 numeric
  Inspector inputs clamped inside `onChange`, so the clamped number was re-rendered into the field on
  every keystroke (the field could never be emptied, and "1"/"12" on the way to "120" snapped to the
  minimum as you typed). Fixed once, by a shared `NumberInput` in `components/ui.tsx` that holds a DRAFT
  string while focused: an in-range value still commits live so the preview follows each keystroke, while
  an empty/partial/out-of-range one waits for blur or Enter, and Escape abandons it. Every clamping site
  now routes through it (`Inspector.tsx` x11, `TextStyleControls.tsx` x2) — which also picked up a
  two-sided clamp (trim-in) that the original grep had missed because its `onChange` spanned lines.
  _Verified: `e2e/numberInput.spec.ts` covers clear-while-typing, the below-minimum intermediate, live
  commit, blur-clamps, blur-on-empty reverting, Escape and Enter; the first test fails without the fix.
  Escape initially still committed — blur fires `commit` before React applies `setDraft(null)` — which is
  why the draft is mirrored in a ref._
- [x] **Edge-scroll speed accelerates instead of staying constant** — `edgeAutoScroll` scaled speed by
  edge proximity, so the same hand movement scrolled a different distance depending on where in the 40px
  band it landed and overshooting was hard to correct. The band is now a pure GATE: `edgeScrollDir`
  returns a DIRECTION (-1/0/+1) and the rate is a flat 12 px/frame anywhere inside it (or past the edge).
  Moved out of `Timeline.tsx` into `lib/pointerDrag.ts` alongside the rest of the drag plumbing, so the
  invariant is unit-testable — `pointerDrag.test.ts` pins that the velocity is identical across the whole
  band, which is what fails if a ramp is ever reintroduced.
  **A second, independent cause of the same symptom surfaced in testing:** the owner reported that after
  the flat-rate fix, dragging RIGHT felt right but dragging LEFT still accelerated. That was not the
  scroll rate at all — the track's width is derived from the total duration, so moving the rightmost tile
  left shrinks the scrollable area mid-drag; the browser clamps `scrollLeft` to the new maximum, that
  clamp feeds into the drag's `dx` (which adds the live `scrollLeft`), the tile jumps further left, and
  the width shrinks again. A genuine runaway that a constant velocity cannot fix. The vertical axis had
  been guarded against exactly this since the lane-resize work (`resizeFloorH`); `dragFloorW` is the
  horizontal twin, pinning the width for the drag and releasing it on pointer-up. All five horizontal
  drags go through one `startEdgeScrollX` wrapper so none can re-open it. The floor must RATCHET with the
  drag rather than be snapshotted at grab time — the owner caught a first attempt that pinned once: drag
  right and the natural width grows past the stale floor, so dragging back left without releasing is free
  to shrink through that band and the runaway returns. (The vertical twin always ratcheted; porting it
  dropped that property.) _Verified: owner-reported and
  reproduced; `e2e/edgeScrollShrink.spec.ts` asserts the width never shrinks mid-drag, that the pin is
  released after, a mid-drag REVERSAL (right then left, still held) never shrinks, and a leftward drag moves
  the tile by exactly the pointer distance. Both failure modes were reproduced by reverting the fix: with no
  pin two tests fail; with a frozen (non-ratcheting) pin exactly the reversal test fails._
  _Smoke-tested by the owner in `npm run dev` (2026-09-04): both directions and a mid-drag reversal are
  free of acceleration, and 12 px/frame was confirmed as the right feel — leave `EDGE_SCROLL_SPEED` alone
  without a reason to change it._
- [x] **Bundled fonts never loaded in the preview** — `reelmedia://` was registered without the `corsEnabled` privilege. CSS `@font-face` fetches are always CORS-mode, so Chromium rejected the scheme outright ("Cross origin requests are only supported for protocol schemes: chrome, …, https") and EVERY bundled face silently fell back to a system font — in dev (`http://localhost:5173`) and in the packaged app (`file://`) alike, since the font feature shipped. Nothing threw, so the only symptom was that the preview quietly stopped matching the faces libass burns, which is the one guarantee `shared/fonts` exists to provide; any Reel exported with a text overlay had a preview that disagreed with the burn. Fixed by adding `corsEnabled` plus the `Access-Control-*` headers the privilege then obliges every response to carry (`Range` allow-listed so `<video>` seeking keeps working). `e2e/fonts.spec.ts` pins all three — every face loads, a missing face 404s, and media range requests still return 206 — and all three fail without the fix. _Verified against the real binary: all 14 faces load and each measures a distinct rendered width from the fallback._
- [x] **Rasterised text was cropped off the bottom of every export** — a text layer with a gradient OR an explicit wrap width (`widthPx`, i.e. any overlay that has been side-resized) burns as a full-frame PNG rasterised in a hidden 1080x1920 `BrowserWindow`. The `BrowserWindow` constructor CLAMPS width/height to the display work area, so on an ordinary landscape monitor that window was born short (measured 1080x1032 on a 1920x1080 screen) and `capturePage()` returned a picture cropped at that height. The normalisation guard compared the WIDTH only — which was correct — so the short PNG sailed through and every overlay below the cut vanished from the export with nothing raised anywhere. Fixed by re-asserting the size with `setContentSize` (not clamped, and it survives `showInactive()`), and by making a non-uniform capture size THROW so the caller's existing fallback burns the text flat through libass instead of dropping it. _Verified end-to-end: the owner's own overlay at y≈1110 was missing before and burns correctly after; the fallback path was exercised by disabling the fix and confirming the text still appears._
- [x] **Text overlay pill geometry disagreed with the preview** — surfaced the moment rasterised text actually reached the output. Two separate breaks. (1) The pill is an inline `<span>` BETWEEN the positioning box and the text span, and an inline box's background is sized from ITS OWN font metrics; `buildHtml` declared the font on the innermost span only, so the pill inherited the document default 16px and painted a box 16 + 2x18 = 52px tall (measured exactly that) behind 108.89px glyphs — the text sat outside its own background. The preview never had this because it declares the font on the wrapper div. (2) Decorations were scaled by the output scale only, omitting `layer.scale`, so a resized overlay wore a pill sized for the unscaled text — in BOTH the raster and the ASS fallback path, the latter passing the pill through completely unscaled. Also aligned `line-height` with the preview's Tailwind `leading-tight`, read out of the built stylesheet as 1.25 rather than assumed (the export had 1.1). The factor now lives in `services/textScale.ts` with a test pinning the real invariant: the pill-to-font ratio survives into the export unchanged at any layer scale and any preset. _Verified by pill aspect ratio (scale-independent, so it compares across the CSS-scaled preview stage and the 1080x1920 output): preview 1.596, export 5.346 before, 1.598 after; owner confirmed in a real export._ **Note:** this changes output for any text layer that has been resized, ordinary ASS-path overlays included — they now match the preview, but earlier exports will not match new ones.
