# Shared building blocks

The reusable homes for things that were previously hand-rolled in 3–4 places.
**Before writing a labelled form field, a drag handler, an ffmpeg fragment, a
1080×1920 constant, an inherit/override resolver, or an IPC wrapper — reach for
one of these instead of re-rolling it.** Adding a feature should extend these, not
copy them. (Result of the de-duplication refactor; see `docs/HANDOFF.md` →
Refactor for the per-theme history.)

## Layout of the codebase

- `src/shared/**` — pure, dependency-free code imported by **both** the main and
  renderer processes. The 1080×1920 logical space is the contract that lets the
  same numbers drive preview and export; geometry/timing/style helpers that must
  match on both sides live here.
- `src/main/**` — Electron main process (ffmpeg orchestration, media store, IPC
  handlers).
- `src/preload/index.ts` — the typed `api` surface exposed to the renderer; the
  **single source of truth** for IPC signatures (`RendererApi`).
- `src/renderer/**` — React UI.

## UI (renderer) — `components/ui.tsx`, `lib/pointerDrag.ts`, `lib/arrays.ts`

| Concept | Home | Use instead of |
| --- | --- | --- |
| `Field`, `Row`, `Check` | `components/ui.tsx` | re-declaring a labelled `<label>`/value-row/checkbox per component |
| `inputCls`, `colorCls`, `btnCls`, `subtleBtnCls`, `dangerBtnCls`, `toggleCls(on)`, `disabledCls` | `components/ui.tsx` | pasting the `rounded bg-white/10 …` / rose / color-input class strings inline. `disabledCls` is the greyed-out + not-allowed pair for a control disabled for a STRUCTURAL reason (linked tile, re-timed clip) |
| `startPointerDrag(onMove, onUp?)` | `lib/pointerDrag.ts` | hand-rolling `window.addEventListener('pointermove'/'pointerup')` + cleanup |
| `startDragWithUndo((ev, before) => …)` | `lib/pointerDrag.ts` | the snapshot-project → liveUpdate → `commitLive(before)` dance for canvas drags |
| `useMediaGain(ref, gainDb, muted?)`, `dbToGain(db)` | `lib/mediaGain.ts` | setting `element.volume` by hand for a preview clip, or re-deriving the dB→linear conversion (the export twin is `dbToGain` in `services/audio.ts`). **Read the module header before trying to lift the >0 dB ceiling**: `volume` clamps at 1.0, and the WebAudio route that would fix it is blocked while the renderer runs from `file://` — with `crossOrigin` a `reelmedia://` element fails to load, and without it the element is tainted and the graph emits measured silence. Both were verified against the real app and are pinned in `e2e/previewGain.spec.ts` |
| `OverrideToggle`, `StabilizeSliders` | `components/Inspector.tsx` | re-rendering the Default/On/Off segmented control or the shakiness/smoothing sliders a second time |
| `updateById(arr, id, fn)`, `replaceAt(arr, i, count, …items)` | `lib/arrays.ts` | `arr.map(x => x.id===id?…:x)` and `slice()`+`splice()` in store actions |
| `useDragDepth(accepts)` | `lib/dragDepth.ts` | tracking a drop-zone highlight with `onDragLeave={e => e.currentTarget === e.target && …}` — that misses the final leave and leaves the overlay stuck (depth-counted enter/leave + window dragend/drop mop-up) |
| `ClipCard`, `ClipThumb`, `AudioThumb`, `ClipBadges` | `components/ClipCard.tsx` | re-building a media card (thumbnail + hover **preview screen** + name/meta) per surface. The parent both callers implement slightly differently: the Library (`ClipRow`) makes it selectable+draggable with add/remove `trailing`; a layout cell (`FormatMenu`) passes trim/mute in the `footer` and no add-to-timeline. Preserves the `data-testid` popout hooks |
| `LayoutPresetPreview`, `LayoutPickerModal` | `components/LayoutPresetPreview.tsx` / `LayoutPickerModal.tsx` | drawing a layout arrangement (cells normalised from `FRAME` → the current aspect) or a preset gallery inline. The picker adds a layout (or reshapes the selected one via `activePresetId`); the preview takes a `thumb(i)` render-prop to fill assigned cells |
| `LayoutCells` | `components/LayoutCells.tsx` | the per-cell editor (Inspector ▸ Layout): a "Change layout" button (reopens `LayoutPickerModal` to reshape), assign/change/clear a clip, a drop target for the `application/x-reel-asset` payload (overwrites), and the `ClipCard` preview + trim/mute. The Format menu keeps only aspect ratio + "Add layout" |
| `trimVideoStart` / `trimVideoEnd` / `trimLayerEdge` / `trimCaptionEdge` / `trimAudioEdge` / `splitVideoLayer` / `splitStaticLayer` / `splitCaptionSegment` / `splitAudioClip` | `lib/timeline.ts` | inlining timeline↔source math in a trim/split handler — freeze holds make the mapping **nonlinear**; these keep the window invariant `endSec − startSec = (out − in) + Σ holds`. **One splitter per tile kind, all with the same shape** (`(tile, atSec, makeId) → [left, right] | null`, `null` = the cut misses): video divides the source trim + freezes, `splitStaticLayer` (text/image) divides window-anchored motion instead, `splitCaptionSegment` divides the word timings. Both layer splitters partition transform keyframes through the same internal helper, which re-bases the right half and pins the interpolated transform at the seam — skip that and the motion jumps where the pieces meet. The `trim*Edge` trio is the same idea for a single edge: one signature per tile kind, each taking a TIMELINE delta and returning `{tile, achieved}` so a group trim can find the delta every member can absorb |
| `timelineTiles`/`tileOf`, `expandGroup`/`expandSelection`, `canLinkItems`/`linkItems`/`unlinkItems`, `moveItemsBy`, `splittableAt`/`canSplitItems`/`splitItemsAt`, `removeItems`, `pruneLinkGroups` | `lib/links.ts` | treating the timeline's three arrays as three things. **`timelineTiles` is the tile "base class"** — one flat `{ref, startSec, endSec, linkGroupId, linkable, splittable}` record per layer/caption/audio clip, which is what lets one code path select, move, split, delete and link them uniformly. Anything operating on "whatever tiles the user picked" belongs here, not inlined in `Timeline.tsx` (see LINK GROUPS below) |
| `useUi().selection` + `selectItems(refs, primary)` / `selectTile(project, ref)` | `state/ui.ts` | reading `selected{Layer,Caption,Audio}Id` to decide what an action applies to. Those three are the **primary** (what the Inspector edits); `selection` is every selected tile. Selecting a tile outside the timeline goes through `selectTile` so it picks the whole link group |
| `packRows`, `layoutLanes`, `resizeRowH` | `lib/lanes.ts` | computing timeline lane rows / vertical stack (top/height/collapse) / resize height **inline** in `Timeline.tsx`, where a refactor can delete it untested (see `docs/TIMELINE.md`) |
| `DOCK_PANELS`, `buildDefaultLayout`, `placementFor`, `load/saveDockLayout`, `load/save/clearDefaultLayout` | `lib/dockLayout.ts` | hardcoding panel arrangement/persistence anywhere — the manifest drives the dock (see below) |
| `applyLayout(api, layout)` | `state/dock.ts` | re-rolling the restore-or-fall-back-to-built-in dance; startup and Reset both go through it |
| `DockPanel` | `components/DockPanel.tsx` | styling a dock panel body inline; panel chrome as a class is edited HERE only |

