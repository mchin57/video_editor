# HANDOFF — Reel Editor

> **Purpose of this file:** preserve the exact state of work so a future Claude (Fable/Opus) iteration can resume *exactly* where the previous session left off, without re-doing exploration or re-litigating settled decisions. Written 2026-06-12.

---

## TL;DR — where we are right now

- **Phase:** **M0 complete and verified** (2026-06-12). The app builds, typechecks, tests pass, and the Electron window launches with a working ffmpeg/NVENC capability probe (confirmed on screen). All work is on branch **`prototype`** (per owner instruction — do all build work there, not `main`).
- **Next action:** Begin **Milestone M1** (media import → ffprobe → proxy job → player → library). See "Exact next step" at the bottom.
- **Stack is settled and now real:** Electron 42 + TypeScript (React 19 + Vite 7 + Tailwind 4 + zustand + react-query) orchestrating ffmpeg (+ whisper.cpp later). *Not* Python. *Not* a browser web app.
- **The full plan lives in [`PLAN.md`](PLAN.md)** in this folder (also mirrored at `C:\Users\57tuc\.claude\plans\build-a-video-editing-glowing-torvalds.md`). Read it in full before writing code.
- **To run:** `npm install` then `npm run dev` (must prepend Node to PATH in agent shells — see env note). `npm run build` / `npm run typecheck` / `npm test` all green.

---

## Who this is for / the real goal

The owner is a **US-based triathlon coach** (strong swim background) who sells coaching to age-group triathletes. He uses **Instagram Reels as a client-acquisition channel**. This editor is not a general NLE — it is a **purpose-built Reels factory** that bakes his Instagram strategy into the tool.

