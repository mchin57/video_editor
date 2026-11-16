import { describe, expect, it } from 'vitest'
import { PROJECT_VERSION, type Layer } from './project'
import { BUILT_IN_TEMPLATES, isBuiltInTemplate } from './templateStarters'
import { FONTS } from './fonts'
import {
  TEMPLATE_FORMAT_VERSION,
  cleanTemplateName,
  isTemplateFileName,
  mapTemplateFiles,
  mapTemplateLuts,
  migrateTemplate,
  parseTemplateShare,
  sanitizeTemplate,
  templateDuration,
  templateAllFiles,
  templateFiles,
  templateLutFiles,
  templatePreviewTime,
  templateSummary,
  type ReelTemplate
} from './templates'

const image = (id: string, file: string, start = 0, end = 2): Layer => ({
  id,
  hidden: false,
  startSec: start,
  endSec: end,
  x: 540,
  y: 960,
  scale: 1,
  content: { kind: 'image', mediaId: file, opacity: 1 }
})

const rightBack = BUILT_IN_TEMPLATES.find((t) => t.id === 'builtin-right-back')!

const withFiles: ReelTemplate = {
  ...rightBack,
  id: 'mine',
  layers: [...rightBack.layers, image('i1', 'logo.png', 0, 4)],
  audio: [{ ...rightBack.audio[0], file: 'sting.mp3' }]
}

describe('built-in starters', () => {
  it('are all valid templates, in bundled fonts, with unique ids', () => {
    const fontIds = new Set(FONTS.map((f) => f.id))
    for (const t of BUILT_IN_TEMPLATES) {
      expect(sanitizeTemplate(t), t.name).not.toBeNull()
      for (const l of t.layers)
        if (l.content.kind === 'text') expect(fontIds.has(l.content.fontFamily), l.id).toBe(true)
      expect(isBuiltInTemplate(t.id)).toBe(true)
    }
    expect(new Set(BUILT_IN_TEMPLATES.map((t) => t.id)).size).toBe(BUILT_IN_TEMPLATES.length)
    expect(isBuiltInTemplate('mine')).toBe(false)
  })

  it("keep every piece out of Instagram's bottom caption zone", () => {
    for (const t of BUILT_IN_TEMPLATES) for (const l of t.layers) expect(l.y, `${t.name} ${l.id}`).toBeLessThan(1400)
  })

  it("'We'll be right back' holds, zooms and tints, with an empty sting slot", () => {
    expect(rightBack.clipEffect).toMatchObject({ holdSec: 3, zoom: { scale: 1.3 } })
    expect(rightBack.audio).toEqual([expect.objectContaining({ label: 'Sting', file: null })])
    expect(templateSummary(rightBack)).toBe('Freeze 3s · zoom · tint · 1 text · sting: none')
  })
})

describe('template files', () => {
  it('lists every referenced file once', () => {
    expect(templateFiles(withFiles)).toEqual(['logo.png', 'sting.mp3'])
    expect(templateFiles(rightBack)).toEqual([])
  })

  it('maps references both ways; a null drops an image and empties a sound slot', () => {
    const ids = mapTemplateFiles(withFiles, (f) => `id-${f}`)
    expect(templateFiles(ids)).toEqual(['id-logo.png', 'id-sting.mp3'])
    const dropped = mapTemplateFiles(withFiles, () => null)
    expect(dropped.layers.some((l) => l.content.kind === 'image')).toBe(false)
    expect(dropped.audio[0].file).toBeNull()
    expect(dropped.layers).toHaveLength(rightBack.layers.length)
  })

  it('accepts only bare file names (no folders, no traversal)', () => {
    expect(isTemplateFileName('sting.mp3')).toBe(true)
    for (const bad of ['', '.', '..', '../x.mp3', 'a/b.png', 'a\\b.png', 'C:x', 'x\0']) {
      expect(isTemplateFileName(bad), bad).toBe(false)
    }
  })

  it('refuses names Windows rejects and the template’s own JSON', () => {
    for (const bad of ['template.json', 'TEMPLATE.JSON', 'CON', 'nul.mp3', 'com1.wav', 'sting.', 'sting ']) {
      expect(isTemplateFileName(bad), bad).toBe(false)
    }
    expect(isTemplateFileName('console.mp3')).toBe(true)
  })

  it('refuses a template whose files differ only in case (one file on Windows)', () => {
    const clash = { ...withFiles, layers: [...withFiles.layers, image('i2', 'STING.MP3')] }
    expect(sanitizeTemplate(clash)).toBeNull()
  })
})

