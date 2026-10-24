/**
 * Template storage against a real temp folder: saving copies the media IN (so a
 * template survives its original moving), a same-named save replaces, a
 * built-in's sound makes a user copy that stands in for it, the share file
 * round-trips media, a damaged or traversing file is refused, and dropping
 * adopts copies into the project.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaAsset } from '@shared/media'
import { BUILT_IN_TEMPLATES } from '@shared/templateStarters'
import { TEMPLATE_FORMAT_VERSION, type ReelTemplate } from '@shared/templates'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))

import {
  deleteTemplate,
  exportTemplate,
  importTemplate,
  instantiateTemplate,
  listTemplates,
  saveTemplate,
  setTemplateSound
} from './templates'

let dir: string
let root: string
let media: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reel-templates-'))
  root = join(dir, 'templates')
  media = join(dir, 'media')
  mkdirSync(media)
  writeFileSync(join(media, 'ding.mp3'), 'DING')
  writeFileSync(join(media, 'logo.png'), 'LOGO')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const RIGHT_BACK = 'builtin-right-back'

/** A template from the selection: references are library media ids. */
function selection(name = 'My sting'): ReelTemplate {
  return {
    id: 'unsaved',
    name,
    formatVersion: TEMPLATE_FORMAT_VERSION,
    clipEffect: null,
    layers: [
      {
        id: 'i',
        hidden: false,
        startSec: 0,
        endSec: 2,
        x: 540,
        y: 960,
        scale: 1,
        content: { kind: 'image', mediaId: 'm-logo', opacity: 1 }
      }
    ],
    audio: [
      {
        label: 'Sting',
        file: 'm-ding',
        clip: { startSec: 0, inSec: 0, outSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, duck: false, kind: 'music' }
      }
    ]
  }
}

const library: Record<string, Pick<MediaAsset, 'originalPath' | 'fileName'>> = {}
const resolve = async (id: string): Promise<Pick<MediaAsset, 'originalPath' | 'fileName'>> => {
  library['m-ding'] = { originalPath: join(media, 'ding.mp3'), fileName: 'ding.mp3' }
  library['m-logo'] = { originalPath: join(media, 'logo.png'), fileName: 'logo.png' }
  const a = library[id]
  if (!a) throw new Error('That media is no longer in the library.')
  return a
}

const mine = async (): Promise<ReelTemplate[]> =>
  (await listTemplates(root)).filter((e) => !e.builtIn).map((e) => e.template)

describe('template storage', () => {
  it('lists the built-ins when nothing is saved yet', async () => {
    const list = await listTemplates(root)
    expect(list.map((e) => e.template.id)).toEqual(BUILT_IN_TEMPLATES.map((t) => t.id))
    expect(list.every((e) => e.builtIn)).toBe(true)
  })

  it('saves a template with its OWN copies of the media, which outlive the originals', async () => {
    await saveTemplate(root, selection(), resolve)
    const [t] = await mine()
    expect(t.name).toBe('My sting')
    expect(t.id).not.toBe('unsaved')
    expect(t.audio[0].file).toBe('ding.mp3')
    expect(t.layers[0].content).toMatchObject({ kind: 'image', mediaId: 'logo.png' })
    rmSync(media, { recursive: true })
    const [again] = await mine()
    expect(again.audio[0].file).toBe('ding.mp3')
    expect(readFileSync(join(root, t.id, 'ding.mp3'), 'utf8')).toBe('DING')
  })

  it('replaces a template saved under the same name (any case)', async () => {
    await saveTemplate(root, selection('Sting'), resolve)
    const first = (await mine())[0].id
    await saveTemplate(root, selection('STING'), resolve)
    const now = await mine()
    expect(now).toHaveLength(1)
    expect(now[0].id).not.toBe(first)
    expect(existsSync(join(root, first))).toBe(false)
  })

  it('refuses to save when a clip is missing from the library', async () => {
    const t = selection()
    t.audio[0].file = 'gone'
    await expect(saveTemplate(root, t, resolve)).rejects.toThrow('no longer in the library')
    expect(await mine()).toEqual([])
  })

  it('leaves no half-written folder behind when copying a file fails', async () => {
    const vanish = async (id: string): Promise<Pick<MediaAsset, 'originalPath' | 'fileName'>> =>
      id === 'm-logo' ? { originalPath: join(media, 'gone.png'), fileName: 'gone.png' } : resolve(id)
    await expect(saveTemplate(root, selection(), vanish)).rejects.toThrow()
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
  })

  it("choosing a built-in's sound makes a user copy that stands in for it; deleting the copy brings it back", async () => {
    let list = await setTemplateSound(root, RIGHT_BACK, 0, join(media, 'ding.mp3'))
    const copies = list.filter((e) => e.template.name === "We'll be right back")
    expect(copies).toHaveLength(1)
    expect(copies[0].builtIn).toBe(false)
    expect(copies[0].template.basedOn).toBe(RIGHT_BACK)
    expect(copies[0].template.audio[0].file).toBe('ding.mp3')
    // Choosing again replaces the copy's sound, not the built-in's.
    writeFileSync(join(media, 'boom.wav'), 'BOOM')
    list = await setTemplateSound(root, copies[0].template.id, 0, join(media, 'boom.wav'))
    const copy = list.find((e) => e.template.id === copies[0].template.id)!
    expect(copy.template.audio[0].file).toBe('boom.wav')
    expect(existsSync(join(root, copy.template.id, 'ding.mp3'))).toBe(false)
    list = await deleteTemplate(root, copy.template.id)
    expect(list.find((e) => e.template.id === RIGHT_BACK)?.builtIn).toBe(true)
  })

  it("won't delete a built-in or a template that isn't there", async () => {
    await expect(deleteTemplate(root, RIGHT_BACK)).rejects.toThrow("Built-in templates can't be deleted.")
    await expect(deleteTemplate(root, 'nope')).rejects.toThrow('no longer exists')
    await expect(deleteTemplate(root, '..')).rejects.toThrow('no longer exists')
  })

  it('turns a sound file that went missing into an empty slot', async () => {
    await saveTemplate(root, selection(), resolve)
    const [t] = await mine()
    rmSync(join(root, t.id, 'ding.mp3'))
    const [after] = await mine()
    expect(after.audio[0].file).toBeNull()
  })

  it('skips a damaged template.json instead of failing the list', async () => {
    mkdirSync(join(root, 'bad'), { recursive: true })
    writeFileSync(join(root, 'bad', 'template.json'), '{not json')
    mkdirSync(join(root, 'wrong'), { recursive: true })
    writeFileSync(join(root, 'wrong', 'template.json'), JSON.stringify({ ...selection(), id: 'other' }))
    expect(await mine()).toEqual([])
  })
})

