# TODO / backlog

Deferred polish and features, newest-first. Not blocking; pick up as time allows.

## Open

### Platform profiles system

- [ ] **Platform profiles** — replace the hardcoded Instagram-specific UI with a profile system. Each profile bundles export presets, checklist rules, safe-zone guides, default overlay styles, and aspect ratio. Profiles can be toggled on/off; their features (checklist, safe-zone overlay, hook-zone marker, keyword bank) only appear in the UI when the profile is active.
  - **Built-in profiles to ship with:**
    - `Instagram Reels` — current behavior: 9:16 1080×1920, 30–90s rule, hook-zone marker, safe-zone overlay, caption keyword checker, Reel/Story/Carousel presets.
    - `General` — no platform-specific rules; just timeline + export. Useful as a blank slate.
  - **Custom profiles** — user can create, name, duplicate, and delete profiles; each stores its own set of rules and presets in `settings.json`.
  - **UI:** add a menu bar (File / Edit / Profile / …) across the top of the app window — standard dropdown tabs. `Profile` menu lists available profiles with a checkmark on the active one, plus "New profile…" and "Manage profiles…" actions.
  - Where to start: `src/shared/export.ts` (profile type), `src/main/services/projectStore.ts` (persist active profile), `src/renderer/src/state/editorStore.ts` (active profile in store), new `ProfileMenu` component, conditionalize `ReelChecklist`, `SafeZoneOverlay`, `HookZoneMarker` on active profile's flags.

### Not planned / missing features

- [ ] **Clip-audio locking** — allow a video clip to be locked to an audio clip so they move and split together. When locked, dragging either clip moves both by the same delta; splitting either at the playhead splits both at the same timeline position. UI: a small lock icon between the video and audio lanes on overlapping clips; click to toggle. Data model: add an optional `lockedAudioId` field on `Clip` (and `lockedClipId` on `MusicTrack`) referencing the paired asset. Logic lives in `timelineMath.ts` — move/split ops check for a lock and apply the same operation to the paired track before returning the new project state. Undo/redo snapshots capture both changes atomically.
  - **Open question:** when one locked clip is deleted, should the other be deleted automatically, or just unlocked and left in place? Could be a preference (always delete both / always just unlock / ask each time).

- [ ] **Split audio clips on the timeline** — audio clips on the music track should support the same split-at-playhead operation as video clips. Each split produces two independent audio segments with their own `inSec`/`outSec` trim points, which can then be moved, trimmed, or deleted separately. Implementation: extend `timelineMath.ts` `splitClip` (or an equivalent `splitAudio`) to operate on `MusicTrack` entries; update `editorStore` undo snapshots; wire the existing split keybind/button to fire on whichever track is selected (video or audio).

- [ ] **"Extract audio from clip" via File menu** — a File → "Extract audio from clip…" action that lets the user pick any video file and pull its audio track directly into the project library as a standalone audio asset, without needing to place the clip on the timeline first. Implementation: file picker → `ffmpeg -i input -vn -c:a pcm_s16le extracted.wav` (or aac for smaller size) → hash + copy into `media/{hash}/` → add to project `mediaIds` → appears in the library's audio section ready to drag onto the music track. Should reuse the existing job pipeline for progress feedback.

- [ ] **Project-scoped media library** — the library should reflect only the media belonging to the current project, not a global pool. Opening a new project shows an empty library; loading an existing project auto-populates it with that project's clips, images, and audio. The underlying `media/{hash}/` store on disk stays global (so the same clip imported into two projects isn't duplicated on disk), but each `project.json` maintains its own `mediaIds: string[]` list and the library panel renders only those assets. Clearing/removing an asset from the library removes it from the project's list but does not delete it from disk (other projects may reference it). Key changes: `projectStore.ts` (serialize/deserialize `mediaIds`), `editorStore.ts` (library derived from project doc, not a global store), `MediaLibrary` component (reads from project state, not a shared media cache).

- [ ] **Auto background removal (subject-aware crop)** — detect the primary subject (person) in a clip using a segmentation model and remove or replace the background automatically. Likely approach: run a lightweight portrait segmentation model (e.g. MediaPipe Selfie Segmentation or ONNX rembg) frame-by-frame as a job in the main process, output an alpha-masked overlay, then composite via ffmpeg `overlay` + `alphaextract`/`alphamerge`. User can choose to replace the background with a solid color, blur, or a custom image. Useful for creating clean talking-head Reels without needing a physical green screen.

