import { useMemo, type JSX } from 'react'
import type { MediaAsset } from '@shared/media'
import { createEmptyComposition } from '@shared/project'
import { templatePreviewTime, type ReelTemplate } from '@shared/templates'
import { CompFill } from './preview/layers'

const NO_ASSETS = new Map<string, MediaAsset>()

/** A still of the template's layers at its busiest moment, over a plain
 *  backdrop (tinted when the template tints the clip). Read-only. The template
 *  gallery's cards and the shared library's text cards (a text piece as a
 *  layers-only template, `sharedTextTemplate`) both draw with it. */
export function TemplatePreview({ template: t }: { template: ReelTemplate }): JSX.Element {
  // Image layers point at files in the template's folder, not library media,
  // so they can't be drawn here; text and graphics are.
  const comp = useMemo(
    () => ({ ...createEmptyComposition(), layers: t.layers.filter((l) => l.content.kind !== 'image') }),
    [t.layers]
  )
  const tint = t.clipEffect?.tint
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative w-[72px] shrink-0 overflow-hidden rounded bg-gradient-to-b from-zinc-600 to-zinc-800"
      style={{ aspectRatio: '9 / 16', containerType: 'size' }}
    >
      {tint && tint.amount > 0 && (
        <div className="absolute inset-0" style={{ background: tint.color, opacity: tint.amount * 0.6 }} />
      )}
      <CompFill comp={comp} time={templatePreviewTime(t)} playing={false} assetById={NO_ASSETS} depth={1} muted />
    </div>
  )
}
