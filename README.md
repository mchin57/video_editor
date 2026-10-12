# Reel Editor

A local, offline desktop video editor for Windows, purpose-built for creating Instagram Reels from iPhone footage. Built for a triathlon coach who uses Reels for client acquisition.

> **Status: working prototype.** The editor runs, and you can build a Windows
> installer that bundles everything an end user needs. See
> [Installing (end users)](#installing-end-users) and
> [Building the installer](#building-the-installer-distribution). Open work and
> known bugs are tracked in [`docs/TODO.md`](docs/TODO.md).

## What it does

- Imports iPhone footage (HEVC/HDR `.mov`), stills, and the other major formats (mp4, mkv, avi, webm, …) via ffmpeg
- Points the library at your original files instead of copying them. A moved or deleted file shows as **Missing** and can be **relinked**.
- Projects in a 1080×1920 logical space with output **formats**: Reel, Story and Carousel slide (9:16), Feed (4:5), Square, Landscape (16:9) and more, with Instagram **safe-zone** guides
- Timeline editing: trim, split (including split on silence), reorder, delete, crop/reframe, freeze frames and speed ramps
- **Text overlays** with a 3-second hook-zone marker
- **Auto-captions** with local whisper.cpp: editable, styled and burned in
- **Music** with volume, voice ducking and fade-out, plus rendered audio effects (echo, chorus, …)
- Optional **background removal** (RVM ONNX model, GPU-accelerated)
- Clean H.264 export, NVENC-accelerated where available
- A live **Reel checklist** that scores the edit against a set of Instagram best practices
- An **AI assistant** hook: Claude Code can drive the editor through a local MCP server (see below)

## Stack

Electron + TypeScript (React 19 + Vite + Tailwind 4 renderer) orchestrating **ffmpeg** and **whisper.cpp** as child processes. Fully local, no cloud. See [`docs/PLAN.md`](docs/PLAN.md) for the rationale (including why not Python, and the Tauri alternative).

## Target machine (verified)

Windows 11, RTX 4070 Ti Super (NVENC + CUDA), i9-14900K, 32 GB RAM.

## Installing (end users)

Download **`Reel Editor-<version>-setup.exe`** and run it. That's the whole
setup. The installer bundles ffmpeg, ffprobe, whisper.cpp with its captions
model and, if it was staged at build time, the background-removal model. Nothing
else needs to be installed, and the app works fully offline.

> **macOS** is experimental. A GitHub Actions workflow
> (`.github/workflows/build-mac.yml`) builds an **unsigned** `.dmg` that bundles
> no engines, so the user installs ffmpeg separately (`brew install ffmpeg`).

> The `.exe` is currently signed with a **self-signed** certificate, so Windows
> SmartScreen / Norton will still warn on first launch (the publisher isn't
> trusted yet). Choose **More info → Run anyway** (or allow it in your
> antivirus). Earning real trust needs a purchased cert or Azure Trusted Signing
> — see [Code-signing](#code-signing) below.

## Development

```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg   # Node + the full ffmpeg build
npm install
npm run dev
```

The Gyan **full** ffmpeg build is required (has `h264_nvenc`, `libx264`,
`libass`/`ass` filter, `zscale`); the app verifies ffmpeg capabilities at
startup. For captions in dev, the app looks for whisper.cpp and a `ggml-*.bin`
model under `Documents\VideoEditor\bin\whisper`, or in `resources/bin` once
staged (see below). Background removal needs the RVM `.onnx` model under
`Documents\VideoEditor\bin\models`. Without it, the feature stays unavailable.

```powershell
npm run typecheck   # node + web tsconfigs
npm test            # vitest over the pure layers
npm run test:e2e    # builds, then Playwright drives the real Electron app
```

Contributor and agent notes live in [`CLAUDE.md`](CLAUDE.md).

### AI assistant (Claude Code)

Claude Code drives the editor through **reel-mcp**, a small stdio MCP server built
with the app (`out/main/mcp.js`) that talks to the running editor over a named
pipe (switch: **Settings → AI assistant**). Register it once — Settings shows the
exact line for your checkout with a Copy button:

    claude mcp add --scope user reel-editor -- node "<repo>\out\main\mcp.js"

Then, with the editor open, run `/edit-video` in a Claude Code session opened in
this repo. Claude Code asks before each tool call; choose "don't ask again" for
the reel-editor tools if you want it to work uninterrupted.

## Building the installer (distribution)

```powershell
npm run build:win
```

This stages the engine binaries into `resources/bin/` (via
`scripts/collect-binaries.mjs`), builds the renderer/main bundles, then packages
an NSIS installer into `release/`. The binaries are **bundled** as
electron-builder `extraResources` so a clean machine needs no separate install.

`collect-binaries` copies from where the engines already live on the dev machine
(winget Gyan.FFmpeg; `Documents\VideoEditor\bin\whisper`;
`Documents\VideoEditor\bin\models`). Point it elsewhere with the `FFMPEG_SRC`,
`WHISPER_SRC`, `WHISPER_MODEL` and `MATTE_MODEL` env vars if needed. The
background-removal model is optional: without it, the build simply leaves that
feature out. The staged `resources/bin/` and `resources/models/` (~1 GB) are
gitignored, not committed.

**Licensing of bundled binaries:** the Gyan ffmpeg build is GPL. whisper.cpp
and the Whisper model are MIT. Check the license of the background-removal model
you stage. Keep all of their license notices with any distributed copy. The
bundled fonts' licenses are in
[`resources/fonts/LICENSES.md`](resources/fonts/LICENSES.md).

### Code-signing

Signing is **env-var driven** — electron-builder signs when `CSC_LINK` (path to a
`.pfx`) and `CSC_KEY_PASSWORD` are set, and produces an unsigned build otherwise.

For local testing, generate a throwaway self-signed cert:

```powershell
npm run make-cert                       # writes certs/code-signing.pfx (gitignored)
$env:CSC_LINK = "certs/code-signing.pfx"
$env:CSC_KEY_PASSWORD = "reel-editor-dev"
npm run build:win
```

A self-signed cert proves the pipeline but does **not** stop SmartScreen/Norton
warnings (untrusted publisher). To actually earn trust, swap in a real cert with
no code change:

- **Azure Trusted Signing** (recommended; modern, no hardware token) — set
  `win.azureSignOptions` in `electron-builder.yml` and the Azure env vars per
  [their docs](https://www.electron.build/code-signing). EV-level reputation.
- **Purchased OV/EV `.pfx`** — just point `CSC_LINK`/`CSC_KEY_PASSWORD` at it.
  (Note: most new OV/EV certs now ship on hardware tokens that can't export a
  `.pfx`, which is why Azure Trusted Signing is the easier path.)

### Auto-update / releases

Built with `electron-updater`. On launch a packaged app polls its release feed
(GitHub Releases, configured under `publish:` in `electron-builder.yml`),
downloads any newer version, and prompts to restart-and-install. In dev it's a
no-op. Wiring lives in [`src/main/services/updater.ts`](src/main/services/updater.ts).

> `publish.owner` / `publish.repo` in `electron-builder.yml` point at
> `mchin57/video_editor`, matching the repo wired as `origin`. If you ever rename
> or move the repo, update them together — a mismatch means clients silently
> never find updates.

To cut a release: bump `version` in `package.json`, then publish so the
installer + `latest.yml` land on the repo's Releases:

```powershell
$env:GH_TOKEN = "<github personal access token>"
npm run build:win -- --publish always
```

A plain `npm run build:win` never uploads — it only embeds the feed URL.

## Documentation

- [`docs/TODO.md`](docs/TODO.md): the live backlog, with known bugs and what is or isn't verified
- [`docs/SHARED.md`](docs/SHARED.md): catalog of shared helpers (check before adding code)
- [`docs/FFMPEG-NOTES.md`](docs/FFMPEG-NOTES.md): verified ffmpeg/whisper behaviors and traps
- [`docs/TIMELINE.md`](docs/TIMELINE.md): timeline interaction checklist
- [`docs/MEDIA-POINTERS.md`](docs/MEDIA-POINTERS.md): how the library references original files, plus Missing/Relink
- [`docs/PLAN.md`](docs/PLAN.md): the original implementation plan (architecture, pipelines, milestones)
- [`docs/HANDOFF.md`](docs/HANDOFF.md): the original handoff and decisions log
- [`docs/PROJECT-FOLDERS.md`](docs/PROJECT-FOLDERS.md): historical, superseded by media pointers