- [x] **Color correction controls** — per-clip exposure/contrast/saturation (Inspector sliders; preview CSS filter mirrors export `eq`). _LUT (.cube) support still TODO._
- [ ] **Speed ramping** — no variable speed or slow-mo support. Common in short-form video; would require ffmpeg `setpts` + `atempo` per clip segment and timeline representation of speed curves. _(Large.)_
- [ ] **Keyframe animation** — no way to animate overlay position, scale, or opacity over time. Would require a keyframe store per overlay property and interpolation in both preview and ASS export. _(Large.)_
- [x] **Snap-to-grid / magnetic timeline** — block move/trim snaps to clip/audio boundaries, playhead, and 0 (`lib/snap.ts`).
- [x] **Waveform-based audio editing** — split-on-silence (`silencedetect` → speech segments) + per-clip denoise (`afftdn` on export).
- [x] **Storyboard / script integration** — Script drawer; lines pin to the playhead and show as ruler markers (click to seek).
- [ ] **Canvas waveform (crisp at any zoom / sample-level).** Audio waveforms are pre-rendered PNGs (`showwavespic`), now scaled to clip length so they're crisp at realistic zoom — but a raster image still softens at extreme zoom. The DAW-style fix: decode the audio to a multi-resolution **peak cache**, then render the waveform on a `<canvas>` that redraws per zoom/scroll, switching from min/max peak envelopes to individual samples at extreme zoom. Bigger feature; overkill for Reels but the "infinite zoom" answer. Start: a peaks extractor (ffmpeg → raw PCM → min/max buckets) + a `<WaveformCanvas>` lane renderer.
- [x] **Left track-header gutter** — a fixed (non-scrolling) column down the left of the timeline; each lane (Clips / Text / Image / Captions / Audio) gets a full-height tinted rounded "bubble" header, like Premiere/Resolve. The track content scrolls horizontally beside it (gutter stays pinned and is kept vertically in sync with the track scroll). Built in `Timeline.tsx`; persisted in the `timelineView` localStorage view. _Per-lane mute/solo deferred — they'd need a data-model change; the gutter is layout/UI only as scoped._
	- [x] Resize a lane by click-dragging its header bubble vertically (in addition to the bottom-edge handles); minimize/expand by double-clicking the bubble (or the ▾/▸ chevron). Collapsed lanes shrink to a thin tinted strip and hide their resize handle.

### Explicitly out of scope for v1 (revisit post-launch)

- [ ] **Transitions beyond hard cuts** — no dissolves, fades, or wipes. ASS/libass can't do video transitions; would need ffmpeg `xfade` filter wired into the export pipeline.
- [ ] **Direct Instagram publishing** — export only; no Instagram API integration.
- [ ] **GPU whisper build** — transcription is CPU-only (`small.en`); GPU/CUDA build is optional upgrade.
- [ ] **Multi-cam editing** — out of scope for single-creator Reels workflow.

- [x] **Stack overlapping blocks vertically in the timeline lanes.** Done via
  greedy interval packing (`lib/lanes.ts` `packRows`) for the text, caption, and
  audio lanes; lanes lay out vertically by row count and the track grows to fit.

### Packaging & distribution

- [ ] **Bundle (or fetch) ffmpeg + whisper.cpp for distribution.** The NSIS
  installer ships the Electron app but not the ffmpeg/ffprobe binaries or the
  whisper.cpp binary + model — these are discovered at runtime and currently only
  exist on the dev machine (installed via winget / downloaded to
  `Documents\VideoEditor\bin\whisper`). On a clean machine the app would have no
  engine. Options: bundle the Gyan ffmpeg build + whisper binary as
  `extraResources` (watch licensing/size — the small.en model is ~465 MB), or add
  a guided first-run downloader that fetches them into the data dir.

- [ ] **Auto-update** — so recipients get new versions without manually reinstalling. Use `electron-updater` (`autoUpdater`) which polls a release feed on launch and shows a "Update available — restart to install" prompt. Simplest host: a private GitHub repo's Releases tab (free, no server to run). If distribution goes wider, add stable/beta channels. Wire into the existing electron-builder config via `publish` field in `electron-builder.yml`.

- [ ] **Custom app icon.** electron-builder logs "default Electron icon is used —
  application icon is not set". Add `resources/icon.ico` (256px) and reference it
  in `electron-builder.yml` (`win.icon`) so the installer, taskbar, and window use
  a real icon.

- [ ] **Code-sign the installer (Norton/SmartScreen false positives).** The
  unsigned `.exe` gets quarantined by Norton Cyber Capture / Windows SmartScreen
  because it has no signature and no download reputation. Fix: buy an Authenticode
  code-signing certificate (an **EV cert** earns SmartScreen reputation
  immediately; a standard OV cert builds reputation over downloads) and configure
  electron-builder signing. Interim: submit a false-positive dispute to Norton, or
  "Allow"/whitelist locally for personal use.
## MSC other todo
- [ ] 
## Done

(empty)
