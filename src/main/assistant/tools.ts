/**
 * The assistant's tools, editor side: one async handler per tool returning MCP
 * content blocks. reel-mcp (src/mcp) defines and validates the tools and
 * forwards calls here over the pipe. Read tools answer from main (library,
 * whisper, ffmpeg); edit tools go through `callRenderer` so the real store
 * actions run. A thrown Error becomes the tool's error.
 * Times: "source" = seconds into a media file; "timeline" = seconds in the edit.
 */

import { existsSync, promises as fsp } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { alphaInputDecoder, assetAspect, assetKind, type MediaAsset } from '@shared/media'
import type { SequenceItem } from '@shared/assistant/protocol'
import type { ToolContent } from '@shared/assistant/pipeProtocol'
import type { ToolArgs, ToolName } from '@shared/assistant/toolArgs'
import { transcriptPhraseText, transcriptWordText } from '@shared/assistant/transcriptText'
import { frameTimes } from '@shared/assistant/frameTimes'
import { resolveCompAtPath } from '@shared/compositions'
import { getSubdir } from '../config'
import { ensureProxy, getProjectMedia } from '../services/mediaStore'
import { importManyReport } from '../services/importMany'
import { getTranscript, transcribeMedia, whisperAvailable } from '../services/whisper'
import { generateStill } from '../services/still'
import { hdrToSdrChain } from '../services/proxy'
import { exportProject, renderFrames, suggestedExportName } from '../services/exporter'
import { listJobs } from '../services/jobs'
import { getSettings } from '../services/settings'
import { exportRefusal, sanitizeExportName, uniqueExportPath } from '../services/exportTarget'
import { callRenderer } from './bridge'
import { fileFeatureRequest } from './todoFile'

const text = (t: string): ToolContent[] => [{ type: 'text', text: t }]
const json = (v: unknown): ToolContent[] => text(JSON.stringify(v, null, 2))
const r2 = (n: number): number => Math.round(n * 100) / 100

function describeAsset(a: MediaAsset): Record<string, unknown> {
  return {
    id: a.id,
    fileName: a.fileName,
    path: a.originalPath,
    kind: assetKind(a),
    durationSec: r2(a.probe.durationSec),
    hasAudio: !!a.probe.audio,
    width: a.probe.video?.displayWidth,
    height: a.probe.video?.displayHeight,
    transcribed: a.transcribed,
    proxyReady: a.proxyReady,
    status: a.status ?? 'ok'
  }
}

/** The open project's library, by id. */
async function projectAssets(): Promise<Map<string, MediaAsset>> {
  const ids = await callRenderer('getMediaIds', {})
  return new Map((await getProjectMedia(ids)).map((a) => [a.id, a]))
}

/** Each library clip's source length — what the renderer needs to measure open-ended audio. */
async function sourceDurations(): Promise<Record<string, number>> {
  return Object.fromEntries([...(await projectAssets())].map(([id, a]) => [id, a.probe.durationSec]))
}

function requireAsset(assets: Map<string, MediaAsset>, mediaId: string): MediaAsset {
  const asset = assets.get(mediaId)
  if (!asset) {
    const valid = [...assets.keys()].join(', ') || '(the library is empty — use import_media)'
    throw new Error(`No media "${mediaId}" in this project. Valid ids: ${valid}`)
  }
  if (asset.status && asset.status !== 'ok') {
    throw new Error(`Media "${mediaId}" (${asset.fileName}) is ${asset.status} on disk; the user has to fix it in the Library first.`)
  }
  return asset
}

