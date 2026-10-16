/**
 * Regression: a clip was reported READY while ffmpeg was still writing its proxy.
 *
 * mediaStore decided readiness with `existsSync(proxy.mp4)`, but ffmpeg creates
 * its output the moment it starts encoding. So any library refetch mid-encode
 * (e.g. importing another file) flipped the clip to ready, the Library enabled
 * its add buttons, and a layer added in that window got a preview <video> that
 * failed for good — MediaError 4, `DEMUXER_ERROR_COULD_NOT_OPEN` (a faststart
 * mp4 has no `moov` atom until the encode ends) — blank until reload.
 *
 * Fixed by encoding to `proxy.part.mp4` and renaming onto `proxy.mp4` only after
 * ffmpeg exits 0 (`writeAtomically`), and by coalescing concurrent `ensureProxy`
 * calls for one asset into a single build. See FFMPEG-NOTES "Partial outputs".
 *
 * The source is iPhone-shaped (1080x1920 @ 60, HLG-tagged) — the reported case,
 * and the proxy's HDR tonemap chain makes the encode slow enough (seconds, not
 * milliseconds) to act inside it. ARRANGE via real imports, ACT via the real
 * Library button, ASSERT on main's answer + disk + the preview <video>.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobProgressEvent } from '../src/shared/jobs'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

type Probe = { __jobs: JobProgressEvent[]; __second: Promise<boolean> }

test('a clip is not ready — and cannot be added — until its proxy is fully written', async ({
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-proxy-'))
  const clip = join(dir, 'iphone-hlg.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=60:duration=20',
    '-vf', 'setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc,format=yuv420p10le',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
    clip
  ])
  // A second, tiny asset: importing it mid-encode is the Library refetch that
  // used to flip the clip to ready.
  const tone = join(dir, 'tone.wav')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    tone
  ])

  await page.evaluate(() => {
    const w = window as unknown as Probe
    w.__jobs = []
    window.api.onJobProgress((ev) => w.__jobs.push(ev))
  })
  const proxyJobs = (id: string): Promise<JobProgressEvent[]> =>
    page.evaluate(
      (id) => (window as unknown as Probe).__jobs.filter((e) => e.type === 'proxy' && e.subjectId === id),
      id
    )
  const importOne = (path: string): Promise<string> =>
    page.evaluate(async (p) => {
      const [asset] = await window.api.importPaths([p])
      window.__reelStores.useProject.getState().addMedia([asset.id])
      return asset.id
    }, path)

  const projectDir = await page.evaluate(() => window.api.getProjectDir())
  const id = await importOne(clip)
  const assetDir = join(projectDir, 'cache', id)

  // Wait until ffmpeg is demonstrably mid-encode: it has reported progress.
  await expect
    .poll(async () => (await proxyJobs(id)).some((e) => e.status === 'running' && e.progress > 0), {
      timeout: 30_000
    })
    .toBe(true)

  // --- Mid-encode ----------------------------------------------------------
  // The final name never refers to an incomplete file, so main says not ready.
  expect(existsSync(join(assetDir, 'proxy.mp4'))).toBe(false)
  expect(
    await page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0].proxyReady, id)
  ).toBe(false)

  // A second ensureProxy joins the running build: no second encode, and it
  // resolves only once the proxy is really there.
  await page.evaluate((id) => {
    ;(window as unknown as Probe).__second = window.api
      .ensureProxy(id)
      .then(async () => (await window.api.listProjectMedia([id]))[0].proxyReady)
  }, id)

  // The reported trigger: a Library refetch mid-encode must NOT enable the
  // clip's add buttons.
  await importOne(tone)
  await expect(page.getByTitle('Add to audio track at the playhead')).toBeVisible() // refetch landed
  const addClip = page.getByTitle('Add clip at the playhead')
  await expect(addClip).toHaveCSS('pointer-events', 'none')

  // All of the above must have run INSIDE the encode, or it proved nothing.
  expect(
    (await proxyJobs(id)).some((e) => e.status === 'done'),
    'proxy finished before the mid-encode checks ran — lengthen the synthetic clip'
  ).toBe(false)

  // --- After the encode ----------------------------------------------------
  await expect
    .poll(async () => (await proxyJobs(id)).some((e) => e.status === 'done'), { timeout: 60_000 })
    .toBe(true)
  expect(await page.evaluate(() => (window as unknown as Probe).__second)).toBe(true)
  expect(new Set((await proxyJobs(id)).map((e) => e.id)).size).toBe(1) // one build, not two
  expect(readdirSync(assetDir).filter((f) => f.includes('.part.'))).toEqual([]) // no partial left

  // The done event refetches the Library; the button comes alive, and a layer
  // added now gets a preview <video> that actually opens.
  await expect(addClip).toHaveCSS('pointer-events', 'auto')
  await addClip.click()
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const vids = [...document.querySelectorAll('video')].filter((v) =>
            v.src.includes(`${id}/proxy.mp4`)
          )
          if (!vids.length) return 'no <video>'
          const failed = vids.find((v) => v.error)
          if (failed) return `MediaError ${failed.error!.code}: ${failed.error!.message}`
          return vids.some((v) => v.readyState >= 1) ? 'loaded' : 'loading'
        }, id),
      { timeout: 15_000 }
    )
    .toBe('loaded')
})
