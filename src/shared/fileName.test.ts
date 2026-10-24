import { describe, expect, it } from 'vitest'
import {
  BIDI_CONTROL_CHARS,
  BIDI_CONTROL_REASON,
  FILE_NAME_MAX,
  pathBaseName,
  splitFileName,
  validateFileStem
} from './fileName'

describe('splitFileName', () => {
  it('splits at the last dot, like path.extname', () => {
    expect(splitFileName('IMG_0010.MOV')).toEqual({ stem: 'IMG_0010', ext: '.MOV' })
    expect(splitFileName('clip (no bg 0.03–0.05).webm')).toEqual({ stem: 'clip (no bg 0.03–0.05)', ext: '.webm' })
    expect(splitFileName('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' })
  })

  it('a name without a dot, or with only a leading one, has no extension', () => {
    expect(splitFileName('README')).toEqual({ stem: 'README', ext: '' })
    expect(splitFileName('.hidden')).toEqual({ stem: '.hidden', ext: '' })
  })
})

describe('pathBaseName', () => {
  it('takes the last segment with either separator', () => {
    expect(pathBaseName('C:\\Reels\\footage\\IMG_1.MOV')).toBe('IMG_1.MOV')
    expect(pathBaseName('/home/u/clip.mp4')).toBe('clip.mp4')
    expect(pathBaseName('clip.mp4')).toBe('clip.mp4')
  })
})

describe('validateFileStem', () => {
  it('accepts ordinary names, judged after trimming', () => {
    for (const ok of ['Swim drill', 'IMG_0010', 'race (final)', 'café', '  padded  ', 'v1.2 cut', '.hidden']) {
      expect(validateFileStem(ok, '.mp4'), ok).toBeNull()
    }
  })

  it('rejects empty and whitespace-only names', () => {
    expect(validateFileStem('', '.mp4')).toMatch(/name/i)
    expect(validateFileStem('   ', '.mp4')).toMatch(/name/i)
  })

  it('rejects each forbidden character and control characters', () => {
    for (const c of ['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\u0000', '\u0007', '\u001f', '\n']) {
      expect(validateFileStem(`a${c}b`, '.mp4'), JSON.stringify(c)).not.toBeNull()
    }
  })

  it('rejects a trailing dot; a trailing space is trimmed away, never refused', () => {
    expect(validateFileStem('clip.', '.mp4')).toMatch(/dot/)
    expect(validateFileStem('clip.', '')).toMatch(/dot/)
    expect(validateFileStem('clip ', '.mp4')).toBeNull()
  })

  it('rejects reserved device names, any case, alone or with the extension', () => {
    for (const bad of ['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'nul.backup', ' aux ']) {
      expect(validateFileStem(bad, '.mp4'), bad).toMatch(/reserved/)
    }
    expect(validateFileStem('CON', '')).toMatch(/reserved/)
    expect(validateFileStem('console', '.mp4')).toBeNull()
    expect(validateFileStem('COM10', '.mp4')).toBeNull()
  })

  it('caps the whole name (stem + extension) at the NTFS component limit', () => {
    const fits = 'a'.repeat(FILE_NAME_MAX - 4)
    expect(validateFileStem(fits, '.mp4')).toBeNull()
    expect(validateFileStem(`${fits}a`, '.mp4')).toMatch(String(FILE_NAME_MAX - 4))
    expect(validateFileStem('a'.repeat(FILE_NAME_MAX), '')).toBeNull()
  })
})

describe('validateFileStem: bidi controls (#11)', () => {
  it('rejects a right-to-left override that would disguise the extension', () => {
    expect(validateFileStem(`clip${String.fromCharCode(0x202e)}4pm`, '.mp4')).toBe(BIDI_CONTROL_REASON)
    expect(BIDI_CONTROL_CHARS.test(String.fromCharCode(0x2066))).toBe(true)
    expect(validateFileStem('clip', '.mp4')).toBeNull()
  })
})
