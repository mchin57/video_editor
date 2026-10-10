import { describe, expect, it } from 'vitest'
import { LineDecoder, defaultPipePath, encodeLine } from './pipeProtocol'

describe('LineDecoder', () => {
  it('returns whole messages across split chunks', () => {
    const d = new LineDecoder()
    expect(d.push('{"a":')).toEqual([])
    expect(d.push('1}\n{"b"')).toEqual([{ a: 1 }])
    expect(d.push(':2}\n')).toEqual([{ b: 2 }])
  })

  it('returns several messages from one chunk and skips blank lines', () => {
    expect(new LineDecoder().push('{"a":1}\n\n{"a":2}\r\n')).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('round-trips encodeLine, including newlines inside strings', () => {
    const msg = { text: 'two\nlines', n: 3 }
    expect(new LineDecoder().push(encodeLine(msg))).toEqual([msg])
  })
})

describe('defaultPipePath', () => {
  it('is a named pipe on Windows and a socket file elsewhere', () => {
    expect(defaultPipePath('win32', 'C:\\Temp')).toBe('\\\\.\\pipe\\reel-editor')
    expect(defaultPipePath('linux', '/tmp/')).toBe('/tmp/reel-editor.sock')
  })
})
