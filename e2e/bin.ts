/**
 * The staged engine binaries the specs synthesize media with — the same
 * `resources/bin` the app under test finds (`findDevBinDir`: this checkout's,
 * or the main checkout's when running in a git worktree, so a worktree needs
 * no junction to it). Every path is under `resources/bin` whether or not it is
 * staged; specs `test.skip(!existsSync(FFMPEG), …)` when it isn't.
 */

import { join, resolve } from 'node:path'
import { findDevBinDir } from '../src/main/devBinDir'

const root = resolve(__dirname, '..')
export const BIN_DIR = findDevBinDir(root) ?? join(root, 'resources', 'bin')
export const FFMPEG_DIR = join(BIN_DIR, 'ffmpeg')
export const FFMPEG = join(FFMPEG_DIR, 'ffmpeg.exe')
export const FFPROBE = join(FFMPEG_DIR, 'ffprobe.exe')
