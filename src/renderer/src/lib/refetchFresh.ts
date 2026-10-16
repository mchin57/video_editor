import type { QueryClient, QueryKey } from '@tanstack/react-query'

/**
 * Refetch `queryKey` so the result reflects the world NOW, not when an
 * already-running fetch started. `invalidateQueries` alone doesn't guarantee
 * that: a query with no data yet (a fresh key, e.g. the library just after an
 * import changed `mediaIds`) JOINS its in-flight fetch instead of restarting
 * it. A proxy that finished mid-fetch then never shows as ready, and its card
 * sits at "generating preview… 100%". Cancelling first forces a new fetch.
 */
export async function refetchFresh(qc: QueryClient, queryKey: QueryKey): Promise<void> {
  await qc.cancelQueries({ queryKey })
  await qc.invalidateQueries({ queryKey })
}
