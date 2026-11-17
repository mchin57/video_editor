/**
 * A project LUT's parsed table in the renderer (`readLut`, read from the open
 * project's `luts/` once and cached — files are content-named, so a name never
 * changes meaning). A read that FAILED (the file was missing) is cached too, so
 * anything that puts a LUT into `luts/` — the Inspector's Import LUT…, a pick
 * from the shared library, a template drop — calls `invalidateLuts` for the
 * names it stored: re-importing the very file that was missing gives the same
 * name, and the preview must read it again.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { CubeTable } from '@shared/cube'
import { readLut } from '@/ipc/client'

export const LUT_KEY = 'lut'

/** The query key of LUT `file`'s table. */
export const lutQueryKey = (file: string | null): [string, string | null] => [LUT_KEY, file]

/** LUT `file`'s parsed table; `missing` when it couldn't be read. */
export function useLutTable(file: string | null): { table: CubeTable | null; missing: boolean } {
  const q = useQuery({
    queryKey: lutQueryKey(file),
    queryFn: () => readLut(file!),
    enabled: !!file,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false
  })
  return { table: q.data ?? null, missing: !!file && q.isError }
}

/** Read LUTs `files` again (they were just stored in `luts/`). */
export const invalidateLuts = (qc: QueryClient, files: readonly string[]): Promise<void[]> =>
  Promise.all(files.map((f) => qc.invalidateQueries({ queryKey: lutQueryKey(f) })))
