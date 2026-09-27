/**
 * Instagram-success checklist: scores a project against the strategy notes
 * (hook in the first 3s, 30–90s length, captions, on-screen text, spoken niche
 * keywords, text clear of UI safe zones, vertical 9:16). Pure + unit-tested.
 */

import type { Layer, Project, TextContent } from '@shared/project'
import { hookCovered, type FrameRect } from '@shared/layers'
import { isNineSixteen, type ExportPreset } from '@shared/formats'
import { intrudesSafeZone, type Rect } from './coords'

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface CheckItem {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

export interface ChecklistResult {
  items: CheckItem[]
  /** 0–100; pass = full credit, warn = half. */
  score: number
}

export interface ChecklistInput {
  /** Overall timeline duration (max of video + audio). */
  durationSec: number
  keywordBank: string[]
  /** The project's output format: its aspect, frame and platform safe zones. */
  format: ExportPreset
}

/** Non-empty text layers (the "on-screen text" the checklist scores). */
function textLayers(project: Project): { layer: Layer; text: TextContent }[] {
  return project.layers
    .filter((l): l is Layer & { content: TextContent } => l.content.kind === 'text' && l.content.text.trim().length > 0)
    .map((l) => ({ layer: l, text: l.content }))
}

/** Rough bounding box for a (center-anchored) text layer, FRAME-relative (the
 *  space safe zones are defined in). */
function textBox(layer: Layer, text: TextContent, frame: FrameRect): Rect {
  const w = Math.min(frame.w, Math.max(text.fontSizePx * 3, text.text.trim().length * text.fontSizePx * 0.55))
  const h = text.fontSizePx * 1.3
  return { x: layer.x - frame.x - w / 2, y: layer.y - frame.y - h / 2, w, h }
}

const PASS = (id: string, label: string, detail: string): CheckItem => ({ id, label, status: 'pass', detail })
const WARN = (id: string, label: string, detail: string): CheckItem => ({ id, label, status: 'warn', detail })
const FAIL = (id: string, label: string, detail: string): CheckItem => ({ id, label, status: 'fail', detail })

export function buildChecklist(project: Project, input: ChecklistInput): ChecklistResult {
  const items: CheckItem[] = []
  const overlays = textLayers(project)
  const hasCaptions = project.captions.enabled && project.captions.segments.some((s) => s.enabled)
  const captionText = project.captions.segments
    .map((s) => s.text)
    .join(' ')
    .toLowerCase()

  // 1. Hook in the first 3 seconds
  items.push(
    hookCovered(project.layers)
      ? PASS('hook', 'Hook text in first 3s', 'On-screen hook within 0–3s.')
      : FAIL('hook', 'Hook text in first 3s', 'Add a text overlay starting before 3s — the first 3s decide retention.')
  )

  // 2. Length 30–90s
  const d = input.durationSec
  if (d >= 15 && d <= 90) {
    items.push(PASS('length', 'Length 30–90s', `${d.toFixed(0)}s — within the recommended range.`))
  } else if (d >= 7 && d < 15) {
    items.push(WARN('length', 'Length 30–90s', `${d.toFixed(0)}s — short; fine for trend clips, but 30–90s usually retains better.`))
  } else if (d > 90 && d <= 120) {
    items.push(WARN('length', 'Length 30–90s', `${d.toFixed(0)}s — a touch long; tighten toward ≤90s.`))
  } else {
    items.push(FAIL('length', 'Length 30–90s', `${d.toFixed(0)}s — outside the 7–90s range.`))
  }

  // 3. Captions
  items.push(
    hasCaptions
      ? PASS('captions', 'Captions', 'Captions present — ~half of viewers watch muted.')
      : WARN('captions', 'Captions', 'Generate captions — most viewers watch without sound.')
  )

  // 4. On-screen text
  items.push(
    overlays.length > 0
      ? PASS('overlays', 'On-screen text', `${overlays.length} text overlay${overlays.length > 1 ? 's' : ''}.`)
      : WARN('overlays', 'On-screen text', 'Add on-screen text — Instagram OCRs it and muted viewers rely on it.')
  )

  // 5. Spoken niche keywords (scanned from captions)
  const bank = input.keywordBank.map((k) => k.trim().toLowerCase()).filter(Boolean)
  if (bank.length === 0) {
    items.push(WARN('keywords', 'Niche keywords spoken', 'No keyword bank set (Settings).'))
  } else if (!hasCaptions) {
    items.push(WARN('keywords', 'Niche keywords spoken', 'Generate captions to check spoken keywords.'))
  } else {
    const hits = bank.filter((k) => captionText.includes(k))
    items.push(
      hits.length > 0
        ? PASS('keywords', 'Niche keywords spoken', `Said: ${hits.slice(0, 4).join(', ')}${hits.length > 4 ? '…' : ''}`)
        : WARN('keywords', 'Niche keywords spoken', 'No niche keywords heard — Instagram transcribes audio for ranking.')
    )
  }

  // 6. Text clear of UI safe zones (only formats that carry platform UI have any)
  const { format } = input
  const zones = format.safeZones ?? []
  const intruding = overlays.filter((o) => intrudesSafeZone(textBox(o.layer, o.text, format.frame), zones))
  items.push(
    zones.length === 0
      ? PASS('safezones', 'Text clear of UI safe zones', `No platform UI overlays the ${format.name} frame.`)
      : intruding.length === 0
        ? PASS('safezones', 'Text clear of UI safe zones', 'No text under the caption bar or action rail.')
        : WARN('safezones', 'Text clear of UI safe zones', `${intruding.length} overlay(s) may sit behind Instagram UI.`)
  )

  // 7. Vertical 9:16
  items.push(
    isNineSixteen(format)
      ? PASS('aspect', 'Vertical 9:16', `${format.width}×${format.height} full-screen vertical.`)
      : WARN('aspect', 'Vertical 9:16', `${format.name} — Reels/Stories favor full vertical 9:16.`)
  )

  const credit = items.reduce((s, it) => s + (it.status === 'pass' ? 1 : it.status === 'warn' ? 0.5 : 0), 0)
  return { items, score: Math.round((credit / items.length) * 100) }
}
