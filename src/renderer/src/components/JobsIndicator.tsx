import { useEffect, useRef, useState, type JSX } from 'react'
import type { JobProgressEvent } from '@shared/jobs'
import { formatEta, isJobActive, jobEtaSec } from '@shared/jobs'
import { cancelJob } from '@/ipc/client'
import { useEditor } from '@/state/store'

/** A clock that ticks every `ms` while `active` (ETA labels), idle otherwise. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}

/** "42% · 1m 5s left" — percent plus a linear ETA once there is enough signal. */
export function jobProgressText(job: JobProgressEvent, now: number): string {
  const pct = `${Math.round(job.progress * 100)}%`
  const eta = jobEtaSec(job.progress, job.startedAt, now)
  return eta === null ? pct : `${pct} · ${formatEta(eta)} left`
}

/**
 * Cancel control for one job. Cancel is a request: the job stops, kills what it
 * spawned and cleans up in main, then reports `canceled` — so between the click
 * and that event the button reads "Canceling…".
 */
export function CancelJobButton({
  job,
  className = ''
}: {
  job: JobProgressEvent
  className?: string
}): JSX.Element | null {
  const [requested, setRequested] = useState(false)
  if (!job.cancelable || !isJobActive(job.status)) return null
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        setRequested(true)
        void cancelJob(job.id).then((ok) => {
          if (!ok) setRequested(false)
        })
      }}
      disabled={requested}
      aria-label={`Cancel ${job.label}`}
      className={`rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-rose-500/30 hover:text-rose-200 disabled:opacity-50 ${className}`}
    >
      {requested ? 'Canceling…' : 'Cancel'}
    </button>
  )
}

function ProgressBar({ value }: { value: number }): JSX.Element {
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-white/10">
      <div
        className="h-full bg-sky-400 transition-[width]"
        style={{ width: `${Math.round(Math.min(1, value) * 100)}%` }}
      />
    </div>
  )
}

/**
 * Always-visible background-job status (header, next to Project settings).
 * Reads the ONE jobs map every job surface shares (`useEditor().jobs`), so
 * proxies, captions, audio renders, exports and background removal all show up
 * here while they run — even after the panel that started one has closed. One
 * running job shows inline (name, percent/ETA, Cancel when it supports it);
 * several collapse to a count that opens the full list. Failures stay listed
 * until dismissed. Renders nothing when there is nothing to report.
 */
export function JobsIndicator(): JSX.Element | null {
  const jobs = useEditor((s) => s.jobs)
  const dismissJob = useEditor((s) => s.dismissJob)
  const all = Object.values(jobs)
  const active = all.filter((j) => isJobActive(j.status))
  const failed = all.filter((j) => j.status === 'error')
  const now = useNow(active.length > 0)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (active.length === 0 && failed.length === 0) return null

  const single = active.length === 1 ? active[0] : null
  const overall = active.length ? active.reduce((sum, j) => sum + j.progress, 0) / active.length : 0
  const summary = single
    ? `${single.label} · ${jobProgressText(single, now)}`
    : active.length > 1
      ? `${active.length} jobs running · ${Math.round(overall * 100)}%`
      : `⚠ ${failed.length} job${failed.length > 1 ? 's' : ''} failed`

  return (
    <div ref={ref} className="relative min-w-0" data-testid="jobs-indicator">
      <div
        className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-0.5 text-xs ${
          active.length ? 'bg-sky-500/15 text-sky-200' : 'bg-rose-500/15 text-rose-200'
        }`}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 max-w-[340px] flex-col gap-0.5 text-left"
          title={summary}
        >
          <span className="flex items-center gap-1.5">
            {active.length > 0 && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-300" />}
            <span className="truncate">{summary}</span>
            <span className="shrink-0 text-[10px] opacity-70">▾</span>
          </span>
          {active.length > 0 && <ProgressBar value={overall} />}
        </button>
        {single && <CancelJobButton job={single} />}
      </div>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-96 rounded-lg border border-white/10 bg-zinc-900 p-2 shadow-2xl">
          {all
            .filter((j) => isJobActive(j.status) || j.status === 'error')
            .map((j) => (
              <div key={j.id} data-testid="job-row" className="rounded px-2 py-1.5 hover:bg-white/5">
                <div className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-zinc-200" title={j.label}>
                    {j.label}
                  </span>
                  {isJobActive(j.status) ? (
                    <>
                      <span className="shrink-0 text-[10px] text-zinc-400">{jobProgressText(j, now)}</span>
                      <CancelJobButton job={j} />
                    </>
                  ) : (
                    <button
                      onClick={() => dismissJob(j.id)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
                {isJobActive(j.status) ? (
                  <div className="mt-1">
                    <ProgressBar value={j.progress} />
                  </div>
                ) : (
                  <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-rose-300" title={j.error}>
                    {j.error ?? 'Failed'}
                  </p>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
