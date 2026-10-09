import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'

// whisper imports ../config which imports electron; stub it so the module loads.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { runWhisper } from './whisper'

describe('runWhisper', () => {
  // `-ml 1` + `-dtw` makes whisper-cli re-print every earlier word segment as
  // each new one lands, so stdout grows quadratically (~130 KB for an 80-word
  // clip). An undrained stdout pipe fills and the child blocks forever at 0% CPU.
  it('does not hang when the child floods stdout', async () => {
    const flood = "process.stdout.write('x'.repeat(4e6))"
    await expect(runWhisper(process.execPath, ['-e', flood])).resolves.toBeUndefined()
  }, 15_000)

  it('rejects with the stderr tail on a non-zero exit', async () => {
    const fail = "process.stderr.write('model not found'); process.exit(3)"
    await expect(runWhisper(process.execPath, ['-e', fail])).rejects.toThrow(/exited 3: model not found/)
  })
})
