/**
 * Bundled fonts must actually LOAD in the renderer.
 *
 * Regression: the `reelmedia://` scheme was registered without the `corsEnabled`
 * privilege. CSS `@font-face` fetches are always CORS-mode, so Chromium rejected
 * the scheme outright ("Cross origin requests are only supported for protocol
 * schemes: chrome, …, https") and EVERY bundled face silently fell back to a
 * system font — in dev (`http://localhost:5173`) and in the packaged app
 * (`file://`) alike. Nothing threw; the preview just quietly stopped matching
 * the faces libass burns into the export, which is the one thing the whole
 * `shared/fonts` catalog exists to guarantee.
 *
 * This is invisible to vitest (no font machinery in jsdom) and to the
 * arg-builder tests (they pin strings, not what the browser will fetch), so it
 * has to live here, against the real binary.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FONTS } from '../src/shared/fonts'
import { test, expect } from './fixtures'

test('every bundled font resolves over reelmedia://', async ({ appPage }) => {
  const errors: string[] = []
  appPage.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  const results = await appPage.evaluate(
    async (labels: string[]) => {
      await document.fonts.ready
      const loaded: Record<string, number> = {}
      for (const label of labels) {
        // `load()` rejects on a network/CORS failure, so a resolved non-empty
        // array is proof the TTF really came down the protocol.
        loaded[label] = (await document.fonts.load(`16px "${label}"`)).length
      }
      return loaded
    },
    FONTS.map((f) => f.label)
  )

  for (const font of FONTS) {
    expect(results[font.label], `${font.label} (${font.file}) must load`).toBeGreaterThan(0)
  }
  expect(errors.filter((e) => /font|reelmedia/i.test(e))).toEqual([])
})

test('a missing font file 404s instead of hanging', async ({ appPage }) => {
  const status = await appPage.evaluate(() => fetch('reelmedia://fonts/NoSuchFace-Regular.ttf').then((r) => r.status))
  expect(status).toBe(404)
})

test('enabling CORS did not break media range requests', async ({ appPage }) => {
  // <video>/<audio> seeking depends on 206 partial responses (see
  // mediaProtocol.ts); `corsEnabled` changes how the scheme is fetched, so pin
  // that ranges still work and that Content-Range survives to the renderer.
  const wav = join(mkdtempSync(join(tmpdir(), 'reel-fonts-')), 'tone.wav')
  const sampleRate = 8000
  const n = sampleRate * 2
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 12000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(wav, Buffer.concat([header, data]))

  const res = await appPage.evaluate(async (p: string) => {
    const [asset] = await window.api.importPaths([p])
    await window.api.ensureProxy(asset.id)
    const r = await fetch(`reelmedia://${asset.id}/audio.m4a`, {
      headers: { Range: 'bytes=0-1023' }
    })
    return {
      status: r.status,
      contentRange: r.headers.get('Content-Range'),
      bytes: (await r.arrayBuffer()).byteLength
    }
  }, wav)

  expect(res.status).toBe(206)
  expect(res.contentRange).toMatch(/^bytes 0-1023\/\d+$/)
  expect(res.bytes).toBe(1024)
})
