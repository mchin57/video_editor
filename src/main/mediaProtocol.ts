/**
 * Custom `reelmedia://` scheme so the renderer's <video>/<img> can read media
 * from the open project's cache/. Crucially this handles HTTP **range requests** itself:
 * net.fetch over file:// does not, which leaves <video> unable to seek to an
 * un-buffered position (scrubbing forward appears to do nothing). Serving 206
 * partial responses makes the proxy fully seekable.
 *
 * URL shape: reelmedia://<mediaId>/<file>  e.g. reelmedia://ab12cd34ef56/proxy.mp4
 */

import { protocol } from 'electron'
import { createReadStream, promises as fsp } from 'node:fs'
import { join, normalize, sep, extname } from 'node:path'
import { Readable } from 'node:stream'
import { getBundledFontsDir } from './config'
import { getProjectRoot } from './services/projectRoot'
import { cacheDir } from './services/projectLayout'

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
      // `corsEnabled` is what lets the renderer's `@font-face` rules read
      // reelmedia:// at all. CSS font fetches are ALWAYS CORS-mode, and without
      // this privilege Chromium rejects the scheme outright ("Cross origin
      // requests are only supported for protocol schemes: chrome, …, https"),
      // so every bundled font silently fell back to a system face and the
      // preview stopped matching what libass burns into the export. It also
      // obliges the handler to send `Access-Control-Allow-Origin` (see CORS).
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true
      }
    }
  ])
}

/**
 * Now that the scheme is `corsEnabled`, every response has to opt in explicitly
 * or the fetch is blocked. The renderer is the only consumer (and the handler
 * already refuses to escape the asset dir), so `*` is the whole policy.
 * `Range` must be allow-listed too, or the <video> seek preflight fails.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
} as const

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
    // Bundled fonts live outside the project; serve them from their dir. Media
    // is served from the OPEN project's cache/<id> (its derived files only —
    // the protocol never hands out originals).
    let base: string | null
    try {
      base = id === FONTS_HOST ? getBundledFontsDir() : cacheDir(getProjectRoot(), id)
    } catch {
      base = null // no project open yet
    }
    if (!base) return new Response('Not found', { status: 404, headers: { ...CORS_HEADERS } })
    const assetRoot = normalize(base)
    const target = normalize(join(assetRoot, file))

    // Path-traversal guard: target must stay within this asset's folder.
    if (target !== assetRoot && !target.startsWith(assetRoot + sep)) {
      return new Response('Forbidden', { status: 403, headers: { ...CORS_HEADERS } })
    }

    let size: number
    try {
      size = (await fsp.stat(target)).size
    } catch {
      return new Response('Not found', { status: 404, headers: { ...CORS_HEADERS } })
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
          headers: { ...CORS_HEADERS, 'Content-Range': `bytes */${size}` }
        })
      }
      return new Response(webStream(createReadStream(target, { start, end })), {
        status: 206,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1)
        }
      })
    }

    return new Response(webStream(createReadStream(target)), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size)
      }
    })
  })
}
