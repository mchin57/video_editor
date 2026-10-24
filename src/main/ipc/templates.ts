/** IPC: the template gallery — list, save as, delete, a template's sound, the
 *  share file, and getting one ready to drop (services/templates.ts). */

import { app } from 'electron'
import { copyFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { AUDIO_EXTS } from '@shared/media'
import { TEMPLATE_FILE_EXT, sanitizeTemplate } from '@shared/templates'
import { importGenerated, requireUsable, tmpOutput } from '../services/mediaStore'
import { requireSession } from '../services/projectSession'
import { safeFileName } from '../services/projectLayout'
import {
  deleteTemplate,
  exportTemplate,
  importTemplate,
  instantiateTemplate,
  listTemplates,
  saveTemplate,
  setTemplateSound,
  templatesRoot
} from '../services/templates'
import { dialogsFor, handle, pickedPath } from './handle'

const shareFilter = { name: 'Reel Editor template', extensions: [TEMPLATE_FILE_EXT] }

export function registerTemplateHandlers(): void {
  handle('listTemplates', () => listTemplates(templatesRoot()))

  handle('saveTemplate', async (_event, template) => {
    const t = sanitizeTemplate(template)
    if (!t) throw new Error("That selection can't be saved as a template.")
    const s = requireSession()
    return saveTemplate(templatesRoot(), t, (id) => requireUsable(id, s))
  })

  handle('deleteTemplate', (_event, id) => deleteTemplate(templatesRoot(), id))

  handle('chooseTemplateSound', async (event, id, slot) => {
    const path = pickedPath(
      await dialogsFor(event).open({
        title: 'Choose a sound for the template',
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: [...AUDIO_EXTS] }]
      })
    )
    return path ? setTemplateSound(templatesRoot(), id, slot, path) : null
  })

  handle('exportTemplateDialog', async (event, id) => {
    const entry = (await listTemplates(templatesRoot())).find((e) => e.template.id === id)
    if (!entry) throw new Error('That template no longer exists.')
    const res = await dialogsFor(event).save({
      title: 'Export template',
      defaultPath: join(
        app.getPath('documents'),
        `${safeFileName(entry.template.name) || 'template'}.${TEMPLATE_FILE_EXT}`
      ),
      filters: [shareFilter]
    })
    if (res.canceled || !res.filePath) return null
    await exportTemplate(templatesRoot(), id, res.filePath)
    return res.filePath
  })

  handle('importTemplateDialog', async (event) => {
    const path = pickedPath(
      await dialogsFor(event).open({ title: 'Import template', properties: ['openFile'], filters: [shareFilter] })
    )
    return path ? importTemplate(templatesRoot(), path) : null
  })

  handle('instantiateTemplate', async (_event, id) => {
    // The project gets its OWN copy of each file (in generated/), so it never
    // points into the templates folder; identical files dedupe by fingerprint.
    const s = requireSession()
    return instantiateTemplate(templatesRoot(), id, async (path, name) => {
      const tmp = tmpOutput('template', extname(path).slice(1) || 'bin')
      await copyFile(path, tmp)
      return importGenerated(tmp, name, s)
    })
  })
}
