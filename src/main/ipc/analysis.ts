/** IPC: work on a clip's content — transcripts, silence, loudness, audio
 *  effects, background removal — and cancelling the jobs that run it. */

import { getTranscript, transcribeMedia, whisperAvailable } from '../services/whisper'
import { detectSilence } from '../services/silence'
import { ensureLoudness } from '../services/loudness'
import { removeBackgroundToLibrary, segmentAvailable } from '../services/removeBackground'
import { renderAudioFxToLibrary, requireUsable } from '../services/mediaStore'
import { cancelJob } from '../services/jobs'
import { handle } from './handle'

export function registerAnalysisHandlers(): void {
  handle('whisperAvailable', () => whisperAvailable())
  handle('transcribeMedia', (_event, mediaId) => transcribeMedia(mediaId))
  handle('getTranscript', (_event, mediaId) => getTranscript(mediaId))

  // The asset's loudness series, measured now if the cache lacks it (null = no
  // audio, original missing, or the measurement failed). @see shared/loudness.ts
  handle('getLoudness', (_event, mediaId) => ensureLoudness(mediaId))

  handle('detectSilence', async (_event, mediaId) => {
    const asset = await requireUsable(mediaId)
    return detectSilence(asset.originalPath, asset.probe.durationSec)
  })

  handle('renderAudioFx', (_event, req) =>
    renderAudioFxToLibrary(req.settings, req.sourceMediaId, req.inSec, req.outSec)
  )

  // Background removal: matte one clip segment into a new transparent library
  // asset (null = the job was canceled).
  handle('segmentAvailable', () => segmentAvailable())
  handle('removeBackground', (_event, req) => removeBackgroundToLibrary(req))
  // Ask a cancelable background job to stop (false = nothing to cancel).
  handle('cancelJob', (_event, jobId) => cancelJob(jobId))
}