describe('LUTs in a template (#55)', () => {
  const lut = { file: 'warm.cube', name: 'Warm', strength: 0.6 }
  const pic = image('i1', 'logo.png')
  const withLuts: ReelTemplate = {
    ...withFiles,
    clipEffect: {
      ...rightBack.clipEffect!,
      color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0.4, greenMagenta: -0.1, vibrance: 0.2 },
      lut
    },
    layers: [...rightBack.layers, { ...pic, content: { ...pic.content, lut: { ...lut, file: 'cool.cube' } } } as Layer]
  }

  it('lists the LUT files apart from the media, and both in templateAllFiles', () => {
    expect(templateFiles(withLuts)).toEqual(['logo.png', 'sting.mp3'])
    expect(templateLutFiles(withLuts)).toEqual(['warm.cube', 'cool.cube'])
    expect(templateAllFiles(withLuts)).toEqual(['logo.png', 'sting.mp3', 'warm.cube', 'cool.cube'])
  })

  it('maps LUT files on their own; a null drops that LUT and keeps the rest of the look', () => {
    const mapped = mapTemplateLuts(withLuts, (f) => `p-${f}`)
    expect(mapped.clipEffect!.lut).toEqual({ ...lut, file: 'p-warm.cube' })
    expect(templateLutFiles(mapped)).toEqual(['p-warm.cube', 'p-cool.cube'])
    expect(templateFiles(mapped)).toEqual(templateFiles(withLuts))
    const dropped = mapTemplateLuts(withLuts, () => null)
    expect(dropped.clipEffect!.lut).toBeNull()
    expect(dropped.clipEffect!.color).toEqual(withLuts.clipEffect!.color)
  })

  it('is a valid template; a LUT that is not a bare .cube name, or a mistyped control, is refused', () => {
    expect(sanitizeTemplate(withLuts)).not.toBeNull()
    const bad = (fx: object) => sanitizeTemplate({ ...withLuts, clipEffect: { ...withLuts.clipEffect!, ...fx } })
    expect(bad({ lut: { ...lut, file: '../x.cube' } })).toBeNull()
    expect(bad({ lut: { ...lut, file: 'x.png' } })).toBeNull()
    expect(bad({ lut: { ...lut, strength: 'full' } })).toBeNull()
    expect(bad({ color: { brightness: 0, contrast: 1, saturation: 1, vibrance: '1' } })).toBeNull()
    const picBad = { ...withLuts, layers: [{ ...pic, content: { ...pic.content, lut: { file: 'a/b.cube' } } }] }
    expect(sanitizeTemplate(picBad)).toBeNull()
  })

  it('a share file must carry its LUTs too, and the summary says LUT', () => {
    const files = { 'logo.png': 'TE9HTw==', 'sting.mp3': 'U1Q=', 'warm.cube': 'Q1VCRQ==' }
    expect(parseTemplateShare({ format: 'reel-template', version: 1, template: withLuts, files })).toEqual({
      error: 'That template is missing its file "cool.cube".'
    })
    expect(templateSummary(withLuts)).toContain('LUT')
  })
})

describe('sanitizeTemplate', () => {
  it('refuses a newer format, a missing name, a bad piece, an empty template or a traversing file', () => {
    expect(sanitizeTemplate(withFiles)).toBe(withFiles)
    expect(sanitizeTemplate({ ...withFiles, formatVersion: TEMPLATE_FORMAT_VERSION + 1 })).toBeNull()
    expect(sanitizeTemplate({ ...withFiles, name: '  ' })).toBeNull()
    expect(sanitizeTemplate({ ...withFiles, layers: [{ ...rightBack.layers[0], endSec: 0 }] })).toBeNull()
    const video = { ...rightBack.layers[0], content: { kind: 'video' } }
    expect(sanitizeTemplate({ ...withFiles, layers: [video] })).toBeNull()
    expect(sanitizeTemplate({ ...withFiles, layers: [], audio: [], clipEffect: null })).toBeNull()
    expect(sanitizeTemplate({ ...withFiles, layers: [image('i', '../../evil.exe')] })).toBeNull()
    expect(sanitizeTemplate({ ...withFiles, clipEffect: { ...rightBack.clipEffect, holdSec: 0 } })).toBeNull()
    expect(sanitizeTemplate('nope')).toBeNull()
  })

  it('checks every field a shared file could break the preview or export with', () => {
    const graphics = BUILT_IN_TEMPLATES.find((t) => t.id === 'builtin-link-in-bio')!
    const g = graphics.layers.find((l) => l.content.kind === 'graphics')!
    const badMark = (m: Record<string, unknown>): ReelTemplate => ({
      ...graphics,
      layers: [{ ...g, content: { kind: 'graphics', marks: [m] } } as unknown as Layer]
    })
    const mark = (g.content as unknown as { marks: Record<string, unknown>[] }).marks[0]
    expect(sanitizeTemplate(badMark(mark))).not.toBeNull()
    expect(sanitizeTemplate(badMark({ ...mark, tool: 'laser' }))).toBeNull()
    expect(
      sanitizeTemplate(
        badMark({
          ...mark,
          points: [
            { x: 1, y: 'a' },
            { x: 2, y: 2 }
          ]
        })
      )
    ).toBeNull()
    const t = rightBack.layers[0]
    const withText = (patch: Record<string, unknown>): ReelTemplate => ({
      ...rightBack,
      layers: [{ ...t, content: { ...t.content, ...patch } } as Layer]
    })
    expect(sanitizeTemplate(withText({ pill: { enabled: 'yes', color: '#000', padPx: 1 } }))).toBeNull()
    expect(sanitizeTemplate(withText({ shadow: { distancePx: 'far', color: '#000', blur: 0 } }))).toBeNull()
    expect(sanitizeTemplate(withText({ animation: { in: 'fadeIn' } }))).toBeNull()
    expect(sanitizeTemplate(withText({ fontSizePx: -4 }))).toBeNull()
    expect(sanitizeTemplate({ ...rightBack, layers: [{ ...t, keyframes: [{ tSec: 0 }] }] })).toBeNull()
  })
})

