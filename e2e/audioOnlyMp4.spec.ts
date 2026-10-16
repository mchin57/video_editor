/**
 * Regression (#12): an audio-only `.mp4` — AAC in an MP4, or an MP3 renamed
 * `.mp4` — imported as VIDEO because its kind came from the extension alone.
 * The video proxy's `-map 0:v:0` then failed ("Stream map '' matches no
 * streams"), the card said "proxy failed", and ♪ PH never became clickable.
 * The same audio as `.m4a` worked.
 *
 * Fixed by checking the extension against the probed streams (`kindOfFile` /
 * `reconcileKind`, shared/media.ts): a video container with no picture is
 * audio. ARRANGE via real imports of lavfi-made files, ACT via the real ♪ PH
 * button, ASSERT on main's answer, the proxy jobs and the store.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { JobProgressEvent } from '../src/shared/jobs'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

type Probe = { __jobs: JobProgressEvent[] }

const tone = (codec: string, out: string): void => {
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', codec,
    out
  ])
}

for (const variant of ['AAC in an MP4', 'an MP3 renamed .mp4'] as const) {
  test(`an audio-only .mp4 (${variant}) imports as audio and places with ♪ PH`, async ({ appPage: page }) => {
    test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
    test.setTimeout(60_000)

    const dir = mkdtempSync(join(tmpdir(), 'reel-audio-mp4-'))
    const file = join(dir, 'song.mp4')
    if (variant === 'AAC in an MP4') {
      tone('aac', file)
    } else {
      tone('libmp3lame', join(dir, 'song.mp3'))
      copyFileSync(join(dir, 'song.mp3'), file)
    }

    await page.evaluate(() => {
      const w = window as unknown as Probe
      w.__jobs = []
      window.api.onJobProgress((ev) => w.__jobs.push(ev))
    })
    const asset = await page.evaluate(async (p) => {
      const [a] = await window.api.importPaths([p])
      window.__reelStores.useProject.getState().addMedia([a.id])
      return { id: a.id, kind: a.kind }
    }, file)
    expect(asset.kind).toBe('audio')

    // The audio proxy builds and the row's ♪ PH comes alive.
    const addAudio = page.getByTitle('Add to audio track at the playhead')
    await expect(addAudio).toBeVisible()
    await expect(addAudio).toHaveCSS('pointer-events', 'auto', { timeout: 30_000 })
    const jobs = await page.evaluate(
      (id) => (window as unknown as Probe).__jobs.filter((e) => e.type === 'proxy' && e.subjectId === id),
      asset.id
    )
    expect(jobs.map((e) => e.status)).not.toContain('error')
    expect(jobs.map((e) => e.status)).toContain('done')
    expect(
      await page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0].proxyReady, asset.id)
    ).toBe(true)
    await expect(page.getByText('proxy failed')).toHaveCount(0)

    await addAudio.click()
    const project = await page.evaluate(() => {
      const p = window.__reelStores.useProject.getState().project
      return {
        clips: p.audioClips.map((c) => ({ mediaId: c.mediaId, kind: c.kind })),
        layers: p.layers.length
      }
    })
    // An audio clip, not a video layer.
    expect(project).toEqual({ clips: [{ mediaId: asset.id, kind: 'audio' }], layers: 0 })
  })
}
