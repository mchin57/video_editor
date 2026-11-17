# Plan: color correction and LUTs (#105, #55)

2026-11-14, refreshed 2026-11-17 after the Exposure fix (#216, PR 221). Issues:
mchin57/video_editor#105 (color correction) and #55 (LUT support). No code in this plan
(owner preference).

**Size: Large.** New controls, LUT import, a second way of drawing graded clips in the
preview, and images gaining a colour grade. The owner answered the decisions on
2026-11-17; see "Owner decisions" below.

## What exists today (read in the code, after PR 221)

- A video clip has `color` (`ColorAdjust`: brightness labelled "Exposure", contrast,
  saturation) and `tint` (`shared/tint.ts`, a wash toward one colour). Images and
  layout cells have neither.
- **`shared/grade.ts` is the one definition of the grade.** The REFERENCE is what
  Chromium draws for the preview's CSS filter `brightness(1 + b) contrast(c)
  saturate(s)`; `applyGrade` reproduces it on 8-bit RGB and is pinned to measured
  Chromium values. Saturation is held at 0..2 (`MAX_GRADE_SATURATION`) on both sides.
- Preview: `videoFillStyle` (`components/preview/geometry.tsx`) uses `gradeCssFilter`,
  then the tint as an SVG `feColorMatrix` (`TintFilter`).
- Export: `gradeFilter` (`main/services/ffmpegFilters.ts`) emits `lutrgb` for exposure
  and contrast and `colorchannelmixer` for saturation (`gradeColorFilter`), then the
  tint's `colorchannelmixer`.
- Parity is measured by `e2e/colorParity.spec.ts` (preview screenshot vs exported frame,
  tolerance 12 levels; about 5 levels of difference exist with no grade at all).
  Details: `docs/FFMPEG-NOTES.md` "Clip grade" and "Clip tint".
- The bundled ffmpeg (8.1.1 full build) has `lut3d`, `haldclut`, `colortemperature`,
  `colorbalance` and `vibrance`.

## Owner decisions (2026-11-17)

1. **LUTs: yes.** The whole grade is baked into one 3D lookup table that the preview
   (a WebGL shader over the clip) and the export (`lut3d`) both apply, so they agree by
   construction. Approach B of the original plan.
2. **New controls:** Temperature, a green / magenta balance, and Vibrance, each with a
   reset. (Highlights and shadows were NOT chosen.)
3. **Naming:** the existing "Tint" control is renamed **"Color wash"** in the UI only
   (the stored `tint` field keeps its name); the new green / magenta control is called
   **"Tint"**, as in other editors.
4. **Images too:** image layers get the same Color section as video in this round.

Taken as defaults, not asked:

- LUT files are copied into the project folder so the project stays portable; a LUT can
  also be saved to the shared library (`docs/SHARED-LIBRARY.md`) for reuse.
- A 0–100 % strength slider beside the LUT picker.
- **Nothing that exists today changes how it looks or exports.** A clip that uses only
  Exposure / Contrast / Saturation and the Color wash keeps today's CSS preview and
  today's `lutrgb` / `colorchannelmixer` export, byte for byte. Only a clip that uses a
  new control or a LUT goes through the baked table, and that table bakes the old three
  sliders and the wash in too, through `applyGrade`'s maths, so turning on a new
  control never shifts the old ones.

## Phases

**Phase 0: research and real checks.** Record everything in `docs/FFMPEG-NOTES.md`.
- `.cube` files: sizes (17, 33, 65), `DOMAIN_MIN` / `DOMAIN_MAX` lines, 1D LUTs, and
  what real free LUT packs contain.
- ffmpeg `lut3d`: on a yuv420p input (colour matrix, range), interpolation modes, cost
  at 1080x1920, and where it sits relative to the HDR tonemap, stabilization,
  background-removed alpha, and the image path (looped stills, keyframes, opacity).
- Browser: a WebGL shader applying a 33-point table to a video frame in this project's
  Electron, compared pixel for pixel with `lut3d` on the same frame and table.
- How the baked table for the OLD three sliders compares with today's two paths
  (`gradeCssFilter` in the preview, `gradeColorFilter` in the export) for the same
  values: it must be within the existing parity tolerance.
- What `colortemperature` / `vibrance` compute, if the new controls are defined to
  match them; or define the controls in `shared/grade.ts` directly (preferred, since the
  table is baked from shared maths, not from ffmpeg filters).

**Phase 1: the shared grade, extended.**
- `shared/grade.ts` gains the new controls (temperature, green / magenta, vibrance),
  defined as pure maths on sRGB values, and a function that bakes the whole grade
  (old sliders, new controls, the colour wash, then the LUT at its strength) into an
  N-point 3D table. New `shared/cube.ts` reads and writes `.cube` files, malformed input
  handled.
- New optional fields: the new controls on `ColorAdjust` (or a sibling), and a LUT
  reference (`{ file, strength }`). `ImageContent` gains `color`, `tint` and the LUT.
  Bump the schema; absent means neutral, nothing is rewritten. `isNeutralColor` and
  friends updated so a clip with only the old fields is still "legacy".

**Phase 2: export.**
- A clip or image whose grade uses only the old fields keeps today's path and exact
  strings.
- Anything new: the bake writes a `.cube` file into the export's temp folder and the
  chain applies one `lut3d` where the grade sits today. Stills and the assistant's
  `render_frame` share the path. Images: the same table in the image chain.

**Phase 3: preview.**
- A graded-media canvas component in `components/preview/` applies the same table with
  WebGL, used only when the grade needs it. It must honour crop, flip, rotation,
  keyframes, opacity and removed backgrounds exactly as the plain `<video>` / `<img>`
  does, and stay in sync with playback.
- If the graphics context is lost or WebGL is unavailable, the clip shows ungraded with
  a visible warning.

**Phase 4: Inspector.**
- The Color section grows Temperature, Tint (green / magenta) and Vibrance with resets,
  the LUT picker with Import LUT…, its strength slider and Save to shared library.
- "Tint" becomes "Color wash" in the UI.
- Image layers get the same section.
- Templates carry the new fields in their clip effect (`shared/templates.ts`,
  `lib/templates.ts`), including the LUT file.

**Phase 5: assistant and docs.** `get_timeline` reports a clip's grade and LUT. Update
`docs/SHARED.md`.

## Files to change

Shared: `shared/project.ts`, `shared/grade.ts`, new `shared/cube.ts`, `shared/tint.ts`,
`shared/templates.ts`, `shared/ipc.ts`, `shared/assistant/timelineSummary.ts`.

Main: `main/services/ffmpegFilters.ts`, `main/services/exportLayers.ts`,
`main/services/exporterArgs.ts`, `main/services/exportRender.ts`, `main/ipc/media.ts`
(or a new IPC for importing a LUT), `main/ipc/schemas.ts`,
`main/services/projectLayout.ts`, `main/services/sharedLibrary.ts`.

Preload / client: `preload/index.ts`, `renderer/src/ipc/client.ts`.

Renderer: `components/preview/geometry.tsx`, `components/preview/layers.tsx`, a new
graded-media component in `components/preview/`,
`components/inspector/VideoSections.tsx` (and the image editor's Inspector section),
`lib/templates.ts`.

New tests beside each module, plus `e2e/lutExport.spec.ts`; extend
`e2e/colorParity.spec.ts` with the new controls, a LUT, and an image.

## Tests

- Keep green WITHOUT changing their pinned strings: the `ffmpegFilters` and
  `exporterArgs` tests for legacy grades, `e2e/colorParity.spec.ts`,
  `e2e/templates.spec.ts`, `e2e/templateExport.spec.ts`, `e2e/removeBackground.spec.ts`,
  `e2e/rotation.spec.ts`.
- New unit tests: each new control at its extremes; an identity table leaves colours
  alone; the baked table for the old sliders matches `applyGrade` within 1 level;
  `.cube` round trip and malformed files; strength 0 = no LUT, 100 = full.
- New e2e: preview pixels match the exported frame for each new control, for an
  imported LUT at two strengths, and for a graded image; a graded clip with a crop, a
  rotation and a removed background still draws in the right place.

## Risks

- **A second way to draw a clip in the preview.** Everything the plain element does
  (crop, flip, rotation, alpha, playback sync, keyframes, opacity) has to be matched by
  the canvas. This is the main cost of the LUT approach.
- **Colour conversion differences** between Chromium's video decode and ffmpeg's; about
  5 levels exist today with no grade. A strong LUT makes them more visible.
- **Preview speed** with several graded clips, or graded clips inside layouts.
- **Two export paths** (legacy, and the baked table) must agree where they overlap.

## Related plans

Transitions (#64) is being built at the same time and also touches
`preview/layers.tsx`, `exportLayers.ts` and `exporterArgs.ts`: keep edits there small and
localised.
