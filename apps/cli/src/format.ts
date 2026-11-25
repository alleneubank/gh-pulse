import type { Report } from '@alleneubank/gh-pulse-core'
import type { MemberInsight } from './tui'
import type { TrendDirection } from './trends'

export type LinkMode = 'plain' | 'osc8' | 'markdown' | 'slack'

export const style = (text: string, code: number, interactive: boolean): string =>
  interactive ? `\x1b[${code}m${text}\x1b[0m` : text

export const colors = {
  cyan: (text: string, interactive: boolean): string => style(text, 36, interactive),
  green: (text: string, interactive: boolean): string => style(text, 32, interactive),
  red: (text: string, interactive: boolean): string => style(text, 31, interactive),
  yellow: (text: string, interactive: boolean): string => style(text, 33, interactive),
  dim: (text: string, interactive: boolean): string => style(text, 2, interactive),
  bold: (text: string, interactive: boolean): string => style(text, 1, interactive),
  underline: (text: string, interactive: boolean): string => style(text, 4, interactive),
}

export const ESC = String.fromCharCode(27)
export const BEL = String.fromCharCode(7)
export const OSC8_PREFIX = `${ESC}]8;;`

export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 'n/a'
  }
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`
  }

  const totalSeconds = Math.round(durationMs / 1_000)
  const units: Array<{ label: string; seconds: number }> = [
    { label: 'd', seconds: 86_400 },
    { label: 'h', seconds: 3_600 },
    { label: 'm', seconds: 60 },
    { label: 's', seconds: 1 },
  ]

  let remaining = totalSeconds
  const parts: string[] = []
  for (const unit of units) {
    if (parts.length === 2) {
      break
    }
    const value = Math.floor(remaining / unit.seconds)
    if (value === 0) {
      continue
    }
    parts.push(`${value}${unit.label}`)
    remaining -= value * unit.seconds
  }

  return parts.length > 0 ? parts.join(' ') : '0s'
}

export function formatDurationMetric(durationMs: number | null): string {
  if (durationMs === null) {
    return 'n/a'
  }
  return formatDurationMs(durationMs)
}

export function formatHyperlink(text: string, url: string, mode: LinkMode): string {
  if (mode === 'plain') {
    return text
  }
  if (mode === 'markdown') {
    const safeText = text.replaceAll(']', '\\]')
    return `[${safeText}](${url})`
  }
  if (mode === 'slack') {
    const safeText = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    return `<${url}|${safeText}>`
  }
  return `${OSC8_PREFIX}${url}${BEL}${text}${OSC8_PREFIX}${BEL}`
}

export function githubRepoUrl(repo: string): string {
  return `https://github.com/${repo}`
}

export function githubPullRequestUrl(repo: string, number: number): string {
  return `${githubRepoUrl(repo)}/pull/${number}`
}

export function githubUserUrl(user: string): string {
  const username = user.startsWith('@') ? user.slice(1) : user
  return `https://github.com/${username}`
}

export function repoCell(repo: string, linkMode: LinkMode): string {
  return formatHyperlink(repo, githubRepoUrl(repo), linkMode)
}

export function prCell(repo: string, number: number, linkMode: LinkMode): string {
  return formatHyperlink(`#${number}`, githubPullRequestUrl(repo, number), linkMode)
}

export function userCell(user: string, linkMode: LinkMode): string {
  return formatHyperlink(user, githubUserUrl(user), linkMode)
}

export function stripAnsi(value: string): string {
  return Bun.stripANSI(value)
}

export function stripOsc8(value: string): string {
  let result = ''
  let index = 0
  while (index < value.length) {
    const marker = value.indexOf(OSC8_PREFIX, index)
    if (marker === -1) {
      result += value.slice(index)
      break
    }
    result += value.slice(index, marker)
    const terminator = value.indexOf(BEL, marker + OSC8_PREFIX.length)
    if (terminator === -1) {
      break
    }
    index = terminator + 1
  }
  return result
}

