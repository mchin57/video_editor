/**
 * The pose detection JOB with the real models: it runs end to end through the
 * built app — both ONNX sessions open, every frame decoded and fed through the
 * detector and the pose model, the result saved to the project's `pose/`
 * folder and read back. Synthetic footage has nobody in it, so this pins the
 * wiring (the files' real inputs/outputs, the job, the save), not accuracy —
 * accuracy was checked by eye on real footage (#191).
 *
 * Skipped unless the models are installed in the developer's data dir
 * (`Documents\VideoEditor\bin\models`, see #201) and ffmpeg is staged: they are
 * copied into the test's own throwaway data dir.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const MODELS_DIR = join(homedir(), 'Documents', 'VideoEditor', 'bin', 'models')
const MODELS = ['yolox_m_humanart.onnx', 'rtmpose_m_halpe26.onnx']

test('detects pose with the real models and saves it in the project', async ({
  appPage: page,
  scratchDir,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.skip(!MODELS.every((m) => existsSync(join(MODELS_DIR, m))), 'pose models not installed (#201)')
  test.setTimeout(180_000)
  const models = join(scratchDir, 'data', 'bin', 'models')
  mkdirSync(models, { recursive: true })
  for (const m of MODELS) copyFileSync(join(MODELS_DIR, m), join(models, m))

  const dir = mkdtempSync(join(tmpdir(), 'reel-posedetect-'))
  const clip = join(dir, 'clip.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=30:d=2',
    '-pix_fmt',
    'yuv420p',
    clip
  ])

  expect(await page.evaluate(() => window.api.poseAvailable())).toMatchObject({ ready: true, missing: [] })
  const mediaId = await page.evaluate(async (clip) => {
    const [a] = await window.api.importPaths([clip])
    window.__reelStores.useProject.getState().addMedia([a.id])
    return a.id
  }, clip)
  const data = await page.evaluate(
    (id) => window.api.detectPose({ mediaId: id, startSec: 0, durationSec: 2, minSpeed: 1 }),
    mediaId
  )
  expect(data).toMatchObject({ version: 1, mediaId, fps: 30, width: 640, height: 360, startSec: 0 })
  expect(data!.frameCount).toBeGreaterThanOrEqual(59)
  expect(Array.isArray(data!.tracks)).toBe(true)
  // Saved in the project folder, and read back the same.
  expect(existsSync(join(projectsDir, 'E2E', 'pose', `${mediaId}.json`))).toBe(true)
  expect(await page.evaluate((id) => window.api.getPose(id), mediaId)).toEqual(data)
})
