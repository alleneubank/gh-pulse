import { describe, expect, it } from 'bun:test'
import type { Report } from '@dave/gh-pulse-core'
import { renderTuiFrame, runTuiSession } from './tui'
import { stripAnsi } from './format'

describe('tui rendering', () => {
  it('renders navigation and overview content for team reports', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'overview',
      timeZone: 'UTC',
      memberInsights: {
        'mona-lisa': { score: 100, trend: 'down', delta_pct: -12 },
      },
    })

    expect(frame).toContain('gh-pulse')
    expect(frame).toContain('[1] Overview')
    expect(frame).toContain('Velocity')
    expect(frame).toContain('Activity Sparkline')
  })

  it('renders members tab with score and trend', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'members',
      timeZone: 'UTC',
      termWidth: 120,
      memberInsights: {
        'mona-lisa': { score: 100, trend: 'down', delta_pct: -12 },
      },
    })

    expect(frame).toContain('Members')
    expect(frame).toContain('Mona-Lisa')
    expect(frame).toContain('100')
    expect(frame).toContain('\u25bc -12%')
  })

  it('renders blockers tab entries', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'blockers',
      timeZone: 'UTC',
      memberInsights: {},
    })

    expect(frame).toContain('Blockers')
    // Repo name may be truncated due to column budgeting
    expect(frame).toContain('acme-co/web')
    expect(frame).toContain('#123')
  })
})

describe('tui interactive mode', () => {
  it('adds ANSI color codes when interactive is true', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'overview',
      timeZone: 'UTC',
      interactive: true,
    })

    // Should contain ANSI escape codes
    expect(frame).toContain('\x1b[')
    // Bold gh-pulse
    expect(frame).toContain('\x1b[1mgh-pulse\x1b[0m')
  })

  it('produces no ANSI codes when interactive is false', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'overview',
      timeZone: 'UTC',
      interactive: false,
    })

    expect(frame).not.toContain('\x1b[')
  })

  it('uses box-drawing separator', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'overview',
      timeZone: 'UTC',
      termWidth: 40,
    })

    expect(frame).toContain('\u2500'.repeat(40))
  })

  it('exits on ctrl-c and pauses stdin cleanup', async () => {
    const stdin = process.stdin as NodeJS.ReadStream & {
      isTTY?: boolean
      isRaw?: boolean
      setRawMode?: (mode: boolean) => void
    }
    const stdout = process.stdout as NodeJS.WriteStream & {
      isTTY?: boolean
      columns?: number
      rows?: number
    }

    const original = {
      stdinIsTTY: stdin.isTTY,
      stdinIsRaw: stdin.isRaw,
      stdinSetRawMode: stdin.setRawMode,
      stdinResume: stdin.resume,
      stdinPause: stdin.pause,
      stdinSetEncoding: stdin.setEncoding,
      stdinOn: stdin.on,
      stdinOff: stdin.off,
      stdoutIsTTY: stdout.isTTY,
      stdoutColumns: stdout.columns,
      stdoutRows: stdout.rows,
      stdoutOn: stdout.on,
      stdoutOff: stdout.off,
      stdoutWrite: stdout.write,
    }

    let onDataHandler: ((chunk: string) => void) | null = null
    let pauseCalls = 0
    const rawModeCalls: boolean[] = []

    try {
      stdin.isTTY = true
      stdin.isRaw = false
      stdin.setRawMode = (mode: boolean): void => {
        rawModeCalls.push(mode)
        stdin.isRaw = mode
      }
      stdin.resume = (() => stdin) as typeof stdin.resume
      stdin.pause = (() => {
        pauseCalls += 1
        return stdin
      }) as typeof stdin.pause
      stdin.setEncoding = (() => stdin) as typeof stdin.setEncoding
      stdin.on = ((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          onDataHandler = listener as (chunk: string) => void
        }
        return stdin
      }) as typeof stdin.on
      stdin.off = ((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data' && onDataHandler === listener) {
          onDataHandler = null
        }
        return stdin
      }) as typeof stdin.off

      stdout.isTTY = true
      stdout.columns = 120
      stdout.rows = 40
      stdout.on = (() => stdout) as typeof stdout.on
      stdout.off = (() => stdout) as typeof stdout.off
      stdout.write = (() => true) as typeof stdout.write

      const session = runTuiSession({
        report: buildTeamReport(),
        timeZone: 'UTC',
      })

      expect(onDataHandler).not.toBeNull()
      onDataHandler?.('\u0003')

      await session

      expect(pauseCalls).toBe(1)
      expect(rawModeCalls).toEqual([true, false])
    } finally {
      stdin.isTTY = original.stdinIsTTY
      stdin.isRaw = original.stdinIsRaw
      stdin.setRawMode = original.stdinSetRawMode
      stdin.resume = original.stdinResume
      stdin.pause = original.stdinPause
      stdin.setEncoding = original.stdinSetEncoding
      stdin.on = original.stdinOn
      stdin.off = original.stdinOff

      stdout.isTTY = original.stdoutIsTTY
      stdout.columns = original.stdoutColumns
      stdout.rows = original.stdoutRows
      stdout.on = original.stdoutOn
      stdout.off = original.stdoutOff
      stdout.write = original.stdoutWrite
    }
  })
})

