# Research — Text updates: Fonts + Colors & styling

> Expands the **Text updates → Fonts** and **Text updates → Colors & styling**
> sections of [`TODO.md`](TODO.md) into a concrete, build-ready spec: a specific
> font bundle, specific colors/presets, the data-model and ASS/preview wiring each
> item needs, and the gotchas found while reading the current code.
> Branch: `feature/text-fonts-colors` (off `feature/add-caption-features`).

---

## 0. Current state (what the code actually does today)

Read before estimating — several of these items are smaller or larger than they look.

| Fact | Location | Implication |
|---|---|---|
| `resources/fonts/` **does not exist** (only `resources/bin/`). | filesystem | Must be created + added to `electron-builder.yml` `extraResources`. |
| `TextContent.fontFamily` and `CaptionStyle.fontFamily` exist in the model. | [project.ts:109](src/shared/project.ts#L109), [project.ts:156](src/shared/project.ts#L156) | Data model is ready; nothing reads it on export. |
| **`assBuilder` never emits a font name.** Styles hardcode `Arial`; the per-overlay/per-caption inline tags emit `\an \pos \fs \c` (+pill) but **no `\fn`**. | [assBuilder.ts:69-71](src/main/services/assBuilder.ts#L69), [assBuilder.ts:86](src/main/services/assBuilder.ts#L86), [assBuilder.ts:100](src/main/services/assBuilder.ts#L100) | **`fontFamily` is silently ignored on export today — every burn is Arial.** This is the real missing link, not just "drop files in." |
| The `ass=` filter is invoked with **no `fontsdir`**. | [exporterArgs.ts:184](src/main/services/exporterArgs.ts#L184), [exporterArgs.ts:190](src/main/services/exporterArgs.ts#L190) | Even with `\fn` set, libass can't find bundled faces until `fontsdir` is passed. |
| Default caption font is the CSS stack `'Inter, system-ui, sans-serif'`. | [project.ts:167](src/shared/project.ts#L167) | Fine for preview CSS; libass needs a **single real family name**, so a stack can never match a face. |
| Preview hardcodes `font-extrabold` (CSS weight 800) on **all** text + captions. | [PreviewStage.tsx:479](src/renderer/src/components/PreviewStage.tsx#L479), [PreviewStage.tsx:542](src/renderer/src/components/PreviewStage.tsx#L542) | Single-weight display fonts (Anton, Bebas) get faux-bolded; the real weight never shows. Must be removed/derived per font. |
| ASS styles hardcode `Bold=1`. | [assBuilder.ts:69-71](src/main/services/assBuilder.ts#L69) | libass faux-bolds. On an already-heavy face (Montserrat ExtraBold) that's double-bold mush → set `Bold=0` and reference the real weight. |
| Stroke is hardcoded `Outline=4` (Plain) / `5` (Caption); shadow `Shadow=1`. No UI. | [assBuilder.ts:69](src/main/services/assBuilder.ts#L69), [assBuilder.ts:71](src/main/services/assBuilder.ts#L71) | Stroke/shadow items = expose these as fields + scale by `sy` on export. |
| `PillStyle.color` is 8-digit hex (alpha included) but the Inspector uses a `type="color"` swatch, which **strips alpha**. | [project.ts:64-69](src/shared/project.ts#L64), [Inspector.tsx:371](src/renderer/src/components/Inspector.tsx#L371) | Pill opacity is unreachable from the UI today → the "opacity slider" item. |
| **Text layers have no font control at all** in the Inspector (only size, color, pill). Captions have a free-text "Font family" box. | [Inspector.tsx:355-388](src/renderer/src/components/Inspector.tsx#L355), [Inspector.tsx:432](src/renderer/src/components/Inspector.tsx#L432) | Font picker is net-new for text layers; replaces the free-text box for captions. |
| `Settings` holds only `exportDir` + `keywordBank`. | [settings.ts:1-7](src/shared/settings.ts#L1) | Brand-color presets need a new persisted field here. |
| Export already scales geometry logical→output via `sx`/`sy` and `ScaledBorderAndShadow: yes` is set. | [exporter.ts:175](src/main/services/exporter.ts#L175), [exporter.ts:211-217](src/main/services/exporter.ts#L211), [assBuilder.ts:64](src/main/services/assBuilder.ts#L64) | Outline/Shadow scale with PlayRes automatically — only `\fs`/`padPx` need manual `*sy`; stroke/shadow widths can stay in logical px. |

**Net:** "Fonts" is really three jobs — (1) bundle the files, (2) make `assBuilder` emit `\fn` + pass `fontsdir`, (3) build the picker + load the same faces in preview. The data model barely changes. "Colors & styling" is mostly **new fields + new Inspector controls + ASS tag mapping**, with gradient text the one genuinely large item (needs a PNG render path because ASS has no gradients).

---

## Part A — Fonts

### A1. The bundle (all SIL OFL 1.1 / Apache-2.0 → safe to redistribute in the installer)

Do **not** ship Arial/Helvetica/Proxima etc. — proprietary, not redistributable, and absent on some machines. Everything below is free to bundle. Source: Google Fonts (download the **static** TTFs, not the variable font, so the family name per weight is unambiguous for libass). Ship one TTF per weight we actually reference.

Grouped to match the picker's intended categories (Caption / Hook·Display / Stylized).

#### Caption workhorses — heavy, geometric, muted-viewer legibility

| Family | Weights to ship | File(s) | ASS `Fontname` | License | Notes |
|---|---|---|---|---|---|
| **Montserrat** | ExtraBold 800, Black 900 | `Montserrat-ExtraBold.ttf`, `Montserrat-Black.ttf` | `Montserrat ExtraBold` / `Montserrat Black` | OFL | The default Reels caption look. Make ExtraBold the app default. |
| **Poppins** | Bold 700, ExtraBold 800 | `Poppins-Bold.ttf`, `Poppins-ExtraBold.ttf` | `Poppins` (Bold) | OFL | Rounder, friendlier geometric. |
| **Inter** | Bold 700, Black 900 | `Inter-Bold.ttf`, `Inter-Black.ttf` | `Inter` / `Inter Black` | OFL | Already the preview default; superb small-size legibility. |
| **League Spartan** | Bold 700, Black 900 | `LeagueSpartan-Bold.ttf`, `LeagueSpartan-Black.ttf` | `League Spartan` | OFL | Strong geometric, tight. |
| **Barlow Semi Condensed** | Bold 700, ExtraBold 800 | `BarlowSemiCondensed-Bold.ttf`, `…-ExtraBold.ttf` | `Barlow Semi Condensed` | OFL | Fits more words per line without going full-condensed. |

#### Hook / Display — big, loud, impact titles (first-3-seconds hook text)

| Family | Weights to ship | File(s) | ASS `Fontname` | License | Notes |
|---|---|---|---|---|---|
| **Anton** | Regular 400 (only weight) | `Anton-Regular.ttf` | `Anton` | OFL | The viral ultra-condensed hook font. #1 pick for hooks. |
| **Bebas Neue** | Regular 400 | `BebasNeue-Regular.ttf` | `Bebas Neue` | OFL | Tall all-caps condensed; classic title. |
| **Oswald** | Medium 500, Bold 700 | `Oswald-Medium.ttf`, `Oswald-Bold.ttf` | `Oswald` | OFL | Condensed, versatile, multiple weights. |
| **Archivo Black** | Regular 400 | `ArchivoBlack-Regular.ttf` | `Archivo Black` | OFL | Heavy grotesque; blocky impact. |
| **Barlow Condensed** | Bold 700, Black 900 | `BarlowCondensed-Bold.ttf`, `…-Black.ttf` | `Barlow Condensed` | OFL | Narrow — long single-line hooks (named in TODO). |
| **Teko** | Bold 700 | `Teko-Bold.ttf` | `Teko` | OFL | Very tall/narrow; sporty scoreboard feel (good for an athletic brand). |

#### Stylized / personality — accents, niche tone (use sparingly)

| Family | Weights to ship | File(s) | ASS `Fontname` | License | Notes |
|---|---|---|---|---|---|
| **Permanent Marker** | Regular 400 | `PermanentMarker-Regular.ttf` | `Permanent Marker` | Apache-2.0 | Energetic marker scrawl; "handwritten on screen" accents. |
| **Caveat** | Bold 700 | `Caveat-Bold.ttf` | `Caveat` | OFL | Real-handwriting feel for annotations/arrows. |
| **Bangers** | Regular 400 | `Bangers-Regular.ttf` | `Bangers` | OFL | Comic-book shout; fun/loud reactions. |
| **Pacifico** | Regular 400 | `Pacifico-Regular.ttf` | `Pacifico` | OFL | Casual brush script. |
| **Shrikhand** | Regular 400 | `Shrikhand-Regular.ttf` | `Shrikhand` | OFL | Heavy display script; playful headline. |
| **Abril Fatface** | Regular 400 | `AbrilFatface-Regular.ttf` | `Abril Fatface` | OFL | High-contrast serif; an elegant/premium counterpoint to all the sans. |

**Footprint:** ~22 TTFs, ≈ 4–9 MB total (negligible next to the ~1 GB engine bundle). Recommend committing these to the repo under `resources/fonts/` (unlike `resources/bin/`, they're tiny and license-clean, so no need to gitignore + stage them).

**Minimum viable subset** if you want to ship fewer first: **Montserrat ExtraBold** (default caption), **Anton** + **Bebas Neue** (hooks), **Poppins Bold**, **Inter** — covers ~90% of real use; the TODO's named priority picks plus Inter.

**Brand fit note (triathlon coach):** the athletic/energetic register is best served by **Anton, Bebas Neue, Teko, Barlow Condensed** for hooks and **Montserrat ExtraBold / League Spartan** for captions. Keep Pacifico/Abril for the occasional "soft" or "premium" post.

### A2. Wiring checklist (the part that makes fonts actually burn)

1. **Create `resources/fonts/`** and drop the TTFs in. Add to [`electron-builder.yml`](electron-builder.yml):
   ```yaml
   extraResources:
     - from: resources/bin   # existing
       to: bin
       filter: ["**/*"]
     - from: resources/fonts  # new
       to: fonts
       filter: ["**/*"]
   ```
2. **`getBundledFontsDir()` in [config.ts](src/main/config.ts)** — mirror `getBundledBinDir()` ([config.ts:43](src/main/config.ts#L43)): packaged → `join(process.resourcesPath, 'fonts')`; dev → `join(base, 'resources', 'fonts')`. Returns the absolute dir.
3. **Pass `fontsdir` to the `ass=` filter** in [exporterArgs.ts:184](src/main/services/exporterArgs.ts#L184) and [:190](src/main/services/exporterArgs.ts#L190): `ass=<file>:fontsdir=<dir>`. **Windows gotcha:** the filtergraph parser treats `:` and `\` specially. An absolute path like `C:\Users\…\fonts` must be escaped (`C\:/Users/…/fonts` — forward slashes + escaped drive colon) or passed through ffmpeg's path-escaping. The current code runs ffmpeg with `cwd=tmp` and uses a bare `assFile` name to dodge exactly this; `fontsdir` reintroduces it. Plan to add an escape helper and unit-test it (the `exporterArgs` builder is already pure + tested — extend [exporterArgs.test.ts](src/main/services/exporterArgs.test.ts)). Consider also `:shaping=harfbuzz` for correct kerning.
4. **Emit `\fn` in `assBuilder`** — the actual bug fix. For each overlay/caption, push `\fn<resolvedName>` into the tag list ([assBuilder.ts:86](src/main/services/assBuilder.ts#L86), [:100](src/main/services/assBuilder.ts#L100)); set `Bold=0` in the three style rows ([:69-71](src/main/services/assBuilder.ts#L69)) so heavy faces aren't faux-bolded. Add `fontName` to the `AssOverlay` interface and to the scaled `CaptionStyle` path.
5. **`fontFamily` → ASS name + (optional) weight resolver.** Keep a single source-of-truth map (shared module, e.g. `src/shared/fonts.ts`) of `{ id, displayName, category, assName, cssStack, weight, file }`. The model can store the stable `id`; preview uses `cssStack`/`weight`, export uses `assName`. Cleanest with libass: **one family-named file per weight** referenced with `Bold=0` (e.g. `assName: 'Montserrat ExtraBold'`) rather than relying on Bold/Italic synthesis.
6. **Preview must load the same faces.** Register `@font-face` for each bundled TTF in the renderer (point `src` at the files via the existing localhost media server, or copy fonts into the renderer's served assets). Then **drop the hardcoded `font-extrabold`** at [PreviewStage.tsx:479](src/renderer/src/components/PreviewStage.tsx#L479) and [:542](src/renderer/src/components/PreviewStage.tsx#L542) and drive `font-weight` from the font map — otherwise Anton/Bebas render wrong and preview≠export.
7. **Migrate the default** `DEFAULT_CAPTION_STYLE.fontFamily` from the CSS stack to a real bundled family id (e.g. Montserrat ExtraBold), and have the migration map the legacy `'Inter, system-ui, sans-serif'` value onto the Inter entry.

### A3. Font picker UI (TODO: "Font picker UI")

- Replace the caption **free-text "Font family"** box ([Inspector.tsx:432](src/renderer/src/components/Inspector.tsx#L432)) and add the **same control to text layers** (which have none today).
- Scrollable dropdown/popover, **grouped by category** (Caption / Hook·Display / Stylized), each row rendering its own name **in its own font** as the live preview (`font-family` + the map's weight).
- Drive options from the shared font map (single source of truth from A2.5) so picker, preview, and export never drift.
- Nice-to-have: a search/filter field; show the current font's category badge; a "recently used" pin.

---

## Part B — Colors & styling

All five TODO items. Summary of the ASS tag each maps to, then specifics.

| Item | Model change | Preview (CSS) | Export (ASS / other) | Effort |
|---|---|---|---|---|
| Brand color presets | `Settings.brandColors: string[]` (+ gradients) | swatch row → sets existing `color` | n/a (just feeds `color`) | **S** |
| Pill opacity | none (already 8-hex) | `background` already alpha-aware | already alpha-aware | **S** |
| Stroke / outline | `stroke?: {widthPx,color}` on text+caption styles | `-webkit-text-stroke` + `paint-order` | `\bord`/`\3c` (BorderStyle 1) | **M** |
| Drop shadow | `shadow?: {distancePx,color,blur}` | `text-shadow` | `\shad`/`\4c` (+`\blur`) | **M** |
| Gradient text | `gradient?: {from,to,angle}` | `background-clip:text` | **render to PNG + overlay** | **L** |

### B1. Brand color presets (TODO: "Brand color presets")

- **Storage:** add `brandColors: string[]` to [`Settings`](src/shared/settings.ts#L1) (persisted to `settings.json`). The TODO says "per profile" — but the Platform-profiles system isn't built yet, so ship **global** now and move it under the active profile when profiles land (note the dependency).
- **UI:** a swatch strip above the color picker in the text + caption style sections; click a swatch → sets `color`. A "+" captures the current color into the palette; long-press/× removes. Optional: 8-digit hex entry so users can store semi-transparent brand colors too.
- **Default starter palette** (high-attention Reels colors; ship as the seed so it's not empty):

  | Name | Hex | Use |
  |---|---|---|
  | White | `#FFFFFF` | Default caption fill |
  | Black | `#000000` | On light footage / stroke |
  | IG Yellow | `#FFE600` | Keyword/last-word highlight (the classic) |
  | Punch Red | `#FF3B30` | Urgency / "don't" |
  | Energy Orange | `#FF9500` | Warm emphasis |
  | Lime | `#A8FF00` | High-energy pop |
  | Cyan | `#00D1FF` | Cool accent |
  | Brand Blue | `#0A84FF` | Links / brand |
  | Magenta | `#FF2D95` | Playful pop |
  | Purple | `#AF52DE` | Secondary accent |

  (For the triathlon brand specifically, replace 2–3 of these with his actual brand hexes once known; that's exactly what the feature is for.)
- **Convention to support:** white base text + one **highlight color** on the keyword/spoken word. This is the same hook the future "word-by-word highlight" animation needs, so model the highlight color now (a second color on the style) even if animation comes later.

### B2. Semi-transparent pill backgrounds (TODO: "Semi-transparent pill backgrounds")

- No model change — `PillStyle.color` is already 8-hex with alpha ([project.ts:64-69](src/shared/project.ts#L64)). The bug is purely UI: `type="color"` can't edit alpha.
- **UI:** split the pill control into a **6-hex color swatch + a 0–100% opacity slider**; recombine to the 8-hex on change (`#RRGGBB` + `Math.round(a*255).toString(16)`). Put it everywhere pill is exposed: text layers ([Inspector.tsx:380](src/renderer/src/components/Inspector.tsx#L380)) and the shared `CaptionStyleFields` ([Inspector.tsx:471](src/renderer/src/components/Inspector.tsx#L471)).
- **Defaults/presets:** black @ 60% (`#00000099`), black @ 80% (`#000000CC`, current), white @ 90% (`#FFFFFFE6`, for dark text), brand color @ 100%. Keep `padPx` default 18.
- Both preview and export already honor the alpha ([PreviewStage.tsx:487](src/renderer/src/components/PreviewStage.tsx#L487) uses the raw `color`; `assColor` converts alpha at [assBuilder.ts:41](src/main/services/assBuilder.ts#L41)), so once the slider can produce the 8-hex, it just works.

### B3. Stroke / outline control (TODO: "Stroke / outline control")

- **Model:** add `stroke?: { widthPx: number; color: string } | null` to `TextContent` and `CaptionStyle` (and any shared text-style type — see B6).
- **Export:** map to `\bord<widthPx>` + `\3c<assColor(color)>&` with `BorderStyle=1`. Width is in logical px and `ScaledBorderAndShadow: yes` scales it, so **no `*sy` needed** (unlike `\fs`).
- **⚠ Mutual exclusion with pill:** the Pill style uses `BorderStyle=3` and **repurposes `\3c`/`\bord` as the box color/padding** ([assBuilder.ts:89](src/main/services/assBuilder.ts#L89), [:108](src/main/services/assBuilder.ts#L108)). libass can't draw an opaque box *and* a glyph outline at once. So: **stroke applies only when pill is off.** The Inspector should show stroke controls only when pill is unchecked (and vice-versa), and the doc/tooltip should say so.
- **Preview:** `-webkit-text-stroke: <w>px <color>` with `paint-order: stroke fill` (so the stroke sits *outside* the glyph, matching libass). Width must be scaled by the same `cqw` factor the font size uses ([PreviewStage.tsx:473](src/renderer/src/components/PreviewStage.tsx#L473)).
- **Defaults:** the dominant muted-viewer pattern is **white text + chunky black stroke**. Current hardcode is only `Outline=4` at `fs≈76` (thin). Recommend default **8 px**, range **0–24**, default color black. Provide quick presets: None / Thin (4) / Bold (8) / Heavy (16).

### B4. Drop shadow control (TODO: "Drop shadow control")

- **Model:** add `shadow?: { distancePx: number; color: string; blur?: number } | null`.
- **Export — know the libass limits:** ASS shadow is a **single diagonal offset** via `\shad<dist>` + `\4c<color>` (BackColour). There is **no independent X/Y offset and no native blur.** A soft look needs `\blur<n>` (which blurs outline+shadow edges) or `\be`. So:
  - Expose **distance (0–10)** + **color/opacity** → `\shad`/`\4c` (clean 1:1).
  - Optionally expose **softness (0–10)** → `\blur`. Don't promise a CSS-style independent offset+blur; it can't burn faithfully.
- **Preview:** CSS `text-shadow: <dist> <dist> <blur> <color>` — CSS *can* do offset+blur, so **preview can look softer than export**. Flag this mismatch (or deliberately clamp preview to a diagonal `\shad`-like shadow so WYSIWYG holds).
- **Works with both pill and stroke** (shadow is the box's/glyph's drop shadow under `BorderStyle` 1 *and* 3).
- **Defaults:** distance **2**, color black @ 85% (`#000000D9`), softness 0. This roughly matches today's `Shadow=1`.

### B5. Gradient text (TODO: "Gradient text" — the big one)

- **Model:** `gradient?: { from: string; to: string; angle: number } | null` on `TextContent`/`CaptionStyle`. When set, it **overrides** the flat `color`.
- **Preview (easy):** `background: linear-gradient(<angle>deg, <from>, <to>); -webkit-background-clip: text; background-clip: text; color: transparent;` on the text span.
- **Export (hard — ASS has no gradients):** render the gradient text to a **transparent PNG** and overlay it like an image layer:
  - Reuse the existing image-overlay compositing path ([exporterArgs.ts:161-182](src/main/services/exporterArgs.ts#L161)) — gradient text becomes "just another PNG overlay" with `enable='between(t,…)'`, so the export graph barely changes.
  - Render the PNG in the main process. Lowest-friction option: an **offscreen `BrowserWindow`** that draws the exact same CSS the preview uses → `capturePage()`/`toPNG()` at output resolution (guarantees preview==export). Alternative: `node-canvas` (extra native dep; must re-implement gradient+stroke+wrap to match — more drift risk).
  - Caveat: pill/stroke/shadow for gradient text must be baked into the PNG too (or composited around it), since it's no longer going through libass.
- **Curated gradient presets** (ship as one-tap "hook" gradients; angle in deg):

  | Name | From → To | Angle |
  |---|---|---|
  | Sunset | `#FF512F` → `#DD2476` | 90 |
  | Gold | `#F7971E` → `#FFD200` | 90 |
  | Ocean | `#2193B0` → `#6DD5ED` | 90 |
  | Grape | `#DA22FF` → `#9733EE` | 90 |
  | Lime | `#56AB2F` → `#A8E063` | 90 |
  | Fire | `#FF416C` → `#FF4B2B` | 90 |
  | Ice | `#FFFFFF` → `#8AB4FF` | 180 |

- **Recommendation:** schedule this **last**. High visual payoff for hooks, but the PNG render path is the only item here that touches the export architecture; everything else in Part B is fields + tag mapping.

### B6. Shared text-style model (do this before B3–B5)

`TextContent` and `CaptionStyle` already duplicate `fontFamily`/`fontSizePx`/`color`/`pill`, and the Inspector already shares one control component (`CaptionStyleFields`, [Inspector.tsx:403](src/renderer/src/components/Inspector.tsx#L403)). Before adding `stroke`/`shadow`/`gradient` to both, factor the common decoration into a shared shape (e.g. a `TextDecoration` mixin reused by both types) so the new fields, the Inspector control, the preview span, and `assBuilder` each touch **one** definition. This also sets up the future **"Text style templates"** TODO (save font+size+color+pill+stroke+shadow as a named preset) — that feature is essentially "serialize this shared shape."

---

## Suggested build order

1. **Fonts wiring** (A2.1–A2.5): create dir + bundle the minimum subset, emit `\fn`, pass `fontsdir`, build the shared font map. This fixes the silent "everything exports as Arial" bug and unblocks the picker. *(Highest value: the model already promises fonts that don't work.)*
2. **Font picker UI** (A3) + preview `@font-face` + kill `font-extrabold` (A2.6).
3. **Pill opacity** (B2) — tiny, self-contained, immediately useful.
4. **Brand color presets** (B1) — small; seeds the palette.
5. **Shared text-style refactor** (B6), then **stroke** (B3) + **shadow** (B4) together.
6. **Gradient text** (B5) — last; needs the PNG render path.

## Open questions

- **Fonts in repo vs. staged?** Recommend committing the ~22 TTFs to `resources/fonts/` (small + license-clean), unlike the gitignored `resources/bin/`. Confirm that's acceptable vs. a download step.
- **Brand colors global now, per-profile later?** The TODO says per-profile, but profiles don't exist yet. Plan is global in `settings.json` now, migrate under the active profile when the Platform-profiles item lands. OK?
- **Gradient export renderer:** offscreen `BrowserWindow` (pixel-perfect, heavier) vs. `node-canvas` (lighter dep, drift risk). Leaning offscreen window for WYSIWYG.
- **Preview/export shadow mismatch:** allow CSS to look softer than the `\shad` burn, or clamp preview to match libass exactly? Leaning "clamp for WYSIWYG."
