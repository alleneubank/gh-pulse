import { describe, expect, it } from 'bun:test'
import type { Report, Cache } from '@dave/gh-pulse-core'
import {
  buildTrendBuckets,
  formatCompareOutput,
  formatReport,
  formatVersionOutput,
  renderTable,
} from './index'

const THRESHOLDS = { stale_days: 14, stuck_days: 14 }
const OSC_PREFIX = '\u001B]8;;'

describe('version output', () => {
  it('prints semver only outside TTY', () => {
    expect(formatVersionOutput('1.2.3', false)).toBe('gh-pulse 1.2.3')
  })

  it('prints ASCII banner, icon line, and quote in TTY', () => {
    const output = stripAnsi(formatVersionOutput('1.2.3', true))
    expect(output).toContain('____')
    expect(output).toContain('PRs + reviews + commits')
    expect(output).toContain('gh-pulse v1.2.3')
    expect(output).toContain('everyone is blocked in the same direction')
  })
})

describe('CLI hyperlink rendering', () => {
  it('renders OSC 8 links in markdown output when hyperlinks are enabled', () => {
    const report = buildTeamReport()
    const output = formatReport(report, 'markdown', 'UTC', false, THRESHOLDS, {
      linkMode: 'osc8',
    })

    expect(output).toContain('\u001B]8;;https://github.com/acme-co/webapp\u0007')
    expect(output).toContain('\u001B]8;;https://github.com/acme-co/webapp/pull/123\u0007#123')
    expect(output).toContain('\u001B]8;;https://github.com/Mona-Lisa\u0007Mona-Lisa')
  })

  it('does not render OSC 8 links when hyperlinks are disabled', () => {
    const report = buildTeamReport()
    const output = formatReport(report, 'markdown', 'UTC', false, THRESHOLDS, {
      linkMode: 'plain',
    })

    expect(output).not.toContain(OSC_PREFIX)
    expect(output).toContain('| acme-co/webapp | #123 |')
  })

  it('renders markdown links when markdown link mode is selected', () => {
    const report = buildTeamReport()
    const output = formatReport(report, 'markdown', 'UTC', false, THRESHOLDS, {
      linkMode: 'markdown',
    })

    expect(output).toContain('[acme-co/webapp](https://github.com/acme-co/webapp)')
    expect(output).toContain('[#123](https://github.com/acme-co/webapp/pull/123)')
    expect(output).not.toContain(OSC_PREFIX)
  })
})

describe('exec report rendering', () => {
  it('includes cycle time trends section in markdown output', () => {
    const report = buildExecReport()
    const output = formatReport(report, 'markdown', 'UTC', false, THRESHOLDS, {
      linkMode: 'plain',
    })

    expect(output).toContain('## Cycle Time Trends')
    expect(output).toContain('| Week start | Cycle time p50 |')
  })
})

describe('slack report rendering', () => {
  it('uses slack bold section headers instead of markdown headers', () => {
    const output = formatReport(buildTeamReport(), 'slack', 'UTC', false, THRESHOLDS, {
      linkMode: 'slack',
    })

    expect(output).toContain('*Velocity*')
    expect(output).toContain('*Member Breakdown*')
    expect(output).not.toContain('## Velocity')
  })

  it('uses slack links and not markdown link syntax', () => {
    const output = formatReport(buildTeamReport(), 'slack', 'UTC', false, THRESHOLDS, {
      linkMode: 'slack',
    })

    expect(output).toContain('<https://github.com/acme-co/webapp|acme-co/webapp>')
    expect(output).toContain('<https://github.com/acme-co/webapp/pull/321|#321>')
    expect(output).not.toContain('[acme-co/webapp](')
  })

  it('does not render pipe-delimited tables', () => {
    const output = formatReport(buildTeamReport(), 'slack', 'UTC', false, THRESHOLDS, {
      linkMode: 'slack',
    })

    expect(output).not.toMatch(/^\|.*\|$/m)
  })

  it('renders deploy section as a count without individual PR entries', () => {
    const output = formatReport(buildTeamReport(), 'slack', 'UTC', false, THRESHOLDS, {
      linkMode: 'slack',
    })

    expect(output).toContain('*Deploy/CI Activity*')
    expect(output).toContain('- 1 deploy/CI PRs')
    expect(output).not.toContain('deploy: release to prod')
    expect(output).not.toContain('#999')
  })

  it('renders exec report sections in slack format', () => {
    const output = formatReport(buildExecReport(), 'slack', 'UTC', false, THRESHOLDS, {
      linkMode: 'slack',
    })

    expect(output).toContain('*Velocity Trends*')
    expect(output).toContain('*Cycle Time Trends*')
    expect(output).toContain('*Repo Health*')
    expect(output).toContain('*Highlights*')
    expect(output).toContain('*Team Breakdown*')
    expect(output).toContain('*What Shipped (1 PRs merged)*')
    expect(output).toContain('*Themes*')
    expect(output).toContain('*Deploy/CI Activity*')
    expect(output).toContain('*Repo Breakdown*')
  })

  it('renders personal blockers with status and age', () => {
    const output = formatReport(
      buildPersonalReportWithOldOpenPr(),
      'slack',
      'UTC',
      true,
      { stale_days: 7, stuck_days: 7 },
      {
        linkMode: 'slack',
      },
    )

    expect(output).toContain('*Blockers*')
    expect(output).toContain('<https://github.com/acme-co/webapp/pull/101|#101>')
    expect(output).toContain('stale+stuck')
    expect(output).toContain('days=')
  })

  it('hides deploy activity and limits blockers in concise mode', () => {
    const output = formatReport(
      buildTeamReportWithManyBlockers(),
      'slack',
      'UTC',
      false,
      THRESHOLDS,
      {
        linkMode: 'slack',
        concise: true,
      },
    )

    expect(output).not.toContain('*Deploy/CI Activity*')
    expect(output).toContain('and 2 more...')
    expect(output).toContain('<https://github.com/acme-co/webapp/pull/119|#119>')
    expect(output).not.toContain('<https://github.com/acme-co/webapp/pull/109|#109>')
  })

  it('renders shipped body snippets under each shipped PR', () => {
    const output = formatReport(buildTeamReport(), 'slack', 'UTC', false, THRESHOLDS, {
      linkMode: 'slack',
    })

    expect(output).toContain('Faster PR summaries for weekly updates.')
  })
})

