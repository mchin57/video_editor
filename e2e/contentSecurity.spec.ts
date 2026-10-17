/**
 * The built renderer runs under a Content Security Policy (electron.vite.config.ts)
 * in a sandboxed window (#4). A policy that blocks something doesn't throw: the
 * resource just never loads. So this records every CSP violation Chromium
 * reports while the app loads from scratch and shows real media — a proxy
 * <video>, a library thumbnail, an audio waveform, a bundled font — and
 * requires none, plus checks that the policy and the sandbox are really on.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

test('the app loads and shows media with no Content Security Policy violation', async ({
  appPage: page,
  electronApp
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)

  const violations: string[] = []
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text())
  })
  // Load the page again with the listener attached, so the initial load counts too.
  await page.reload()
  await expect(page.locator('[data-app-header]')).toBeVisible()
  await page.evaluate(() => {
    const w = window as unknown as { __csp: string[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })

  // The policy is in the page, and the window is sandboxed.
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain(
    "script-src 'self'"
  )
  expect(
    await electronApp.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()?.sandbox
    )
  ).toBe(true)

  const dir = mkdtempSync(join(tmpdir(), 'reel-csp-'))
  const clip = join(dir, 'clip.mp4')
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=540x960:rate=30:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    clip
  ])

  // A clip on the timeline (video layer + its linked audio, so a waveform and a
  // thumbnail load), and a text layer (a bundled @font-face).
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const s = window.__reelStores.useProject.getState()
    s.addMedia([asset.id])
    await window.api.ensureProxy(asset.id)
    s.addVideoLayer('V', asset.id, 0, 2, true)
    s.addLayer({
      id: 'T',
      hidden: false,
      startSec: 0,
      endSec: 2,
      x: 540,
      y: 400,
      scale: 1,
      content: {
        kind: 'text',
        text: 'Hook',
        fontFamily: 'anton',
        fontSizePx: 90,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000', padPx: 0 }
      }
    })
    window.__reelStores.usePlayback.getState().setTime(0.5)
    return asset.id
  }, clip)

  // The preview video opens and has a frame.
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const v = [...document.querySelectorAll('video')].find((el) => el.src.includes(`${id}/proxy`))
          return v ? (v.error ? `error ${v.error.code}` : v.readyState) : 'no video'
        }, id),
      { timeout: 30_000 }
    )
    .toBeGreaterThanOrEqual(2)
  // The bundled font loads (a face is found and fetched, as in fonts.spec.ts).
  await expect
    .poll(() => page.evaluate(async () => (await document.fonts.load('90px "Anton"')).length), { timeout: 15_000 })
    .toBeGreaterThan(0)
  // Images (library thumbnail, waveform) loaded rather than being blocked.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const imgs = [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('reelmedia://'))
          return imgs.length > 0 && imgs.every((i) => i.complete)
        }),
      { timeout: 30_000 }
    )
    .toBe(true)

  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  expect(violations).toEqual([])
})
