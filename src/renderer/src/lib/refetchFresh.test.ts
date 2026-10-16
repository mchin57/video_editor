import { describe, expect, it } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { refetchFresh } from './refetchFresh'

/** A library query whose fetch reads `ready` at its start but resolves later —
 *  like main reading proxyReady early in a slow getProjectMedia. */
function setup(): { qc: QueryClient; observer: QueryObserver<boolean>; finish: () => void; markReady: () => void } {
  const qc = new QueryClient()
  let ready = false
  const pending: Array<() => void> = []
  const observer = new QueryObserver<boolean>(qc, {
    queryKey: ['library', 'p', ['a']],
    queryFn: () => {
      const seen = ready
      return new Promise<boolean>((resolve) => pending.push(() => resolve(seen)))
    }
  })
  observer.subscribe(() => {}) // active, as the mounted Library is
  return {
    qc,
    observer,
    finish: () => pending.splice(0).forEach((f) => f()),
    markReady: () => (ready = true)
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('refetchFresh', () => {
  it('plain invalidate joins a data-less in-flight fetch and keeps its stale answer (the bug)', async () => {
    const { qc, observer, finish, markReady } = setup()
    markReady() // the proxy lands while the first fetch is still running
    void qc.invalidateQueries({ queryKey: ['library'] })
    finish()
    await settle()
    expect(observer.getCurrentResult().data).toBe(false)
  })

  it('restarts a data-less in-flight fetch so the result is current', async () => {
    const { qc, observer, finish, markReady } = setup()
    markReady()
    const done = refetchFresh(qc, ['library'])
    await settle()
    finish()
    await done
    expect(observer.getCurrentResult().data).toBe(true)
  })
})
