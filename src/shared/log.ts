/**
 * Logging for the main process and the renderer alike. `createLogger(scope)`
 * gives `debug` / `info` / `warn` / `error`, each taking a message and,
 * optionally, the error behind it; every entry goes to ONE sink — by default
 * the console, as `[scope] message` (+ the error). `setLogSink` swaps the sink
 * (tests capture entries; main could add a file).
 *
 * `bestEffort` is for steps whose failure must not fail the caller — removing
 * a temp or partial file, a background analysis — but must not vanish either:
 * the failure is logged at `warn` and swallowed. An empty `catch {}` hides
 * exactly the clue you need when something later looks wrong.
 *
 * Not for expected outcomes: a missing file read as "none", an autoplay
 * `play()` rejection, a parse fallback — those stay plain control flow.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  level: LogLevel
  /** Which part of the app (`export`, `media`, `assistant`, …). */
  scope: string
  message: string
  /** The error behind the entry, when there is one. */
  error?: unknown
}

export type LogSink = (entry: LogEntry) => void

export interface Logger {
  debug: (message: string, error?: unknown) => void
  info: (message: string, error?: unknown) => void
  warn: (message: string, error?: unknown) => void
  error: (message: string, error?: unknown) => void
}

const CONSOLE: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: (...a) => console.debug(...a),
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a)
}

/** The default sink: the console, `[scope] message` then the error if any. */
export const consoleSink: LogSink = (e) => {
  const line = `[${e.scope}] ${e.message}`
  if (e.error === undefined) CONSOLE[e.level](line)
  else CONSOLE[e.level](line, e.error)
}

let sink: LogSink = consoleSink

/** Route every logger's entries to `next` (null restores the console). */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? consoleSink
}

export function createLogger(scope: string): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, error?: unknown): void =>
      sink({ level, scope, message, ...(error === undefined ? {} : { error }) })
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

/** Run a step that may fail without failing the caller: a failure is logged
 *  at `warn` ("<what> failed") and swallowed. Resolves either way. */
export async function bestEffort(step: Promise<unknown>, what: string, log: Logger): Promise<void> {
  try {
    await step
  } catch (error) {
    log.warn(`${what} failed`, error)
  }
}
