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

- [x] **Project-scoped media library** — the library now reflects only the current project's media, not a global pool. New project = empty library; opening a `.reel` auto-populates from its `mediaIds` (legacy files without one are backfilled from referenced clips/images/audio in `migrateProject`). The `media/{hash}/` store on disk stays global; each project's `mediaIds: string[]` scopes what the panel shows. The library's × removes from the project list only (kept on disk; other projects may reference it). Implemented via `Project.mediaIds` (`shared/project.ts`), `getProjectMedia(ids)` + `media:listForProject` IPC, `useProject.addMedia/removeMedia`, and `useLibrary` keyed on `project.mediaIds`.

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
## MSC other todo
- [ ] 
## Done

(empty)