export function visibleWidth(value: string): number {
  return stripAnsi(stripOsc8(value)).length
}

export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return ''
  }
  const plain = stripAnsi(stripOsc8(text))
  if (plain.length <= maxWidth) {
    return text
  }
  if (maxWidth <= 1) {
    return plain.slice(0, maxWidth)
  }
  const truncated = `${plain.slice(0, maxWidth - 1)}\u2026`
  // Preserve OSC8 hyperlink if the original text contained one
  const url = extractOsc8Url(text)
  if (url) {
    return `${OSC8_PREFIX}${url}${BEL}${truncated}${OSC8_PREFIX}${BEL}`
  }
  return truncated
}

function extractOsc8Url(text: string): string | null {
  const start = text.indexOf(OSC8_PREFIX)
  if (start === -1) return null
  const urlStart = start + OSC8_PREFIX.length
  const urlEnd = text.indexOf(BEL, urlStart)
  if (urlEnd === -1) return null
  const url = text.slice(urlStart, urlEnd)
  return url.length > 0 ? url : null
}

export function renderTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return `${headers.join(' | ')}\n${headers.map(() => '---').join(' | ')}\n(no rows)`
  }

  const widths = headers.map((header, index) =>
    Math.max(visibleWidth(header), ...rows.map((row) => visibleWidth(row[index] ?? ''))),
  )
  const formatRow = (row: string[]): string =>
    row
      .map((cell, index) => {
        const targetWidth = widths[index] ?? 0
        const pad = Math.max(0, targetWidth - visibleWidth(cell))
        return `${cell}${' '.repeat(pad)}`
      })
      .join(' | ')

  const headerRow = formatRow(headers)
  const separator = widths.map((width) => '-'.repeat(width ?? 0)).join('-|-')
  const body = rows.map(formatRow)
  return [headerRow, separator, ...body].join('\n')
}

export function trendArrow(trend: TrendDirection): string {
  switch (trend) {
    case 'up':
      return '\u25b2'
    case 'down':
      return '\u25bc'
    case 'flat':
      return '\u2192'
    default: {
      const _exhaustive: never = trend
      throw new Error(`Unhandled trend: ${_exhaustive}`)
    }
  }
}

export function formatSignedPercent(value: number): string {
  const rounded = Math.round(value)
  if (rounded > 0) {
    return `+${rounded}%`
  }
  return `${rounded}%`
}

export function formatMemberScore(user: string, insights?: Record<string, MemberInsight>): string {
  if (!insights) {
    return 'n/a'
  }
  const insight = insights[user.toLowerCase()]
  return insight ? `${insight.score}` : 'n/a'
}

export function formatMemberTrend(user: string, insights?: Record<string, MemberInsight>): string {
  if (!insights) {
    return '\u2192'
  }
  const insight = insights[user.toLowerCase()]
  if (!insight) {
    return '\u2192'
  }
  return `${trendArrow(insight.trend)} ${formatSignedPercent(insight.delta_pct)}`
}

// --- Blocker dedup ---

export type BlockerRow = {
  repo: string
  pr_number: number
  pr_title?: string
  owner?: string
  status: string
  days: number
}

export function blockerStatusOrder(status: string): number {
  switch (status) {
    case 'stale':
      return 0
    case 'stuck':
      return 1
    default:
      return 10
  }
}

export function collapseBlockerRows(rows: BlockerRow[]): BlockerRow[] {
  const grouped = new Map<string, { statuses: Set<string>; maxDays: number; row: BlockerRow }>()

  for (const row of rows) {
    const key = `${row.repo}#${row.pr_number}#${row.owner ?? ''}`
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, {
        statuses: new Set([row.status]),
        maxDays: row.days,
        row: { ...row },
      })
      continue
    }
    existing.statuses.add(row.status)
    existing.maxDays = Math.max(existing.maxDays, row.days)
  }

  return Array.from(grouped.values()).map((entry) => {
    const status = [...entry.statuses]
      .toSorted((a, b) => blockerStatusOrder(a) - blockerStatusOrder(b))
      .join('+')
    return {
      ...entry.row,
      status,
      days: entry.maxDays,
    }
  })
}