export const toolHandlers: { [K in ToolName]: (args: ToolArgs[K]) => Promise<ToolContent[]> } = {
  list_media: async () => json([...(await projectAssets()).values()].map(describeAsset)),

  import_media: async ({ paths }) => {
    // A relative or ~ path would resolve against the EDITOR's working directory, not Claude's.
    const relative = paths.filter((p) => !isAbsolute(p))
    if (relative.length) throw new Error(`Paths must be absolute: ${relative.join(', ')}`)
    const { assets, skipped } = await importManyReport(paths)
    if (!assets.length) {
      const why = skipped.map((s) => `\n- ${s.path}: ${s.reason}`).join('')
      throw new Error(`Nothing was imported — check the paths exist and are video, audio or image files${why}`)
    }
    await callRenderer('addMedia', { ids: assets.map((a) => a.id) })
    return json({ imported: assets.map(describeAsset), skipped })
  },

  get_transcript: async ({ mediaId, fromSec, toSec, words }) => {
    const asset = requireAsset(await projectAssets(), mediaId)
    if (!asset.probe.audio) throw new Error(`${asset.fileName} has no audio track to transcribe`)
    let transcript = await getTranscript(mediaId)
    if (!transcript) {
      if (!whisperAvailable()) throw new Error('whisper.cpp is not installed, so clips cannot be transcribed')
      transcript = await transcribeMedia(mediaId)
    }
    const range =
      fromSec !== undefined || toSec !== undefined ? { fromSec: fromSec ?? 0, toSec: toSec ?? Infinity } : undefined
    const body = words ? transcriptWordText(transcript.words, range) : transcriptPhraseText(transcript.words, range)
    return text(`${asset.fileName} (${mediaId}) — source seconds\n${body}`)
  },

  get_frames: async ({ mediaId, times, count }) => {
    const asset = requireAsset(await projectAssets(), mediaId)
    const v = asset.probe.video
    if (!v) throw new Error(`${asset.fileName} has no picture`)
    const dir = await fsp.mkdtemp(join(getSubdir('tmp'), 'frames-'))
    try {
      const content: ToolContent[] = []
      for (const t of frameTimes(asset.probe.durationSec, times, count)) {
        const out = join(dir, `${t.toFixed(3)}.jpg`)
        const chain = [...(v.isHdr ? [hdrToSdrChain(v)] : []), 'scale=360:-2']
        await generateStill(asset.originalPath, out, t, chain, alphaInputDecoder(v))
        content.push({ type: 'text', text: `${asset.fileName} @ ${t.toFixed(2)}s` })
        content.push({ type: 'image', mimeType: 'image/jpeg', data: (await fsp.readFile(out)).toString('base64') })
      }
      return content
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  },

  get_timeline: async () => json(await callRenderer('getTimeline', {})),

  place_sequence: async ({ items, mode, atSec }) => {
    const assets = await projectAssets()
    const enriched: SequenceItem[] = items.map((it) => {
      const asset = requireAsset(assets, it.mediaId)
      if (assetKind(asset) !== 'video') throw new Error(`${asset.fileName} is not a video clip`)
      return { ...it, sourceDurationSec: asset.probe.durationSec, hasAudio: !!asset.probe.audio, aspect: assetAspect(asset) }
    })
    // The preview plays proxies; wait for any still encoding (coalesced — cheap when ready).
    await Promise.all([...new Set(items.map((i) => i.mediaId))].map((id) => ensureProxy(id)))
    const placed = await callRenderer('placeSequence', { items: enriched, mode: mode ?? 'append', atSec })
    return json({ placed, note: 'One undo step: call undo to revert this whole placement.' })
  },

  remove_items: async ({ ids }) => json(await callRenderer('removeItems', { ids })),

  undo: async () => json(await callRenderer('undo', {})),

  export_video: async ({ fileName, folder }) => {
    const project = await callRenderer('getProject', {})
    const requested = fileName !== undefined ? sanitizeExportName(fileName) : null
    if (fileName !== undefined && !requested) throw new Error(`"${fileName}" is not a usable file name`)
    const preset = project.preset ?? 'reel'
    let exportDir: string
    if (folder !== undefined) {
      // A model-chosen folder must already exist: never create directories it names.
      if (!isAbsolute(folder)) throw new Error(`folder must be an absolute path, got "${folder}"`)
      const st = await fsp.stat(folder).catch(() => null)
      if (!st?.isDirectory()) throw new Error(`No folder at ${folder}`)
      exportDir = folder
    } else {
      exportDir = (await getSettings()).exportDir
      await fsp.mkdir(exportDir, { recursive: true })
    }
    // No await from the refusal check to the exportProject call: exportProject registers its
    // job synchronously, so a second concurrent call sees it running and the picked path is
    // never claimed twice.
    const refusal = exportRefusal(project, listJobs())
    if (refusal) throw new Error(refusal)
    const path = uniqueExportPath(exportDir, requested ?? suggestedExportName(project.name, preset), existsSync)
    const done = exportProject(project, { preset, preferNvenc: true }, path)
    await done
    const { size } = await fsp.stat(path)
    return json({ path, sizeMB: Math.round((size / 1_048_576) * 10) / 10 })
  },

  get_text: async (q) => json(await callRenderer('getText', { ...q, sourceDurations: await sourceDurations() })),

  set_text: async ({ edits }) => {
    const results = await callRenderer('applyTextEdits', { edits, sourceDurations: await sourceDurations() })
    return json({ results, note: 'One undo step: call undo to revert this whole batch.' })
  },

  set_playhead: async ({ timeSec }) => {
    const r = await callRenderer('setPlayhead', { timeSec, sourceDurations: await sourceDurations() })
    const clamped = r.timeSec !== timeSec ? ` (clamped; the edit is ${r2(r.durationSec)}s long)` : ''
    return text(`Playhead at ${r2(r.timeSec)}s${clamped}. Playback is paused there.`)
  },

  render_frame: async ({ times }) => {
    // Render what the editor shows, so times match get_text / get_timeline: inside a
    // compound clip those are the clip's own local seconds.
    const { project, editPath } = await callRenderer('getRenderTarget', {})
    const comp = resolveCompAtPath(project, editPath) ?? project
    const nested = comp !== project
    const dir = await fsp.mkdtemp(join(getSubdir('tmp'), 'render-frame-'))
    try {
      const { frames, skippedStabilize } = await renderFrames(project, project.preset ?? 'reel', times, dir, comp)
      // Label + image per time, so each picture is captioned with its moment.
      const out: ToolContent[] = []
      if (nested) out.push({ type: 'text', text: 'The user is inside a nested composition: these frames show it on its own, at its local times.' })
      for (let k = 0; k < frames.length; k++) {
        const { path, shownSec } = frames[k]
        const clamped = shownSec < times[k] - 1 / 30 ? ` — asked for ${r2(times[k])}s, which is past the end of the edit; this is its last frame` : ''
        out.push({ type: 'text', text: `Finished frame @ ${r2(shownSec)}s (timeline)${clamped}` })
        out.push({ type: 'image', mimeType: 'image/jpeg', data: (await fsp.readFile(path)).toString('base64') })
      }
      if (skippedStabilize) {
        out.push({ type: 'text', text: 'Note: stabilization is skipped in these frames, so stabilized clips may sit slightly differently than in the export.' })
      }
      return out
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  },

  request_feature: async (req) => {
    const r = await fileFeatureRequest(req)
    return text(r.status === 'duplicate' ? `Already requested: "${req.title}" is in ${r.path}` : `Filed in ${r.path}:\n${r.entry}`)
  }
}

/** Pipe entry point: dispatch one call by tool name. */
export function handleTool(tool: string, args: unknown): Promise<ToolContent[]> {
  if (!Object.hasOwn(toolHandlers, tool)) return Promise.reject(new Error(`Unknown tool "${tool}"`))
  const run = toolHandlers[tool as ToolName] as unknown as (a: unknown) => Promise<ToolContent[]>
  return run(args ?? {})
}