describe('migrateTemplate', () => {
  it('leaves a current template alone and records the schema on an older one', () => {
    expect(migrateTemplate(rightBack)).toBe(rightBack)
    // Absent means 29, the schema templates shipped with: brought up to date.
    const unversioned = { ...rightBack, projectVersion: undefined }
    expect(migrateTemplate(unversioned).projectVersion).toBe(PROJECT_VERSION)
    expect(migrateTemplate(unversioned).layers).toEqual(rightBack.layers)
    const old = { ...rightBack, projectVersion: 28 }
    const m = migrateTemplate(old)
    expect(m.projectVersion).toBe(PROJECT_VERSION)
    expect(m.layers).toEqual(rightBack.layers)
    expect(old.layers).toBe(rightBack.layers) // the input is not mutated
  })

  it("runs the project's own migrations over the layers (an unknown font falls back)", () => {
    const t = rightBack.layers[0]
    const old: ReelTemplate = {
      ...rightBack,
      projectVersion: 1,
      layers: [{ ...t, content: { ...t.content, fontFamily: 'no-such-font' } } as Layer]
    }
    const m = migrateTemplate(old)
    expect((m.layers[0].content as { fontFamily: string }).fontFamily).not.toBe('no-such-font')
  })
})

describe('parseTemplateShare', () => {
  const share = {
    format: 'reel-template',
    version: 1,
    template: withFiles,
    files: { 'logo.png': 'AAA', 'sting.mp3': 'BBB', extra: 'CCC' }
  }

  it('returns the template and exactly the files it uses', () => {
    expect(parseTemplateShare(share)).toEqual({ template: withFiles, files: { 'logo.png': 'AAA', 'sting.mp3': 'BBB' } })
  })

  it('says why a file cannot be imported', () => {
    expect(parseTemplateShare({ ...share, format: 'x' })).toEqual({ error: "That file isn't a Reel Editor template." })
    expect(parseTemplateShare({ ...share, version: 99 })).toEqual({
      error: 'That template was made by a newer version of the editor.'
    })
    expect(parseTemplateShare({ ...share, template: { ...withFiles, layers: 'x' } })).toEqual({
      error: "That template is damaged or incomplete, so it can't be imported."
    })
    expect(parseTemplateShare({ ...share, files: { 'logo.png': 'AAA' } })).toEqual({
      error: 'That template is missing its file "sting.mp3".'
    })
  })
})

describe('summaries', () => {
  it('measures the length from the hold, layers and sounds', () => {
    expect(templateDuration(rightBack)).toBe(3)
    expect(templateDuration({ ...withFiles, layers: [image('i', 'x.png', 1, 6)] })).toBe(6)
    const sound = { ...withFiles.audio[0], clip: { ...withFiles.audio[0].clip, startSec: 2, inSec: 1, outSec: 9 } }
    expect(templateDuration({ ...withFiles, layers: [], audio: [sound] })).toBe(10)
    // A sound keeps its speed in a template: 8 s of source at 0.5× plays 16 s.
    const slow = { ...sound, clip: { ...sound.clip, speed: 0.5 } }
    expect(templateDuration({ ...withFiles, layers: [], audio: [slow] })).toBe(18)
  })

  it('previews at the moment the most layers are on screen', () => {
    const follow = BUILT_IN_TEMPLATES.find((t) => t.id === 'builtin-follow')!
    const at = templatePreviewTime(follow)
    expect(follow.layers.every((l) => l.startSec <= at && at < l.endSec)).toBe(true)
  })

  it('cleans names', () => {
    expect(cleanTemplateName('  a   b  ')).toBe('a b')
    expect(cleanTemplateName('   ')).toBeNull()
    expect(cleanTemplateName('x'.repeat(100))!.length).toBe(60)
  })
})
