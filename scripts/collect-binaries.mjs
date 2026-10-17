// Stage the engine binaries that electron-builder bundles into the installer.
// Run before `npm run build:win` (build:win does this automatically).
//
// On a clean machine the app has no ffmpeg or whisper.cpp, so the installer
// ships them as extraResources. This copies them from where they live on the
// dev machine into resources/bin/{ffmpeg,whisper}/ (gitignored, ~1 GB):
//
//   ffmpeg.exe + ffprobe.exe  <- winget Gyan.FFmpeg full build   (or $FFMPEG_SRC)
//   whisper-cli.exe + *.dll   <- Documents\VideoEditor\bin\whisper\Release (or $WHISPER_SRC)
//   ggml-*.bin (model)        <- Documents\VideoEditor\bin\whisper          (or $WHISPER_MODEL)
//
// Discovery mirrors the app's runtime logic. Idempotent: skips files already
// staged at the same size unless you pass --force.

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const force = process.argv.includes('--force')
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function copyInto(src, destDir) {
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, basename(src))
  if (!force && existsSync(dest) && statSync(dest).size === statSync(src).size) {
    console.log(`  = ${basename(src)} (up to date)`)
    return
  }
  copyFileSync(src, dest)
  console.log(`  → ${basename(src)} (${(statSync(dest).size / 1e6).toFixed(0)} MB)`)
}

// --- ffmpeg / ffprobe -------------------------------------------------------
function findFfmpegBinDir() {
  if (process.env.FFMPEG_SRC) return process.env.FFMPEG_SRC
  const pkgRoot = join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
  if (!existsSync(pkgRoot)) return null
  const pkg = readdirSync(pkgRoot).find((d) => d.toLowerCase().startsWith('gyan.ffmpeg'))
  if (!pkg) return null
  const inner = readdirSync(join(pkgRoot, pkg)).find((x) => x.toLowerCase().startsWith('ffmpeg-'))
  return inner ? join(pkgRoot, pkg, inner, 'bin') : null
}

console.log('• ffmpeg / ffprobe')
const ffDir = findFfmpegBinDir()
if (!ffDir) die('ffmpeg not found (winget Gyan.FFmpeg). Set FFMPEG_SRC to its bin/ dir.')
for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
  const src = join(ffDir, exe)
  if (!existsSync(src)) die(`missing ${exe} in ${ffDir}`)
  copyInto(src, join(root, 'resources', 'bin', 'ffmpeg'))
}

// --- whisper.cpp: cli + dlls + model ---------------------------------------
console.log('• whisper.cpp (cli + dlls + model)')
const whisperRoot = process.env.WHISPER_SRC ?? join(HOME, 'Documents', 'VideoEditor', 'bin', 'whisper')
if (!existsSync(whisperRoot)) die(`whisper dir not found: ${whisperRoot}. Set WHISPER_SRC.`)

const cliDir = ['Release', 'bin', join('build', 'bin'), '.']
  .map((s) => join(whisperRoot, s))
  .find((d) => existsSync(join(d, 'whisper-cli.exe')))
if (!cliDir) die(`whisper-cli.exe not found under ${whisperRoot}`)

const destWhisper = join(root, 'resources', 'bin', 'whisper')
copyInto(join(cliDir, 'whisper-cli.exe'), destWhisper)
// Bundle every DLL next to the exe so Windows can resolve them at runtime.
for (const f of readdirSync(cliDir).filter((f) => f.toLowerCase().endsWith('.dll'))) {
  copyInto(join(cliDir, f), destWhisper)
}

const modelSrc =
  process.env.WHISPER_MODEL ??
  [whisperRoot, cliDir]
    .filter((d) => existsSync(d))
    .flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.toLowerCase().endsWith('.bin'))
        .map((f) => join(d, f))
    )[0]
if (!modelSrc || !existsSync(modelSrc)) die('whisper model (*.bin) not found. Set WHISPER_MODEL.')
copyInto(modelSrc, destWhisper)

// --- background-removal model (RVM ONNX) -----------------------------------
// Optional: the "Remove background" feature is gated on the model being present,
// so a build without it just leaves the feature unavailable. The resources/models
// dir is always created so electron-builder's extraResources `from` path exists.
console.log('• background-removal model (RVM ONNX)')
const destModels = join(root, 'resources', 'models')
mkdirSync(destModels, { recursive: true })
const matteModelSrc =
  process.env.MATTE_MODEL ??
  (() => {
    const dir = join(HOME, 'Documents', 'VideoEditor', 'bin', 'models')
    if (!existsSync(dir)) return null
    const onnx = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.onnx'))
    return onnx ? join(dir, onnx) : null
  })()
if (!matteModelSrc || !existsSync(matteModelSrc)) {
  console.log('  ! no RVM .onnx found (set MATTE_MODEL or place one in <data>/bin/models) — skipping')
} else {
  copyInto(matteModelSrc, destModels)
}

console.log('✓ binaries staged in resources/bin/')
