import type { JSX, ReactNode } from 'react'
import { useLibrary } from '@/hooks/useMedia'
import { useEditor } from '@/state/store'
import { formatDuration, formatFps } from '@/lib/format'

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex justify-between gap-2 py-1 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right text-zinc-300">{children}</span>
    </div>
  )
}

export function Inspector(): JSX.Element {
  const selectedId = useEditor((s) => s.selectedId)
  const { data: assets = [] } = useLibrary()
  const asset = assets.find((a) => a.id === selectedId) ?? null

  return (
    <div className="flex h-full w-64 flex-col">
      <div className="border-b border-white/10 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Inspector
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!asset ? (
          <p className="text-sm text-zinc-600">Select a clip to see its details.</p>
        ) : (
          <>
            <div className="mb-2 truncate text-sm font-medium text-zinc-200" title={asset.fileName}>
              {asset.fileName}
            </div>
            <div className="divide-y divide-white/5">
              <Row label="Duration">{formatDuration(asset.probe.durationSec)}</Row>
              <Row label="Container">{asset.probe.container.split(',')[0]}</Row>
              {asset.probe.video && (
                <>
                  <Row label="Video">{asset.probe.video.codec}</Row>
                  <Row label="Display">
                    {asset.probe.video.displayWidth}×{asset.probe.video.displayHeight}
                  </Row>
                  <Row label="Frame rate">{formatFps(asset.probe.video.avgFps)}</Row>
                  <Row label="Rotation">{asset.probe.video.rotationDeg}°</Row>
                  <Row label="VFR">{asset.probe.video.isVfr ? 'yes' : 'no'}</Row>
                  <Row label="HDR">
                    {asset.probe.video.isHdr
                      ? `yes (${asset.probe.video.colorTransfer})`
                      : 'no'}
                  </Row>
                </>
              )}
              {asset.probe.audio && (
                <Row label="Audio">
                  {asset.probe.audio.codec} · {asset.probe.audio.channels}ch
                </Row>
              )}
              <Row label="Proxy">{asset.proxyReady ? 'ready' : 'pending'}</Row>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
              Trim, crop, text & captions arrive in M2+.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
