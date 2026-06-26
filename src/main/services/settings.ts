/** Settings persistence (<dataDir>/settings.json), with sensible defaults. */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '@shared/settings'
import { DEFAULT_BRAND_COLORS, DEFAULT_KEYWORD_BANK } from '@shared/settings'
import { getDataDir, getSubdir } from '../config'

let cache: Settings | null = null

const settingsPath = (): string => join(getDataDir(), 'settings.json')

export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  let loaded: Partial<Settings> = {}
  try {
    loaded = JSON.parse(await fsp.readFile(settingsPath(), 'utf8'))
  } catch {
    // no settings yet — fall through to defaults
  }
  cache = {
    exportDir: loaded.exportDir || getSubdir('exports'),
    keywordBank: Array.isArray(loaded.keywordBank) ? loaded.keywordBank : DEFAULT_KEYWORD_BANK,
    brandColors: Array.isArray(loaded.brandColors) ? loaded.brandColors : DEFAULT_BRAND_COLORS
  }
  return cache
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  cache = { ...current, ...patch }
  await fsp.writeFile(settingsPath(), JSON.stringify(cache, null, 2), 'utf8')
  return cache
}