describe('tui overview', () => {
  it('shows team size and cycle time metrics', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'overview',
      timeZone: 'UTC',
    })

    expect(frame).toContain('Team size')
    expect(frame).toContain('Cycle time p50')
    expect(frame).toContain('Cycle time p90')
    expect(frame).toContain('Review turnaround p50')
    expect(frame).toContain('Review turnaround p90')
  })
})

describe('tui members sparkline', () => {
  it('includes activity sparkline column for members with history', () => {
    const histories = {
      'mona-lisa': [
        {
          bucket_start: Date.parse('2026-02-01T00:00:00.000Z'),
          bucket_end: Date.parse('2026-02-07T23:59:59.999Z'),
          prs_opened: 2,
          prs_merged: 1,
          prs_closed: 0,
          commits: 3,
          reviews: 4,
          lines_changed: 100,
          activity: 10,
          trend: 'up' as const,
        },
        {
          bucket_start: Date.parse('2026-02-08T00:00:00.000Z'),
          bucket_end: Date.parse('2026-02-14T23:59:59.999Z'),
          prs_opened: 1,
          prs_merged: 2,
          prs_closed: 0,
          commits: 5,
          reviews: 2,
          lines_changed: 200,
          activity: 5,
          trend: 'down' as const,
        },
      ],
    }

    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'members',
      timeZone: 'UTC',
      termWidth: 120,
      memberInsights: {
        'mona-lisa': { score: 100, trend: 'down', delta_pct: -12 },
      },
      histories,
    })

    expect(frame).toContain('Activity')
    // Should contain sparkline characters
    expect(frame).toMatch(/[\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588]/)
  })
})

describe('tui blockers tab', () => {
  it('shows PR title in blockers table', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'blockers',
      timeZone: 'UTC',
    })

    expect(frame).toContain('Title')
    // Title may be truncated due to column budgeting with cursor column
    expect(frame).toContain('Improve report')
  })

  it('colors status when interactive', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'blockers',
      timeZone: 'UTC',
      interactive: true,
    })

    // stale should be yellow (\x1b[33m)
    expect(frame).toContain('\x1b[33mstale\x1b[0m')
  })
})

