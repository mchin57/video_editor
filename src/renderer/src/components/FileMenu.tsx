import { useEffect, useRef, useState, type JSX } from 'react'
import { DEFAULT_VOLUME_LEVEL_ID } from '@shared/project'
import { levelMemberCounts } from '@shared/volumeLevels'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { useExtractAudio, useImportFolder } from '@/hooks/useMedia'
import { convertLegacyFolderDialog } from '@/ipc/client'
import { MENU_SEPARATOR, useContextMenu, type ContextMenuEntry } from './ui'

/** Last path segment, handling both Windows and POSIX separators. */
function basename(path: string): string {
  const m = /[^\\/]*$/.exec(path)
  return m ? m[0] : path
}

function MenuItem({
  label,
  shortcut,
  onClick,
  testId
}: {
  label: string
  shortcut: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  testId?: string
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center justify-between gap-6 rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-white/10"
    >
      <span>{label}</span>
      <span className="text-[10px] text-zinc-500">{shortcut}</span>
    </button>
  )
}

/**
 * File ▸ Volume levels ▸ — every level (Set loudness…, Rename…, Delete), then
 * "Create new level…". Default can be re-targeted but not renamed or deleted.
 * Deleting is one undo step and returns the level's clips to their own volume.
 * Rows are built when the menu opens, from the project at that moment.
 */
function volumeLevelRows(): ContextMenuEntry[] {
  const store = useProject.getState()
  const project = store.project
  if (!project) return []
  const counts = levelMemberCounts(project)
  const dialog = useUi.getState().setLevelDialog
  const clips = (n: number): string => (n === 1 ? '1 clip' : `${n} clips`)
  return [
    ...project.volumeLevels.map((l): ContextMenuEntry => {
      const isDefault = l.id === DEFAULT_VOLUME_LEVEL_ID
      const n = counts.get(l.id) ?? 0
      return {
        label: `${l.name} · ${l.targetLufs} LUFS · ${clips(n)}`,
        testId: `level-menu-${l.id}`,
        submenu: [
          { label: 'Set loudness…', testId: 'level-set-loudness', onSelect: () => dialog({ mode: 'loudness', levelId: l.id }) },
          {
            label: 'Rename…',
            testId: 'level-rename',
            disabled: isDefault,
            reason: isDefault ? 'Default keeps its name.' : undefined,
            onSelect: () => dialog({ mode: 'rename', levelId: l.id })
          },
          {
            label: 'Delete',
            testId: 'level-delete',
            disabled: isDefault,
            reason: isDefault ? 'Default is always there — new clips can join it.' : undefined,
            hint: !isDefault && n > 0 ? `${clips(n)} back to own volume` : undefined,
            onSelect: () => useProject.getState().deleteVolumeLevel(l.id)
          }
        ]
      }
    }),
    MENU_SEPARATOR,
    { label: 'Create new level…', testId: 'level-create', onSelect: () => dialog({ mode: 'create' }) }
  ]
}

/**
 * File menu: New / Open… / Save / Save As… for portable .reel project files.
 * Shows the bound filename and an unsaved-changes dot. Keyboard shortcuts for
 * the same actions live in App's global key handler.
 */
export function FileMenu(): JSX.Element {
  const project = useProject((s) => s.project)
  const filePath = useProject((s) => s.filePath)
  const dirty = useProject((s) => s.dirty)
  const newProjectFile = useProject((s) => s.newProjectFile)
  const openFile = useProject((s) => s.openFile)
  const save = useProject((s) => s.save)
  const saveAs = useProject((s) => s.saveAs)
  const extractAudio = useExtractAudio()
  const importFolder = useImportFolder()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const levelsMenu = useContextMenu()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const run = (fn: () => void | Promise<void>) => (): void => {
    setOpen(false)
    void fn()
  }

  // Every open project has a folder and a .reel (there is no untitled state).
  const label = filePath ? basename(filePath) : (project?.name ?? '')

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20"
      >
        File ▾
      </button>
      <span
        className="max-w-[220px] truncate text-xs text-zinc-400"
        title={filePath ?? undefined}
      >
        {label}
        {dirty && (
          <span className="ml-1 text-amber-400" title="Unsaved changes">
            ●
          </span>
        )}
      </span>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded-lg border border-white/10 bg-zinc-900 p-1 shadow-2xl">
          <MenuItem label="New…" shortcut="Ctrl+N" onClick={run(newProjectFile)} />
          <MenuItem label="Open…" shortcut="Ctrl+O" onClick={run(openFile)} />
          <div className="my-1 h-px bg-white/10" />
          <MenuItem label="Save" shortcut="Ctrl+S" onClick={run(save)} />
          <MenuItem label="Save As…" shortcut="Ctrl+Shift+S" onClick={run(saveAs)} />
          <div className="my-1 h-px bg-white/10" />
          <MenuItem
            label="Volume levels"
            shortcut="▸"
            testId="file-volume-levels"
            onClick={(e) => {
              // The levels open in the shared menu, beside this row (where a
              // submenu would sit); the File dropdown itself closes.
              const r = e.currentTarget.getBoundingClientRect()
              setOpen(false)
              levelsMenu.openAt(r.right, r.top, volumeLevelRows())
            }}
          />
          <div className="my-1 h-px bg-white/10" />
          <MenuItem label="Import folder…" shortcut="" onClick={run(() => importFolder.mutate())} />
          <MenuItem
            label="Extract audio from clip…"
            shortcut=""
            onClick={run(() => extractAudio.mutate())}
          />
          <div className="my-1 h-px bg-white/10" />
          <MenuItem
            label="Convert old projects…"
            shortcut=""
            onClick={run(() => {
              void convertLegacyFolderDialog().then(
                (lines) => lines && window.alert(lines.join('\n')),
                (err: Error) => window.alert(err.message)
              )
            })}
          />
        </div>
      )}
      {levelsMenu.menu}
    </div>
  )
}
