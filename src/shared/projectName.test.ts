import { describe, expect, it } from 'vitest'
import { PROJECT_NAME_MAX, validateProjectName } from './projectName'

describe('validateProjectName', () => {
  it('accepts ordinary names, judged after trimming', () => {
    for (const ok of [
      'My Reel',
      'reel-01',
      'Trip (2026)',
      'café',
      '  padded  ',
      'v1.2 final',
      'a'.repeat(PROJECT_NAME_MAX)
    ]) {
      expect(validateProjectName(ok), ok).toBeNull()
    }
  })

  it('rejects empty and whitespace-only names', () => {
    expect(validateProjectName('')).toMatch(/name/i)
    expect(validateProjectName('   \t')).toMatch(/name/i)
  })

  it('rejects names longer than the maximum (surrounding whitespace does not count)', () => {
    expect(validateProjectName('a'.repeat(PROJECT_NAME_MAX + 1))).not.toBeNull()
    expect(validateProjectName(` ${'a'.repeat(PROJECT_NAME_MAX)} `)).toBeNull()
  })

  it('rejects each forbidden character and control characters', () => {
    for (const c of ['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\u0000', '\u0007', '\u001f', '\n']) {
      expect(validateProjectName(`a${c}b`), JSON.stringify(c)).not.toBeNull()
    }
  })

  it('rejects a trailing dot (after trimming), allows inner and leading dots', () => {
    expect(validateProjectName('reel.')).not.toBeNull()
    expect(validateProjectName('reel. ')).not.toBeNull()
    expect(validateProjectName('...')).not.toBeNull()
    expect(validateProjectName('re.el')).toBeNull()
    expect(validateProjectName('.reel')).toBeNull()
  })

  it('rejects reserved device names, any case, with or without an extension', () => {
    for (const bad of [
      'CON',
      'con',
      'Prn',
      'AUX',
      'nul',
      'COM1',
      'com9',
      'LPT1',
      'lpt9',
      'con.txt',
      'NUL.tar.gz',
      ' aux '
    ]) {
      expect(validateProjectName(bad), bad).not.toBeNull()
    }
  })

  it('allows names that merely contain or extend a device name', () => {
    for (const ok of ['console', 'CON2', 'COM0', 'COM10', 'LPT', 'nullify', 'my con', 'aux-reel']) {
      expect(validateProjectName(ok), ok).toBeNull()
    }
  })
})