`Timeline.tsx`'s block drags use `startPointerDrag` with the `edgeAutoScroll` rAF
loop stopped in the `onUp` callback. _Not yet converted:_ `Popout.tsx`,
`LayersPanel.tsx` (small, no edge-scroll) — fold in when next touched.

### LINK GROUPS — tiles that behave as one

`Layer`/`CaptionSegment`/`AudioClip` each carry an optional **`linkGroupId`**
(one id space across all three arrays; schema v16). Tiles sharing one are
selected, moved, split and deleted together. All of that logic lives in
**`lib/links.ts`** — the renderer is the only consumer, since the exporter sees
only final positions.

The rules the module enforces (and `lib/links.test.ts` pins):

- **Selection is all-or-nothing** — `expandGroup`/`expandSelection`. Every place
  a tile is picked (timeline press, stage, Layers panel) expands first.
- **Movement is one shared delta** — `moveItemsBy` shifts each member by the same
  amount and clamps the SET on its earliest tile, so relative offsets and each
  tile's own duration are preserved exactly. The timeline drag applies it to the
  pre-drag snapshot every pointermove (idempotent), then commits once.
- **Trimming is one shared delta too** — `trimItemsBy` moves the same edge of
  every member by the same TIMELINE delta, each converting it through its own
  mapping (`trimLayerEdge`/`trimCaptionEdge`/`trimAudioEdge`; a 2× clip gives back
  2s of source per timeline second, an audio clip 1s). The group delta is clamped
  to what the most constrained member can give, measured from the `achieved` each
  per-tile trim reports — letting members clamp themselves would desync the group
  the moment one ran out of source.
