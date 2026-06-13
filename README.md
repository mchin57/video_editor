# Reel Editor

A local, offline desktop video editor for Windows, purpose-built for creating Instagram Reels from iPhone footage. Built for a triathlon coach who uses Reels for client acquisition.

> **Status: planning complete, not yet scaffolded.** This repo currently contains only planning and handoff documentation. Implementation starts at milestone **M0** — see [`docs/HANDOFF.md`](docs/HANDOFF.md) for the exact resume point and [`docs/PLAN.md`](docs/PLAN.md) for the full implementation plan.

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

## Prerequisites (not yet installed)

```powershell
winget install Gyan.FFmpeg OpenJS.NodeJS.LTS
```

The Gyan **full** ffmpeg build is required (has `h264_nvenc`, `libx264`, `libass`/`ass` filter, `zscale`). The app verifies ffmpeg capabilities at startup.

## Getting started (once scaffolded)

```powershell
npm install
npm run dev
```

## Documentation

- [`docs/PLAN.md`](docs/PLAN.md) — full implementation plan: architecture, pipelines, ffmpeg command sketches, milestones, risks, verification
- [`docs/HANDOFF.md`](docs/HANDOFF.md) — current state, decisions log, and exact next step for resuming work
