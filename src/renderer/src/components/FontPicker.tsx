import { useEffect, useRef, useState, type JSX } from 'react'
import { FONTS, FONT_CATEGORIES, fontCssFamily, resolveFont, type FontCategory } from '@shared/fonts'

/**
 * Grouped font picker with a live in-font preview of each option. Used by both
 * text layers and captions. `value` is a bundled-font id (shared/fonts).
 */
export function FontPicker({
  value,
  onChange
}: {
  value: string
  onChange: (id: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = resolveFont(value)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded border border-white/10 bg-black/40 px-2 py-1.5 text-left text-xs text-zinc-200 hover:border-sky-400/60"
      >
        <span className="truncate" style={{ fontFamily: fontCssFamily(value), fontWeight: 'normal' }}>
          {current.label}
        </span>
        <span className="ml-2 text-zinc-500">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded border border-white/10 bg-zinc-900 p-1 shadow-xl">
          {FONT_CATEGORIES.map((cat) => (
            <div key={cat.id}>
              <div className="px-2 pb-0.5 pt-1.5 text-[9px] uppercase tracking-wider text-zinc-500">
                {cat.label}
              </div>
              {FONTS.filter((f) => f.category === (cat.id as FontCategory)).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    onChange(f.id)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-white/10 ${
                    f.id === value ? 'bg-sky-500/20 text-sky-200' : 'text-zinc-200'
                  }`}
                  style={{ fontFamily: `"${f.label}", system-ui, sans-serif`, fontWeight: 'normal' }}
                >
                  <span className="truncate">{f.label}</span>
                  {f.id === value && <span className="ml-2 text-[10px]">✓</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
