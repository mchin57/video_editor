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
| `inputCls`, `colorCls`, `btnCls`, `subtleBtnCls`, `dangerBtnCls`, `toggleCls(on)` | `components/ui.tsx` | pasting the `rounded bg-white/10 …` / rose / color-input class strings inline |
| `startPointerDrag(onMove, onUp?)` | `lib/pointerDrag.ts` | hand-rolling `window.addEventListener('pointermove'/'pointerup')` + cleanup |
| `startDragWithUndo((ev, before) => …)` | `lib/pointerDrag.ts` | the snapshot-project → liveUpdate → `commitLive(before)` dance for canvas drags |
| `OverrideToggle`, `StabilizeSliders` | `components/Inspector.tsx` | re-rendering the Default/On/Off segmented control or the shakiness/smoothing sliders a second time |
| `updateById(arr, id, fn)`, `replaceAt(arr, i, count, …items)` | `lib/arrays.ts` | `arr.map(x => x.id===id?…:x)` and `slice()`+`splice()` in store actions |
| `packRows`, `layoutLanes`, `resizeRowH` | `lib/lanes.ts` | computing timeline lane rows / vertical stack (top/height/collapse) / resize height **inline** in `Timeline.tsx`, where a refactor can delete it untested (see `docs/TIMELINE.md`) |

`Timeline.tsx`'s block drags use `startPointerDrag` with the `edgeAutoScroll` rAF
loop stopped in the `onUp` callback. _Not yet converted:_ `Popout.tsx`,
`LayersPanel.tsx`, `Splitter.tsx` (small, no edge-scroll) — fold in when next touched.

## Shared model — `src/shared/project.ts`, `src/shared/layers.ts`

| Concept | Home | Use instead of |
| --- | --- | --- |
| `TextStyleBase` (font + fill + pill/stroke/shadow/gradient) | `project.ts` | re-declaring those fields on a text/caption type. `TextContent` and `CaptionStyle` **extend** it; `TextStyleLike` (TextStyleControls) and `TextDeco` (PreviewStage) alias/`Pick` it |
| `resolveOverride(value, projectDefault)`, `isOverridden(value)` | `project.ts` | writing `value === undefined ? dflt : value` for a new inherit/force-on/force-off knob. `effectiveDenoise`/`effectiveStabilize` + `*Overridden` are thin wrappers |
| `FRAME` = `{ width: 1080, height: 1920 }` | `layers.ts` | a new `{w,h}`/`{width,height}` literal. Renderer imports it as `LOGICAL` (`lib/coords.ts`); export presets (`shared/export.ts`) own per-preset **output** sizes |
| `containBox(aspect, scale, frame?)` | `layers.ts` | re-deriving the aspect-fit ("contain") box math (was in `exporter.layerBox` + `PreviewStage.mediaBox`) |
| `stretchedBox(aspect, scale, stretchX, stretchY, frame?)` | `layers.ts` | `containBox` + the non-uniform edge-resize stretch; preview `mediaBox` and `exporter` both size media through it |
| `resizeBox(box, handle, dx, dy, aspect)` | `layers.ts` | hand-rolling edge/corner resize math (opposite-anchor recompute, aspect-locked corners) — drives every stage resize handle |
| `effectiveImageAspect(base, crop, rotateQuarters)` | `layers.ts` | re-deriving image crop-reshape + 90°/270° aspect swap |
| `effectiveCaptionStyle`, `effectiveOut`, `contentOfKind`, `audioClipEnd` | `project.ts`/`layers.ts` | already-canonical; extend rather than add parallels |
| `pillRadiusPx(padPx)` | `project.ts` | hard-coding the text-pill corner radius; preview (`PreviewStage`, in `cqw`) and export (`textImage`, in px) must agree on the shape |

_Note:_ video-layer aspect is still a one-line ternary at each call site — the
preview and export fallbacks differ (frame-aspect vs `1` when the probe is
missing), so it was deliberately **not** unified to keep behavior identical.

## Main / ffmpeg — `src/main/services/ffmpegFilters.ts`, `exporter.ts`

| Concept | Home | Use instead of |
| --- | --- | --- |
| `cropFilter(rect)`, `eqFilter(color)` | `ffmpegFilters.ts` | hand-writing `crop=w:h:x:y` or `eq=brightness=…:contrast=…:saturation=…` |
| `f3(n)` (`toFixed(3)`), `r(n)` (`Math.round`) | `ffmpegFilters.ts` | redefining the seconds/rounding formatters per module |
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
