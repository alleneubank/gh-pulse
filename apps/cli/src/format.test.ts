import { describe, expect, it } from 'bun:test'
import {
  formatHyperlink,
  stripAnsi,
  visibleWidth,
  truncateToWidth,
  OSC8_PREFIX,
  BEL,
  renderBudgetedTable,
  collapseBlockerRows,
} from './format'
import type { BlockerRow, ColumnSpec } from './format'

describe('formatHyperlink', () => {
  it('renders slack links as <url|text>', () => {
    expect(formatHyperlink('webapp', 'https://github.com/acme-co/webapp', 'slack')).toBe(
      '<https://github.com/acme-co/webapp|webapp>',
    )
  })

  it('escapes special characters in slack link labels', () => {
    expect(formatHyperlink('A < B & C > D', 'https://example.com', 'slack')).toBe(
      '<https://example.com|A &lt; B &amp; C &gt; D>',
    )
  })
})

describe('stripAnsi', () => {
  it('removes SGR sequences', () => {
    expect(stripAnsi('\x1b[36mhello\x1b[0m')).toBe('hello')
  })

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello')).toBe('hello')
  })

  it('strips nested bold+color', () => {
    expect(stripAnsi('\x1b[1m\x1b[32mok\x1b[0m')).toBe('ok')
  })
})

describe('visibleWidth', () => {
  it('returns length for plain text', () => {
    expect(visibleWidth('hello')).toBe(5)
  })

  it('strips ANSI SGR from width calculation', () => {
    expect(visibleWidth('\x1b[36mhello\x1b[0m')).toBe(5)
  })

  it('strips OSC8 hyperlinks from width calculation', () => {
    const link = `${OSC8_PREFIX}https://example.com${BEL}link${OSC8_PREFIX}${BEL}`
    expect(visibleWidth(link)).toBe(4)
  })

  it('strips mixed ANSI + OSC8', () => {
    const link = `\x1b[1m${OSC8_PREFIX}https://example.com${BEL}link${OSC8_PREFIX}${BEL}\x1b[0m`
    expect(visibleWidth(link)).toBe(4)
  })
})

describe('truncateToWidth', () => {
  it('returns short text unchanged', () => {
    expect(truncateToWidth('hi', 10)).toBe('hi')
  })

  it('truncates with ellipsis', () => {
    expect(truncateToWidth('hello world', 6)).toBe('hello\u2026')
  })

  it('returns empty string for zero width', () => {
    expect(truncateToWidth('hello', 0)).toBe('')
  })

  it('handles maxWidth of 1', () => {
    expect(truncateToWidth('hello', 1)).toBe('h')
  })

  it('preserves OSC8 hyperlink when truncating linked text', () => {
    const url = 'https://github.com/org/repo'
    const link = `${OSC8_PREFIX}${url}${BEL}org/a-very-long-repo-name${OSC8_PREFIX}${BEL}`
    const result = truncateToWidth(link, 10)
    // Should contain the OSC8 wrapper with original URL
    expect(result).toContain(OSC8_PREFIX + url + BEL)
    // Visible text should be truncated with ellipsis
    expect(result).toContain('\u2026')
    // Should still end with closing OSC8 sequence
    expect(result).toContain(`${OSC8_PREFIX}${BEL}`)
  })

  it('returns plain truncated text when no OSC8 link present', () => {
    const result = truncateToWidth('hello world long text', 8)
    expect(result).toBe('hello w\u2026')
    expect(result).not.toContain(OSC8_PREFIX)
  })
})

