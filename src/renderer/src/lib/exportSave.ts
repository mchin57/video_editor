/**
 * A finished export saves the project it was made FROM (the Export button and
 * the assistant's `export_video`). An export runs for a while, and the user
 * can open or create another project meanwhile — the save must not land on
 * whatever happens to be open when the render finishes. Both callers capture
 * the project's identity before the export and check it here, synchronously,
 * right before calling the store's `save`.
 */

/** Which project an export came from. `filePath` undefined = not checked (the
 *  assistant knows only the id). */
export interface ExportOrigin {
  id: string
  filePath?: string | null
}

/** Null when the project the export came from is still the open one (save
 *  it); otherwise why it is not saved, in words for the user. */
export function exportSaveSkipReason(
  origin: ExportOrigin,
  now: { project: { id: string } | null; filePath: string | null }
): string | null {
  if (!now.project) return 'The project was closed while it exported, so it wasn’t saved.'
  const moved = origin.filePath !== undefined && now.filePath !== origin.filePath
  if (now.project.id !== origin.id || moved) {
    return 'Another project was opened while it exported, so the project it came from wasn’t saved.'
  }
  return null
}
