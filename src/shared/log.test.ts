import { afterEach, describe, expect, it, vi } from 'vitest'
import { bestEffort, consoleSink, createLogger, setLogSink, type LogEntry } from './log'

afterEach(() => setLogSink(null))

const capture = (): LogEntry[] => {
  const entries: LogEntry[] = []
  setLogSink((e) => entries.push(e))
  return entries
}

describe('createLogger', () => {
  it('tags each entry with its scope and level, and keeps the error', () => {
    const entries = capture()
    const log = createLogger('export')
    const err = new Error('disk full')
    log.info('started')
    log.warn('layout pass failed', err)
    expect(entries).toEqual([
      { level: 'info', scope: 'export', message: 'started' },
      { level: 'warn', scope: 'export', message: 'layout pass failed', error: err }
    ])
  })

  it('writes to the console as "[scope] message" by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = new Error('x')
    consoleSink({ level: 'warn', scope: 'media', message: 'thumb failed', error: err })
    consoleSink({ level: 'warn', scope: 'media', message: 'no error' })
    expect(warn.mock.calls).toEqual([['[media] thumb failed', err], ['[media] no error']])
    warn.mockRestore()
  })
})

describe('bestEffort', () => {
  it('a failure is logged at warn and swallowed', async () => {
    const entries = capture()
    const err = new Error('EBUSY')
    await expect(bestEffort(Promise.reject(err), 'remove temp folder', createLogger('export'))).resolves.toBe(undefined)
    expect(entries).toEqual([{ level: 'warn', scope: 'export', message: 'remove temp folder failed', error: err }])
  })

  it('a success logs nothing', async () => {
    const entries = capture()
    await bestEffort(Promise.resolve('ok'), 'anything', createLogger('x'))
    expect(entries).toEqual([])
  })
})
