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

- [ ] **Color correction controls** — no user-facing exposure/contrast/saturation/LUT controls. Only automated HDR→SDR tonemap runs on import. Needed for basic grading and cinematic looks.
- [ ] **Speed ramping** — no variable speed or slow-mo support. Common in short-form video; would require ffmpeg `setpts` + `atempo` per clip segment and timeline representation of speed curves.
- [ ] **Keyframe animation** — no way to animate overlay position, scale, or opacity over time. Would require a keyframe store per overlay property and interpolation in both preview and ASS export.
- [ ] **Snap-to-grid / magnetic timeline** — clips don't snap to each other or to markers when dragging. Would improve edit precision significantly.
- [ ] **Waveform-based audio editing** — waveform display is planned (M5) but cut-on-silence and noise removal are not.
- [ ] **Storyboard / script integration** — no way to link script lines or talking points to timeline regions.

### Explicitly out of scope for v1 (revisit post-launch)

- [ ] **Transitions beyond hard cuts** — no dissolves, fades, or wipes. ASS/libass can't do video transitions; would need ffmpeg `xfade` filter wired into the export pipeline.
- [ ] **Direct Instagram publishing** — export only; no Instagram API integration.
- [ ] **GPU whisper build** — transcription is CPU-only (`small.en`); GPU/CUDA build is optional upgrade.
- [ ] **Multi-cam editing** — out of scope for single-creator Reels workflow.

- [ ] **Stack overlapping blocks vertically in the timeline lanes.**
  Text overlays (and captions) that overlap in time currently render on top of
  each other in their lane, obscuring each other. They should stack into rows so
  each is visible.
  - Where: `src/renderer/src/components/Timeline.tsx` — the text overlay lane
    (`top-[80px]`) and the caption lane (`top-[108px]`). Both position blocks at
    `top-0` within a fixed `h-6` lane.
  - How: greedy interval packing — sort by `startSec`, assign each block to the
    lowest row whose last block ends before this one starts; position at
    `top: row * rowHeight` and grow the lane height to fit the max row count.
    Apply the same helper to both lanes (and reflect the taller lanes in the
    `top-[…]` offsets / overall track height).

## Done

(empty)
