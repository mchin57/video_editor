import { afterEach, describe, expect, it } from 'vitest'
import { boolPref, enumPref, numberPref, objectPref, readPref, writePref } from './persisted'

afterEach(() => localStorage.clear())

describe('pref codecs', () => {
  it('boolPref: missing → fallback, else "1"/"0"', () => {
    expect(boolPref(true).decode(null)).toBe(true)
    expect(boolPref(false).decode(null)).toBe(false)
    expect(boolPref(true).decode('0')).toBe(false)
    expect(boolPref(false).decode('1')).toBe(true)
    expect(boolPref(true).encode(false)).toBe('0')
  })

  it('numberPref: only an in-range number is kept', () => {
    const pps = numberPref(48, 8, 240)
    expect(pps.decode(null)).toBe(48)
    expect(pps.decode('100')).toBe(100)
    expect(pps.decode('4')).toBe(48)
    expect(pps.decode('999')).toBe(48)
    expect(pps.decode('abc')).toBe(48)
    expect(pps.decode('')).toBe(48)
  })

  it('enumPref: only a listed value is kept', () => {
    const follow = enumPref(['none', 'page', 'centered'] as const, 'none')
    expect(follow.decode('page')).toBe('page')
    expect(follow.decode('sideways')).toBe('none')
    expect(follow.decode(null)).toBe('none')
  })

  it('objectPref: only a JSON object is kept', () => {
    const view = objectPref<Record<string, unknown>>(() => ({}))
    expect(view.decode('{"audio":{"rowH":30}}')).toEqual({ audio: { rowH: 30 } })
    expect(view.decode('not json')).toEqual({})
    expect(view.decode('[1,2]')).toEqual({})
    expect(view.decode('5')).toEqual({})
    expect(view.decode(null)).toEqual({})
  })
})

describe('readPref / writePref', () => {
  it('round-trips through localStorage', () => {
    const codec = numberPref(48, 8, 240)
    expect(readPref('k', codec)).toBe(48)
    writePref('k', codec, 120)
    expect(localStorage.getItem('k')).toBe('120')
    expect(readPref('k', codec)).toBe(120)
  })
})
