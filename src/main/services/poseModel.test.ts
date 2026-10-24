import { describe, expect, it } from 'vitest'
import { KEYPOINTS } from '@shared/pose'
import {
  DET_SIZE,
  MAX_PEOPLE,
  POSE_H,
  POSE_W,
  decodeDetections,
  decodeSimcc,
  letterbox,
  nms,
  poseCrop,
  warpToPoseInput
} from './poseModel'

/** A w×h BGR frame filled with one colour. */
const flat = (w: number, h: number, bgr: [number, number, number]): Uint8Array => {
  const f = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) f.set(bgr, i * 3)
  return f
}

describe('letterbox', () => {
  it('fits the frame at the top-left of a 114-grey square, NCHW 0–255', () => {
    const { tensor, ratio } = letterbox(flat(1280, 720, [10, 20, 30]), 1280, 720)
    expect(ratio).toBeCloseTo(0.5)
    const plane = DET_SIZE * DET_SIZE
    expect([tensor[0], tensor[plane], tensor[2 * plane]]).toEqual([10, 20, 30]) // top-left pixel, B G R
    const below = 400 * DET_SIZE + 10 // row 400 is under the 360-row picture
    expect(tensor[below]).toBe(114)
  })
})

describe('person detections', () => {
  it('nms keeps the best of overlapping boxes', () => {
    expect(
      nms(
        [
          [0, 0, 100, 100],
          [5, 5, 105, 105],
          [300, 300, 400, 400]
        ],
        [0.8, 0.9, 0.7]
      )
    ).toEqual([1, 2])
  })

  it('reads an NMS-baked export: person boxes above the score floor, back in frame px', () => {
    const dets = {
      dims: [1, 3, 5],
      data: new Float32Array([10, 20, 110, 220, 0.9, 0, 0, 50, 50, 0.2, 300, 0, 400, 100, 0.8])
    }
    const labels = { dims: [1, 3], data: new BigInt64Array([0n, 0n, 2n]) }
    const boxes = decodeDetections([dets, labels], 0.5, 1280, 720)
    expect(boxes).toEqual([[20, 40, 220, 440]]) // low score and non-person dropped; /ratio
  })

  it('decodes a raw anchor grid (objectness × person) and suppresses duplicates', () => {
    const anchors = (DET_SIZE / 8) ** 2 + (DET_SIZE / 16) ** 2 + (DET_SIZE / 32) ** 2
    const stride = 6 // 4 box + objectness + 1 class
    const data = new Float32Array(anchors * stride)
    // Two neighbouring stride-8 anchors seeing the same 64×128 person around (100, 100).
    const put = (a: number, gx: number, gy: number, score: number): void => {
      data.set([100 / 8 - gx, 100 / 8 - gy, Math.log(64 / 8), Math.log(128 / 8), score, 1], a * stride)
    }
    put(12 * 80 + 12, 12, 12, 0.95)
    put(12 * 80 + 13, 13, 12, 0.9)
    const boxes = decodeDetections([{ dims: [1, anchors, stride], data }], 1, 1280, 720)
    expect(boxes).toHaveLength(1)
    boxes[0].forEach((v, i) => expect(v).toBeCloseTo([68, 36, 132, 164][i]))
  })

  it('keeps at most MAX_PEOPLE, best first', () => {
    const n = MAX_PEOPLE + 3
    const data = new Float32Array(n * 5)
    for (let i = 0; i < n; i++) data.set([i * 100, 0, i * 100 + 50, 100, 0.4 + i * 0.05], i * 5)
    const boxes = decodeDetections([{ dims: [1, n, 5], data }], 1, 5000, 1000)
    expect(boxes).toHaveLength(MAX_PEOPLE)
    expect(boxes[0][0]).toBe((n - 1) * 100)
  })
})

describe('the pose crop and input', () => {
  it('pads the box 1.25× and widens it to the 192:256 aspect', () => {
    const c = poseCrop([100, 100, 200, 500]) // a tall 100×400 person
    expect([c.cx, c.cy]).toEqual([150, 300])
    expect(c.sh).toBeCloseTo(500)
    expect(c.sw / c.sh).toBeCloseTo(POSE_W / POSE_H)
  })

  it('samples the crop around its centre and normalises each channel', () => {
    const frame = flat(400, 400, [123.675, 116.28, 103.53].map(Math.round) as [number, number, number])
    const input = warpToPoseInput(frame, 400, 400, { cx: 200, cy: 200, sw: 192 })
    const plane = POSE_W * POSE_H
    const mid = (POSE_H / 2) * POSE_W + POSE_W / 2
    // ≈ the mean in every channel → ≈ 0 after normalising.
    for (let c = 0; c < 3; c++) expect(Math.abs(input[c * plane + mid])).toBeLessThan(0.02)
  })
})

describe('decodeSimcc', () => {
  it('maps each keypoint’s argmax back through the crop to frame px', () => {
    const lx = POSE_W * 2
    const ly = POSE_H * 2
    const x = new Float32Array(KEYPOINTS * lx)
    const y = new Float32Array(KEYPOINTS * ly)
    // Keypoint 0 at the crop's centre, keypoint 1 at its top-left corner.
    x[POSE_W] = 0.9
    y[POSE_H] = 0.7
    x[lx] = 0.5
    y[ly] = 0.5
    const crop = { cx: 500, cy: 400, sw: 300, sh: 400 }
    const k = decodeSimcc(
      [
        { dims: [1, KEYPOINTS, lx], data: x },
        { dims: [1, KEYPOINTS, ly], data: y }
      ],
      crop
    )
    expect(k.slice(0, 2)).toEqual([500, 400])
    expect(k[2]).toBeCloseTo(0.8) // mean of the two maxima (float32)
    expect(k.slice(3, 6)).toEqual([350, 200, 0.5])
    expect(k).toHaveLength(KEYPOINTS * 3)
  })

  it('names the outputs it got when they are not SimCC', () => {
    expect(() =>
      decodeSimcc([{ dims: [1, 17, 64, 48], data: new Float32Array(1) }], { cx: 0, cy: 0, sw: 1, sh: 1 })
    ).toThrow(/Unexpected pose-model outputs/)
  })
})
