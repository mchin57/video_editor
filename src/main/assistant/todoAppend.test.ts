import { describe, expect, it } from 'vitest'
import { appendAssistantRequest, formatRequestEntry } from './todoAppend'

const DOC = ['# TODO / backlog', '', '## Bugs', '', '- [ ] a bug', '', '## Open', '', '- [ ] thing', ''].join('\n')
const REQ = { title: 'Trim by word', problem: 'Needed to cut at a word.', proposal: 'trim_to_word tool' }
const ENTRY =
  '- [ ] **Trim by word** — Needed to cut at a word. _Proposal:_ trim_to_word tool _(requested by assistant, 2026-10-06)_'

describe('appendAssistantRequest', () => {
  it('creates the section directly above ## Open', () => {
    const r = appendAssistantRequest(DOC, REQ, '2026-10-06')
    expect(r.status).toBe('added')
    expect(r.markdown).toBe(
      ['# TODO / backlog', '', '## Bugs', '', '- [ ] a bug', '', '## Assistant requests', '', ENTRY, '', '## Open', '', '- [ ] thing', ''].join('\n')
    )
  })

  it('leaves the rest of the file byte-identical', () => {
    const r = appendAssistantRequest(DOC, REQ, '2026-10-06')
    expect(r.markdown.replace(`## Assistant requests\n\n${ENTRY}\n\n`, '')).toBe(DOC)
  })

  it('appends after the last entry of an existing section', () => {
    const first = appendAssistantRequest(DOC, REQ, '2026-10-06').markdown
    const r = appendAssistantRequest(first, { title: 'Beat snap', problem: 'p', proposal: 'q' }, '2026-10-07')
    expect(r.markdown).toContain(`${ENTRY}\n- [ ] **Beat snap** — p _Proposal:_ q _(requested by assistant, 2026-10-07)_\n\n## Open`)
  })

  it('separates the first entry from explanatory text with a blank line', () => {
    const doc = ['## Assistant requests', '', '> Filed by the assistant.', '', '## Open', ''].join('\n')
    const r = appendAssistantRequest(doc, REQ, '2026-10-06')
    expect(r.markdown).toBe(['## Assistant requests', '', '> Filed by the assistant.', '', ENTRY, '', '## Open', ''].join('\n'))
  })

  it('treats the same title in any case as already requested', () => {
    const first = appendAssistantRequest(DOC, REQ, '2026-10-06').markdown
    const r = appendAssistantRequest(first, { ...REQ, title: 'TRIM BY WORD' }, '2026-10-08')
    expect(r).toEqual({ status: 'duplicate', markdown: first })
  })

  it('appends a section at the end when there is no ## Open', () => {
    const r = appendAssistantRequest('# T\n\n- [ ] x\n', REQ, '2026-10-06')
    expect(r.markdown).toBe(`# T\n\n- [ ] x\n\n## Assistant requests\n\n${ENTRY}\n`)
  })

  it('keeps CRLF line endings', () => {
    const r = appendAssistantRequest(DOC.replace(/\n/g, '\r\n'), REQ, '2026-10-06')
    expect(r.markdown).not.toMatch(/[^\r]\n/)
    expect(r.markdown).toContain(`## Assistant requests\r\n\r\n${ENTRY}\r\n`)
  })
})

describe('formatRequestEntry', () => {
  it('includes the workaround only when given, and keeps one entry on one line', () => {
    expect(formatRequestEntry({ ...REQ, workaround: '  split\nby hand ' }, '2026-10-06')).toBe(
      '- [ ] **Trim by word** — Needed to cut at a word. _Proposal:_ trim_to_word tool _Workaround used:_ split by hand _(requested by assistant, 2026-10-06)_'
    )
    expect(formatRequestEntry({ ...REQ, problem: 'line one\nline two' }, '2026-10-06')).toContain('— line one line two _Proposal:_')
  })
})
