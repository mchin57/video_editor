/**
 * Custom `reelmedia://` scheme so the renderer's <video>/<img> can read media
 * from the data dir. Crucially this handles HTTP **range requests** itself:
 * net.fetch over file:// does not, which leaves <video> unable to seek to an
 * un-buffered position (scrubbing forward appears to do nothing). Serving 206
 * partial responses makes the proxy fully seekable.
 *
 * Responses carry `Access-Control-Allow-Origin: *`. This scheme is a different
 * origin from the renderer page, and the preview's WebAudio gain path
 * (`renderer/lib/mediaGain.ts`) needs CORS-clean media: routing a TAINTED
 * element through `createMediaElementSource` yields silence rather than an
 * error. The elements set `crossOrigin="anonymous"` to match. Media never
 * leaves the app, so the wildcard grants nothing a local file read would not.
 *
 * URL shape: reelmedia://<mediaId>/<file>  e.g. reelmedia://ab12cd34ef56/proxy.mp4
 */

import { protocol } from 'electron'
import { createReadStream, promises as fsp } from 'node:fs'
import { join, normalize, sep, extname } from 'node:path'
import { Readable } from 'node:stream'
import { getSubdir, getBundledFontsDir } from './config'

export const MEDIA_SCHEME = 'reelmedia'

/** Reserved hostname that serves bundled font files (resources/fonts) for the
 *  renderer's `@font-face` rules. Media ids are hex hashes, so it never collides. */
export const FONTS_HOST = 'fonts'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/** Must run before app 'ready'. */
export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true }
    }
  ])
}

function webStream(nodeStream: NodeJS.ReadableStream): ReadableStream {
  // Readable.toWeb returns a web ReadableStream the Response constructor accepts.
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream
}

/** Must run after app 'ready'. */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const id = url.hostname
    const file = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    // Bundled fonts live outside the per-media store; serve them from their dir.
    const assetRoot =
      id === FONTS_HOST
        ? normalize(getBundledFontsDir() ?? join(getSubdir('media'), id))
        : normalize(join(getSubdir('media'), id))
    const target = normalize(join(assetRoot, file))

    // Path-traversal guard: target must stay within this asset's folder.
    if (target !== assetRoot && !target.startsWith(assetRoot + sep)) {
      return new Response('Forbidden', { status: 403 })
    }

    let size: number
    try {
      size = (await fsp.stat(target)).size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const contentType = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
    const rangeHeader = request.headers.get('Range')
    const match = rangeHeader ? /bytes=(\d+)-(\d*)/.exec(rangeHeader) : null

    if (match) {
      const start = Number(match[1])
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
      if (start >= size || start > end) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` }
        })
      }
      return new Response(webStream(createReadStream(target, { start, end })), {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Content-Length': String(end - start + 1)
        }
      })
    }

    return new Response(webStream(createReadStream(target)), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': String(size)
      }
    })
  })
}
