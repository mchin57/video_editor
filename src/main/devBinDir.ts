import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * The dev checkout's staged engine binaries (`npm run collect-binaries` →
 * `resources/bin/{ffmpeg,whisper}`), looked up from a checkout root.
 *
 * `resources/bin` is gitignored (~1 GB), so a `git worktree` doesn't have one.
 * Rather than linking it in (a directory junction that `git worktree remove`
 * follows, wiping the main checkout's ffmpeg), a linked worktree falls back to
 * its MAIN checkout's `resources/bin`, found through git's own pointers:
 * `<wt>/.git` is a file `gitdir: <main>/.git/worktrees/<name>`, whose
 * `commondir` names `<main>/.git`. Nothing is created inside the worktree, so
 * deleting it can't reach the binaries. Pure fs, no electron: the main process
 * (`getBundledBinDir`) and the e2e specs (`e2e/bin.ts`) both use it.
 */
export function findDevBinDir(checkoutRoot: string): string | null {
  for (const root of [checkoutRoot, mainCheckoutOf(checkoutRoot)]) {
    if (!root) continue
    const dir = join(root, 'resources', 'bin')
    if (existsSync(dir)) return dir
  }
  return null
}

/** The main checkout a linked worktree belongs to; null for anything else. */
export function mainCheckoutOf(checkoutRoot: string): string | null {
  try {
    const dotGit = join(checkoutRoot, '.git')
    if (!statSync(dotGit).isFile()) return null // a main checkout has a .git DIRECTORY
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
    if (!m) return null
    const gitDir = resolve(checkoutRoot, m[1])
    const commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
    // A bare common dir has no working tree to hold resources/bin.
    return basename(commonDir) === '.git' ? dirname(commonDir) : null
  } catch {
    return null
  }
}