describe('tui repos tab for team', () => {
  it('shows repo activity derived from cycle_times', () => {
    const report = buildTeamReport()
    report.cycle_times = [
      {
        pr: {
          repo: 'acme-co/webapp',
          number: 10,
          title: 'Test PR',
          author: 'Mona-Lisa',
          state: 'merged',
          draft: false,
          updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
          created_at: Date.parse('2026-02-08T00:00:00.000Z'),
          age_days: 2,
        },
        metrics: { total_time: 1000, review_time: 500, merge_time: 200, draft_time: null },
      },
    ]

    const frame = renderTuiFrame({
      report,
      tab: 'repos',
      timeZone: 'UTC',
    })

    expect(frame).toContain('Repos')
    expect(frame).toContain('acme-co/webapp')
    expect(frame).toContain('PRs')
    expect(frame).toContain('Contributors')
  })

  it('shows message when no repo activity data', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'repos',
      timeZone: 'UTC',
    })

    expect(frame).toContain('No repo activity data')
  })
})

describe('tui member drill-down', () => {
  it('shows cursor indicator on members tab', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'members',
      timeZone: 'UTC',
      termWidth: 120,
      cursorIndex: 0,
    })

    const lines = frame.split('\n')
    const dataLines = lines.filter((l) => l.includes('Mona-Lisa'))
    expect(dataLines.length).toBeGreaterThan(0)
    // First data row should have > cursor
    expect(dataLines[0]).toContain('>')
  })

  it('renders member detail sub-view when selectedMember is set', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'members',
      timeZone: 'UTC',
      memberInsights: {
        'mona-lisa': { score: 100, trend: 'up', delta_pct: 25 },
      },
      selectedMember: 'Mona-Lisa',
    })

    expect(frame).toContain('Member: Mona-Lisa')
    expect(frame).toContain('Summary')
    expect(frame).toContain('PRs authored')
    expect(frame).toContain('Insight')
    expect(frame).toContain('Score: 100')
  })

  it('shows back hint in member detail', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'members',
      timeZone: 'UTC',
      selectedMember: 'Mona-Lisa',
    })

    expect(frame).toContain('[Esc] back to list')
  })

  it('shows recent PRs in member detail when cycle_times exist', () => {
    const report = buildTeamReport()
    report.cycle_times = [
      {
        pr: {
          repo: 'acme-co/webapp',
          number: 42,
          title: 'Add dashboard feature',
          author: 'Mona-Lisa',
          state: 'merged',
          draft: false,
          updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
          created_at: Date.parse('2026-02-08T00:00:00.000Z'),
          age_days: 2,
        },
        metrics: {
          total_time: 86400000,
          review_time: 3600000,
          merge_time: 1800000,
          draft_time: null,
        },
      },
    ]

    const frame = renderTuiFrame({
      report,
      tab: 'members',
      timeZone: 'UTC',
      selectedMember: 'Mona-Lisa',
    })

    expect(frame).toContain('Recent PRs')
    expect(frame).toContain('#42')
    expect(frame).toContain('Add dashboard feature')
    expect(frame).toContain('1d')
  })

  it('shows navigation hints when interactive', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'members',
      timeZone: 'UTC',
      interactive: true,
    })

    expect(stripAnsi(frame)).toContain('[↑↓] navigate')
    expect(stripAnsi(frame)).toContain('[PgUp/Dn] page')
    expect(stripAnsi(frame)).toContain('[Enter] detail')
  })
})

describe('tui viewport scrolling', () => {
  it('only renders visible rows with termHeight constraint', () => {
    const report = buildTeamReport()
    report.members = Array.from({ length: 15 }, (_, i) => ({
      user: `user${i}`,
      prs_authored: i,
      prs_reviewed: i,
      commits: i * 10,
      lines_changed: i * 100,
    }))

    const frame = renderTuiFrame({
      report,
      tab: 'members',
      timeZone: 'UTC',
      termHeight: 15,
      termWidth: 100,
    })

    // Position indicator should appear since 15 members > visible rows
    expect(frame).toMatch(/\[\d+-\d+\/15\]/)
    // Not all users visible
    const lines = frame.split('\n')
    const userLines = lines.filter((l) => /user\d+/.test(l))
    expect(userLines.length).toBeLessThan(15)
  })

  it('scrollOffset adjusts visible window', () => {
    const report = buildTeamReport()
    report.members = Array.from({ length: 15 }, (_, i) => ({
      user: `user${i}`,
      prs_authored: i,
      prs_reviewed: i,
      commits: i * 10,
      lines_changed: i * 100,
    }))

    const frame = renderTuiFrame({
      report,
      tab: 'members',
      timeZone: 'UTC',
      termHeight: 15,
      termWidth: 100,
      scrollOffset: 5,
    })

    // user0-user4 should not be visible
    expect(frame).not.toContain('user0')
    expect(frame).not.toContain('user4')
    // user5 should be visible
    expect(frame).toContain('user5')
  })
})

