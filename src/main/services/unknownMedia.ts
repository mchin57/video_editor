/**
 * Placeholder records for clips a document uses but nothing describes — e.g.
 * an old project converted while the old shared library was missing. Without
 * a record a clip has no library card, so it could never be relinked; with one
 * it shows as **Missing — unknown clip** and Relink fills it in. Pure.
 * docs/MEDIA-POINTERS.md "Unknown clips".
 */

import type { MediaRecord, ProbeInfo } from '@shared/media'
import { UNKNOWN_CLIP_NAME } from '@shared/media'
import { mediaUses, type Project } from '@shared/project'
import { UNKNOWN_FINGERPRINT } from './fingerprint'

/** Sorts after every real import (the library lists newest first). */
const LONG_AGO = new Date(0).toISOString()

/**
 * One placeholder per media id `doc` uses that `known` has no record of. Its
 * kind and length come from how the timeline uses it: any video use makes it a
 * video, else an image, else audio; the length is the furthest source second
 * played (0 when no use says). The empty `absolutePath` marks it as unknown
 * (see `isUnknownClip`); `UNKNOWN_FINGERPRINT` keeps it Missing until Relink.
 */
export function unknownRecords(
  doc: Pick<Project, 'layers' | 'audioClips'>,
  known: (id: string) => boolean
): MediaRecord[] {
  const byId = new Map<string, { video: boolean; image: boolean; audio: boolean; outSec: number }>()
  for (const use of mediaUses(doc)) {
    if (known(use.mediaId)) continue
    const u = byId.get(use.mediaId) ?? { video: false, image: false, audio: false, outSec: 0 }
    u[use.as] = true
    u.outSec = Math.max(u.outSec, use.outSec)
    byId.set(use.mediaId, u)
  }
  return [...byId].map(([id, u]) => {
    const kind = u.video ? 'video' : u.image ? 'image' : 'audio'
    const probe: ProbeInfo = {
      durationSec: u.outSec,
      container: 'unknown',
      video:
        kind === 'audio'
          ? null
          : {
              codec: 'unknown',
              width: 1080,
              height: 1920,
              displayWidth: 1080,
              displayHeight: 1920,
              rotationDeg: 0,
              avgFps: 30,
              rFps: 30,
              isVfr: false,
              pixFmt: 'unknown',
              colorTransfer: null,
              colorPrimaries: null,
              colorSpace: null,
              isHdr: false
            },
      audio: u.audio || kind === 'audio' ? { codec: 'unknown', sampleRate: 48000, channels: 2 } : null
    }
    return {
      id,
      fileName: UNKNOWN_CLIP_NAME,
      relativePath: null,
      absolutePath: '',
      fingerprint: UNKNOWN_FINGERPRINT,
      importedAt: LONG_AGO,
      probe,
      kind
    }
  })
}