His strategy knowledge base (read these — they drive every feature decision):
`C:\Users\57tuc\Desktop\Code\coaching_webapp\obsidian_notes\Instagram Strategy\`
- `00 - Start here.md`, `Instagram algorithm 2026.md`, `Content strategy and formats.md`, `90-day playbook.md`, `Metrics and benchmarks.md` (+ niche/funnel/integration notes).

**Strategy facts that became product requirements:**
- Reels: **30–90s** sweet spot; **first 3 seconds decide everything** → hook text must be on screen in the first 3s (we add a 3s hook-zone marker + checklist rule).
- **Text overlays are mandatory** — ~half of viewers watch muted. Instagram **OCRs on-screen text** and **transcribes speech**, both feed ranking → captions + spoken niche keywords are algorithmically valuable (checklist scores spoken keywords against a configurable bank).
- **Safe zones:** bottom ~25% and the right action-rail are covered by Instagram UI → preview guides + checklist enforce text stays clear (logical coords: bottom y ≥ 1440, right x ≥ 972 in a 1080×1920 space).
- **No third-party watermarks** (TikTok logo = hard derank) → exports are clean H.264.
- **Carousels** can include 3–5s video slides → we have a "Carousel slide" export preset.
- Output is **vertical 9:16, 1080×1920**.

Owner preferences (from the strategy vault's "how to behave" note): prefers **conda over pip** for Python tooling; **runs all git pushes himself — never push for him**. (We pivoted off Python, so conda is moot, but the *never push* rule still applies — commit locally only when he asks; do not `git push`.)

---

## Verified environment facts (do not re-probe — confirmed 2026-06-12)

| Fact | Value |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| GPU | **NVIDIA RTX 4070 Ti Super** (NVENC h264/hevc + CUDA) + Intel UHD 770 |
| CPU | **i9-14900K** |
| RAM | 31.8 GB |
| ffmpeg | **INSTALLED 2026-06-12** — `Gyan.FFmpeg` full build **8.1.1** via winget. Verified present: `h264_nvenc`, `hevc_nvenc`, `libx264`, `aac`, and filters `ass`, `subtitles`, `zscale`, `tonemap`, `sidechaincompress`, `showwavespic`. Binary at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-8.1.1-full_build\bin\`. |
| Node | **ALREADY INSTALLED** — v24.16.0 / npm 11.13.0 at `C:\Program Files\nodejs` (on the Machine PATH). It was never missing; the earlier "not installed" claim was wrong — a bare PATH lookup in the *agent* shell fails (see env note below). |
| **Agent-shell PATH** | The harness launches its tool shells (`bash -c`, PowerShell `-NoProfile`) with a **stripped PATH** that excludes the Windows Machine PATH and **ignores `~/.bashrc` and the PS profile**. To run node/npm/ffmpeg from a tool shell, prepend the dir: `export PATH="/c/Program Files/nodejs:$PATH"`. Verified — do not waste time re-testing profile files. |
| Docker | Installed (v29.4.0) — not needed for this project |
| conda | miniconda3 at `C:\Users\57tuc\miniconda3` (no longer relevant after pivot off Python) |
| git | v2.53.0; global user.name = `mchin57` |
| Project dir | `C:\Users\57tuc\Desktop\Code\video_editor` — git initialized. **Active branch: `prototype`** (build here; `main` holds only planning/handoff commits). |

**Reference for conventions** (his other project, if you want to mirror code style): `C:\Users\57tuc\Desktop\Code\coaching_webapp` — React 19 + Vite + TS + Tailwind 4 (`@tailwindcss/vite`, `@` alias, `/api` proxy), `@tanstack/react-query`, eslint 9 + prettier + vitest. The renderer of *this* project should feel familiar to him (same React/Vite/Tailwind/react-query/vitest tooling).

---

## Decision log (settled — don't re-open without reason)

1. **Not Python.** The owner asked directly "is Python really the best option?" Answer: no. The heavy lifting is **ffmpeg** (an external binary, language-agnostic) + a speech model. Python's strengths (ML/data libs) aren't the bottleneck. The UI wants web tech. So a **single TypeScript codebase that shells out to ffmpeg/whisper** wins: shared types between UI and engine, a real installable desktop app, no Python runtime to bundle.
2. **Electron over Tauri (for now).** Electron chosen for zero new toolchain (no Rust) and maximum React familiarity. **Tauri is the noted alternative** (lighter binaries, Rust core) — revisit only if bundle size becomes a real complaint. This is the most reasonable decision to reconsider if the owner wants smaller installers.
3. **Electron over a local React+FastAPI web app** (the original first draft, which was *rejected* by the owner). Reasons: single language, native file dialogs + Explorer drag-drop, packaged `.exe`, IPC progress push instead of HTTP polling.
4. **Proxy-based preview.** Chromium can't reliably decode iPhone HEVC on Windows → generate H.264 proxies on import; keep originals for export. HDR sources get the **same tonemap** on proxy and export so preview colors match output.
5. **Export = per-clip normalize → concat demuxer → one final pass.** Intermediates are near-lossless H.264 + **PCM** audio (.mov); AAC is encoded exactly once at the end (no concat clicks). Chosen over one mega-filtergraph for robustness + debuggability + Windows quoting safety.
6. **Text via a single ASS file** (captions + hook overlays), `PlayResX=1080 PlayResY=1920` so the same coordinates drive preview and burn; same TTFs given to libass via `fontsdir`.
7. **whisper.cpp** (child process) for captions — replaces Python's faster-whisper. CPU `small.en` is ≫ realtime on the i9; GPU build optional later.
8. **JSON-file persistence** (atomic writes), content-hash media library. No SQLite.
9. **zustand** for renderer state (project doc + undo snapshots; separate high-frequency playback store), react-query for IPC/server-ish calls.
10. **ffmpeg = Gyan full build**, discovered + capability-probed at startup; `h264_nvenc` with `libx264` fallback; hard-require `ass` + `zscale` filters.

---

## Conversation arc (what happened this session, in order)

1. Owner asked to build a local video editor prioritizing iPhone video + Instagram-success features, drawing on his Instagram Strategy notes.
2. I explored: read all the Instagram Strategy notes; confirmed `video_editor` was empty; probed the machine (GPU/CPU/RAM, ffmpeg/Node/conda/docker presence); inspected `coaching_webapp` for stack conventions.
3. I asked the owner two clarifying questions (app form; v1 feature set) — **he dismissed them** ("do not proceed, wait"). I proceeded with sensible defaults: all four strategy features in v1.
4. I had a **Plan agent** design a React+Python+conda local web app. Wrote it to the plan file. Called ExitPlanMode → **rejected**: *"This doesn't necessarily need to integrate directly with the coaching_webapp tech stack if there are better options than python."*
5. I **rewrote the plan to Electron + TypeScript** (current `PLAN.md`). Called ExitPlanMode → **rejected** with: *"Also make sure to setup a git repo and other supporting infrastructure."*
6. Owner then asked **"Is Python really the best option?"** (answered: no — see decision 1), switched the model to **claude-opus-4-8** via `/model`, and asked to **"Save all work so a future iteration of Fable can pick it up exactly where left off… save the exact state of the context window and the generated plan."**
7. **This handoff + repo setup is the response to step 6.** Git initialized; `.gitignore`, `.editorconfig`, `README.md`, `docs/PLAN.md`, `docs/HANDOFF.md` created.

**Open feedback not yet actioned beyond planning:** "set up a git repo and other supporting infrastructure" — git is now initialized with baseline files; full scaffolding (package.json, electron-vite, tsconfig, eslint/prettier) is M0 work, not yet done.

---

## Architecture cheat-sheet (full detail in PLAN.md)

- **Logical coordinate space = 1080×1920 px** everywhere (preview stage is literally that size, CSS-scaled; ASS uses the same PlayRes). Overlay/caption coords are stored in this space and used verbatim in both preview and export → fidelity is exact by construction.
- **Repo layout:** `src/shared` (types shared by main+renderer), `src/main/services/*` (ffmpeg, ffprobe, mediaStore, proxy, jobs, transcribe, assBuilder, exporter, projectStore, mediaServer), `src/preload` (typed contextBridge), `src/renderer/src/{state,lib,components}`.
- **Data dir:** `%USERPROFILE%\Documents\VideoEditor\` → `media/{hash}/…`, `projects/{id}.json`, `exports/`, `tmp/{jobId}/`, `bin/whisper/`, `settings.json`.
- **Key ffmpeg sketches** (proxy, HDR→SDR tonemap, 3-phase export graph, sidechain ducking) are written out in PLAN.md §"Core pipelines" — copy them from there.
- **Pure, unit-testable modules** (do these test-first): `timelineMath`, `captions`, `checklist`, `coords`, ffprobe-JSON parsing, ffmpeg command builders, assBuilder golden files.

---

## Milestones (resume marker: ✅ M0 done → M1 next)

| # | Scope | Status |
|---|---|---|
| M0 | winget installs; electron-vite + Tailwind scaffold; ffmpeg discovery + capability probe; status footer | ✅ **done 2026-06-12** (localhost media server deferred to M1, where the player needs it) |
| M1 | Import + ffprobe + proxy job + player + safe-zone overlay | ⬜ **next** |
| M2 | Timeline (trim/split/reorder/delete), playback engine, crop tool, hook overlays + 3s marker, undo, autosave | ⬜ |
| M3 | Export pipeline + Reel preset + NVENC fallback | ⬜ |
| M4 | whisper.cpp + caption editor + ASS burn | ⬜ |
| M5 | Music + volume + ducking + fade + mute-original + waveform | ⬜ |
| M6 | Checklist + keyword-bank settings + Story/Square/Carousel presets + NSIS installer | ⬜ |

Each milestone's "done when" acceptance test is in PLAN.md §Milestones. End-to-end verification (with a real iPhone clip + ffprobe spec checks) is in PLAN.md §Verification.

---

## Exact next step (for the resuming iteration)

M0 is done. Begin **M1** on the `prototype` branch:

1. Skim `docs/PLAN.md` §"Core pipelines" (proxy command) and §Milestones M1 acceptance test.
2. Build, roughly in this order (test-first where pure):
   - `src/main/services/ffprobe.ts` — run `ffprobe -show_streams -show_format -print_format json`; parse into `ProbeInfo` (`src/shared/media.ts`). Handle **rotation** (displaymatrix side-data → displayW/H), **VFR** (avg vs r frame rate), **HDR** (transfer `smpte2084`/`arib-std-b67`). Unit-test the parser against captured JSON fixtures.
   - `src/main/services/mediaStore.ts` — content-hash import into `%USERPROFILE%\Documents\VideoEditor\media\{hash}\`, keep original, write probe.json.
   - `src/main/services/jobs.ts` + `proxy.ts` — H.264 proxy transcode (tonemap if HDR), progress pushed to renderer over IPC.
   - Media serving for `<video>` — `protocol.registerFileProtocol` (or small localhost server) so the renderer can play proxies.
   - Renderer: Library panel (clips + thumbnails, dialog + drag-drop import), player wired to the existing 9:16 `PreviewStage` + safe-zone overlay.
3. **Verification needs a real iPhone clip** (HEVC + rotation + VFR). Ask the owner to drop one in; synthetic `testsrc` clips only exercise the mechanics.
4. **Do NOT `git push`** — owner runs pushes himself. (And per owner: light checkpointing on `prototype` — don't over-document.)

## Guardrails carried over

- **Never `git push`** — owner does pushes himself. Commit locally only when asked.
- Don't re-probe the environment (facts table above is current).
- Don't reopen settled decisions (decision log) without a concrete reason.
- Keep the tool single-purpose: a Reels factory, not a general NLE. Out-of-scope list is at the end of PLAN.md.
