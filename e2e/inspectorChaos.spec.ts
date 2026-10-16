/**
 * Regressions from the 2026-10-15 chaos-QA run (docs/TODO.md ▸ Bugs).
 *
 * ARRANGE via the stores, ACT via real clicks, ASSERT on store + DOM.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

test('a new project starts with the playhead at 0', async ({ appPage: page, projectsDir }) => {
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(3))
  await page.evaluate((dir) => window.__reelStores.useProject.getState().createProject('Fresh', dir), projectsDir)
  await expect.poll(() => page.evaluate(() => window.__reelStores.useProject.getState().project?.name)).toBe('Fresh')
  expect(await page.evaluate(() => window.__reelStores.usePlayback.getState().time)).toBe(0)
})

test('switching between two video layers never stacks duplicate Inspector sections', async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(90_000)
  const ids: string[] = []
  for (const name of ['a.mp4', 'b.mp4']) {
    const clip = join(projectsDir, 'E2E', name)
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip
    ])
    ids.push(await page.evaluate(async (p) => {
      const [asset] = await window.api.importPaths([p])
      window.__reelStores.useProject.getState().addMedia([asset.id])
      return asset.id
    }, clip))
  }
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('same key')) errors.push(m.text())
  })
  await page.evaluate((ids) => {
    const s = window.__reelStores.useProject.getState()
    s.addVideoLayer('V1', ids[0], 0, 2, false)
    s.addVideoLayer('V2', ids[1], 2, 2, false)
  }, ids)
  for (const id of ['V1', 'V2', 'V1', 'V2', 'V1']) {
    await page.getByTestId(`tile-layer-${id}`).click()
  }
  await expect(page.getByRole('button', { name: /Sound effects$/ })).toHaveCount(1)
  expect(errors).toEqual([])
})
