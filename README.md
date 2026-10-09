# Reel Editor

A local, offline desktop video editor for Windows, purpose-built for creating Instagram Reels from iPhone footage. Built for a triathlon coach who uses Reels for client acquisition.

> **Status: working prototype** (`prototype` branch). The editor runs and a
> Windows installer can be built that bundles everything an end user needs — see
> [Installing (end users)](#installing-end-users) and
> [Building the installer](#building-the-installer-distribution). Remaining
> polish lives in [`docs/TODO.md`](docs/TODO.md).

## What it will do

- Import iPhone footage (HEVC/HDR `.mov`) and all major formats (mp4, mkv, avi, webm, …) via ffmpeg
- Vertical **9:16 (1080×1920)** output with crop/reframe and Instagram **safe-zone** guides
- Timeline editing: trim, split, reorder, delete
- **Hook text overlays** with a 3-second hook-zone marker
- **Auto-captions** (local whisper.cpp) — editable, Reels-styled, burned in
- **Music** track with volume, voice-ducking, and fade-out
- **Export presets**: Reel, Story, Square, Carousel slide — clean H.264, NVENC-accelerated
- A live **Reel checklist** scoring the edit against the owner's Instagram strategy

## Stack

Electron + TypeScript (React 19 + Vite + Tailwind 4 renderer) orchestrating **ffmpeg** and **whisper.cpp** as child processes. Fully local, no cloud. See [`docs/PLAN.md`](docs/PLAN.md) for the rationale (including why not Python, and the Tauri alternative).

## Target machine (verified)

Windows 11, RTX 4070 Ti Super (NVENC + CUDA), i9-14900K, 32 GB RAM.

## Installing (end users)

Download **`Reel Editor-<version>-setup.exe`** and run it. That's the whole
setup — the installer bundles ffmpeg, ffprobe, and whisper.cpp (with the
`small.en` captions model), so nothing else needs to be installed and the app
works fully offline.

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
startup. For captions in dev, whisper.cpp + a `ggml-*.bin` model are discovered
under `Documents\VideoEditor\bin\whisper` (or staged into `resources/bin`, see
below).

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
(winget Gyan.FFmpeg; `Documents\VideoEditor\bin\whisper`). Point it elsewhere
with `FFMPEG_SRC`, `WHISPER_SRC`, and `WHISPER_MODEL` env vars if needed. The
staged `resources/bin/` (~1 GB) is gitignored, not committed.

**Licensing of bundled binaries:** the Gyan ffmpeg build is GPL; whisper.cpp and
the Whisper model are MIT. Keep their license notices with any distributed copy.

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

- [`docs/PLAN.md`](docs/PLAN.md) — full implementation plan: architecture, pipelines, ffmpeg command sketches, milestones, risks, verification
- [`docs/HANDOFF.md`](docs/HANDOFF.md) — current state, decisions log, and exact next step for resuming work
