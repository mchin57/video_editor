/**
 * Project persistence: a single "current" project saved as JSON with an atomic
 * write (temp file + rename) so an autosave mid-write can't corrupt it. The
 * renderer owns edit state and pushes debounced saves here.
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '@shared/project'
import { createEmptyProject } from '@shared/project'
import { getSubdir } from '../config'

const CURRENT = 'current.json'

const projectPath = (): string => join(getSubdir('projects'), CURRENT)

export async function loadProject(): Promise<Project> {
  try {
    const raw = await fsp.readFile(projectPath(), 'utf8')
    return JSON.parse(raw) as Project
  } catch {
    return createEmptyProject('default', 'Untitled Reel')
  }
}

export async function saveProject(project: Project): Promise<void> {
  const dir = getSubdir('projects')
  const tmp = join(dir, `.${CURRENT}.tmp`)
  await fsp.writeFile(tmp, JSON.stringify({ ...project, updatedAt: new Date().toISOString() }, null, 2))
  await fsp.rename(tmp, join(dir, CURRENT)) // atomic on the same volume
}