describe('shipped/themes/deploy/repo rendering', () => {
  it('renders shipped author groups in table format', () => {
    const output = formatReport(buildTeamReport(), 'table', 'UTC', false, THRESHOLDS, {
      linkMode: 'plain',
    })

    expect(output).toContain('What Shipped (2 PRs merged)')
    expect(output).toContain('Mona-Lisa')
    expect(output).toContain('#321')
  })

  it('renders body snippets under shipped PR entries', () => {
    const output = formatReport(buildTeamReport(), 'markdown', 'UTC', false, THRESHOLDS, {
      linkMode: 'plain',
    })

    expect(output).toContain('Faster PR summaries for weekly updates.')
  })

  it('renders themes section in markdown', () => {
    const output = formatReport(buildTeamReport(), 'markdown', 'UTC', false, THRESHOLDS, {
      linkMode: 'plain',
    })

    expect(output).toContain('## Themes')
    expect(output).toContain('| Category | Count |')
    expect(output).toContain('| Features | 1 |')
    expect(output).toContain('| Bug Fixes | 1 |')
  })

  it('renders deploy activity section in table format', () => {
    const output = formatReport(buildTeamReport(), 'table', 'UTC', false, THRESHOLDS, {
      linkMode: 'plain',
    })

    expect(output).toContain('Deploy/CI Activity (1 PRs)')
    expect(output).toContain('dependabot[bot]')
    expect(output).toContain('deploy: release to prod')
  })

  it('renders repo breakdown in markdown', () => {
    const output = formatReport(buildTeamReport(), 'markdown', 'UTC', false, THRESHOLDS, {
      linkMode: 'plain',
    })

    expect(output).toContain('## Repo Breakdown')
    expect(output).toContain('### acme-co/webapp - Web app')
    expect(output).toContain('| PR | Author | Title |')
  })

  it('includes shipped/themes/deploy/repo fields in json output', () => {
    const parsed = JSON.parse(
      formatReport(buildTeamReport(), 'json', 'UTC', false, THRESHOLDS, { linkMode: 'plain' }),
    )

    expect(parsed.shipped).toBeDefined()
    expect(parsed.themes).toBeDefined()
    expect(parsed.deploy_activity).toBeDefined()
    expect(parsed.repo_breakdown).toBeDefined()
  })

  it('hides deploy activity and limits blockers in concise mode', () => {
    const output = formatReport(
      buildTeamReportWithManyBlockers(),
      'markdown',
      'UTC',
      false,
      THRESHOLDS,
      {
        linkMode: 'plain',
        concise: true,
      },
    )

    expect(output).not.toContain('## Deploy/CI Activity')
    expect(output).toContain('and 2 more...')
    expect(output).toContain('| acme-co/webapp | #119 |')
    expect(output).not.toContain('| acme-co/webapp | #109 |')
  })

  it('omits deploy_activity from concise json output', () => {
    const parsed = JSON.parse(
      formatReport(buildTeamReport(), 'json', 'UTC', false, THRESHOLDS, {
        linkMode: 'plain',
        concise: true,
      }),
    )

    expect(parsed.deploy_activity).toBeUndefined()
  })

  it('supports customer format preset with feature/fix-only output', () => {
    const output = formatReport(buildTeamReport(), 'customer', 'UTC', false, THRESHOLDS, {
      linkMode: 'plain',
    })

    expect(output).toContain('# gh-pulse customer update')
    expect(output).toContain('## Features')
    expect(output).toContain('## Bug Fixes')
    expect(output).not.toContain('## CI')
    expect(output).not.toContain('Deploy/CI Activity')
  })
})

