/**
 * Custom `reelmedia://` scheme so the renderer's <video> can stream proxy files
 * from the data dir with proper HTTP range support (net.fetch over file://).
 * URL shape: reelmedia://<mediaId>/<file>  e.g. reelmedia://ab12cd34ef56/proxy.mp4
 */

import { net, protocol } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getSubdir } from './config'

export const MEDIA_SCHEME = 'reelmedia'

/** Must run before app 'ready'. */
export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true }
    }
  ])
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
    return net.fetch(pathToFileURL(target).toString())
  })
}