describe('renderBudgetedTable', () => {
  it('respects totalWidth — no visible row exceeds it', () => {
    const columns: ColumnSpec[] = [
      { header: 'Repo', flexWeight: 2, minWidth: 10 },
      { header: 'PR', fixedWidth: 6 },
      { header: 'Title', flexWeight: 3, minWidth: 10 },
    ]
    const rows = [
      ['org/some-very-long-repo-name', '#12345', 'A very long PR title that should be truncated'],
      ['org/short', '#1', 'Short title'],
    ]
    const output = renderBudgetedTable(columns, rows, 60)
    for (const line of output.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(60)
    }
  })

  it('allocates fixed + flex columns correctly', () => {
    const columns: ColumnSpec[] = [
      { header: 'A', fixedWidth: 5 },
      { header: 'B', flexWeight: 1, minWidth: 5 },
    ]
    const rows = [['hello', 'world of text']]
    // totalWidth = 5 (fixed) + 3 (separator) + flex = whatever remains
    const output = renderBudgetedTable(columns, rows, 30)
    const lines = output.split('\n')
    // Header line: 'A' padded to 5, separator ' | ', 'B' padded to 22 (30 - 5 - 3)
    expect(lines[0]?.length).toBe(30)
  })

  it('truncates cells exceeding budget', () => {
    const columns: ColumnSpec[] = [{ header: 'Name', fixedWidth: 8 }]
    const rows = [['A very long name that exceeds 8 chars']]
    const output = renderBudgetedTable(columns, rows, 8)
    const dataLine = output.split('\n')[2] ?? ''
    expect(dataLine.length).toBeLessThanOrEqual(8)
    expect(dataLine).toContain('\u2026') // ellipsis
  })

  it('respects totalWidth in narrow terminals where minWidths exceed available', () => {
    const columns: ColumnSpec[] = [
      { header: '', fixedWidth: 2 },
      { header: 'Repo', flexWeight: 2, minWidth: 10 },
      { header: 'PR', fixedWidth: 6 },
      { header: 'Title', flexWeight: 3, minWidth: 10 },
      { header: 'Owner', flexWeight: 1, minWidth: 8 },
      { header: 'Status', fixedWidth: 12 },
      { header: 'Days', fixedWidth: 5 },
    ]
    const rows = [['>', 'org/some-repo', '#123', 'A long title', 'alice', 'stale+stuck', '30']]
    const output = renderBudgetedTable(columns, rows, 60)
    for (const line of output.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(60)
    }
  })

  it('respects totalWidth when fixed columns alone exceed available space', () => {
    const columns: ColumnSpec[] = [
      { header: '', fixedWidth: 2 },
      { header: 'Repo', flexWeight: 2, minWidth: 10 },
      { header: 'PR', fixedWidth: 6 },
      { header: 'Title', flexWeight: 3, minWidth: 10 },
      { header: 'Owner', flexWeight: 1, minWidth: 8 },
      { header: 'Status', fixedWidth: 12 },
      { header: 'Days', fixedWidth: 5 },
    ]
    const rows = [['>', 'org/repo', '#1', 'Title', 'bob', 'stale', '5']]
    const output = renderBudgetedTable(columns, rows, 40)
    for (const line of output.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(40)
    }
  })

  it('shows (no rows) for empty data', () => {
    const columns: ColumnSpec[] = [{ header: 'Foo', fixedWidth: 5 }]
    const output = renderBudgetedTable(columns, [], 40)
    expect(output).toContain('(no rows)')
  })
})

describe('collapseBlockerRows', () => {
  it('merges stale+stuck for same PR', () => {
    const rows: BlockerRow[] = [
      { repo: 'org/repo', pr_number: 42, owner: 'alice', status: 'stale', days: 10 },
      { repo: 'org/repo', pr_number: 42, owner: 'alice', status: 'stuck', days: 15 },
    ]
    const collapsed = collapseBlockerRows(rows)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.status).toBe('stale+stuck')
    expect(collapsed[0]?.days).toBe(15) // max days
  })

  it('keeps distinct PRs separate', () => {
    const rows: BlockerRow[] = [
      { repo: 'org/repo', pr_number: 1, status: 'stale', days: 5 },
      { repo: 'org/repo', pr_number: 2, status: 'stuck', days: 3 },
    ]
    const collapsed = collapseBlockerRows(rows)
    expect(collapsed).toHaveLength(2)
  })

  it('preserves single-status rows unchanged', () => {
    const rows: BlockerRow[] = [{ repo: 'org/repo', pr_number: 1, status: 'stale', days: 7 }]
    const collapsed = collapseBlockerRows(rows)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.status).toBe('stale')
  })
})