export function deriveTeamBlockers(report: Extract<Report, { type: 'team' }>): BlockerRow[] {
  const rows = report.blockers.map((blocker) => ({
    repo: blocker.pr.repo,
    pr_number: blocker.pr.number,
    pr_title: blocker.pr.title,
    owner: blocker.pr.author,
    status: blocker.status,
    days: blocker.days,
  }))
  return collapseBlockerRows(rows)
}

// --- Budgeted table ---

export interface ColumnSpec {
  header: string
  fixedWidth?: number
  flexWeight?: number
  minWidth?: number
}

export function renderBudgetedTable(
  columns: ColumnSpec[],
  rows: string[][],
  totalWidth: number,
): string {
  if (rows.length === 0) {
    return `${columns.map((c) => c.header).join(' | ')}\n${columns.map(() => '---').join(' | ')}\n(no rows)`
  }

  const separatorTotal = (columns.length - 1) * 3 // ' | '
  const widths = allocateColumnWidths(columns, totalWidth - separatorTotal)

  const formatRow = (row: string[]): string =>
    row
      .map((cell, index) => {
        const colWidth = widths[index] ?? 0
        const truncated = truncateToWidth(cell, colWidth)
        const pad = Math.max(0, colWidth - visibleWidth(truncated))
        return `${truncated}${' '.repeat(pad)}`
      })
      .join(' | ')

  const headerRow = formatRow(columns.map((c) => c.header))
  const separator = widths.map((w) => '-'.repeat(w)).join('-|-')
  const body = rows.map(formatRow)
  return [headerRow, separator, ...body].join('\n')
}

function allocateColumnWidths(columns: ColumnSpec[], available: number): number[] {
  let fixedTotal = 0
  let flexTotalWeight = 0
  const flexIndices: number[] = []

  for (const [i, col] of columns.entries()) {
    if (col.fixedWidth !== undefined) {
      fixedTotal += col.fixedWidth
    } else {
      flexTotalWeight += col.flexWeight ?? 1
      flexIndices.push(i)
    }
  }

  const remaining = Math.max(0, available - fixedTotal)
  const widths = columns.map((col) => {
    if (col.fixedWidth !== undefined) {
      return col.fixedWidth
    }
    const weight = col.flexWeight ?? 1
    const minW = col.minWidth ?? 5
    if (flexTotalWeight <= 0) {
      return minW
    }
    return Math.max(minW, Math.floor((remaining * weight) / flexTotalWeight))
  })

  // Trim columns if total allocation exceeds available space
  const totalAllocated = widths.reduce((s, w) => s + w, 0)
  let overflow = totalAllocated - available
  for (let i = flexIndices.length - 1; i >= 0 && overflow > 0; i--) {
    const idx = flexIndices[i]!
    const minW = columns[idx]?.minWidth ?? 5
    const current = widths[idx] ?? 0
    const trim = Math.min(overflow, current - minW)
    if (trim > 0) {
      widths[idx] = current - trim
      overflow -= trim
    }
  }

  // If still overflowing, trim flex columns below minWidth (floor: 1)
  for (let i = flexIndices.length - 1; i >= 0 && overflow > 0; i--) {
    const idx = flexIndices[i]!
    const current = widths[idx] ?? 0
    const trim = Math.min(overflow, current - 1)
    if (trim > 0) {
      widths[idx] = current - trim
      overflow -= trim
    }
  }

  // If still overflowing, trim fixed columns from right (floor: 1)
  if (overflow > 0) {
    for (let i = columns.length - 1; i >= 0 && overflow > 0; i--) {
      if (columns[i]?.fixedWidth === undefined) continue
      const current = widths[i] ?? 0
      const trim = Math.min(overflow, current - 1)
      if (trim > 0) {
        widths[i] = current - trim
        overflow -= trim
      }
    }
  }

  return widths
}
