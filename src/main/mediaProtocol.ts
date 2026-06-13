/**
 * Custom `reelmedia://` scheme so the renderer's <video>/<img> can read media
 * from the data dir. Crucially this handles HTTP **range requests** itself:
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
import { getSubdir } from './config'

export const MEDIA_SCHEME = 'reelmedia'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
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
    const root = getSubdir('media')
    const assetRoot = normalize(join(root, id))
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
          'Content-Length': String(end - start + 1)
        }
      })
    }

    return new Response(webStream(createReadStream(target)), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size)
      }
    })
  })
}