- **Splitting happens at the playhead, per member** — `splitItemsAt` cuts the
  members the playhead crosses and leaves the ones it misses whole, dispatching to
  the splitter for each tile kind (video / text+image / caption / audio — every
  tile except a layout can be cut). The right-hand halves get a NEW group id so
  the two sides of a cut are independent afterwards. `canSplitItems` (the
  toolbar's disabled state) and the split share `splittableAt`, and a test asserts
  the predicate and the operation agree.
- **A group with <2 surviving members is unlinked** — `pruneLinkGroups` runs after
  any structural edit, so a dangling id can never change behavior.
- **Layout layers are never members** (`timelineTiles().linkable`), and anything
  that would re-time ONE member out of step (speed, freezes, extract audio, split
  on silence, the Inspector's absolute start/end/trim fields) is disabled while
  linked. Edge drags are NOT — they trim the whole group (see above).

**A clip added with audio lands linked.** `addVideoLayer` puts the video layer and
the audio clip it extracts in a fresh group (both the timeline drop and the
Library's ＋ PH / ＋ End go through it), so an A/V pair stays in sync — and
deleting the clip no longer orphans its audio. `extractLayerAudio` deliberately
does NOT link: extracting is how you go get the audio to treat separately.

When adding a timeline operation, ask whether it applies to `selection` (link it
through `lib/links.ts`) or to the primary tile only (per-tile looks: crop, colour,
gain, style) — and if it re-times a single tile, disable it for linked tiles.

### Dockable panels — how to add one

The workspace between the header and the status footer is a VS Code-style dock
(`dockview-react`, hosted by `components/Dock.tsx`). Adding a panel is drop-in:

1. Add a `PanelSpec` to `DOCK_PANELS` in `lib/dockLayout.ts` — id, tab title,
   and default placement (direction / reference panel / initial size).
2. Register `id → content component` in `DOCK_COMPONENTS` (`components/Dock.tsx`),
   wrapping the content in `<DockPanel>`.

That's it — the View menu entry, reopen placement, layout persistence, and
default layout all derive from the manifest (a vitest parity check fails if the
two lists drift). Users with a saved layout see the new panel closed initially;
they open it from **View ▾**. Content components must fill their container
(`h-full`/flex) and never assume viewport position. Bump `DOCK_LAYOUT_VERSION`
when renaming/removing a panel id so stale saved layouts fall back to default.

**Three layouts, in precedence order.** `dockLayout` (localStorage) is the live
session, saved debounced on every change. `dockDefaultLayout` is the user's own
default, captured by **View ▸ Set default layout**; **Reset layout** restores it
and **Forget saved default** discards it. `buildDefaultLayout` is the built-in
fallback used when neither key is present or valid. Startup resolves
session → user default → built-in; Reset resolves user default → built-in. Both
paths go through `applyLayout` (`state/dock.ts`) — don't re-roll that fallback.

## Shared model — `src/shared/project.ts`, `src/shared/layers.ts`

| Concept | Home | Use instead of |
| --- | --- | --- |
| `TextStyleBase` (font + fill + pill/stroke/shadow/gradient) | `project.ts` | re-declaring those fields on a text/caption type. `TextContent` and `CaptionStyle` **extend** it; `TextStyleLike` (TextStyleControls) and `TextDeco` (PreviewStage) alias/`Pick` it |
| `Composition` (`layers`+`audioClips`+`captions`; `Project` extends it), `createEmptyComposition` | `project.ts` | typing timeline-editing/rendering code against `Project` when it only touches the editable core — write it against `Composition` so the SAME code serves the root and any nested comp (compound clips / layout-cell comps) |
| `resolveCompAtPath` / `updateCompAtPath` / `stepInto` (`CompPath`), `compositionDuration`, `compDepth` + `MAX_COMP_DEPTH`, `syncCompoundWindows`, `compPathLabels`, `makeCompFromCell` / `makeCompFromLayer` | `compositions.ts` | walking `content.comp` / `cell.comp` inline. All nested-composition traversal, immutable path updates (the bridge into root-level `commit`/undo), durations and seeding go through here; `referencedMediaIds` (`project.ts`) is the one recursive media walker |
| `activeComp(state)` / `getActiveComp()` + `commitComp` (private) | `state/projectStore.ts` | reading `s.project.layers` (or `.captions`/`.audioClips`) in a component, or committing a timeline edit against the root. Read/write the ACTIVE composition instead and the same code serves the root and any nested comp; only genuinely root-scoped things (preset, media list, script, project-wide denoise/stabilize defaults) use `s.project` / plain `commit` |
| `StackLayer` / `CompFill` | `components/PreviewStage.tsx` | re-implementing how a layer renders for a nested context. `StackLayer` is the ONE per-layer renderer (interactive at the root, read-only inside a comp); `CompFill` composites a whole composition into a rect, cover-cropped and clock-shifted |
| `resolveOverride(value, projectDefault)`, `isOverridden(value)` | `project.ts` | writing `value === undefined ? dflt : value` for a new inherit/force-on/force-off knob. `effectiveDenoise`/`effectiveStabilize` + `*Overridden` are thin wrappers |
| `FRAME` = `{ width: 1080, height: 1920 }` | `layers.ts` | a new `{w,h}`/`{width,height}` literal. Renderer imports it as `LOGICAL` (`lib/coords.ts`); export presets (`shared/export.ts`) own per-preset **output** sizes |
| `containBox(aspect, scale, frame?)` | `layers.ts` | re-deriving the aspect-fit ("contain") box math (was in `exporter.layerBox` + `PreviewStage.mediaBox`) |
| `stretchedBox(aspect, scale, stretchX, stretchY, frame?)` | `layers.ts` | `containBox` + the non-uniform edge-resize stretch; preview `mediaBox` and `exporter` both size media through it |
| `resizeBox(box, handle, dx, dy, aspect)` | `layers.ts` | hand-rolling edge/corner resize math (opposite-anchor recompute, aspect-locked corners) — drives every stage resize handle |
| `effectiveImageAspect(base, crop, rotateQuarters)` | `layers.ts` | re-deriving image crop-reshape + 90°/270° aspect swap |
| `effectiveCaptionStyle`, `effectiveOut`, `contentOfKind`, `audioClipEnd` | `project.ts`/`layers.ts` | already-canonical; extend rather than add parallels |
| `pillRadiusPx(padPx)` | `project.ts` | hard-coding the text-pill corner radius; preview (`PreviewStage`, in `cqw`) and export (`textImage`, in px) must agree on the shape |
| Text animation timing/geometry (`textAnimStateAt`, `clampAnimWindows`, `typewriterSteps`, `splitWords`, slide/bounce/karaoke constants) | `textAnim.ts` | re-deriving entrance/exit animation math in the preview or the ASS builder. Preview computes per-frame state from the playhead; `assBuilder.overlayEvents` maps the SAME constants onto `\fad`/`\move`/`\t`/`\k`. Both must resolve through `effectiveTextAnimation` (rasterised text never animates) |
| `videoSpeed(content)`, `playedVideoDuration(content)` | `project.ts`/`layers.ts` | reading `content.speed` raw or computing a video layer's timeline length inline. The invariant `endSec = startSec + playedBetween(in, out) + Σholds` is maintained by `setVideoSpeed`/the ramp actions/trim/split — never re-derive it in a handler |
| `playedBetween(c, a, b)`, `sourceAfterPlayed(c, from, played, limit?)`, `videoSpeedAtSource(c, s)`, `hasSpeedRamp(c)`, `sortedRamp(c)`, `speedSegments(c, a, b)` | `speed.ts` | integrating a speed ramp (or dividing by a constant speed) inline. Played time is the log-closed-form integral of 1/speed; `sourceAfterPlayed` is its signed inverse (negative = backward, for edge-drags). `videoSourceTime`/`videoTimelineTime`/trim/split all resolve through these; the export twin is `speedRampPlayedExpr` (`ffmpegFilters.ts`) |
| `layerTransformAt(layer, t)`, `upsertKeyframe(kfs, kf)` | `layers.ts` | lerping layer keyframes inline. Preview evaluates per tick; export bakes the SAME piecewise-linear ramps via `piecewiseLinearExpr` (`ffmpegFilters.ts`) into `scale=eval=frame`/`overlay` `t` expressions — keep the two interpolations identical |
| Sparkle placement + twinkle (`sparklesFor`, `sparkleStateAt`, `activeSparkle`, `estimateTextBox`, `charAnchor`, `hashSeed`/`mulberry32`) | `sparkle.ts` | placing decorative particles from either side’s own text metrics. Neither side may MEASURE glyphs (the DOM and libass disagree and cannot consult each other), so placement comes only from text + font size + window through the rough metrics here. The PRNG seed must stay **resolution-independent** — the preview passes a logical font size and the export one pre-scaled to output px, so seeding on it silently desyncs every preset that is not 1080×1920. Preview draws SVG stars; `assBuilder.sparkleEvents` draws the same unit star as a `\p1` vector on ASS Layer 1 |
| Audio effect settings + tap/voice math (`echoTaps`, `chorusVoices`, `fxTailSec`, `normalizeEcho`/`normalizeChorus`, ranges + defaults) | `audioFx.ts` | deriving echo repeats or chorus voices at a call site. An effect renders the **wet signal only**, onto its own track over the untouched dry clip — which is what makes preview and export identical (the preview plays the very samples the export mixes) |
| `LAYOUT_PRESETS`, `layoutCellRect(layer, rect)`, `coverCrop(w, h, aspect)`, `cellSpan`, `makeLayoutLayer`, `applyLayoutPreset` | `layouts.ts` | re-deriving multi-clip layout geometry. `layoutCellRect` applies the layer's move/zoom to a cell rect (preview wrapper + export both use it); `coverCrop` is the export twin of the preview's `object-fit: cover` — the two must agree |

_Note:_ video-layer aspect is still a one-line ternary at each call site — the
preview and export fallbacks differ (frame-aspect vs `1` when the probe is
missing), so it was deliberately **not** unified to keep behavior identical.

## Main / ffmpeg — `src/main/services/ffmpegFilters.ts`, `exporter.ts`

| Concept | Home | Use instead of |
| --- | --- | --- |
| `cropFilter(rect)`, `eqFilter(color)` | `ffmpegFilters.ts` | hand-writing `crop=w:h:x:y` or `eq=brightness=…:contrast=…:saturation=…` |
| `f3(n)` (`toFixed(3)`), `f6(n)` (`toFixed(6)`), `r(n)` (`Math.round`) | `ffmpegFilters.ts` | redefining the seconds/rounding formatters per module |
| `speedRampPlayedExpr(points, x?)` | `ffmpegFilters.ts` | hand-writing the piecewise log-integral `setpts` expression for a speed ramp — it must stay in lockstep with `playedBetween` (`shared/speed.ts`); the whole setpts value must be single-quoted (see FFMPEG-NOTES "Speed ramps") |
| `buildOpacityCmdLines(id, points)` + `kfOpacity`/`opacityKeyframePoints` (`shared/layers.ts`) | `ffmpegFilters.ts` | hand-writing sendcmd intervals for keyframed opacity. The `[expr]` `lerp` intervals + constant tail pin are load-bearing (see FFMPEG-NOTES "Keyframed opacity"); the preview twin is `layerTransformAt(...).opacity` |
| `runFfmpeg(ffmpeg, args, durationSec, onProgress?, cwd?)` | `ffmpegRun.ts` | re-rolling the spawn + stderr-tail + exit-code promise (with `-progress pipe:1` parsing) — proxy/thumbnail/still all go through it |
| `alphaInputDecoder(video)` | `shared/media.ts` | decoding a VP8/VP9-alpha WebM without forcing `-c:v libvpx…` before `-i` (native decode silently drops alpha — see `docs/FFMPEG-NOTES.md`) |
| `monoFoldPan(channel)` + `detectMonoFoldChannel`/`monoFoldFrom`/`parseChannelPeaks` | `audio.ts` | hand-writing a `pan=stereo\|c0=cN\|c1=cN` fold or re-parsing `astats` peaks to mirror a one-sided (dead-channel) source to both sides (see `AudioStreamInfo.monoFoldChannel`) |
| `buildAudioFxFilter(settings, in, out)`, `buildAudioFxArgs`, `pitchStages(cents)` | `audioFx.ts` | hand-writing an echo or chorus graph. Echo is one `aecho` with `in_gain=0` (wet only) and one explicit tap per repeat — `aecho` has NO feedback. Chorus must NOT use ffmpeg’s `chorus` filter, which ignores its `delays` entirely (verified); it is built from `asplit` + per-voice `asetrate`/`aresample`/`atempo`/`volume`/`adelay` + `amix`. Derive each voice’s `atempo` from the ROUNDED shifted rate or the voice drifts against its siblings. See FFMPEG-NOTES “Audio effects” |
| `renderAudioFxToLibrary(settings, mediaId, in, out)` | `mediaStore.ts` | rendering an effect ad hoc. Content-addresses the result like every generated asset, so re-rendering identical settings reuses the file on disk instead of re-encoding |
| `renderGradientImage(spec, start, end)` (closure in `exporter.ts`) | `exporter.ts` | duplicating the rasterise-text-to-PNG → full-frame-overlay block for text vs captions |
| `hdrToSdrChain` (`proxy.ts`), `buildAudioGraph` (`audio.ts`), `buildAss` (`assBuilder.ts`) | their modules | the orchestration seams the new helpers feed; don't reimplement |

_Note:_ `assBuilder.ts` and `audio.ts` keep their own local round/format helpers
(assBuilder's `r` collides with a hex-component name in another scope) — low
priority; the string-pinning tests guard them either way.

## IPC — `src/preload/index.ts`, `src/renderer/src/ipc/client.ts`

The preload `api` object is the **one** place a channel's signature is declared
(`RendererApi`). `ipc/client.ts` re-exports those methods by **destructuring**
`window.api` (no second signature list) and adds only the `reelmedia://` URL
builders (`proxyUrl`/`thumbUrl`/`imageUrl`/`audioUrl`/`waveformUrl`/`fontUrl`).

To add an IPC call: add the channel in `shared/ipc.ts`, the invoker in
`preload/index.ts`, the handler in `main/ipc.ts`, then add the method name to the
destructure in `ipc/client.ts`. Don't write a `() => window.api.x()` wrapper.

`ipc/client.ts` also owns the `reelmedia://` URL builders. For a video layer's
playable proxy use **`videoProxyUrl(asset)`**, not `proxyUrl(id)` directly — it
picks the alpha-preserving `proxy.webm` for background-removed clips
(`probe.video.hasAlpha`) and the H.264 `proxy.mp4` otherwise, so the preview
`<video>` keeps transparency. The matching main-side split is in
`mediaStore.ts` (`playableProxyPath`/`ensureProxy` → `generateAlphaProxy`).
