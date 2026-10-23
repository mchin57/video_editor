/**
 * ONNX models in main: finding them on disk, loading onnxruntime-node lazily,
 * and one cached inference session per model + device — DirectML on the GPU
 * where it works, else the CPU. Shared by every model job (background matte,
 * pose detection) so the load/fallback rules exist once.
 *
 * Models are found like whisper's: the bundled models dir (installer) first,
 * then `<data>/bin/models` (user-provided).
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getBundledModelsDir, getSubdir } from '../config'
import { createLogger } from '@shared/log'

const log = createLogger('onnx')

export type OrtModule = typeof import('onnxruntime-node')
export type OrtTensor = import('onnxruntime-node').Tensor
export type OrtSession = import('onnxruntime-node').InferenceSession
export type OrtOutputs = Awaited<ReturnType<OrtSession['run']>>

/** Where inference runs. GPU = DirectML (any D3D12 GPU on Windows — it ships
 *  inside onnxruntime-node's win32 binaries, so it costs no installer size). */
export type InferenceDevice = 'gpu' | 'cpu'

/** Model search roots, bundled (installer) first, then the user data dir. */
export function modelDirs(): string[] {
  const dirs: string[] = []
  const bundled = getBundledModelsDir()
  if (bundled) dirs.push(bundled)
  dirs.push(join(getSubdir('bin'), 'models'))
  return dirs
}

/** Every `.onnx` file in the model dirs, as `[dir, file]`, bundled first. */
export function onnxFiles(): [string, string][] {
  const out: [string, string][] = []
  for (const dir of modelDirs()) {
    if (!existsSync(dir)) continue
    try {
      for (const f of readdirSync(dir)) if (f.toLowerCase().endsWith('.onnx')) out.push([dir, f])
    } catch {
      continue
    }
  }
  return out
}

/** The first model whose (lower-cased) file name starts with `prefix`. */
export function findModel(prefix: string): string | null {
  const hit = onnxFiles().find(([, f]) => f.toLowerCase().startsWith(prefix))
  return hit ? join(hit[0], hit[1]) : null
}

// onnxruntime-node is a native module, loaded lazily so a load failure (an
// Electron ABI mismatch, a missing DLL) can't crash main at import.
let ortMod: OrtModule | null = null
const sessions = new Map<string, Promise<OrtSession>>()
/** Models whose GPU session was created but could not actually run: later
 *  jobs go straight to the CPU instead of failing over again. */
const gpuUnusable = new Set<string>()

export async function loadOrt(): Promise<OrtModule> {
  if (!ortMod) ortMod = await import('onnxruntime-node')
  return ortMod
}

/** Whether onnxruntime-node loads at all — a feature gate, so the UI can hide
 *  a model feature rather than fail at click time (and say why in the log). */
export async function ortLoads(feature: string): Promise<boolean> {
  try {
    await loadOrt()
    return true
  } catch (error) {
    log.warn(`onnxruntime-node did not load; ${feature} is unavailable`, error)
    return false
  }
}

export function getSession(ort: OrtModule, modelPath: string, device: InferenceDevice): Promise<OrtSession> {
  const key = `${device}:${modelPath}`
  let s = sessions.get(key)
  if (!s) {
    s =
      device === 'gpu'
        ? // DirectML supports neither memory patterns nor parallel execution;
          // onnxruntime's docs require both off for the DML provider.
          ort.InferenceSession.create(modelPath, {
            executionProviders: ['dml'],
            enableMemPattern: false,
            executionMode: 'sequential'
          })
        : ort.InferenceSession.create(modelPath)
    // Don't cache a failure — the next job should get to try again.
    s.catch(() => sessions.delete(key))
    sessions.set(key, s)
  }
  return s
}

/** The GPU session when this machine can create one, else the CPU session. */
export async function bestSession(
  ort: OrtModule,
  modelPath: string
): Promise<{ session: OrtSession; device: InferenceDevice }> {
  if (process.platform === 'win32' && !gpuUnusable.has(modelPath)) {
    try {
      return { session: await getSession(ort, modelPath, 'gpu'), device: 'gpu' }
    } catch (err) {
      log.warn('DirectML unavailable, using the CPU', err)
    }
  }
  return { session: await getSession(ort, modelPath, 'cpu'), device: 'cpu' }
}

/** A GPU session that loaded but failed to run: remember it, and hand back the
 *  model's CPU session for the retry. */
export async function fallBackToCpu(ort: OrtModule, modelPath: string, err: unknown): Promise<OrtSession> {
  log.warn('GPU inference failed, retrying on the CPU', err)
  gpuUnusable.add(modelPath)
  return getSession(ort, modelPath, 'cpu')
}
