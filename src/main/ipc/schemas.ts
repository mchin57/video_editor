/**
 * Runtime checks for what the renderer sends, one per channel of the contract
 * (`IpcInvoke` / `IpcSend`, shared/ipc.ts). The object is `satisfies` a mapped
 * type over the contract, so a channel without a schema, or a schema whose
 * output doesn't fit the channel's argument types, is a compile error.
 *
 * Every number is a finite number and every id a non-empty string, so nothing
 * malformed reaches an ffmpeg argument or a filter graph (effect settings are
 * written into one). Project documents get a structural check, not a full
 * schema: they are the renderer's own state, migrated on load
 * (`migrateProject`), and a full schema would be a second, drifting copy of
 * the document type. Extra trailing arguments are ignored, as before: no
 * handler reads them.
 */

import { z } from 'zod'
import type { InvokeArgs, InvokeName, IpcSend } from '@shared/ipc'
import type { Project } from '@shared/project'
import { EXPORT_PRESETS, type PresetId } from '@shared/formats'
import type { Settings } from '@shared/settings'
import type { ReelTemplate } from '@shared/templates'

/** Why `args` don't fit `schema`, or null when they do. Paths count from the
 *  first argument at 0 (`argument 0.pieces.1.inSec`). */
export function argsProblem(schema: z.ZodType, args: unknown[]): string | null {
  const r = schema.safeParse(args)
  if (r.success) return null
  return r.error.issues
    .map((i) => (i.path.length ? `argument ${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
}

/** An argument list: these items, anything after them ignored. */
const args = <T extends z.ZodType[]>(...items: T) =>
  z.tuple(items as unknown as [z.ZodType]).rest(z.unknown()) as unknown as z.ZodType<{ [I in keyof T]: z.output<T[I]> }>

const id = z.string().min(1)
const num = z.number()
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const project = z.custom<Project>(
  (v) =>
    isRecord(v) &&
    typeof v.id === 'string' &&
    Array.isArray(v.layers) &&
    Array.isArray(v.audioClips) &&
    isRecord(v.captions),
  { message: 'not a project document' }
)

/** A template from the renderer: a structural check here; the handler runs
 *  the full `sanitizeTemplate` before anything is written. */
const template = z.custom<ReelTemplate>(
  (v) => isRecord(v) && typeof v.name === 'string' && Array.isArray(v.layers) && Array.isArray(v.audio),
  { message: 'not a template' }
)

const window = { inSec: num, outSec: num }

const audioFxSettings = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('echo'), echo: z.object({ delayMs: num, decay: num, repeats: num }) }),
  z.object({ kind: z.literal('ensemble'), ensemble: z.object({ voices: num, spreadMs: num, detuneCents: num }) }),
  z.object({ kind: z.literal('chorus'), chorus: z.object({ voices: num, rateHz: num, depth: num }) })
])

const stillRequest = z.object({
  mediaId: id,
  sourceSec: num,
  crop: z.object({ x: num, y: num, w: num, h: num }).nullable(),
  color: z.object({ brightness: num, contrast: num, saturation: num }).nullable(),
  tint: z.object({ color: z.string(), amount: num }).nullable().optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional()
})

/** A settings patch: only known keys, each with its type (settings.json is
 *  written straight from the merged patch). */
const settingsPatch = z.strictObject({
  exportDir: z.string().min(1).optional(),
  keywordBank: z.array(z.string()).optional(),
  brandColors: z.array(z.string()).optional(),
  assistant: z.strictObject({ enabled: z.boolean() }).optional(),
  autoJoinDefaultLevel: z.boolean().optional(),
  // Each preset is re-checked on load (`sanitizeTextStyles`).
  textStyles: z.array(z.custom<Settings['textStyles'][number]>(isRecord)).optional()
}) satisfies z.ZodType<Partial<Settings>>

export const INVOKE_SCHEMAS = {
  getCapabilities: args(),
  getDataDir: args(),

  importDialog: args(),
  importPaths: args(z.array(z.string().min(1))),
  importFolderDialog: args(),
  extractAudioDialog: args(),
  listProjectMedia: args(z.array(z.string())),
  ensureProxy: args(id),
  relinkMediaDialog: args(id),
  renameMedia: args(id, z.string()),
  quickCut: args(z.object({ mediaId: id, pieces: z.array(z.object(window)) })),
  mergeClips: args(z.array(z.object({ mediaId: id, ...window }))),
  setMediaDescription: args(id, z.string()),

  loadProject: args(),
  saveProject: args(project),
  openProjectFile: args(),
  saveProjectAs: args(project),
  saveProjectFile: args(project),
  createProject: args(z.string(), z.string()),
  chooseProjectLocation: args(z.string()),
  defaultProjectLocation: args(),
  getProjectDir: args(),
  convertLegacyFolderDialog: args(),

  exportProject: args(
    project,
    z.object({ preset: z.enum(Object.keys(EXPORT_PRESETS) as [PresetId, ...PresetId[]]), preferNvenc: z.boolean() })
  ),
  revealFile: args(z.string().min(1)),

  getSettings: args(),
  updateSettings: args(settingsPatch),
  chooseExportDir: args(),

  whisperAvailable: args(),
  transcribeMedia: args(id),
  getTranscript: args(id),
  detectSilence: args(id),
  getLoudness: args(id),
  renderAudioFx: args(z.object({ settings: audioFxSettings, sourceMediaId: id, ...window })),

  segmentAvailable: args(),
  removeBackground: args(
    z.object({ mediaId: id, startSec: num, durationSec: num, minSpeed: num, subjectId: z.string().optional() })
  ),
  poseAvailable: args(),
  detectPose: args(
    z.object({ mediaId: id, startSec: num, durationSec: num, minSpeed: num, subjectId: z.string().optional() })
  ),
  getPose: args(id),
  getWorkout: args(id),
  mediaRecordedAt: args(id),
  cancelJob: args(id),

  captureStillToLibrary: args(stillRequest),
  captureStillToDisk: args(stillRequest, z.string()),

  listTemplates: args(),
  saveTemplate: args(template),
  deleteTemplate: args(id),
  chooseTemplateSound: args(id, z.number().int().min(0)),
  exportTemplateDialog: args(id),
  importTemplateDialog: args(),
  instantiateTemplate: args(id),

  assistantStatus: args()
} satisfies { [K in InvokeName]: z.ZodType<InvokeArgs<K>> }

export const SEND_SCHEMAS = {
  assistantResponse: args(
    z.union([
      z.object({ id, ok: z.literal(true), result: z.unknown() }),
      z.object({ id, ok: z.literal(false), error: z.string() })
    ])
  )
} satisfies { [K in keyof IpcSend]: z.ZodType<IpcSend[K]> }