describe('tui blocker dedup', () => {
  it('deduplicates stale+stuck for same PR', () => {
    const report = buildTeamReport()
    report.blockers = [
      {
        pr: {
          repo: 'acme-co/webapp',
          number: 99,
          title: 'Fix payment flow',
          author: 'alice',
          state: 'open',
          draft: false,
          updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
          created_at: Date.parse('2026-01-01T00:00:00.000Z'),
          age_days: 47,
        },
        status: 'stale',
        days: 7,
      },
      {
        pr: {
          repo: 'acme-co/webapp',
          number: 99,
          title: 'Fix payment flow',
          author: 'alice',
          state: 'open',
          draft: false,
          updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
          created_at: Date.parse('2026-01-01T00:00:00.000Z'),
          age_days: 47,
        },
        status: 'stuck',
        days: 47,
      },
    ]

    const frame = renderTuiFrame({
      report,
      tab: 'blockers',
      timeZone: 'UTC',
    })

    // Should appear once as stale+stuck, not twice
    expect(frame).toContain('stale+stuck')
    const lines = frame.split('\n')
    const dataLines = lines.filter((l) => l.includes('#99'))
    expect(dataLines).toHaveLength(1)
  })

  it('blocker rows do not exceed termWidth with long repo names', () => {
    const report = buildTeamReport()
    report.blockers = [
      {
        pr: {
          repo: 'some-very-long-organization/a-really-long-repository-name-here',
          number: 456,
          title: 'A very long pull request title that should definitely be truncated at some point',
          author: 'longusername123',
          state: 'open',
          draft: false,
          updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
          created_at: Date.parse('2026-01-01T00:00:00.000Z'),
          age_days: 30,
        },
        status: 'stale',
        days: 30,
      },
    ]

    const frame = renderTuiFrame({
      report,
      tab: 'blockers',
      timeZone: 'UTC',
      termWidth: 80,
    })

    const lines = frame.split('\n')
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(80)
    }
  })
})

describe('tui universal cursor', () => {
  it('shows cursor on blockers tab', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'blockers',
      timeZone: 'UTC',
      cursorIndex: 0,
    })

    const lines = frame.split('\n')
    const dataLines = lines.filter((l) => l.includes('#123'))
    expect(dataLines.length).toBeGreaterThan(0)
    expect(dataLines[0]).toContain('>')
  })

  it('shows cursor on repos tab', () => {
    const report = buildTeamReport()
    report.cycle_times = [
      {
        pr: {
          repo: 'acme-co/webapp',
          number: 10,
          title: 'Test PR',
          author: 'Mona-Lisa',
          state: 'merged',
          draft: false,
          updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
          created_at: Date.parse('2026-02-08T00:00:00.000Z'),
          age_days: 2,
        },
        metrics: { total_time: 1000, review_time: 500, merge_time: 200, draft_time: null },
      },
    ]

    const frame = renderTuiFrame({
      report,
      tab: 'repos',
      timeZone: 'UTC',
      cursorIndex: 0,
    })

    const lines = frame.split('\n')
    const dataLines = lines.filter((l) => l.includes('acme-co'))
    expect(dataLines.length).toBeGreaterThan(0)
    expect(dataLines[0]).toContain('>')
  })
})

