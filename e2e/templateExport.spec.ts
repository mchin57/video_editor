/**
 * A template's held frame through the REAL export (the binary is the oracle —
 * CLAUDE.md). The held piece is a couple of source frames with a hold at its
 * head (`lib/templates.ts`); this renders it with ffmpeg at the frame rates and
 * speeds that broke the first design (a one-frame window at an assumed 30 fps
 * held NOTHING at 24/25 fps or in slow motion) and reads the output back.
 *
 * Each source clip encodes time as brightness: frame N has luma 16 + 20·(N/fps),
 * so an output frame's centre luma says which source moment it shows. For a
 * drop at timeline `D` with a 1s hold on a clip playing at speed `s` from 0:
 *   before the drop   → source s·t
 *   during the hold   → source s·D (the frame under the playhead), never black
 *   after the hold    → source s·(t − 1) (the clip resumes where it left off)
 * which is exactly what the preview's `videoSourceTime` shows.
 *
 * ARRANGE via store (import + `dropTemplate`), ACT via the real export IPC,
 * ASSERT on output pixels. Skipped without the bundled ffmpeg.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const DROP = 2.02 // off any frame boundary, so the cut's frame phase is arbitrary
const HOLD = 1
const lumaOf = (src: number): number => 16 + 20 * src

/** Mean Y (the limited-range luma the source was written in) of the centre of
 *  the output frame at `t` — the Y plane of a raw yuv420p frame, unconverted. */
function centreLuma(file: string, t: number): number {
  const side = 200
  const buf = execFileSync(FFMPEG, [
    '-v',
    'error',
    '-ss',
    String(t),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `crop=${side}:${side},format=yuv420p`,
    '-f',
    'rawvideo',
    '-'
  ])
  let sum = 0
  for (let i = 0; i < side * side; i++) sum += buf[i]
  return sum / (side * side)
}

/** A 10s 540×960 clip at `fps` whose brightness is its time. */
function rampClip(dir: string, fps: number): string {
  const out = join(dir, `ramp${fps}.mp4`)
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=540x960:r=${fps}:d=10,format=yuv420p,geq=lum='16+20*N/${fps}':cb=128:cr=128`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '1',
    '-pix_fmt',
    'yuv420p',
    out
  ])
  return out
}

/** Import `clip`, lay it at 0 at `speed`, drop a 1s hold (no zoom/grade) at DROP, and export. */
async function renderHeld(
  page: Page,
  app: ElectronApplication,
  clip: string,
  speed: number,
  out: string
): Promise<void> {
  await page.evaluate(
    async ({ clip, speed, drop, hold }) => {
      const { useProject } = window.__reelStores
      const s = useProject.getState()
      for (const l of s.project!.layers) s.removeItems([{ kind: 'layer', id: l.id }])
      const [a] = await window.api.importPaths([clip])
      s.addMedia([a.id])
      s.addVideoLayer('V', a.id, 0, 10, false, 540 / 960)
      if (speed !== 1) s.setVideoSpeed('V', speed)
      s.dropTemplate(
        {
          id: 't',
          name: 'Hold',
          formatVersion: 1,
          layers: [],
          audio: [],
          clipEffect: { holdSec: hold, zoom: null, color: null, tint: null }
        },
        drop,
        { durationOf: () => a.probe.durationSec, fpsOf: () => a.probe.video?.avgFps ?? 0 }
      )
    },
    { clip, speed, drop: DROP, hold: HOLD }
  )
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, out)
  await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    await window.api.exportProject(p, { preset: p.preset, preferNvenc: true })
  })
}

for (const { fps, speed } of [
  { fps: 24, speed: 1 },
  { fps: 25, speed: 1 },
  { fps: 30, speed: 1 },
  { fps: 60, speed: 1 },
  { fps: 30, speed: 0.5 },
  { fps: 24, speed: 2 }
]) {
  test(`the held frame exports at ${fps} fps, ${speed}×: the drop frame across the hold, then the clip resumes`, async ({
    appPage: page,
    electronApp
  }) => {
    test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
    test.setTimeout(180_000)
    const dir = mkdtempSync(join(tmpdir(), 'reel-heldexport-'))
    const out = join(dir, 'out.mp4')
    await renderHeld(page, electronApp, rampClip(dir, fps), speed, out)

    // Within ~4 source frames (the export's cfr resampling + the known
    // one-frame hold hairline, FFMPEG-NOTES "Speed"), and never black.
    const tol = 20 * (4 / fps) * Math.max(1, speed) + 1.5
    const at = (t: number): number => centreLuma(out, t)
    expect(Math.abs(at(1.5) - lumaOf(speed * 1.5)), 'before the drop').toBeLessThan(tol)
    const held = lumaOf(speed * DROP)
    for (const t of [DROP + 0.2, DROP + 0.5, DROP + 0.9]) {
      const v = at(t)
      expect(v, `held at ${t}s is a real frame`).toBeGreaterThan(30)
      expect(Math.abs(v - held), `held at ${t}s`).toBeLessThan(tol)
    }
    for (const t of [DROP + HOLD + 0.5, DROP + HOLD + 1.2]) {
      expect(Math.abs(at(t) - lumaOf(speed * (t - HOLD))), `resumed at ${t}s`).toBeLessThan(tol)
    }
  })
}
