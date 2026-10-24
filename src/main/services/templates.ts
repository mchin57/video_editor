/**
 * Template storage (shared/templates.ts holds the format): editor-wide, one
 * folder per user template under `<data>/templates/<id>/` holding
 * `template.json` plus the template's OWN copies of its media (a sound, an
 * image) — so a template keeps working when the original moves, and the share
 * file can carry them. Built-in starters live in code (`templateStarters.ts`);
 * a user template `basedOn` one stands in for it in the list.
 *
 * Every function takes the templates `root`, so tests run against a temp dir;
 * the IPC handlers pass `templatesRoot()`.
 */

import { existsSync, promises as fsp } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { MediaAsset } from '@shared/media'
import { newId } from '@shared/ids'
import { PROJECT_VERSION } from '@shared/project'
import { bestEffort, createLogger } from '@shared/log'
import { BUILT_IN_TEMPLATES, isBuiltInTemplate } from '@shared/templateStarters'
import {
  TEMPLATE_FORMAT_VERSION,
  TEMPLATE_JSON,
  isTemplateFileName,
  mapTemplateFiles,
  migrateTemplate,
  parseTemplateShare,
  sanitizeTemplate,
  templateFiles,
  type ReelTemplate,
  type TemplateEntry,
  type TemplateShareFile
} from '@shared/templates'
import { getSubdir } from '../config'
import { replaceFile } from './atomicWrite'
import { safeFileName, uniqueFileName } from './projectLayout'

const log = createLogger('templates')

/** The biggest share file Import reads (they hold their media, base64). */
export const MAX_SHARE_BYTES = 256 * 1024 * 1024

/** Where user templates live: `<data>/templates`. */
export const templatesRoot = (): string => getSubdir('templates')

/** A user template's folder, or null when `id` couldn't be one (a path, `..`). */
function dirOf(root: string, id: string): string | null {
  return isTemplateFileName(id) ? join(root, id) : null
}

/** The user template `id` as stored, with any file that has gone missing
 *  turned into an empty slot / dropped image; null when there is none. */
async function readUserTemplate(root: string, id: string): Promise<ReelTemplate | null> {
  const dir = dirOf(root, id)
  if (!dir) return null
  let raw: string
  try {
    raw = await fsp.readFile(join(dir, TEMPLATE_JSON), 'utf8')
  } catch {
    return null // not a template folder
  }
  let t: ReelTemplate | null = null
  try {
    t = sanitizeTemplate(JSON.parse(raw))
  } catch (error) {
    log.warn(`template ${id} is not valid JSON; skipped`, error)
    return null
  }
  if (!t || t.id !== id) {
    log.warn(`template ${id} is damaged; skipped`)
    return null
  }
  return mapTemplateFiles(migrateTemplate(t), (f) => (existsSync(join(dir, f)) ? f : null))
}

