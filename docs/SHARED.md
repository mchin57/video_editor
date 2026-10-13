# Shared building blocks

The reusable homes for things that were previously hand-rolled in 3–4 places.
**Before writing a labelled form field, a drag handler, an ffmpeg fragment, a
1080×1920 constant, an inherit/override resolver, or an IPC wrapper — reach for
one of these instead of re-rolling it.** Adding a feature should extend these, not
copy them. (Result of the de-duplication refactor; see `docs/archived/HANDOFF.md` →
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
| `NumberInput` | `components/ui.tsx` | binding an `<input type="number">` straight to a value with a clamp in `onChange` — that re-renders the clamped number on every keystroke, so the field can't be emptied and an intermediate value below the minimum snaps back as you type. Keeps a DRAFT string while focused: an in-range value commits live (the preview still follows each keystroke), anything empty/partial/out-of-range waits for blur or Enter, Escape abandons it. Pass `format` for the resting display (`v => v.toFixed(1)`) — it never touches what is being typed. `e2e/numberInput.spec.ts` pins the behaviour |
| `Slider` | `components/ui.tsx` | a hand-rolled `<input type="range">` whose `onChange` calls a normal action (an `onPatch`), which records one undo step PER TICK of the drag. `Slider` wraps the drag in a store gesture (`useProject` `beginGesture`/`endGesture`: actions still apply and autosave, but the drag lands in history once). Clamps only the thumb, so a paired `NumberInput` can hold a value past the slider's range. `e2e/fontSizeSlider.spec.ts` pins it. (The Inspector's older `LiveRange` does the same job for composition transforms via `liveUpdate`/`commitLive`.) |
| `AngleField` | `components/ui.tsx` | a rotation slider/number pair per panel. THE rotation control, for layers and captions alike (slider −180…180 + exact field; typed values fold into (−180, 180]). Its canvas twin is `RotateHandle` in `PreviewStage` (one handle for every rotatable element; only the `apply` passed to `startRotate` differs between a layer and a caption) |
| `startPointerDrag(onMove, onUp?)` | `lib/pointerDrag.ts` | hand-rolling `window.addEventListener('pointermove'/'pointerup')` + cleanup. Also holds the interaction lock (below) from start until after `onUp` — so EVERY drag must go through it, including range-input drags (`Slider`, Inspector `LiveRange`) |
| `interactionOpen()`, `whenIdle(fn)`, `idle()`, `beginInteraction()` | `lib/interaction.ts` | letting another edit land mid-drag. A live drag recomputes from its pointerdown snapshot, so an edit in between is overwritten and the undo step goes stale. Keyboard shortcuts check `interactionOpen()` and are ignored (except save and play/pause). Assistant requests `whenIdle` and run in order after the release. Any commit that follows a long await (job results, imports) does `await idle()` right before it |
| `startDragWithUndo((ev, before) => …)` | `lib/pointerDrag.ts` | the snapshot-project → liveUpdate → `commitLive(before)` dance for canvas drags |
| `edgeAutoScroll(el, onScroll)`, `edgeScrollDir`, `EDGE_SCROLL_ZONE`/`EDGE_SCROLL_SPEED` | `lib/pointerDrag.ts` | re-rolling the drag-near-the-edge rAF scroll loop. Speed is **constant**: the 40px band is a gate, not a throttle. `edgeScrollDir` returns a DIRECTION (-1/0/+1) and `pointerDrag.test.ts` pins that it is flat across the band — if it ever returns a magnitude again, the old proximity ramp (which made drags accelerate away from the user) is back |
| `useMediaGain(ref, gainDb, muted?)`, `dbToGain(db)` | `lib/mediaGain.ts` | setting `element.volume` by hand for a preview clip, or re-deriving the dB→linear conversion (the export twin is `dbToGain` in `services/audio.ts`). **Two routes, and the split is deliberate — read the module header before touching it**: at or below unity a clip rides plain `element.volume`; above 0 dB it is routed through a WebAudio `GainNode` (which `volume`, clamped to [0,1], cannot express). Routing is ONE-WAY per element (`createMediaElementSource` can only be called once), which is why the common attenuation path is left alone. It works only because `reelmedia://` is `corsEnabled` and the elements carry `crossOrigin="anonymous"` — drop either and boosted clips go silent or every preview element fails to load, with nothing raised. `appliedGain`/`isRouted`/`previewAudioState` are the e2e seams; `e2e/previewGain.spec.ts` pins both routes |
| `useEditor().jobs` + `latestJob(jobs, type, subjectId?)` | `state/store.ts` | a per-surface job map or an `onJobProgress` subscription in a component. ONE map of every job's latest event feeds all job UI — the header `JobsIndicator`, Library proxy badges, the Export button, the Inspector's matte row — so a job stays visible after the panel that started it closes. Completed/canceled jobs are evicted past 30; failures stay until dismissed |
| `JobsIndicator`, `CancelJobButton`, `jobProgressText(job, now)`, `useNow(active)` | `components/JobsIndicator.tsx` | re-rendering a job's percent / ETA / Cancel control. Cancel is a request ("Canceling…" until main reports `canceled`) |
| `removeLayerBackground(layerId, sourceAsset)` | `lib/backgroundRemoval.ts` | driving the matte job from a component. It outlives the Inspector (the job takes minutes), mattes only the layer's window, and swaps the result in through `applyBackgroundRemoval` (one undo step; skipped if the layer changed past the matted window meanwhile) |
| `OverrideToggle`, `StabilizeSliders` | `components/Inspector.tsx` | re-rendering the Default/On/Off segmented control or the shakiness/smoothing sliders a second time |
| `updateById(arr, id, fn)`, `replaceAt(arr, i, count, …items)` | `lib/arrays.ts` | `arr.map(x => x.id===id?…:x)` and `slice()`+`splice()` in store actions |
| `useDragDepth(accepts)` | `lib/dragDepth.ts` | tracking a drop-zone highlight with `onDragLeave={e => e.currentTarget === e.target && …}` — that misses the final leave and leaves the overlay stuck (depth-counted enter/leave + window dragend/drop mop-up) |
| `ClipCard`, `ClipThumb`, `AudioThumb`, `ClipBadges` | `components/ClipCard.tsx` | re-building a media card (thumbnail + hover **preview screen** + name/meta) per surface. The parent both callers implement slightly differently: the Library (`ClipRow`) makes it selectable+draggable with add/remove `trailing`; a layout cell (`FormatMenu`) passes trim/mute in the `footer` and no add-to-timeline. Preserves the `data-testid` popout hooks |
| `LayoutPresetPreview`, `LayoutPickerModal` | `components/LayoutPresetPreview.tsx` / `LayoutPickerModal.tsx` | drawing a layout arrangement (cells normalised from `FRAME` → the current aspect) or a preset gallery inline. The picker adds a layout (or reshapes the selected one via `activePresetId`); the preview takes a `thumb(i)` render-prop to fill assigned cells |
| `LayoutCells` | `components/LayoutCells.tsx` | the per-cell editor (Inspector ▸ Layout): a "Change layout" button (reopens `LayoutPickerModal` to reshape), assign/change/clear a clip, a drop target for the `application/x-reel-asset` payload (overwrites), and the `ClipCard` preview + trim/mute. The Format menu keeps only aspect ratio + "Add layout" |
| `trimVideoStart` / `trimVideoEnd` / `trimLayerEdge` / `trimCaptionEdge` / `trimAudioEdge` / `splitVideoLayer` / `splitStaticLayer` / `splitCaptionSegment` / `splitAudioClip` | `lib/timeline.ts` | inlining timeline↔source math in a trim/split handler — freeze holds make the mapping **nonlinear**; these keep the window invariant `endSec − startSec = (out − in) + Σ holds`. **One splitter per tile kind, all with the same shape** (`(tile, atSec, makeId) → [left, right] | null`, `null` = the cut misses): video divides the source trim + freezes, `splitStaticLayer` (text/image) divides window-anchored motion instead, `splitCaptionSegment` divides the word timings. Both layer splitters partition transform keyframes through the same internal helper, which re-bases the right half and pins the interpolated transform at the seam — skip that and the motion jumps where the pieces meet. The `trim*Edge` trio is the same idea for a single edge: one signature per tile kind, each taking a TIMELINE delta and returning `{tile, achieved}` so a group trim can find the delta every member can absorb |
| `timelineTiles`/`tileOf`, `expandGroup`/`expandSelection`, `canLinkItems`/`linkItems`/`unlinkItems`, `moveItemsBy`, `snapToPreviousDelta`, `splittableAt`/`canSplitItems`/`splitItemsAt`, `removeItems`, `pruneLinkGroups` | `lib/links.ts` | treating the timeline's three arrays as three things. **`timelineTiles` is the tile "base class"** — one flat `{ref, startSec, endSec, lane, linkGroupId, linkable, splittable}` record per layer/caption/audio clip, which is what lets one code path select, move, split, delete and link them uniformly. `lane` (`TileLane`) is the visual band the tile is drawn in — what "the previous clip" means to `snapToPreviousDelta`, which returns the delta to feed `moveItemsBy` (`null` = already flush). **`layerLane(layer)` / `audioLane(clip)` are the one definition of that grouping**: `timelineTiles` fills `Tile.lane` from them and `Timeline.tsx` builds its lane rows from them, so a new content kind cannot land in one band for rendering and another for tile operations. `LANE_STYLE` is `satisfies Record<TileLane, …>`, so adding a band without giving it colours is a compile error. Anything operating on "whatever tiles the user picked" belongs here, not inlined in `Timeline.tsx` (see LINK GROUPS below) |
| `useUi().selection` + `selectItems(refs, primary)` / `selectTile(project, ref)` | `state/ui.ts` | reading `selected{Layer,Caption,Audio}Id` to decide what an action applies to. Those three are the **primary** (what the Inspector edits); `selection` is every selected tile. Selecting a tile outside the timeline goes through `selectTile` so it picks the whole link group |
| `packRows`, `layoutLanes`, `resizeRowH` | `lib/lanes.ts` | computing timeline lane rows / vertical stack (top/height/collapse) / resize height **inline** in `Timeline.tsx`, where a refactor can delete it untested (see `docs/TIMELINE.md`) |
| `DOCK_PANELS`, `buildDefaultLayout`, `placementFor`, `load/saveDockLayout`, `load/save/clearDefaultLayout` | `lib/dockLayout.ts` | hardcoding panel arrangement/persistence anywhere — the manifest drives the dock (see below) |
| `applyLayout(api, layout)` | `state/dock.ts` | re-rolling the restore-or-fall-back-to-built-in dance; startup and Reset both go through it |
| `DockPanel` | `components/DockPanel.tsx` | styling a dock panel body inline; panel chrome as a class is edited HERE only |

