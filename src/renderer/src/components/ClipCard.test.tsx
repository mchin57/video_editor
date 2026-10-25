import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MediaAsset } from '@shared/media'
import type { ClipCard as Card, ClipThumb as Thumb } from './ClipCard'

let ClipThumb: typeof Thumb
let ClipCard: typeof Card
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(async () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // ClipCard imports ipc/client, which destructures window.api at load.
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => () => undefined })
  ;({ ClipThumb, ClipCard } = await import('./ClipCard'))
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = host = null
})

/** A library refresh's copy of the asset: the same clip, a new object. */
const jpeg = (): MediaAsset => ({
  id: 'aaaaaaaaaaaa',
  fileName: 'IMG_8432.JPG',
  relativePath: 'IMG_8432.JPG',
  absolutePath: 'C:\\Reels\\Race clips\\IMG_8432.JPG',
  fingerprint: { size: 1, start: 'a', middle: 'a', end: 'a' },
  importedAt: '2026-08-06T00:44:00.000Z',
  probe: { durationSec: 0.04, container: 'image2', video: null, audio: null },
  kind: 'image',
  originalPath: 'C:\\Reels\\Race clips\\IMG_8432.JPG',
  status: 'ok',
  proxyReady: true,
  transcribed: false,
  rev: 'r1'
})

describe('ClipThumb', () => {
  it('a thumb that failed to load is retried on the next library refresh, not given up for good', () => {
    // 2026-10-11, owner's Race clips JPEG: drawn a moment before its thumb
    // existed, the card fell back to ▶ and stayed there though the thumb
    // appeared right after (reopening showed it).
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(<ClipThumb asset={jpeg()} />))
    const img = host.querySelector('img')!
    expect(img.getAttribute('src')).toBe('reelmedia://aaaaaaaaaaaa/thumb.jpg?v=r1')

    act(() => {
      img.dispatchEvent(new Event('error'))
    })
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('▶')

    // The refresh that follows the thumb being built: same clip, new object.
    act(() => root!.render(<ClipThumb asset={jpeg()} />))
    expect(host.querySelector('img')?.getAttribute('src')).toBe('reelmedia://aaaaaaaaaaaa/thumb.jpg?v=r1')
  })
})

const ride = (): MediaAsset => ({
  ...jpeg(),
  id: 'bbbbbbbbbbbb',
  fileName: 'Morning_Ride.fit',
  probe: {
    durationSec: 7214,
    container: 'fit',
    video: null,
    audio: null,
    workout: {
      sport: 'cycling',
      startUtc: '2026-05-24T13:02:02.000Z',
      channels: ['position', 'distance', 'power'],
      distanceM: 53405.82,
      avgPowerW: 188
    }
  },
  kind: 'workout'
})

describe('a workout card', () => {
  it('shows its route thumbnail and what it is: sport, distance, length', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(<ClipCard asset={ride()} />))
    expect(host.querySelector('[data-testid="workout-thumb"] img')?.getAttribute('src')).toBe(
      'reelmedia://bbbbbbbbbbbb/thumb.svg?v=r1'
    )
    expect(host.textContent).toContain('Ride · 33.2 mi · 2:00:14')
    expect(host.textContent).not.toContain('no video')
  })
})