/** Every user template, by name. */
async function userTemplates(root: string): Promise<ReelTemplate[]> {
  let names: string[]
  try {
    names = await fsp.readdir(root)
  } catch {
    return []
  }
  const out: ReelTemplate[] = []
  for (const n of names) {
    const t = await readUserTemplate(root, n)
    if (t) out.push(t)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The gallery: built-ins first (minus any a user copy stands in for), then
 *  the user's own, by name. */
export async function listTemplates(root: string): Promise<TemplateEntry[]> {
  const mine = await userTemplates(root)
  const replaced = new Set(mine.map((t) => t.basedOn).filter((b): b is string => !!b))
  return [
    ...BUILT_IN_TEMPLATES.filter((t) => !replaced.has(t.id)).map((t) => ({ template: t, builtIn: true })),
    ...mine.map((t) => ({ template: t, builtIn: false }))
  ]
}

/** A template by id: a user one, else a built-in. Throws when there is none. */
async function findTemplate(root: string, id: string): Promise<{ t: ReelTemplate; builtIn: boolean }> {
  const mine = await readUserTemplate(root, id)
  if (mine) return { t: mine, builtIn: false }
  const built = BUILT_IN_TEMPLATES.find((t) => t.id === id)
  if (built) return { t: built, builtIn: true }
  throw new Error('That template no longer exists.')
}

/** A file to put in a template's folder: copied from a path, or written from bytes. */
type FileSource = { from: string } | { data: Buffer }

/**
 * Write `t` into its folder with `files` (file name → source), the JSON last
 * so a half-written template never lists. A folder already there keeps its
 * other files. If anything fails, a folder this call created is removed again,
 * so a failed save or import leaves nothing behind.
 */
async function writeTemplate(root: string, t: ReelTemplate, files: Map<string, FileSource>): Promise<void> {
  const dir = dirOf(root, t.id)
  if (!dir) throw new Error(`Bad template id: ${t.id}`)
  const fresh = !existsSync(dir)
  try {
    await fsp.mkdir(dir, { recursive: true })
    for (const [name, src] of files) {
      const to = join(dir, name)
      if ('from' in src) await fsp.copyFile(src.from, to)
      else await fsp.writeFile(to, src.data)
    }
    await replaceFile(join(dir, TEMPLATE_JSON), JSON.stringify(t, null, 2))
  } catch (error) {
    if (fresh)
      await bestEffort(fsp.rm(dir, { recursive: true, force: true }), `removing half-written template ${t.id}`, log)
    throw error
  }
}

/** Remove a user template's folder (no-op for a built-in or an unknown id). */
async function removeTemplateDir(root: string, id: string): Promise<void> {
  const dir = dirOf(root, id)
  if (!dir || isBuiltInTemplate(id)) return
  await fsp.rm(dir, { recursive: true, force: true })
}

/** A safe, unused file name in a template folder for a file called `name`. */
const fileNameFor = (name: string, taken: Set<string>): string => {
  const safe = safeFileName(name) || 'file'
  const picked = uniqueFileName(safe, (n) => taken.has(n.toLowerCase()))
  taken.add(picked.toLowerCase())
  return picked
}

/**
 * Save a template made from the selection. Its media references are LIBRARY
 * ids; `resolve` gives each one's original (path + display name), which is
 * COPIED into the template. A user template with the same name is replaced
 * (like saved text styles). Returns the updated list.
 */
export async function saveTemplate(
  root: string,
  template: ReelTemplate,
  resolve: (mediaId: string) => Promise<Pick<MediaAsset, 'originalPath' | 'fileName'>>
): Promise<TemplateEntry[]> {
  const files = new Map<string, FileSource>()
  const taken = new Set<string>([TEMPLATE_JSON])
  const byMedia = new Map<string, string>()
  for (const mediaId of templateFiles(template)) {
    const asset = await resolve(mediaId)
    const name = fileNameFor(asset.fileName || basename(asset.originalPath), taken)
    files.set(name, { from: asset.originalPath })
    byMedia.set(mediaId, name)
  }
  const id = newId()
  const t: ReelTemplate = {
    ...mapTemplateFiles(template, (m) => byMedia.get(m) ?? null),
    id,
    formatVersion: TEMPLATE_FORMAT_VERSION,
    projectVersion: template.projectVersion ?? PROJECT_VERSION
  }
  delete t.basedOn
  const same = (await userTemplates(root)).filter((o) => o.name.toLowerCase() === t.name.toLowerCase())
  await writeTemplate(root, t, files)
  for (const o of same) await bestEffort(removeTemplateDir(root, o.id), `removing replaced template ${o.id}`, log)
  return listTemplates(root)
}

/** Delete a user template (its folder and its media copies). A copy of a
 *  built-in going brings the built-in back. */
export async function deleteTemplate(root: string, id: string): Promise<TemplateEntry[]> {
  if (isBuiltInTemplate(id)) throw new Error("Built-in templates can't be deleted.")
  if (!(await readUserTemplate(root, id))) throw new Error('That template no longer exists.')
  await removeTemplateDir(root, id)
  return listTemplates(root)
}

/**
 * Put the sound at `srcPath` into sound slot `slot` of template `id` (copied
 * into its folder). A built-in can't change, so its first sound makes a user
 * copy `basedOn` it, which stands in for it from then on.
 */
export async function setTemplateSound(
  root: string,
  id: string,
  slot: number,
  srcPath: string
): Promise<TemplateEntry[]> {
  const found = await findTemplate(root, id)
  const base = found.t
  if (!base.audio[slot]) throw new Error('That template has no such sound slot.')
  const t: ReelTemplate = found.builtIn ? { ...base, id: newId(), basedOn: base.id } : base
  const dir = dirOf(root, t.id)!
  const taken = new Set([TEMPLATE_JSON.toLowerCase(), ...templateFiles(t).map((f) => f.toLowerCase())])
  const name = fileNameFor(basename(srcPath), taken)
  const old = t.audio[slot].file
  const next: ReelTemplate = { ...t, audio: t.audio.map((a, i) => (i === slot ? { ...a, file: name } : a)) }
  // A built-in copy also carries any other files the built-in has (none today).
  const files = new Map<string, FileSource>([[name, { from: srcPath }]])
  await writeTemplate(root, next, files)
  if (old && !templateFiles(next).includes(old)) {
    await bestEffort(fsp.rm(join(dir, old), { force: true }), `removing replaced sound ${old}`, log)
  }
  return listTemplates(root)
}

/** Write template `id` as a share file at `destPath` (its media inside, base64). */
export async function exportTemplate(root: string, id: string, destPath: string): Promise<void> {
  const { t } = await findTemplate(root, id)
  const files: Record<string, string> = {}
  for (const f of templateFiles(t)) {
    files[f] = (await fsp.readFile(join(root, t.id, f))).toString('base64')
  }
  // On the other side it is simply the user's own template.
  const template: ReelTemplate = { ...t }
  delete template.basedOn
  const share: TemplateShareFile = { format: 'reel-template', version: TEMPLATE_FORMAT_VERSION, template, files }
  await replaceFile(destPath, JSON.stringify(share))
}

/**
 * Add the template in the share file at `srcPath` as a new user template
 * (a new id; " (2)" after the name if one is already called that). Throws
 * with a reason the user can read.
 */
export async function importTemplate(root: string, srcPath: string): Promise<TemplateEntry[]> {
  const st = await fsp.stat(srcPath)
  if (st.size > MAX_SHARE_BYTES) throw new Error('That template file is too big to import.')
  let parsed: unknown
  try {
    parsed = JSON.parse(await fsp.readFile(srcPath, 'utf8'))
  } catch {
    throw new Error("That file isn't a Reel Editor template.")
  }
  const res = parseTemplateShare(parsed)
  if ('error' in res) throw new Error(res.error)
  const migrated = migrateTemplate(res.template)
  const names = new Set((await listTemplates(root)).map((e) => e.template.name.toLowerCase()))
  let name = migrated.name
  for (let n = 2; names.has(name.toLowerCase()); n++) name = `${migrated.name} (${n})`
  const t: ReelTemplate = { ...migrated, id: newId(), name }
  delete t.basedOn
  const files = new Map<string, FileSource>(
    Object.entries(res.files).map(([f, b64]) => [f, { data: Buffer.from(b64, 'base64') }])
  )
  await writeTemplate(root, t, files)
  return listTemplates(root)
}

/**
 * Template `id` ready to drop into the open project: each of its media files
 * adopted into the project's library through `adopt` (a COPY, so the project
 * never points into the templates folder), and its references swapped for the
 * new media ids. A missing file leaves its slot empty.
 */
export async function instantiateTemplate(
  root: string,
  id: string,
  adopt: (copyOf: string, displayName: string) => Promise<MediaAsset>
): Promise<{ template: ReelTemplate; assets: MediaAsset[] }> {
  const { t } = await findTemplate(root, id)
  const assets: MediaAsset[] = []
  const byFile = new Map<string, string>()
  for (const f of templateFiles(t)) {
    const path = join(root, t.id, f)
    if (!existsSync(path)) continue
    const asset = await adopt(path, `${t.name} — ${basename(f, extname(f))}${extname(f)}`)
    assets.push(asset)
    byFile.set(f, asset.id)
  }
  return { template: mapTemplateFiles(t, (f) => byFile.get(f) ?? null), assets }
}
