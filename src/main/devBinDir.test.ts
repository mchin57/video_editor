import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findDevBinDir, mainCheckoutOf } from './devBinDir'

// Real git, real worktrees: the lookup reads git's own pointer files, so the
// layout under test is whatever `git worktree add` actually writes.
let dir: string
let main: string
let nested: string // under the main checkout, like .claude/worktrees/<name>
let sibling: string // outside it entirely
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'reel-devbin-'))
  main = join(dir, 'main')
  mkdirSync(main)
  git(main, 'init', '-q')
  writeFileSync(join(main, 'README'), 'x')
  git(main, 'add', 'README')
  git(main, 'commit', '-q', '-m', 'init')
  nested = join(main, '.claude', 'worktrees', 'wt')
  sibling = join(dir, 'sibling')
  git(main, 'worktree', 'add', '-q', '-b', 'nested', nested)
  git(main, 'worktree', 'add', '-q', '-b', 'sibling', sibling)
  mkdirSync(join(main, 'resources', 'bin'), { recursive: true })
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('mainCheckoutOf', () => {
  it('finds the main checkout from a linked worktree, nested or not', () => {
    expect(mainCheckoutOf(nested)).toBe(main)
    expect(mainCheckoutOf(sibling)).toBe(main)
  })

  it('is null for the main checkout itself and for a non-git folder', () => {
    expect(mainCheckoutOf(main)).toBeNull()
    expect(mainCheckoutOf(dir)).toBeNull()
  })
})

describe('findDevBinDir', () => {
  it("a worktree without resources/bin uses the main checkout's", () => {
    expect(findDevBinDir(nested)).toBe(join(main, 'resources', 'bin'))
    expect(findDevBinDir(sibling)).toBe(join(main, 'resources', 'bin'))
  })

  it('the main checkout uses its own', () => {
    expect(findDevBinDir(main)).toBe(join(main, 'resources', 'bin'))
  })

  it("a worktree's own resources/bin wins (older worktrees that still junction it)", () => {
    const own = join(sibling, 'resources', 'bin')
    mkdirSync(own, { recursive: true })
    try {
      expect(findDevBinDir(sibling)).toBe(own)
    } finally {
      rmSync(join(sibling, 'resources'), { recursive: true, force: true })
    }
  })

  it('is null when nothing is staged anywhere', () => {
    expect(findDevBinDir(dir)).toBeNull()
  })
})