`Timeline.tsx`'s block drags use `startPointerDrag` with the `edgeAutoScroll` rAF
loop stopped in the `onUp` callback. Every draggable surface now goes through
`startPointerDrag` — `Popout.tsx` and `LayersPanel.tsx` were the last hand-rolled
pair and were converted with the drag-helper sweep, so there is no
`window.addEventListener('pointermove')` left in `components/`.

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

## AI assistant (Claude Code via MCP) — `src/mcp/`, `src/main/assistant/`, `src/shared/assistant/`, `lib/sequence.ts`

Shape: Claude Code launches **reel-mcp** (`node out/main/mcp.js`, stdio) → JSON lines over the named pipe `\\.\pipe\reel-editor` → editor main → renderer store. Not local HTTP: an MCP-aware network filter on the owner's machine corrupts local plain-HTTP MCP traffic (design spec, "Why not local HTTP").

| Concept | Home | Use instead of |
| --- | --- | --- |
| Adding a tool | `shared/assistant/toolArgs.ts` (args type) → `mcp/tools.ts` (schema + description) → `main/assistant/tools.ts` (handler) | anything else — `ToolArgs` makes a schema/handler mismatch a compile error |
| `servePipe` / `callPipe`, `LineDecoder`/`encodeLine` | `main/assistant/pipe.ts`, `shared/assistant/pipeProtocol.ts` | another channel between reel-mcp and the editor. One connection per call; no Electron imports |
| `applySequence(comp, plan, ctx)`, `makeExtractedAudioClip(…)` | `lib/sequence.ts` | building trimmed video layers + their linked audio by hand. `applySequence` lays clips end-to-end through `makeVideoLayer` + `trimVideoStart`/`trimVideoEnd` (never inline source↔timeline math); `makeExtractedAudioClip` is THE linked-audio shape, shared with `addVideoLayer`. Store entry point: `addVideoSequence(plan)` (one undo step) |
| `AssistantOps` + `callRenderer(op, args)` / `installAssistantBridge()` | `shared/assistant/protocol.ts`, `main/assistant/bridge.ts`, `assistant/handlers.ts` | reaching into renderer state from main any other way. Add an op to `AssistantOps` and both halves are type-checked against it |
| `summarizeTimeline(comp)` | `shared/assistant/timelineSummary.ts` | hand-serializing the timeline for the model |
| `transcriptPhraseText` / `transcriptWordText`, `frameTimes` | `shared/assistant/` | formatting transcripts / choosing frame times for the model |
| `sanitizeExportName`, `uniqueExportPath`, `exportRefusal` | `main/services/exportTarget.ts` | ad-hoc output naming for a dialog-less export (never overwrites; a name can't leave the export folder) |
| `appendAssistantRequest` / `fileFeatureRequest` | `main/assistant/todoAppend.ts`, `todoFile.ts` | editing docs/TODO.md from code (serialized; `REEL_TODO_PATH` overrides) |

## Shared model — `src/shared/project.ts`, `src/shared/layers.ts`

| Concept | Home | Use instead of |
| --- | --- | --- |
| `TextStyleBase` (font + fill + pill/stroke/shadow/gradient) | `project.ts` | re-declaring those fields on a text/caption type. `TextContent` and `CaptionStyle` **extend** it; `TextStyleLike` (TextStyleControls) and `TextDeco` (`textStyle.ts`) alias/`Pick` it |
| How a text block LOOKS — `TEXT_LINE_HEIGHT`, `textWrapWidth(frameW)`, `textBoxCss`, `textFillCss`, `textPillCss`, `cssText`, `effectiveStroke`/`effectiveShadow`/`usesDefaultShadow`, `DEFAULT_TEXT_SHADOW` | `textStyle.ts` | writing text CSS in a component or the rasteriser. **A text layer and a caption are the same thing**: the preview's `TextBlock` (lengths in `cqw`) and the export's `textImage` (px) both build from these, so wrap width, leading, pill, outline and shadows cannot drift between them (they had: captions wrapped at half the frame, the raster had no default shadow). Position the box by TRANSFORM (`left:` caps its shrink-wrap); gradient text takes its shadow as a `drop-shadow` filter (a text-shadow smears over the clipped gradient) |
| libass corrections — `assFontSize`, `assBaselineBelowPos`, `assOutlineWidth`; `FontDef.win` metrics | `textStyle.ts` / `fonts.ts` | burning a CSS size/stroke straight into ASS. libass sizes and spaces lines by the face's Windows metrics and draws `\bord` wholly outside (FFMPEG-NOTES "libass text metrics"); `fonts.test.ts` re-reads every TTF so `win` can't drift |
| `Composition` (`layers`+`audioClips`+`captions`; `Project` extends it), `createEmptyComposition` | `project.ts` | typing timeline-editing/rendering code against `Project` when it only touches the editable core — write it against `Composition` so the SAME code serves the root and any nested comp (compound clips / layout-cell comps) |
| `resolveCompAtPath` / `updateCompAtPath` / `stepInto` (`CompPath`), `compositionDuration`, `compDepth` + `MAX_COMP_DEPTH`, `syncCompoundWindows`, `resetMediaCuts` (a relink to a different-length file: every placement back to the whole source), `compPathLabels`, `makeCompFromCell` / `makeCompFromLayer` | `compositions.ts` | walking `content.comp` / `cell.comp` inline. All nested-composition traversal, immutable path updates (the bridge into root-level `commit`/undo), durations and seeding go through here; `mediaUses` (`project.ts`) is the one recursive media walker — `referencedMediaIds` is built on it |
| `activeComp(state)` / `getActiveComp()` + `commitComp` (private) | `state/projectStore.ts` | reading `s.project.layers` (or `.captions`/`.audioClips`) in a component, or committing a timeline edit against the root. Read/write the ACTIVE composition instead and the same code serves the root and any nested comp; only genuinely root-scoped things (preset, media list, script, project-wide denoise/stabilize defaults) use `s.project` / plain `commit` |
| `StackLayer` / `CompFill` | `components/PreviewStage.tsx` | re-implementing how a layer renders for a nested context. `StackLayer` is the ONE per-layer renderer (interactive at the root, read-only inside a comp); `CompFill` composites a whole composition into a rect, cover-cropped and clock-shifted |
| `TextBlock` + `StyledText` | `components/PreviewStage.tsx` | a separate renderer for captions vs text layers. Both render through `TextBlock` (translate → rotate → scale, box from `textBoxCss`) with `StyledText` inside (`textFillCss`/`textPillCss`) |
| `FrameCtx` + `frameCanvasStyle(frame)` | `components/PreviewStage.tsx` | positioning preview content against the frame yourself. The stage (and every `CompFill`) is frame-shaped and holds the canonical 1080-wide canvas offset by the frame origin; layers render inside in canonical %/`cqw`, and read the frame from `FrameCtx` for frame-relative geometry (layouts, compounds, auto-wrap widths). Pointer math and box measuring read the CANVAS element (`data-testid="preview-canvas"`) |
| `resolveOverride(value, projectDefault)`, `isOverridden(value)` | `project.ts` | writing `value === undefined ? dflt : value` for a new inherit/force-on/force-off knob. `effectiveDenoise`/`effectiveStabilize` + `*Overridden` are thin wrappers |
| `audioClipAudible(clip)` | `project.ts` | reading `clip.mute` inline to decide whether an audio clip is heard. The two sides act on the answer DIFFERENTLY on purpose — the preview holds a muted clip at gain 0 (`useMediaGain`, so it keeps tracking the playhead and unmuting is instant), the export skips it before it becomes an ffmpeg input (so it never decodes a source contributing nothing) — which is exactly why the decision itself has to come from one place. Mute is its own flag, not `gainDb = -40`, so a clip's level survives being silenced. Verified against the real binary: a muted-only project exports with NO audio stream, the same file unmuted carries mean −24.1 dB |
| `FRAME` = `{ width: 1080, height: 1920 }` — the CANONICAL space every layer/caption/keyframe is stored in | `frame.ts` (re-exported by `layers.ts`; import from either) | a new `{w,h}`/`{width,height}` literal. Renderer imports it as `LOGICAL` (`lib/coords.ts`). `frame.ts` is a dependency-free leaf on purpose: `formats.ts` builds frames at load time and `project.ts` imports `formats.ts`, so these can't live in `layers.ts` without an init-order cycle |
| `FrameRect`, `centeredFrame(w, h)`, `FULL_FRAME`, `frameToOutput(frame, outWidth)` | `frame.ts` | treating 1080×1920 as the visible frame. A project's output frame is a WINDOW centred on the canonical space (9:16 = `FULL_FRAME`, the identity); switching format moves the window, never the layers. `frameToOutput` is the export's canonical→output-px map (uniform `s`); its CSS twin is `frameCanvasStyle` in `PreviewStage` — keep the two in step |
| Format registry: `defineAspect(rw, rh)`, `definePreset(id, label, aspect, extras)`, `ASPECTS`, `EXPORT_PRESETS`, `PresetId`, `presetFor(id)`, `presetGroups()`, `isNineSixteen`, `INSTAGRAM_SAFE_ZONES` | `formats.ts` | a per-format `width`/`height`/`safeZones` literal or an `EXPORT_PRESETS[id]` lookup that can hit `undefined`. Two levels: an ASPECT is only a ratio (size/orientation/label/frame are derived); a PRESET extends one and adds platform extras (safe zones, max duration). Adding a format = one `ASPECTS` line + one `EXPORT_PRESETS` line; the Format menu, preview, export, crop tool, layout picker and checklist all follow. `presetFor` falls back to Reel for unknown ids (migration v22 normalises on load too) |
| `projectFormat(state)` / `getFormat()` | `state/projectStore.ts` | reading `s.project.preset` and looking the preset up yourself. Root-scoped (a nested comp renders through the same frame); returns the registry's own object, so it is a stable zustand selector |
| `fitScale(aspect, frame)`, `layerFitScale(layer, sourceAspect, frame)`, `rescaleForAspect(layer, from, to, frame)`, `PlaceIn` on `makeVideoLayer`/`makeImageLayer`, `makeTextLayer(…, frame)` | `layers.ts` | assuming scale 1 = "fits the frame". `containBox` sizes against the CANONICAL frame, so outside 9:16 new media start at `fitScale`, the Inspector shows zoom as `scale / layerFitScale` (and position minus the frame origin), and a crop that changes a clip's aspect keeps its frame-relative size via `rescaleForAspect` (store: `setVideoCrop`). All are identities in 9:16 |
| `assetAspect(asset)` | `shared/media.ts` | `v.displayWidth / v.displayHeight` with its own zero guard when fitting a NEW layer to the frame |
| `containBox(aspect, scale, frame?)` | `layers.ts` | re-deriving the aspect-fit ("contain") box math (was in `exporter.layerBox` + `PreviewStage.mediaBox`) |
| `stretchedBox(aspect, scale, stretchX, stretchY, frame?)` | `layers.ts` | `containBox` + the non-uniform edge-resize stretch; preview `mediaBox` and `exporter` both size media through it |
| `resizeBox(box, handle, dx, dy, aspect)` | `layers.ts` | hand-rolling edge/corner resize math (opposite-anchor recompute, aspect-locked corners) — drives every stage resize handle |
| `normalizeDeg`, `rotateVec`, `rotatedBounds`, `pointerAngleDeg`, `rotateDragDeg`, `resizeRotatedBox`, `handleOffset` | `rotation.ts` | ANY rotation math. One model for every visual: `Layer.rotationDeg` (video/image/text) and `CaptionStyle.rotationDeg`, clockwise degrees about the box centre. The canvas rotate handle, the rotated resize (`resizeRotatedBox` turns the drag into the box's own axes, then calls `resizeBox`), the slide offset of rotated text and the export (`rotatedBounds` = ffmpeg `rotw`/`roth`) all build from these |
| `textMotion`, `isSimpleMotion`, `simpleMotion`, `newMotionKeyframes`, `editSimpleMotion`, `shiftKeyframes`, `motionPosAt`, `moveSlice` | `motion.ts` | a second motion model, or hand-editing two keyframes. A straight start→end move IS two `Layer.keyframes` (media honour them via `layerTransformAt`; text follows its first moving stretch for position via `textMotion`, in preview and burn alike). `moveSlice` gives one ASS event its windowed `\move`. Generic over keyframe lists, so captions can adopt it |
| `effectiveImageAspect(base, crop, rotateQuarters)` | `layers.ts` | re-deriving image crop-reshape + 90°/270° aspect swap |
| `effectiveCaptionStyle`, `effectiveOut`, `contentOfKind`, `audioClipEnd` | `project.ts`/`layers.ts` | already-canonical; extend rather than add parallels |
| `pillRadiusPx(padPx)` | `project.ts` | hard-coding the text-pill corner radius; preview (`textPillCss` in `cqw`), rasteriser (px) and the ASS pill drawing (`assBuilder.pillPath`) must agree on the shape |
| Text animation timing/geometry (`textAnimStateAt`, `clampAnimWindows`, `typewriterSteps`, `splitWords`, slide/bounce/karaoke constants) | `textAnim.ts` | re-deriving entrance/exit animation math in the preview or the ASS builder. Preview computes per-frame state from the playhead; `assBuilder.blockEvents` maps the SAME constants onto `\fad`/`\move`/`\t`/`\k`, per laid-out line. Both must resolve through `effectiveTextAnimation` (rasterised text never animates) |
| `videoSpeed(content)`, `playedVideoDuration(content)` | `project.ts`/`layers.ts` | reading `content.speed` raw or computing a video layer's timeline length inline. The invariant `endSec = startSec + playedBetween(in, out) + Σholds` is maintained by `setVideoSpeed`/the ramp actions/trim/split — never re-derive it in a handler |
| `playedBetween(c, a, b)`, `sourceAfterPlayed(c, from, played, limit?)`, `videoSpeedAtSource(c, s)`, `slowestSpeedBetween(c, a, b)`, `hasSpeedRamp(c)`, `sortedRamp(c)`, `speedSegments(c, a, b)` | `speed.ts` | integrating a speed ramp (or dividing by a constant speed) inline. Played time is the log-closed-form integral of 1/speed; `sourceAfterPlayed` is its signed inverse (negative = backward, for edge-drags). `videoSourceTime`/`videoTimelineTime`/trim/split all resolve through these; the export twin is `speedRampPlayedExpr` (`ffmpegFilters.ts`) |
| `videoSourceWindow(content)`, `rebaseVideoContent(content, mediaId, windowStartSec, pixelScale, copySize)`, `windowCoversVideo(content, sourceMediaId, window)` | `layers.ts` | pointing a layer at a RE-RENDERED copy of its own footage (background removal) by patching `mediaId`/`inSec`/`outSec` by hand. The window is the trim (all a layer can show, whatever its holds/speed); the rebase shifts EVERY source-anchored time (trim, freezes, ramp keyframes — uniformly, unclamped) by the window start and rescales a pixel crop, so `videoSourceTime` on the result equals the original minus the shift at every timeline instant (`layers.test.ts` pins it) and `endSec` needs no change. Forces stabilization off (the export stabilizes through an opaque intermediate) |
| `layerTransformAt(layer, t)`, `upsertKeyframe(kfs, kf)` | `layers.ts` | lerping layer keyframes inline. Preview evaluates per tick; export bakes the SAME piecewise-linear ramps via `piecewiseLinearExpr` (`ffmpegFilters.ts`) into `scale=eval=frame`/`overlay` `t` expressions — keep the two interpolations identical |
| Sparkle placement + twinkle (`sparklesFor`, `sparkleStateAt`, `activeSparkle`, `estimateTextBox`, `charAnchor`, `hashSeed`/`mulberry32`) | `sparkle.ts` | placing decorative particles from either side’s own text metrics. Neither side may MEASURE glyphs (the DOM and libass disagree and cannot consult each other), so placement comes only from text + font size + window through the rough metrics here. The PRNG seed must stay **resolution-independent** — the preview passes a logical font size and the export one pre-scaled to output px, so seeding on it silently desyncs every preset that is not 1080×1920. Preview draws SVG stars; `assBuilder.sparkleEvents` draws the same unit star as a `\p1` vector on ASS Layer 1 |
| Audio effect settings + tap/voice math (`echoTaps`, `ensembleVoices`, `chorusVoices`, `fxTailSec`, `normalize*`, ranges + defaults) | `audioFx.ts` | deriving echo repeats or stacked voices at a call site. Three effects share it: echo (geometric taps), **ensemble** (copies at a FIXED detune) and **chorus** (copies swept by an LFO). An effect renders the **wet signal only**, onto its own track over the untouched dry clip — which is what makes preview and export identical (the preview plays the very samples the export mixes) |
| `LoudnessSeries`, `windowLoudness(series, inSec, outSec)`, `isLoudnessSeries`, `LOUDNESS_VERSION` | `loudness.ts` | computing a clip's loudness or peak any other way (an ad-hoc ffmpeg pass, averaging dB values). The series is one entry per 0.1 s of SOURCE time (momentary LUFS of the 400 ms block ending there + that step's sample peak); `windowLoudness` gives a source range's BS.1770-gated integrated loudness (absolute −70, relative −10, blocks wholly inside the window) and its peak, or `tooShort` under 0.4 s. Preview (via the `getLoudness` IPC) and export (via `ensureLoudness`) must both go through it — it reproduced ebur128 on the window to 0.1 LU (golden tests on a real recording). File shape in the module header; bump `LOUDNESS_VERSION` if the measurement changes |
| `LAYOUT_PRESETS`, `layoutCellRect(layer, rect, frame)`, `FULL_CELL`, `coverCrop(w, h, aspect)`, `cellSpan`, `makeLayoutLayer`, `applyLayoutPreset` | `layouts.ts` | re-deriving multi-clip layout geometry. `layoutCellRect` stretches a cell rect (authored in 1080×1920 units) onto the project's frame, then applies the layer's move/zoom — so every layout fills every aspect (preview wrapper + export both use it). A compound clip's box is `layoutCellRect(layer, FULL_CELL, frame)`. `coverCrop` is the export twin of the preview's `object-fit: cover` — the two must agree |

_Note:_ video-layer aspect is still a one-line ternary at each call site — the
preview and export fallbacks differ (frame-aspect vs `1` when the probe is
missing), so it was deliberately **not** unified to keep behavior identical.

## Main / ffmpeg — `src/main/services/ffmpegFilters.ts`, `exporter.ts`

| Concept | Home | Use instead of |
| --- | --- | --- |
| `cropFilter(rect)`, `eqFilter(color)` | `ffmpegFilters.ts` | hand-writing `crop=w:h:x:y` or `eq=brightness=…:contrast=…:saturation=…` |
| `rotateFilter(deg)` | `ffmpegFilters.ts` | hand-writing `rotate=`. Clockwise, grown to the even-rounded rotated bounds with a transparent fill; needs an alpha pixel format upstream (see FFMPEG-NOTES "Layer rotation") |
| `f3(n)` (`toFixed(3)`), `f6(n)` (`toFixed(6)`), `r(n)` (`Math.round`) | `ffmpegFilters.ts` | redefining the seconds/rounding formatters per module |
| `speedRampPlayedExpr(points, x?)` | `ffmpegFilters.ts` | hand-writing the piecewise log-integral `setpts` expression for a speed ramp — it must stay in lockstep with `playedBetween` (`shared/speed.ts`); the whole setpts value must be single-quoted (see FFMPEG-NOTES "Speed ramps") |
| `buildOpacityCmdLines(id, points)` + `kfOpacity`/`opacityKeyframePoints` (`shared/layers.ts`) | `ffmpegFilters.ts` | hand-writing sendcmd intervals for keyframed opacity. The `[expr]` `lerp` intervals + constant tail pin are load-bearing (see FFMPEG-NOTES "Keyframed opacity"); the preview twin is `layerTransformAt(...).opacity` |
| Burned text — `textBlockSpec` + `blockOverlay` (`exporter.ts`), `TextRenderer.layout` (`textImage.ts`), `groupLines`/`fallbackLines`/`MEASURE_BLOCKS_SCRIPT`/`LaidOutLine` (`textLayout.ts`), `buildAss` (`assBuilder.ts`) | as listed | a second export path for captions vs text layers — there is ONE: both become a `textBlockSpec` (the preview's layout inputs in output px), gradients rasterise, everything else is laid out by Chromium in one pass per comp with the preview's CSS and burned by libass one event per line (`WrapStyle: 2`, pills as `\p1` drawings on Layer 0, glyphs 1, sparkles 2). Never let libass wrap or space lines itself (FFMPEG-NOTES "libass text metrics") |
| `runFfmpeg(ffmpeg, args, durationSec, onProgress?, cwd?)` | `ffmpegRun.ts` | re-rolling the spawn + stderr-tail + exit-code promise (with `-progress pipe:1` parsing) — proxy/thumbnail/still all go through it |
| `writeAtomically(final, write)` + `partialPath(final)`, `singleFlight()` | `atomicWrite.ts` | pointing ffmpeg straight at a file whose EXISTENCE means "ready"/"done" (proxies, thumb, waveform, display PNG). ffmpeg creates its output when encoding starts (a faststart mp4 is unopenable until the end; a partial WebM opens truncated) and a failed run still finalizes a truncated file — so encode to `partialPath` (real extension kept last, so the muxer is unchanged) and rename on success. The partial name is fixed per file, so any generator that can race must go through `singleFlight`, as `mediaStore` does (`ensureProxy` per asset, thumb/waveform/image per path). See FFMPEG-NOTES "Partial outputs" |
| `startFfmpeg(ffmpeg, args, { cwd?, signal? })` → `{ child, exited, stderrTail }` | `ffmpegRun.ts` | a bare `spawn(ffmpeg…)` for PIPED work (raw frames in/out), where `runFfmpeg` doesn't fit. `runFfmpeg` is built on it. The `signal` IS the kill path — aborting kills the child — and `exited` is pre-marked handled, so an early bail-out (kill + cleanup) can't raise an unhandled rejection. The matte job's decode + encode pair go through it |
| `createJob(type, label, subjectId?, { cancelable })` → `job.signal`, `cancelJob(id)`, `failJob`, `setLabel` | `jobs.ts` | a job-specific cancel flag or IPC. A cancelable job gets an AbortSignal that `job:cancel` fires; its code must stop, kill what it spawned (pass the signal to `startFfmpeg`) and delete partial output, then report through `failJob` — which records `canceled` rather than `error` once the signal has fired. Events carry `cancelable` + `startedAt` so every job surface can offer Cancel and an ETA (`jobEtaSec`/`formatEta`, `shared/jobs.ts`) |
| `alphaInputDecoder(video)` | `shared/media.ts` | decoding a VP8/VP9-alpha WebM without forcing `-c:v libvpx…` before `-i` (native decode silently drops alpha — see `docs/FFMPEG-NOTES.md`) |
| `monoFoldPan(channel)` + `detectMonoFoldChannel`/`monoFoldFrom`/`parseChannelPeaks` | `audio.ts` | hand-writing a `pan=stereo\|c0=cN\|c1=cN` fold or re-parsing `astats` peaks to mirror a one-sided (dead-channel) source to both sides (see `AudioStreamInfo.monoFoldChannel`) |
| `ensureLoudness(mediaId)`, `ensureLoudnessFor(root, src)`, `kickLoudness`, `buildLoudnessArgs`/`parseLoudnessPrint` | `loudness.ts` | measuring loudness for an export/preview decision yourself. `ensureLoudness` reads `cache/<id>/loudness.json` or measures it now (one pass, `singleFlight` per file, at most two at once; null = no audio / original missing / failed) — it IS the `getLoudness` IPC, and the export's entry point. `hydrate` and import kick it in the background. Measured after the mono-fold pan, at the source's channel count (FFMPEG-NOTES "Loudness series") |
| `buildAudioFxFilter(settings, in, out)`, `buildAudioFxArgs`, `pitchStages(cents)` | `audioFx.ts` | hand-writing an echo, ensemble or chorus graph. Echo is one `aecho` with `in_gain=0` (wet only) and one explicit tap per repeat — `aecho` has NO feedback. Neither stacking effect may use ffmpeg’s `chorus` filter, which ignores its `delays` entirely (verified): **ensemble** is `asplit` + per-voice `asetrate`/`aresample`/`atempo`/`volume`/`adelay` + `amix` (derive each `atempo` from the ROUNDED shifted rate or the voice drifts), and **chorus** swaps the fixed pitch shift for `vibrato` (an LFO-swept delay, wet-only by nature) with a per-voice rate spread, since `vibrato` has no phase control. The chorus chain is PRIMED with silence that is trimmed off again — `vibrato` bursts at its output start and a fade does not fix it. Changing the echo/ensemble strings invalidates already-rendered assets. See FFMPEG-NOTES “Audio effects” |
| `expandImportPaths(paths, opts?)`, `isMediaPath` | `importScan.ts` | expanding a dropped/picked FOLDER per caller. `importMany` (`services/importMany.ts`; `importManyReport` also returns the files that failed, with why) runs every import route through it, so the File menu, OS drag-drop and `importPaths` all handle directories identically. The extension filter applies only to files found INSIDE a walked directory — a path the user named explicitly is always attempted, because the picker offers an "All files" filter |
| `renderAudioFxToLibrary(settings, mediaId, in, out)` | `mediaStore.ts` | rendering an effect ad hoc. Content-addresses the result like every generated asset (`importGenerated`), so re-rendering identical settings reuses the file on disk instead of re-encoding |
| `renderGradientImage(spec, start, end)` (closure in `exporter.ts`) | `exporter.ts` | duplicating the rasterise-text-to-PNG → full-frame-overlay block for text vs captions |
| `buildWhisperArgs(model, wav, outPrefix, preset, offsetSec?)` + `dtwPreset(modelPath)` + `decodeStartSec(silences, duration)` | `whisperArgs.ts` | hand-assembling whisper-cli args. `-dtw` without `-nfa` silently yields NO token timestamps (flash attention wins), and a preset that does not match the model returns garbage at exit 0 — so `dtwPreset` returns null rather than guess. `decodeStartSec` is where decoding starts (`-ot`): whisper drops a file's opening sentence after a leading click or long lead-in. See FFMPEG-NOTES "whisper word timings" |
| `parseWhisperTranscript(json, silences?)` | `whisperParse.ts` | reading whisper's entry `offsets` as word times. Those are SEGMENT bounds and smear the leading words of a segment back over the preceding silence (measured 2.42s early); this prefers DTW `t_dtw`, gates it for sanity, ends each word where silencedetect says its sound stops, caps word windows, and reports which source won |
| `TRANSCRIPT_VERSION` + `isCurrentTranscript(t)` | `shared/transcript.ts` | hand-checking whether a cached transcript is stale. Bump the version whenever the whisper flags or the parse change, or old transcripts are served forever |
| `hdrToSdrChain` (`proxy.ts`), `buildAudioGraph` (`audio.ts`), `buildAss` (`assBuilder.ts`) | their modules | the orchestration seams the new helpers feed; don't reimplement |

_Note:_ `assBuilder.ts` and `audio.ts` keep their own local round/format helpers
(assBuilder's `r` collides with a hex-component name in another scope) — low
priority; the string-pinning tests guard them either way.

## Project folders & media — `projectLayout.ts`, `library.ts`, `mediaRef.ts`, `fingerprint.ts`, `mediaStore.ts`

A project is a folder (`<Name>.reel`, `generated/`, `transcripts/`, `cache/`);
its library items POINT at originals where they are (docs/MEDIA-POINTERS.md).
Main owns which project is open and its in-memory library; only Save writes the
`.reel`.

| Concept | Home | Use instead of |
| --- | --- | --- |
| `docPath`/`autosavePath`/`generatedRoot`/`transcriptsRoot`/`cacheDir`/`cachePath`/`transcriptPath`, `projectSubdirs`, `projectFolderFor`, `sweepPlan`, `isMediaId` | `projectLayout.ts` | joining paths into a project folder by hand. Pure; every main-side path into a project goes through it. (`mediaDir`/`assetJsonPath`/`originalName` are the schema-24 layout, kept only for conversion) |
| `cleanupPlan(present, docs)` | `projectLayout.ts` | deciding by hand which `generated/` / `transcripts/` files a project still uses. Pure; any unreadable document means nothing is deleted. `projectStore`'s sweep is its only caller and never deletes outside `cache/`, `generated/`, `transcripts/` |
| `safeFileName(name)`, `uniqueFileName(name, taken)` | `projectLayout.ts` | writing a display name to disk as-is. A display name can hold `:` (time ranges), which Windows refuses; the library keeps the display name |
| `getProjectRoot()` / `currentProjectRoot()` / `setProjectRoot()` | `projectRoot.ts` | a global data-dir media path. There may be NO open project (start screen): `currentProjectRoot()` returns null, `getProjectRoot()` throws. Capture the root once at the start of a long job |
| `openLibrary`/`getEntry`/`putEntry`/`resolveEntry`/`resolveAll`/`recordsFor`/`rebaseLibrary`, `onLibraryChanged`, `fingerprintOf` | `library.ts` | reading or writing media records anywhere else. Records live in memory; `projectStore` writes them into the autosave and, on Save, the `.reel`. A change after open notifies the renderer (unsaved changes) |
| `locateOriginal(record, dir, read?)`, `decideResolution`, `toRelativePath`/`fromRelativePath`, `samePath` | `mediaRef.ts` | resolving a record's file yourself. Relative path first, absolute second, each fingerprint-checked; returns which path to use and which fields to update |
| `fingerprintFile`, `sameFingerprint`, `fingerprintDiff`, `fingerprintId` | `fingerprint.ts` | hashing a whole file to identify it. Size + three 256 KiB samples; `fingerprintId` is the id of a new import (never change its formula) |
| `importFile(src)` / `importGenerated(tmp, name)` | `mediaStore.ts` | adding media any other way. `importFile` points at the file (no copy); `importGenerated` moves an app output into `generated/`. Both dedup by fingerprint |
| `unknownRecords(doc, known)`, `isUnknownClip` / `UNKNOWN_CLIP_NAME` | `unknownMedia.ts`, `shared/media.ts` | hiding a clip the document uses but nothing describes. Opening a project gives each one a placeholder record (Missing, unknown clip) so it can be relinked; Relink keeps its cuts |
| `relinkCheck(id, path)`, `relinkMedia(id, path, force)` | `mediaStore.ts` | repointing a record by hand. `relinkCheck` names the differing fingerprint fields for the "Update path anyway?" warning; `relinkMedia` re-probes on a forced mismatch, reports `cutsReset` for a length change, and reconnects the folder's other missing clips |
| `requireUsable(id)`, `assertMediaUsable(ids)` | `mediaStore.ts` | `getAsset` before a job that READS the original (proxy, transcribe, matte, still, silence, export). They locate the original now and throw a message naming any missing file |
| `replaceFile(path, data)` | `atomicWrite.ts` | `fs.writeFile` onto a document/transcript. Temp + rename (never torn), with the Windows EPERM retry |
| `validateProjectName(name)`, `PROJECT_NAME_MAX` | `shared/projectName.ts` | checking a project name by hand. Null or a short reason (Windows folder rules); the New project window shows it live and main re-checks before creating |
| `convertLegacyProject`, `convertLegacyFolder`, `remainingLegacyProjects`, `legacyStoreBytes`/`deleteLegacyStore` | `legacyConvert.ts` | ad-hoc handling of an old (schema < 24) `.reel`. Old ids are kept; offer `deleteLegacyStore` only when `remainingLegacyProjects` over every folder the app looks in is empty |
| `conversionFolder`, `legacyIdsIn`, `idsToConvert`, `isLegacyDoc`, `isGeneratedPath`, `generatedFileName` | `legacyPlan.ts` | the converter's pure decisions |

## IPC — `src/preload/index.ts`, `src/renderer/src/ipc/client.ts`

The preload `api` object is the **one** place a channel's signature is declared
(`RendererApi`). `ipc/client.ts` re-exports those methods by **destructuring**
`window.api` (no second signature list) and adds only the `reelmedia://` URL
builders (`proxyUrl`/`thumbUrl`/`imageUrl`/`audioUrl`/`waveformUrl`/`fontUrl`).

To add an IPC call: add the channel in `shared/ipc.ts`, the invoker in
`preload/index.ts`, the handler in `main/ipc.ts`, then add the method name to the
destructure in `ipc/client.ts`. Don't write a `() => window.api.x()` wrapper.

`listProjectMedia`'s `proxyReady` is recomputed from disk on every call and is
only true once the playable proxy is COMPLETE (the proxies are written
atomically, see `atomicWrite.ts` above). `ensureProxy(id)` resolves only once
it is — concurrent calls for one asset share a single build.

`ipc/client.ts` also owns the `reelmedia://` URL builders. **Pass them the
asset** (a `MediaRef`: `{ id, rev }`), never a bare id: they append the asset's
content revision (`?v=<rev>`, `MediaAsset.rev`, from its fingerprint), which
changes when "Update path anyway" gives the clip different content — with the
same address the `<video>`, `<audio>` and `<img>` would keep the old proxy
(`e2e/relinkPreview.spec.ts`). For a video layer's playable proxy use
**`videoProxyUrl(asset)`**, not `proxyUrl` directly — it
picks the alpha-preserving `proxy.webm` for background-removed clips
(`probe.video.hasAlpha`) and the H.264 `proxy.mp4` otherwise, so the preview
`<video>` keeps transparency. The matching main-side split is in
`mediaStore.ts` (`playableProxyPath`/`ensureProxy` → `generateAlphaProxy`).
