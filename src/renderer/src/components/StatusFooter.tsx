import type { JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getCapabilities } from '@/ipc/client'

function Badge({ ok, label }: { ok: boolean; label: string }): JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
        ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-600/30 text-zinc-400'
      }`}
    >
      {label}
    </span>
  )
}

export function StatusFooter(): JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['capabilities'],
    queryFn: getCapabilities,
    staleTime: Infinity
  })

  return (
    <footer className="flex items-center gap-3 border-t border-white/10 bg-black/40 px-3 py-1.5 text-xs text-zinc-400">
      <span className="font-semibold text-zinc-200">Engine</span>
      {isLoading && <span>checking ffmpeg…</span>}
      {isError && <span className="text-red-400">failed to query ffmpeg</span>}
      {data && !data.found && <span className="text-red-400">ffmpeg not found</span>}
      {data && data.found && (
        <>
          <Badge ok={data.usable} label={data.usable ? 'ready' : 'unusable'} />
          <Badge ok={data.nvencAvailable} label={data.nvencAvailable ? 'NVENC' : 'CPU x264'} />
          <span className="truncate text-zinc-500" title={data.ffmpegPath ?? ''}>
            {data.version ?? data.ffmpegPath}
          </span>
          {!data.usable && data.problems.length > 0 && (
            <span className="text-amber-400">{data.problems.join('; ')}</span>
          )}
        </>
      )}
    </footer>
  )
}
