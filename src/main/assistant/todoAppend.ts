/**
 * Insert an assistant feature request into docs/TODO.md's markdown. Pure: the
 * file I/O lives in `todoFile.ts`. The section is created directly above
 * `## Open` so requests sit near the top for triage.
 */

export const ASSISTANT_SECTION = '## Assistant requests'

export interface FeatureRequest {
  title: string
  problem: string
  proposal: string
  workaround?: string
}

export type AppendResult =
  | { status: 'added'; markdown: string; entry: string }
  | { status: 'duplicate'; markdown: string }

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const ENTRY_TITLE = /^- \[[ x~]\] \*\*(.+?)\*\*/i

export function formatRequestEntry(req: FeatureRequest, date: string): string {
  const parts = [`- [ ] **${oneLine(req.title)}** — ${oneLine(req.problem)}`, `_Proposal:_ ${oneLine(req.proposal)}`]
  const workaround = req.workaround ? oneLine(req.workaround) : ''
  if (workaround) parts.push(`_Workaround used:_ ${workaround}`)
  parts.push(`_(requested by assistant, ${date})_`)
  return parts.join(' ')
}

export function appendAssistantRequest(markdown: string, req: FeatureRequest, date: string): AppendResult {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const entry = formatRequestEntry(req, date)
  const start = lines.findIndex((l) => l.trim() === ASSISTANT_SECTION)

  if (start === -1) {
    const open = lines.findIndex((l) => l.trim() === '## Open')
    if (open === -1) {
      const body = markdown.replace(/(\r?\n)+$/, '')
      return { status: 'added', entry, markdown: `${body}${eol}${eol}${ASSISTANT_SECTION}${eol}${eol}${entry}${eol}` }
    }
    const next = [...lines.slice(0, open), ASSISTANT_SECTION, '', entry, '', ...lines.slice(open)]
    return { status: 'added', entry, markdown: next.join(eol) }
  }

  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end === -1) end = lines.length
  const title = oneLine(req.title).toLowerCase()
  const dup = lines
    .slice(start + 1, end)
    .some((l) => ENTRY_TITLE.exec(l)?.[1].trim().toLowerCase() === title)
  if (dup) return { status: 'duplicate', markdown }

  let last = end - 1
  while (last > start && lines[last].trim() === '') last--
  // Directly under another entry; otherwise (heading, prose, quote) leave a blank line.
  const insert = last > start && lines[last].startsWith('- ') ? [entry] : ['', entry]
  const next = [...lines.slice(0, last + 1), ...insert, ...lines.slice(last + 1)]
  return { status: 'added', entry, markdown: next.join(eol) }
}