describe('tui blocker detail', () => {
  it('shows PR fields when selectedBlockerIndex is set', () => {
    const frame = renderTuiFrame({
      report: buildTeamReport(),
      tab: 'blockers',
      timeZone: 'UTC',
      selectedBlockerIndex: 0,
    })

    expect(frame).toContain('Blocker:')
    expect(frame).toContain('Improve report links')
    expect(frame).toContain('Mona-Lisa')
    expect(frame).toContain('stale')
    expect(frame).toContain('[Esc] back')
  })
})

describe('tui repo detail', () => {
  it('shows filtered PRs when selectedRepo is set', () => {
    const report = buildTeamReport()
    report.cycle_times = [
      {
        pr: {
          repo: 'acme-co/webapp',
          number: 10,
          title: 'Dashboard feature',
          author: 'Mona-Lisa',
          state: 'merged',
          draft: false,
          updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
          created_at: Date.parse('2026-02-08T00:00:00.000Z'),
          age_days: 2,
        },
        metrics: { total_time: 1000, review_time: 500, merge_time: 200, draft_time: null },
      },
      {
        pr: {
          repo: 'other/repo',
          number: 20,
          title: 'Other PR',
          author: 'alice',
          state: 'merged',
          draft: false,
          updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
          created_at: Date.parse('2026-02-08T00:00:00.000Z'),
          age_days: 2,
        },
        metrics: { total_time: 2000, review_time: 1000, merge_time: 500, draft_time: null },
      },
    ]

    const frame = renderTuiFrame({
      report,
      tab: 'repos',
      timeZone: 'UTC',
      selectedRepo: 'acme-co/webapp',
    })

    expect(frame).toContain('Repo:')
    expect(frame).toContain('acme-co/webapp')
    expect(frame).toContain('#10')
    expect(frame).toContain('Dashboard feature')
    // Should not show PRs from other repos
    expect(frame).not.toContain('#20')
    expect(frame).toContain('[Esc] back')
  })
})

function buildTeamReport(): Extract<Report, { type: 'team' }> {
  return {
    type: 'team',
    meta: {
      audience: 'team',
      period_label: 'last 30 days',
      start: Date.parse('2026-01-17T00:00:00.000Z'),
      end: Date.parse('2026-02-16T00:00:00.000Z'),
      start_utc: '2026-01-17T00:00:00.000Z',
      end_utc: '2026-02-16T00:00:00.000Z',
      generated_at: Date.parse('2026-02-16T00:00:00.000Z'),
      repos: ['acme-co/webapp'],
      data_freshness: {
        dataAsOf: Date.parse('2026-02-16T00:00:00.000Z'),
        cacheAgeMinutes: 0,
        reposSynced: 1,
        totalRepos: 1,
      },
    },
    team_size: 1,
    velocity: {
      prs_opened: 12,
      prs_merged: 10,
      prs_closed: 1,
      cycle_time_p50: 406000,
      cycle_time_p90: 37955000,
      review_turnaround_p50: 252000,
      review_turnaround_p90: 527000,
    },
    members: [
      {
        user: 'Mona-Lisa',
        prs_authored: 10,
        prs_reviewed: 4,
        commits: 120,
        lines_changed: 40000,
      },
    ],
    shipped: {
      entries: [],
      total_merged: 0,
    },
    themes: {
      groups: [],
    },
    deploy_activity: {
      prs: [],
      total_count: 0,
    },
    repo_breakdown: {
      entries: [],
    },
    blockers: [
      {
        pr: {
          repo: 'acme-co/webapp',
          number: 123,
          title: 'Improve report links',
          author: 'Mona-Lisa',
          state: 'open',
          draft: false,
          updated_at: Date.parse('2026-02-15T00:00:00.000Z'),
          created_at: Date.parse('2026-02-01T00:00:00.000Z'),
          age_days: 15,
        },
        status: 'stale',
        days: 15,
      },
    ],
    cycle_times: [],
    review_engagement: [],
  }
}
