/**
 * Project persistence.
 *
 * Two layers, on purpose:
 *  - The *working copy* (`current.json`) is autosaved continuously by the
 *    renderer so a crash or quit can't lose in-progress work and the last
 *    session is restored on launch. (`loadProject` / `saveProject`)
 *  - *Portable project files* are user-chosen `.reel` files written/read by the
 *    explicit File ▸ Save / Open actions. These are the documents the user owns,
 *    backs up, and shares. (`readProjectFile` / `writeProjectFile`)
 *
 * Both use an atomic write (temp file + rename) so a write interrupted midway
 * can't corrupt the target.
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '@shared/project'
import { createEmptyProject, migrateProject } from '@shared/project'
import { getSubdir } from '../config'

/** Extension for portable project files. */
export const REEL_EXT = 'reel'

const CURRENT = 'current.json'

const projectPath = (): string => join(getSubdir('projects'), CURRENT)

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2))
  await fsp.rename(tmp, path) // atomic on the same volume
}

// --- Working copy (autosave / restore on launch) ---------------------------

export async function loadProject(): Promise<Project> {
  try {
    const raw = await fsp.readFile(projectPath(), 'utf8')
    return migrateProject(JSON.parse(raw))
  } catch {
    return createEmptyProject('default', 'Untitled Reel')
  }
}

export async function saveProject(project: Project): Promise<void> {
  await writeJsonAtomic(projectPath(), { ...project, updatedAt: new Date().toISOString() })
}

// --- Portable .reel files (explicit Save / Open) ---------------------------

/** Read and migrate a project from a user-chosen file. Throws on bad input. */
export async function readProjectFile(path: string): Promise<Project> {
  const raw = await fsp.readFile(path, 'utf8')
  return migrateProject(JSON.parse(raw))
}

/** Write a project to a known path, returning the saved doc (with bumped time). */
export async function writeProjectFile(path: string, project: Project): Promise<Project> {
  const saved = { ...project, updatedAt: new Date().toISOString() }
  await writeJsonAtomic(path, saved)
  return saved
}