describe('blocker rendering', () => {
  it('collapses stale+stuck blocker rows for the same PR', () => {
    const report = buildPersonalReportWithOldOpenPr()
    const output = formatReport(
      report,
      'markdown',
      'UTC',
      true,
      { stale_days: 7, stuck_days: 7 },
      {
        linkMode: 'plain',
      },
    )

    expect(output).toContain('| acme-co/webapp | #101 | stale+stuck |')
    expect(output.match(/\| acme-co\/webapp \| #101 \|/g)?.length ?? 0).toBe(1)
  })
})

describe('compare output', () => {
  it('keeps review totals without rendering history tables', () => {
    const reports: Array<Extract<Report, { type: 'personal' | 'individual' }>> = [
      buildCompareReport('alice'),
      buildCompareReport('bob'),
    ]
    const histories = {
      alice: [
        {
          bucket_start: Date.parse('2026-02-01T00:00:00.000Z'),
          bucket_end: Date.parse('2026-02-07T23:59:59.999Z'),
          prs_opened: 2,
          prs_merged: 1,
          prs_closed: 0,
          commits: 3,
          reviews: 4,
          lines_changed: 30,
          activity: 10,
          trend: 'up' as const,
        },
      ],
      bob: [
        {
          bucket_start: Date.parse('2026-02-01T00:00:00.000Z'),
          bucket_end: Date.parse('2026-02-07T23:59:59.999Z'),
          prs_opened: 1,
          prs_merged: 1,
          prs_closed: 0,
          commits: 2,
          reviews: 1,
          lines_changed: 10,
          activity: 5,
          trend: 'flat' as const,
        },
      ],
    }

    const output = formatCompareOutput(reports, 'markdown', 'UTC', 'plain', {}, histories, false)

    expect(output).toContain('| alice | 1 | 1 | 0 | 4 |')
    expect(output).toContain('| bob | 1 | 1 | 0 | 1 |')
    expect(output).not.toContain('## History')
  })
})

describe('table renderer with OSC links', () => {
  it('keeps columns aligned based on visible cell width', () => {
    const repoCell =
      '\u001B]8;;https://github.com/acme-co/webapp\u0007acme-co/webapp\u001B]8;;\u0007'
    const prCell = '\u001B]8;;https://github.com/acme-co/webapp/pull/123\u0007#123\u001B]8;;\u0007'
    const ownerCell = '\u001B]8;;https://github.com/Mona-Lisa\u0007Mona-Lisa\u001B]8;;\u0007'

    const output = renderTable(
      ['Repo', 'PR', 'Owner', 'Status', 'Days'],
      [[repoCell, prCell, ownerCell, 'stuck', '15']],
    )

    const lines = output.split('\n')
    const visibleLineLengths = lines.map((line) => stripOsc8(line).length)
    expect(new Set(visibleLineLengths).size).toBe(1)
  })
})

function stripOsc8(input: string): string {
  const esc = String.fromCharCode(27)
  const bell = String.fromCharCode(7)
  const prefix = `${esc}]8;;`

  let result = ''
  let index = 0
  while (index < input.length) {
    const marker = input.indexOf(prefix, index)
    if (marker === -1) {
      result += input.slice(index)
      break
    }
    result += input.slice(index, marker)
    const terminator = input.indexOf(bell, marker + prefix.length)
    if (terminator === -1) {
      break
    }
    index = terminator + 1
  }
  return result
}

function stripAnsi(input: string): string {
  return Bun.stripANSI(input)
}

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
      total_merged: 2,
      entries: [
        {
          author: 'Mona-Lisa',
          prs: [
            {
              repo: 'acme-co/webapp',
              number: 321,
              title: 'feat: ship shipped section',
              body_snippet: 'Faster PR summaries for weekly updates.',
              author: 'Mona-Lisa',
              state: 'merged',
              draft: false,
              updated_at: Date.parse('2026-02-15T00:00:00.000Z'),
              created_at: Date.parse('2026-02-14T00:00:00.000Z'),
              age_days: 1,
            },
          ],
        },
        {
          author: 'alice',
          prs: [
            {
              repo: 'acme-co/webapp',
              number: 322,
              title: 'fix: patch cli output',
              body_snippet: 'Fixes missing links in markdown output.',
              author: 'alice',
              state: 'merged',
              draft: false,
              updated_at: Date.parse('2026-02-14T00:00:00.000Z'),
              created_at: Date.parse('2026-02-13T00:00:00.000Z'),
              age_days: 1,
            },
          ],
        },
      ],
    },
    themes: {
      groups: [
        {
          type: 'feat',
          label: 'Features',
          prs: [
            {
              repo: 'acme-co/webapp',
              number: 321,
              title: 'feat: ship shipped section',
              body_snippet: 'Faster PR summaries for weekly updates.',
              author: 'Mona-Lisa',
              state: 'merged',
              draft: false,
              updated_at: Date.parse('2026-02-15T00:00:00.000Z'),
              created_at: Date.parse('2026-02-14T00:00:00.000Z'),
              age_days: 1,
            },
          ],
        },
        {
          type: 'ci',
          label: 'CI',
          prs: [
            {
              repo: 'acme-co/webapp',
              number: 400,
              title: 'ci: tighten deploy workflow',
              body_snippet: 'Internal CI tuning only.',
              author: 'bot',
              state: 'merged',
              draft: false,
              updated_at: Date.parse('2026-02-13T00:00:00.000Z'),
              created_at: Date.parse('2026-02-12T00:00:00.000Z'),
              age_days: 1,
            },
          ],
        },
        {
          type: 'fix',
          label: 'Bug Fixes',
          prs: [
            {
              repo: 'acme-co/webapp',
              number: 322,
              title: 'fix: patch cli output',
              body_snippet: 'Fixes missing links in markdown output.',
              author: 'alice',
              state: 'merged',
              draft: false,
              updated_at: Date.parse('2026-02-14T00:00:00.000Z'),
              created_at: Date.parse('2026-02-13T00:00:00.000Z'),
              age_days: 1,
            },
          ],
        },
      ],
    },
    deploy_activity: {
      total_count: 1,
      prs: [
        {
          repo: 'acme-co/webapp',
          number: 999,
          title: 'deploy: release to prod',
          author: 'dependabot[bot]',
          state: 'merged',
          draft: false,
          updated_at: Date.parse('2026-02-15T00:00:00.000Z'),
          created_at: Date.parse('2026-02-15T00:00:00.000Z'),
          age_days: 0,
        },
      ],
    },
    repo_breakdown: {
      entries: [
        {
          repo: 'acme-co/webapp',
          repo_description: 'Web app',
          prs_opened: 3,
          prs_merged: 2,
          contributors: ['Mona-Lisa', 'alice'],
          shipped: [
            {
              repo: 'acme-co/webapp',
              number: 321,
              title: 'feat: ship shipped section',
              body_snippet: 'Faster PR summaries for weekly updates.',
              author: 'Mona-Lisa',
              state: 'merged',
              draft: false,
              updated_at: Date.parse('2026-02-15T00:00:00.000Z'),
              created_at: Date.parse('2026-02-14T00:00:00.000Z'),
              age_days: 1,
            },
            {
              repo: 'acme-co/webapp',
              number: 322,
              title: 'fix: patch cli output',
              body_snippet: 'Fixes missing links in markdown output.',
              author: 'alice',
              state: 'merged',
              draft: false,
              updated_at: Date.parse('2026-02-14T00:00:00.000Z'),
              created_at: Date.parse('2026-02-13T00:00:00.000Z'),
              age_days: 1,
            },
          ],
        },
      ],
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

function buildTeamReportWithManyBlockers(): Extract<Report, { type: 'team' }> {
  const report = buildTeamReport()
  const blockers = Array.from({ length: 12 }).map((_, index) => {
    const number = 119 - index
    return {
      pr: {
        repo: 'acme-co/webapp',
        number,
        title: `Blocked PR ${number}`,
        author: index % 2 === 0 ? 'Mona-Lisa' : 'alice',
        state: 'open' as const,
        draft: false,
        updated_at: Date.parse('2026-02-15T00:00:00.000Z') - index * 86_400_000,
        created_at: Date.parse('2026-01-20T00:00:00.000Z') - index * 86_400_000,
        age_days: 20 + index,
      },
      status: 'stale' as const,
      days: 40 - index,
    }
  })

  return {
    ...report,
    blockers,
  }
}

function buildExecReport(): Extract<Report, { type: 'exec' }> {
  return {
    type: 'exec',
    meta: {
      audience: 'exec',
      period_label: 'last quarter',
      start: Date.parse('2025-11-01T00:00:00.000Z'),
      end: Date.parse('2026-02-16T00:00:00.000Z'),
      start_utc: '2025-11-01T00:00:00.000Z',
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
    velocity_trends: [
      {
        bucket_start: Date.parse('2026-02-01T00:00:00.000Z'),
        bucket_end: Date.parse('2026-02-07T23:59:59.999Z'),
        prs_merged: 5,
        cycle_time_p50: 406000,
      },
    ],
    cycle_time_trends: [
      {
        bucket_start: Date.parse('2026-02-01T00:00:00.000Z'),
        bucket_end: Date.parse('2026-02-07T23:59:59.999Z'),
        prs_merged: 5,
        cycle_time_p50: 406000,
      },
    ],
    repo_health: [
      {
        repo: 'acme-co/webapp',
        status: 'active',
        last_activity_at: Date.parse('2026-02-15T00:00:00.000Z'),
      },
    ],
    highlights: [
      {
        pr: {
          repo: 'acme-co/webapp',
          number: 456,
          title: 'Ship cycle trend section',
          author: 'Mona-Lisa',
          state: 'merged',
          draft: false,
          updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
          created_at: Date.parse('2026-02-08T00:00:00.000Z'),
          age_days: 2,
        },
        reasons: ['large change (900 lines)'],
      },
    ],
    team_breakdown: [
      {
        user: 'Mona-Lisa',
        prs_authored: 8,
        prs_reviewed: 5,
        commits: 90,
        lines_changed: 25000,
      },
    ],
    shipped: {
      total_merged: 1,
      entries: [
        {
          author: 'Mona-Lisa',
          prs: [
            {
              repo: 'acme-co/webapp',
              number: 456,
              title: 'feat: ship cycle trend section',
              author: 'Mona-Lisa',
              state: 'merged',
              draft: false,
              updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
              created_at: Date.parse('2026-02-08T00:00:00.000Z'),
              age_days: 2,
            },
          ],
        },
      ],
    },
    themes: {
      groups: [
        {
          type: 'feat',
          label: 'Features',
          prs: [
            {
              repo: 'acme-co/webapp',
              number: 456,
              title: 'feat: ship cycle trend section',
              author: 'Mona-Lisa',
              state: 'merged',
              draft: false,
              updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
              created_at: Date.parse('2026-02-08T00:00:00.000Z'),
              age_days: 2,
            },
          ],
        },
      ],
    },
    deploy_activity: {
      total_count: 1,
      prs: [
        {
          repo: 'acme-co/webapp',
          number: 999,
          title: 'release: v1.2.3',
          author: 'release-bot',
          state: 'merged',
          draft: false,
          updated_at: Date.parse('2026-02-12T00:00:00.000Z'),
          created_at: Date.parse('2026-02-12T00:00:00.000Z'),
          age_days: 0,
        },
      ],
    },
    repo_breakdown: {
      entries: [
        {
          repo: 'acme-co/webapp',
          prs_opened: 4,
          prs_merged: 1,
          contributors: ['Mona-Lisa'],
          shipped: [
            {
              repo: 'acme-co/webapp',
              number: 456,
              title: 'feat: ship cycle trend section',
              author: 'Mona-Lisa',
              state: 'merged',
              draft: false,
              updated_at: Date.parse('2026-02-10T00:00:00.000Z'),
              created_at: Date.parse('2026-02-08T00:00:00.000Z'),
              age_days: 2,
            },
          ],
        },
      ],
    },
  }
}

function buildPersonalReportWithOldOpenPr(): Extract<Report, { type: 'personal' | 'individual' }> {
  const now = Date.parse('2026-02-16T00:00:00.000Z')
  const createdAt = Date.parse('2026-01-20T00:00:00.000Z')
  const updatedAt = Date.parse('2026-01-20T00:00:00.000Z')

  return {
    type: 'personal',
    user: 'Mona-Lisa',
    meta: {
      audience: 'personal',
      period_label: 'last 30 days',
      start: Date.parse('2026-01-17T00:00:00.000Z'),
      end: now,
      start_utc: '2026-01-17T00:00:00.000Z',
      end_utc: '2026-02-16T00:00:00.000Z',
      generated_at: now,
      repos: ['acme-co/webapp'],
      data_freshness: {
        dataAsOf: now,
        cacheAgeMinutes: 0,
        reposSynced: 1,
        totalRepos: 1,
      },
    },
    summary: {
      prs_opened: 1,
      prs_merged: 0,
      prs_closed: 0,
      commits: 0,
      repos_touched: 1,
      lines_changed: 0,
    },
    review_debt: {
      requested: [],
      team_prs: [],
    },
    open_work: {
      open_prs: [
        {
          repo: 'acme-co/webapp',
          number: 101,
          title: 'Old open PR',
          author: 'Mona-Lisa',
          state: 'open',
          draft: false,
          updated_at: updatedAt,
          created_at: createdAt,
          age_days: 20,
        },
      ],
    },
    authored_prs: [],
    commits_detail: [],
  }
}

function buildCompareReport(user: string): Extract<Report, { type: 'personal' | 'individual' }> {
  const now = Date.parse('2026-02-16T00:00:00.000Z')
  return {
    type: 'individual',
    user,
    meta: {
      audience: 'individual',
      period_label: 'last 30 days',
      start: Date.parse('2026-01-17T00:00:00.000Z'),
      end: now,
      start_utc: '2026-01-17T00:00:00.000Z',
      end_utc: '2026-02-16T00:00:00.000Z',
      generated_at: now,
      repos: ['acme-co/webapp'],
      data_freshness: {
        dataAsOf: now,
        cacheAgeMinutes: 0,
        reposSynced: 1,
        totalRepos: 1,
      },
    },
    summary: {
      prs_opened: 1,
      prs_merged: 1,
      prs_closed: 0,
      commits: 2,
      repos_touched: 1,
      lines_changed: 20,
    },
    review_debt: { requested: [], team_prs: [] },
    open_work: { open_prs: [] },
    authored_prs: [],
    commits_detail: [],
  }
}

// -- buildTrendBuckets tests --

const DAY_MS = 24 * 60 * 60 * 1000

interface MockCacheOptions {
  dailyPrs?: Array<{
    author: string
    day_start: number
    opened: number
    merged: number
    closed: number
  }>
  dailyCommits?: Array<{
    author: string
    day_start: number
    commits: number
    additions: number
    deletions: number
  }>
  dailyReviews?: Array<{ reviewer: string; day_start: number; reviews: number }>
  events?: Array<{ type: string; repo: string; [key: string]: unknown }>
  commits?: Array<{
    repo: string
    author: string
    committed_at: number
    additions: number
    deletions: number
    [key: string]: unknown
  }>
  pullRequests?: Array<{ repo: string; number: number; author: string; [key: string]: unknown }>
}

function mockCache(
  prs: MockCacheOptions['dailyPrs'] = [],
  dailyCommitsData: MockCacheOptions['dailyCommits'] = [],
  reviews: MockCacheOptions['dailyReviews'] = [],
  opts: Pick<MockCacheOptions, 'events' | 'commits' | 'pullRequests'> = {},
): Cache {
  return {
    getDailyPrs: (filter: { start?: number; end?: number } = {}) =>
      (prs ?? [])
        .filter((row) => filter.start === undefined || row.day_start >= filter.start)
        .filter((row) => filter.end === undefined || row.day_start <= filter.end)
        .map((row) => ({ repo: 'org/repo', day: '', ...row })),
    getDailyCommits: (filter: { start?: number; end?: number } = {}) =>
      (dailyCommitsData ?? [])
        .filter((row) => filter.start === undefined || row.day_start >= filter.start)
        .filter((row) => filter.end === undefined || row.day_start <= filter.end)
        .map((row) => ({ repo: 'org/repo', day: '', files_changed: 0, ...row })),
    getDailyReviews: (filter: { start?: number; end?: number } = {}) =>
      (reviews ?? [])
        .filter((row) => filter.start === undefined || row.day_start >= filter.start)
        .filter((row) => filter.end === undefined || row.day_start <= filter.end)
        .map((row) => ({
          repo: 'org/repo',
          day: '',
          approved: 0,
          changes_requested: 0,
          commented: 0,
          ...row,
        })),
    getEvents: (filter: { since?: number; until?: number } = {}) =>
      (opts.events ?? []).filter((event) => {
        const ts =
          (event as Record<string, unknown>).opened_at ??
          (event as Record<string, unknown>).merged_at ??
          (event as Record<string, unknown>).closed_at ??
          (event as Record<string, unknown>).submitted_at ??
          (event as Record<string, unknown>).committed_at ??
          (event as Record<string, unknown>).timestamp ??
          0
        return (
          (filter.since === undefined || (ts as number) >= filter.since) &&
          (filter.until === undefined || (ts as number) <= filter.until)
        )
      }),
    getCommits: (filter: { since?: number; until?: number } = {}) =>
      (opts.commits ?? []).filter(
        (commit) =>
          (filter.since === undefined || commit.committed_at >= filter.since) &&
          (filter.until === undefined || commit.committed_at <= filter.until),
      ),
    getPullRequests: () => opts.pullRequests ?? [],
  } as unknown as Cache
}

describe('buildTrendBuckets', () => {
  it('creates two period-sized buckets with correct boundaries', () => {
    // 7-day range: day 7 00:00 through day 13 23:59:59.999
    const start = 7 * DAY_MS
    const end = 14 * DAY_MS - 1
    const cache = mockCache([], [], [])

    const buckets = buildTrendBuckets(cache, ['org/repo'], 'alice', { start, end }, 'UTC')

    expect(buckets).toHaveLength(2)
    // Prior bucket: day 0 through day 6 end
    expect(buckets[0]!.bucket_start).toBe(0)
    expect(buckets[0]!.bucket_end).toBe(start - 1)
    // Current bucket: day 7 through day 13 end
    expect(buckets[1]!.bucket_start).toBe(start)
    expect(buckets[1]!.bucket_end).toBe(end)
    // Both buckets have equal duration
    const priorDuration = buckets[0]!.bucket_end - buckets[0]!.bucket_start + 1
    const currentDuration = buckets[1]!.bucket_end - buckets[1]!.bucket_start + 1
    expect(priorDuration).toBe(currentDuration)
  })

  it('aggregates activity into correct period buckets', () => {
    const start = 7 * DAY_MS
    const end = 14 * DAY_MS - 1
    // Prior period: days 0-6, Current period: days 7-13
    const cache = mockCache(
      [
        { author: 'alice', day_start: 2 * DAY_MS, opened: 1, merged: 0, closed: 0 }, // prior
        { author: 'alice', day_start: 5 * DAY_MS, opened: 0, merged: 1, closed: 0 }, // prior
        { author: 'alice', day_start: 8 * DAY_MS, opened: 2, merged: 1, closed: 0 }, // current
        { author: 'alice', day_start: 12 * DAY_MS, opened: 1, merged: 2, closed: 0 }, // current
      ],
      [
        { author: 'alice', day_start: 3 * DAY_MS, commits: 3, additions: 10, deletions: 5 },
        { author: 'alice', day_start: 9 * DAY_MS, commits: 7, additions: 20, deletions: 10 },
      ],
      [
        { reviewer: 'alice', day_start: 4 * DAY_MS, reviews: 2 },
        { reviewer: 'alice', day_start: 10 * DAY_MS, reviews: 4 },
      ],
    )

    const buckets = buildTrendBuckets(cache, ['org/repo'], 'alice', { start, end }, 'UTC')

    // Prior bucket: 1 opened + 1 merged + 3 commits + 2 reviews = 7
    expect(buckets[0]!.activity).toBe(7)
    expect(buckets[0]!.prs_opened).toBe(1)
    expect(buckets[0]!.prs_merged).toBe(1)
    expect(buckets[0]!.commits).toBe(3)
    expect(buckets[0]!.reviews).toBe(2)
    // Current bucket: 3 opened + 3 merged + 7 commits + 4 reviews = 17
    expect(buckets[1]!.activity).toBe(17)
    expect(buckets[1]!.prs_opened).toBe(3)
    expect(buckets[1]!.prs_merged).toBe(3)
    expect(buckets[1]!.commits).toBe(7)
    expect(buckets[1]!.reviews).toBe(4)
  })

  it('does not drop first prior day on day-aligned ranges', () => {
    const start = 7 * DAY_MS
    const end = 14 * DAY_MS - 1
    const cache = mockCache(
      [{ author: 'alice', day_start: 0, opened: 5, merged: 0, closed: 0 }],
      [],
      [],
    )

    const buckets = buildTrendBuckets(cache, ['org/repo'], 'alice', { start, end }, 'UTC')

    expect(buckets[0]!.bucket_start).toBe(0)
    expect(buckets[0]!.prs_opened).toBe(5)
    expect(buckets[0]!.activity).toBe(5)
  })

  it('returns empty prior bucket when no prior data exists', () => {
    const start = 7 * DAY_MS
    const end = 14 * DAY_MS - 1
    const cache = mockCache(
      [{ author: 'alice', day_start: 10 * DAY_MS, opened: 3, merged: 0, closed: 0 }],
      [],
      [],
    )

    const buckets = buildTrendBuckets(cache, ['org/repo'], 'alice', { start, end }, 'UTC')

    expect(buckets[0]!.activity).toBe(0)
    expect(buckets[1]!.activity).toBe(3)
  })

  it('uses splitRangeByDay: full-day rollups + edge events for mid-day windows', () => {
    // --period week at noon: start = noon day 7, end = noon day 14
    // splitRangeByDay gives: fullDays = [day8, day13], edges = [day7 noon..end, day14 start..noon]
    // Daily rollups cover full days 8-13. Edge events cover the partial days.
    const NOON = 12 * 60 * 60 * 1000
    const start = 7 * DAY_MS + NOON
    const end = 14 * DAY_MS + NOON
    const cache = mockCache(
      [
        { author: 'alice', day_start: 8 * DAY_MS, opened: 3, merged: 0, closed: 0 }, // full day rollup
      ],
      [],
      [],
      {
        events: [
          // Edge event on day 7 afternoon (within current edge)
          {
            type: 'pr_opened',
            repo: 'org/repo',
            author: 'alice',
            opened_at: 7 * DAY_MS + NOON + 1000,
            pr_number: 1,
            is_draft: false,
          },
          // Edge event on day 14 morning (within current edge)
          {
            type: 'pr_opened',
            repo: 'org/repo',
            author: 'alice',
            opened_at: 14 * DAY_MS + 1000,
            pr_number: 2,
            is_draft: false,
          },
        ],
      },
    )

    const buckets = buildTrendBuckets(cache, ['org/repo'], 'alice', { start, end }, 'UTC')

    // Bucket boundaries match actual timeRange
    expect(buckets[1]!.bucket_start).toBe(start)
    expect(buckets[1]!.bucket_end).toBe(end)
    // Full-day rollup (3) + 2 edge events = 5
    expect(buckets[1]!.prs_opened).toBe(5)
  })

  it('includes trailing-edge-day activity via events (ISSUE-6)', () => {
    // Repro: noon-to-noon weekly range with one PR opened on the trailing
    // partial day. The report counts it via edge events, trend must too.
    const NOON = 12 * 60 * 60 * 1000
    const start = 7 * DAY_MS + NOON
    const end = 14 * DAY_MS + NOON
    const cache = mockCache([], [], [], {
      events: [
        {
          type: 'pr_opened',
          repo: 'org/repo',
          author: 'alice',
          opened_at: 14 * DAY_MS + 1000,
          pr_number: 1,
          is_draft: false,
        },
      ],
    })

    const buckets = buildTrendBuckets(cache, ['org/repo'], 'alice', { start, end }, 'UTC')

    expect(buckets[1]!.prs_opened).toBe(1)
    expect(buckets[1]!.activity).toBe(1)
    expect(buckets[0]!.activity).toBe(0)
  })

  it('today-at-noon: edge commits count correctly, not full-day rollup (ISSUE-9/11)', () => {
    // --period today at noon: start = day1 00:00, end = day1 12:00
    // splitRangeByDay: no full days (same day), edges = [{day1 00:00, day1 12:00}]
    // Prior: {day0 12:00, day1 00:00 - 1}, edges = [{day0 12:00, day0 end}]
    // Edge commits (not daily rollups) are counted, so only in-range commits matter.
    const NOON = 12 * 60 * 60 * 1000
    const start = 1 * DAY_MS
    const end = 1 * DAY_MS + NOON
    const cache = mockCache([], [], [], {
      commits: [
        // 6 commits in prior edge (day0 afternoon): 1 per 2h from noon to midnight
        ...Array.from({ length: 6 }, (_, i) => ({
          repo: 'org/repo',
          sha: `p${i}`,
          author: 'alice',
          committed_at: 0 * DAY_MS + NOON + i * 2 * 60 * 60 * 1000,
          message: '',
          additions: 10,
          deletions: 0,
          files_changed: 1,
        })),
        // 6 commits in current edge (day1 morning): same pace
        ...Array.from({ length: 6 }, (_, i) => ({
          repo: 'org/repo',
          sha: `c${i}`,
          author: 'alice',
          committed_at: 1 * DAY_MS + i * 2 * 60 * 60 * 1000,
          message: '',
          additions: 10,
          deletions: 0,
          files_changed: 1,
        })),
      ],
    })

    const buckets = buildTrendBuckets(cache, ['org/repo'], 'alice', { start, end }, 'UTC')

    // Both buckets get exactly 6 commits from edge events (not full-day rollups)
    expect(buckets[0]!.commits).toBe(6)
    expect(buckets[1]!.commits).toBe(6)
    // Bucket boundaries reflect actual period, not expanded day
    expect(buckets[1]!.bucket_start).toBe(start)
    expect(buckets[1]!.bucket_end).toBe(end)
    const priorDuration = buckets[0]!.bucket_end - buckets[0]!.bucket_start + 1
    const currentDuration = buckets[1]!.bucket_end - buckets[1]!.bucket_start + 1
    expect(priorDuration).toBe(currentDuration)
  })

  it('handles DST spring-forward: prior edge events counted correctly', () => {
    // March 8, 2026 DST spring-forward in America/Chicago (CST→CDT at 2am)
    // CST = UTC-6, CDT = UTC-5
    // Current: March 8 00:00 CST to March 14 23:59:59.999 CDT (6d 23h due to DST)
    // Prior: same duration back → starts March 1 01:00 CST (not midnight, DST-shortened)
    // splitRangeByDay on prior: March 1 is an edge (01:00-23:59 CST),
    // March 2-7 are full days.
    const march8_midnight_cst = Date.UTC(2026, 2, 8, 6, 0, 0, 0)
    const march14_end_cdt = Date.UTC(2026, 2, 15, 5, 0, 0, 0) - 1
    const tz = 'America/Chicago'

    // March 5 00:00 CST rollup (full day in prior period)
    const march5_midnight_cst = Date.UTC(2026, 2, 5, 6, 0, 0, 0)
    // March 1 event at 10:00 CST (within prior edge: 01:00 CST to 23:59 CST)
    const march1_10am_cst = Date.UTC(2026, 2, 1, 16, 0, 0, 0) // 10:00 CST = 16:00 UTC

    const cache = mockCache(
      [{ author: 'alice', day_start: march5_midnight_cst, opened: 2, merged: 0, closed: 0 }],
      [],
      [],
      {
        events: [
          {
            type: 'pr_opened',
            repo: 'org/repo',
            author: 'alice',
            opened_at: march1_10am_cst,
            pr_number: 1,
            is_draft: false,
          },
        ],
      },
    )

    const buckets = buildTrendBuckets(
      cache,
      ['org/repo'],
      'alice',
      { start: march8_midnight_cst, end: march14_end_cdt },
      tz,
    )

    expect(buckets[1]!.bucket_start).toBe(march8_midnight_cst)
    // Prior: 2 from March 5 full-day rollup + 1 from March 1 edge event
    expect(buckets[0]!.prs_opened).toBe(3)
    expect(buckets[0]!.activity).toBe(3)
    // Both buckets have equal duration
    const priorDuration = buckets[0]!.bucket_end - buckets[0]!.bucket_start + 1
    const currentDuration = buckets[1]!.bucket_end - buckets[1]!.bucket_start + 1
    expect(priorDuration).toBe(currentDuration)
  })

  it('counts edge commits from co-authors via commitMatchesContributor (ISSUE-12)', () => {
    // A commit authored by teammate with alice as co-author on an edge day.
    // commitMatchesContributor should attribute it to alice.
    const NOON = 12 * 60 * 60 * 1000
    const start = 1 * DAY_MS
    const end = 1 * DAY_MS + NOON
    const cache = mockCache([], [], [], {
      commits: [
        {
          repo: 'org/repo',
          sha: 'abc',
          author: 'teammate',
          committed_at: 1 * DAY_MS + 1000,
          message: '',
          additions: 10,
          deletions: 0,
          files_changed: 1,
          co_authors: [{ username: 'alice', email: 'alice@example.com' }],
        },
      ],
    })

    const buckets = buildTrendBuckets(cache, ['org/repo'], 'alice', { start, end }, 'UTC')

    expect(buckets[1]!.commits).toBe(1)
    expect(buckets[1]!.lines_changed).toBe(10)
  })

  it('attributes edge pr_merged/pr_closed via PR lookup (ISSUE-13)', () => {
    // A PR authored by alice, merged on an edge day by someone else.
    // The merge event should be attributed to alice via prLookup.
    const NOON = 12 * 60 * 60 * 1000
    const start = 1 * DAY_MS
    const end = 1 * DAY_MS + NOON
    const cache = mockCache([], [], [], {
      events: [
        {
          type: 'pr_merged',
          repo: 'org/repo',
          pr_number: 42,
          merged_at: 1 * DAY_MS + 1000,
          merged_by: 'maintainer',
        },
        {
          type: 'pr_closed',
          repo: 'org/repo',
          pr_number: 43,
          closed_at: 1 * DAY_MS + 2000,
        },
      ],
      pullRequests: [
        {
          repo: 'org/repo',
          number: 42,
          author: 'alice',
          title: '',
          body: null,
          state: 'closed',
          draft: false,
          created_at: 0,
          updated_at: 0,
          merged_at: 1 * DAY_MS + 1000,
          closed_at: null,
        },
        {
          repo: 'org/repo',
          number: 43,
          author: 'alice',
          title: '',
          body: null,
          state: 'closed',
          draft: false,
          created_at: 0,
          updated_at: 0,
          merged_at: null,
          closed_at: 1 * DAY_MS + 2000,
        },
      ],
    })

    const buckets = buildTrendBuckets(cache, ['org/repo'], 'alice', { start, end }, 'UTC')

    expect(buckets[1]!.prs_merged).toBe(1)
    expect(buckets[1]!.prs_closed).toBe(1)
    expect(buckets[1]!.activity).toBe(2)
  })
})
