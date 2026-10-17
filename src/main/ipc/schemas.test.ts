import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/project'
import { argsProblem, INVOKE_SCHEMAS, SEND_SCHEMAS } from './schemas'

const check = (name: keyof typeof INVOKE_SCHEMAS, ...args: unknown[]): string | null =>
  argsProblem(INVOKE_SCHEMAS[name], args)

describe('IPC argument schemas', () => {
  it('accepts the calls the renderer makes', () => {
    expect(check('getSettings')).toBeNull()
    expect(check('importPaths', ['C:\\clips\\a.mp4'])).toBeNull()
    expect(check('renameMedia', 'abc123', 'New name')).toBeNull()
    expect(check('setMediaDescription', 'abc123', '')).toBeNull()
    expect(check('quickCut', { mediaId: 'abc123', pieces: [{ inSec: 0, outSec: 2.5 }] })).toBeNull()
    expect(check('saveProject', createEmptyProject('p1', 'Test'))).toBeNull()
    expect(check('exportProject', createEmptyProject('p1', 'Test'), { preset: 'reel', preferNvenc: true })).toBeNull()
    expect(check('updateSettings', { brandColors: ['#FFFFFF'], assistant: { enabled: false } })).toBeNull()
    expect(
      check('renderAudioFx', {
        settings: { kind: 'echo', echo: { delayMs: 250, decay: 0.5, repeats: 3 } },
        sourceMediaId: 'abc123',
        inSec: 0,
        outSec: 4
      })
    ).toBeNull()
    expect(
      check('captureStillToDisk', { mediaId: 'abc123', sourceSec: 1.2, crop: null, color: null }, 'frame.png')
    ).toBeNull()
  })

  it('ignores extra trailing arguments, as before', () => {
    expect(check('getSettings', 'stray')).toBeNull()
    expect(check('ensureProxy', 'abc123', 'stray')).toBeNull()
  })

  it('refuses a missing or mistyped argument, naming it', () => {
    expect(check('ensureProxy')).toMatch(/argument 0/)
    expect(check('ensureProxy', '')).toMatch(/argument 0/)
    expect(check('renameMedia', 'abc123', 42)).toMatch(/argument 1/)
    expect(check('importPaths', 'C:\\clips\\a.mp4')).toMatch(/argument 0/)
    expect(check('quickCut', { mediaId: 'abc123', pieces: [{ inSec: '0', outSec: 2 }] })).toMatch(
      /argument 0\.pieces\.0\.inSec/
    )
  })

  it('refuses something that is not a project document', () => {
    expect(check('saveProject', { id: 'p1' })).toMatch(/not a project document/)
    expect(check('saveProject', null)).toMatch(/not a project document/)
  })

  it('keeps text out of the numbers an ffmpeg filter graph is built from', () => {
    expect(
      check('renderAudioFx', {
        settings: { kind: 'echo', echo: { delayMs: '250|evil', decay: 0.5, repeats: 3 } },
        sourceMediaId: 'abc123',
        inSec: 0,
        outSec: 4
      })
    ).toMatch(/delayMs/)
    expect(
      check('captureStillToLibrary', { mediaId: 'a', sourceSec: 1, crop: { x: 'x', y: 0, w: 1, h: 1 }, color: null })
    ).toMatch(/crop/)
    expect(
      check('renderAudioFx', { settings: { kind: 'flanger' }, sourceMediaId: 'a', inSec: 0, outSec: 1 })
    ).not.toBeNull()
  })

  it('takes only known settings, each with its type', () => {
    expect(check('updateSettings', { exportDir: 5 })).toMatch(/exportDir/)
    expect(check('updateSettings', { somethingElse: true })).not.toBeNull()
    expect(check('updateSettings', { assistant: { enabled: 'yes' } })).not.toBeNull()
  })

  it('takes only a real export preset', () => {
    expect(check('exportProject', createEmptyProject('p1', 'Test'), { preset: 'nope', preferNvenc: false })).toMatch(
      /preset/
    )
  })

  it('checks the assistant response message', () => {
    expect(argsProblem(SEND_SCHEMAS.assistantResponse, [{ id: 'r1', ok: true, result: { any: 1 } }])).toBeNull()
    expect(argsProblem(SEND_SCHEMAS.assistantResponse, [{ id: 'r1', ok: false, error: 'nope' }])).toBeNull()
    expect(argsProblem(SEND_SCHEMAS.assistantResponse, [{ id: 'r1', ok: false }])).not.toBeNull()
  })
})