describe('the share file', () => {
  it('round-trips a template and its media under a new id, renaming a clash', async () => {
    await saveTemplate(root, selection(), resolve)
    const [t] = await mine()
    const file = join(dir, 'x.reeltemplate')
    await exportTemplate(root, t.id, file)
    await importTemplate(root, file)
    const all = await mine()
    expect(all.map((x) => x.name)).toEqual(['My sting', 'My sting (2)'])
    const imported = all.find((x) => x.id !== t.id)!
    expect(readFileSync(join(root, imported.id, 'ding.mp3'), 'utf8')).toBe('DING')
    expect(readFileSync(join(root, imported.id, 'logo.png'), 'utf8')).toBe('LOGO')
  })

  it('exports a built-in too (it has no files)', async () => {
    const file = join(dir, 'b.reeltemplate')
    await exportTemplate(root, 'builtin-follow', file)
    await importTemplate(root, file)
    expect((await mine()).map((x) => x.name)).toEqual(['Follow for more (2)'])
  })

  it('refuses a file that is not a template, or one whose file name tries to leave its folder', async () => {
    const junk = join(dir, 'junk.reeltemplate')
    writeFileSync(junk, 'hello')
    await expect(importTemplate(root, junk)).rejects.toThrow("isn't a Reel Editor template")
    const evil = selection()
    evil.audio[0].file = '../../evil.exe'
    writeFileSync(
      junk,
      JSON.stringify({ format: 'reel-template', version: 1, template: evil, files: { '../../evil.exe': 'AAAA' } })
    )
    await expect(importTemplate(root, junk)).rejects.toThrow('damaged or incomplete')
    expect(existsSync(join(dir, 'evil.exe'))).toBe(false)
  })
})

describe('instantiateTemplate', () => {
  it('adopts a copy of each file into the project and points the template at the new media ids', async () => {
    await saveTemplate(root, selection(), resolve)
    const [t] = await mine()
    const adopted: string[] = []
    const { template, assets } = await instantiateTemplate(root, t.id, async (path, name) => {
      adopted.push(name)
      return { id: `lib-${name}`, originalPath: path } as MediaAsset
    })
    expect(adopted).toEqual(['My sting — logo.png', 'My sting — ding.mp3'])
    expect(assets).toHaveLength(2)
    expect(template.audio[0].file).toBe('lib-My sting — ding.mp3')
    expect(template.layers[0].content).toMatchObject({ mediaId: 'lib-My sting — logo.png' })
  })

  it('needs nothing adopted for a built-in, and leaves an empty slot empty', async () => {
    const { template, assets } = await instantiateTemplate(root, RIGHT_BACK, async () => {
      throw new Error('should not adopt')
    })
    expect(assets).toEqual([])
    expect(template.audio[0].file).toBeNull()
  })
})
