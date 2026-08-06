import type { JSX } from 'react'
import { compPathLabels } from '@shared/compositions'
import { useProject } from '@/state/projectStore'

/**
 * Where the editor is pointed: "Timeline" at the root, else the chain of nested
 * comps ("Timeline › Layout · Cell 2 › …"). Every ancestor is clickable and
 * exits back to that level (each hop through `exitComposition`, so selection /
 * playhead reset the same way as the ← button). Hidden at the root — the
 * breadcrumb only appears once there is somewhere to come back from.
 */
export function CompBreadcrumb(): JSX.Element | null {
  const editPath = useProject((s) => s.editPath)
  const project = useProject((s) => s.project)
  const exitComp = useProject((s) => s.exitComposition)
  if (!project || editPath.length === 0) return null

  const labels = compPathLabels(project, editPath)
  const exitTo = (depth: number): void => {
    // Pop one level at a time so each hop gets the standard exit behavior.
    for (let i = editPath.length; i > depth; i--) exitComp()
  }

  return (
    <div
      data-testid="comp-breadcrumb"
      className="flex min-w-0 items-center gap-1 rounded bg-fuchsia-500/15 px-2 py-0.5 text-xs"
    >
      <button
        onClick={() => exitTo(editPath.length - 1)}
        className="rounded px-1 font-semibold text-fuchsia-200 hover:bg-white/10"
        title="Back to the parent timeline"
      >
        ←
      </button>
      <button
        onClick={() => exitTo(0)}
        className="rounded px-1 text-zinc-300 hover:bg-white/10"
        title="Back to the main timeline"
      >
        Timeline
      </button>
      {labels.map((label, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          <span className="text-zinc-500">›</span>
          {i === labels.length - 1 ? (
            <span className="truncate font-medium text-fuchsia-200">{label}</span>
          ) : (
            <button
              onClick={() => exitTo(i + 1)}
              className="truncate rounded px-1 text-zinc-300 hover:bg-white/10"
              title="Back to this level"
            >
              {label}
            </button>
          )}
        </span>
      ))}
    </div>
  )
}
