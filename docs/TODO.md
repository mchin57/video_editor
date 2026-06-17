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

- [ ] **Auto background removal (subject-aware crop)** — detect the primary subject (person) in a clip using a segmentation model and remove or replace the background automatically. Likely approach: run a lightweight portrait segmentation model (e.g. MediaPipe Selfie Segmentation or ONNX rembg) frame-by-frame as a job in the main process, output an alpha-masked overlay, then composite via ffmpeg `overlay` + `alphaextract`/`alphamerge`. User can choose to replace the background with a solid color, blur, or a custom image. Useful for creating clean talking-head Reels without needing a physical green screen.

- [x] **Color correction controls** — per-clip exposure/contrast/saturation (Inspector sliders; preview CSS filter mirrors export `eq`). _LUT (.cube) support still TODO._
- [ ] **Speed ramping** — no variable speed or slow-mo support. Common in short-form video; would require ffmpeg `setpts` + `atempo` per clip segment and timeline representation of speed curves. _(Large.)_
- [ ] **Keyframe animation** — no way to animate overlay position, scale, or opacity over time. Would require a keyframe store per overlay property and interpolation in both preview and ASS export. _(Large.)_
- [x] **Snap-to-grid / magnetic timeline** — block move/trim snaps to clip/audio boundaries, playhead, and 0 (`lib/snap.ts`).
- [x] **Waveform-based audio editing** — split-on-silence (`silencedetect` → speech segments) + per-clip denoise (`afftdn` on export).
- [x] **Storyboard / script integration** — Script drawer; lines pin to the playhead and show as ruler markers (click to seek).
- [ ] **Left track-header gutter** — a fixed (non-scrolling) column down the left of the timeline labeling each lane (Clips / Text / Captions / Audio) with per-lane controls (e.g. mute, solo, height presets), like Premiere/Resolve. The track content scrolls horizontally beside it. Pairs with the existing per-lane resize handles (`Timeline.tsx`); would replace the unlabeled lanes with a clearer, more pro layout. Doesn't change the data model — purely a timeline layout/UI change.

### Explicitly out of scope for v1 (revisit post-launch)

- [ ] **Transitions beyond hard cuts** — no dissolves, fades, or wipes. ASS/libass can't do video transitions; would need ffmpeg `xfade` filter wired into the export pipeline.
- [ ] **Direct Instagram publishing** — export only; no Instagram API integration.
- [ ] **GPU whisper build** — transcription is CPU-only (`small.en`); GPU/CUDA build is optional upgrade.
- [ ] **Multi-cam editing** — out of scope for single-creator Reels workflow.

- [x] **Stack overlapping blocks vertically in the timeline lanes.** Done via
  greedy interval packing (`lib/lanes.ts` `packRows`) for the text, caption, and
  audio lanes; lanes lay out vertically by row count and the track grows to fit.

### Packaging / distribution

- [ ] **Bundle (or fetch) ffmpeg + whisper.cpp for distribution.** The NSIS
  installer ships the Electron app but not the ffmpeg/ffprobe binaries or the
  whisper.cpp binary + model — these are discovered at runtime and currently only
  exist on the dev machine (installed via winget / downloaded to
  `Documents\VideoEditor\bin\whisper`). On a clean machine the app would have no
  engine. Options: bundle the Gyan ffmpeg build + whisper binary as
  `extraResources` (watch licensing/size — the small.en model is ~465 MB), or add
  a guided first-run downloader that fetches them into the data dir.

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

## Done

(empty)
