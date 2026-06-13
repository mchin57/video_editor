import type { JSX, ReactNode } from 'react'
import { LOGICAL, SAFE_ZONES } from '@/lib/coords'
import { StatusFooter } from '@/components/StatusFooter'

const pct = (value: number, total: number): string => `${(value / total) * 100}%`

/** Placeholder 9:16 stage that draws the Instagram safe zones from coords.ts. */
function PreviewStage(): JSX.Element {
  return (
    <div className="relative aspect-[9/16] h-full overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-white/10">
      {/* Hook zone hint (first 3 seconds) — top band */}
      <div className="absolute inset-x-0 top-0 flex h-[6%] items-center justify-center border-b border-amber-400/30 bg-amber-400/5 text-[10px] uppercase tracking-wide text-amber-300/70">
        Hook zone · first 3s
      </div>

      {/* Bottom safe zone */}
      <div
        className="absolute left-0 w-full border-t border-rose-400/40 bg-rose-500/10"
        style={{ top: pct(SAFE_ZONES.bottom.y, LOGICAL.height), height: pct(SAFE_ZONES.bottom.h, LOGICAL.height) }}
      />
      {/* Right action rail */}
      <div
        className="absolute top-0 h-full border-l border-rose-400/40 bg-rose-500/10"
        style={{ left: pct(SAFE_ZONES.rightRail.x, LOGICAL.width), width: pct(SAFE_ZONES.rightRail.w, LOGICAL.width) }}
      />

      <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
        Import a clip to begin
      </div>
      <div className="absolute left-2 top-2 text-[10px] uppercase tracking-wide text-zinc-500">
        {LOGICAL.width} × {LOGICAL.height}
      </div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex w-64 flex-col border-white/10">
      <div className="border-b border-white/10 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        {title}
      </div>
      <div className="flex-1 p-3 text-sm text-zinc-600">{children}</div>
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <div className="flex h-full flex-col bg-[#0b0b0f]">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-2">
        <span className="text-sm font-bold tracking-tight text-zinc-100">Reel Editor</span>
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">prototype</span>
        <div className="flex-1" />
        <button
          disabled
          className="cursor-not-allowed rounded-md bg-white/5 px-3 py-1 text-xs text-zinc-500"
          title="Coming in M1"
        >
          Import video
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="border-r border-white/10">
          <Panel title="Library">Imported clips will appear here (M1).</Panel>
        </aside>

        <main className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="h-full max-h-[78vh]">
            <PreviewStage />
          </div>
        </main>

        <aside className="border-l border-white/10">
          <Panel title="Inspector">Clip, text & caption settings (M2+).</Panel>
        </aside>
      </div>

      <div className="flex h-28 items-center justify-center border-t border-white/10 bg-black/20 text-xs text-zinc-600">
        Timeline (M2)
      </div>

      <StatusFooter />
    </div>
  )
}
