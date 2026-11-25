import { formatTimestamp } from '@alleneubank/gh-pulse-core'
import type { Report } from '@alleneubank/gh-pulse-core'
import type { TrendDirection } from './trends'
import {
  colors,
  renderTable,
  renderBudgetedTable,
  trendArrow,
  formatSignedPercent,
  formatMemberScore,
  formatDurationMetric,
  formatDurationMs,
  repoCell,
  prCell,
  userCell,
  deriveTeamBlockers,
} from './format'
import type { ColumnSpec, LinkMode } from './format'

export type TuiTab = 'overview' | 'members' | 'blockers' | 'repos'

export interface MemberInsight {
  score: number
  trend: TrendDirection
  delta_pct: number
}

export interface UserHistoryPoint {
  bucket_start: number
  bucket_end: number
  prs_opened: number
  prs_merged: number
  prs_closed: number
  commits: number
  reviews: number
  lines_changed: number
  activity: number
  trend: TrendDirection
}

export interface TuiFrameOptions {
  report: Report
  tab: TuiTab
  timeZone: string
  memberInsights?: Record<string, MemberInsight>
  histories?: Record<string, UserHistoryPoint[]>
  interactive?: boolean
  termWidth?: number
  termHeight?: number
  linkMode?: LinkMode
  cursorIndex?: number
  scrollOffset?: number
  selectedMember?: string | null
  selectedBlockerIndex?: number | null
  selectedRepo?: string | null
}

interface TuiSessionOptions extends Omit<
  TuiFrameOptions,
  | 'tab'
  | 'cursorIndex'
  | 'selectedMember'
  | 'selectedBlockerIndex'
  | 'selectedRepo'
  | 'scrollOffset'
> {
  initialTab?: TuiTab
}

interface TuiState {
  activeTab: TuiTab
  cursorIndex: number
  scrollOffset: number
  selectedMember: string | null
  selectedBlockerIndex: number | null
  selectedRepo: string | null
}

const CHROME_LINES = 10 // header + nav + separator + section header + blank + table header + table sep + position + blank + hints

export function computeVisibleRows(termHeight: number): number {
  return Math.max(1, termHeight - CHROME_LINES)
}

function ensureCursorVisible(state: TuiState, visibleRows: number): void {
  if (state.cursorIndex < state.scrollOffset) {
    state.scrollOffset = state.cursorIndex
  } else if (state.cursorIndex >= state.scrollOffset + visibleRows) {
    state.scrollOffset = state.cursorIndex - visibleRows + 1
  }
}

export async function runTuiSession(options: TuiSessionOptions): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const frame = renderTuiFrame({
      ...options,
      tab: options.initialTab ?? 'overview',
    })
    console.log(frame)
    return
  }

  const stdin = process.stdin
  const previousRawMode = stdin.isRaw
  let onResizeHandler: (() => void) | null = null
  let cleanupInput: (() => void) | null = null

  // Enter alternate screen buffer to prevent scrollback corruption
  process.stdout.write('\x1b[?1049h')

  try {
    const linkMode: LinkMode = 'osc8'

    const state: TuiState = {
      activeTab: options.initialTab ?? 'overview',
      cursorIndex: 0,
      scrollOffset: 0,
      selectedMember: null,
      selectedBlockerIndex: null,
      selectedRepo: null,
    }

    const isInListView = (): boolean => {
      if (state.activeTab === 'overview') return false
      if (state.activeTab === 'members') return !state.selectedMember
      if (state.activeTab === 'blockers') return state.selectedBlockerIndex === null
      if (state.activeTab === 'repos') return !state.selectedRepo
      return false
    }

    const listCount = (): number => {
      const { report } = options
      if (state.activeTab === 'members') {
        if (report.type === 'team') return Math.min(report.members.length, 20)
        if (report.type === 'exec') return Math.min(report.team_breakdown.length, 20)
        return 0
      }
      if (state.activeTab === 'blockers') {
        if (report.type === 'team') return Math.min(deriveTeamBlockers(report).length, 30)
        return 0
      }
      if (state.activeTab === 'repos') {
        if (report.type === 'team') return deriveRepoList(report).length
        if (report.type === 'exec') return Math.min(report.repo_health.length, 30)
        return 0
      }
      return 0
    }

    const render = (): void => {
      const termWidth = process.stdout.columns ?? 80
      const termHeight = process.stdout.rows ?? 24
      process.stdout.write('\x1b[2J\x1b[H')
      const frame = renderTuiFrame({
        ...options,
        tab: state.activeTab,
        interactive: true,
        termWidth,
        termHeight,
        linkMode,
        cursorIndex: state.cursorIndex,
        scrollOffset: state.scrollOffset,
        selectedMember: state.selectedMember,
        selectedBlockerIndex: state.selectedBlockerIndex,
        selectedRepo: state.selectedRepo,
      })
      // Truncate to terminal height to prevent overflow (safety net for detail views).
      // CHROME_LINES ensures list views fit naturally; this catches unbounded content.
      const maxLines = Math.max(1, termHeight)
      const frameLines = frame.split('\n')
      const output = frameLines.length > maxLines ? frameLines.slice(0, maxLines).join('\n') : frame
      process.stdout.write(output)
    }

    // Re-render on terminal resize, keeping cursor visible after height shrink
    const onResize = (): void => {
      if (isInListView()) {
        const termHeight = process.stdout.rows ?? 24
        ensureCursorVisible(state, computeVisibleRows(termHeight))
      }
      render()
    }
    onResizeHandler = onResize

    process.stdout.on('resize', onResize)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    render()

    await new Promise<void>((resolve) => {
      let cleanedUp = false

      const onData = (chunk: string): void => {
        if (chunk === 'q' || chunk.includes('\u0003')) {
          cleanup()
          resolve()
          return
        }

        if (chunk === 'r') {
          render()
          return
        }

        // Arrow key sequences: \x1b[A (up), \x1b[B (down)
        if (chunk === '\x1b[A') {
          if (isInListView()) {
            state.cursorIndex = Math.max(0, state.cursorIndex - 1)
            const termHeight = process.stdout.rows ?? 24
            ensureCursorVisible(state, computeVisibleRows(termHeight))
            render()
          }
          return
        }

        if (chunk === '\x1b[B') {
          if (isInListView()) {
            const count = listCount()
            if (count === 0) return
            state.cursorIndex = Math.min(count - 1, state.cursorIndex + 1)
            const termHeight = process.stdout.rows ?? 24
            ensureCursorVisible(state, computeVisibleRows(termHeight))
            render()
          }
          return
        }

        // Page Up: \x1b[5~
        if (chunk === '\x1b[5~') {
          if (isInListView()) {
            const termHeight = process.stdout.rows ?? 24
            const visibleRows = computeVisibleRows(termHeight)
            state.cursorIndex = Math.max(0, state.cursorIndex - visibleRows)
            ensureCursorVisible(state, visibleRows)
            render()
          }
          return
        }

        // Page Down: \x1b[6~
        if (chunk === '\x1b[6~') {
          if (isInListView()) {
            const count = listCount()
            if (count === 0) return
            const termHeight = process.stdout.rows ?? 24
            const visibleRows = computeVisibleRows(termHeight)
            state.cursorIndex = Math.min(count - 1, state.cursorIndex + visibleRows)
            ensureCursorVisible(state, visibleRows)
            render()
          }
          return
        }

        // Home: \x1b[H or \x1b[1~
        if (chunk === '\x1b[H' || chunk === '\x1b[1~') {
          if (isInListView()) {
            state.cursorIndex = 0
            state.scrollOffset = 0
            render()
          }
          return
        }

        // End: \x1b[F or \x1b[4~
        if (chunk === '\x1b[F' || chunk === '\x1b[4~') {
          if (isInListView()) {
            const count = listCount()
            if (count === 0) return
            const termHeight = process.stdout.rows ?? 24
            state.cursorIndex = count - 1
            ensureCursorVisible(state, computeVisibleRows(termHeight))
            render()
          }
          return
        }

        // Enter: drill into detail
        if (chunk === '\r' || chunk === '\n') {
          if (!isInListView()) return

          if (state.activeTab === 'members') {
            const { report } = options
            const members =
              report.type === 'team'
                ? report.members
                : report.type === 'exec'
                  ? report.team_breakdown
                  : null
            const member = members?.[state.cursorIndex]
            if (member) {
              state.selectedMember = member.user
              render()
            }
          } else if (state.activeTab === 'blockers') {
            if (options.report.type === 'team') {
              state.selectedBlockerIndex = state.cursorIndex
              render()
            }
          } else if (state.activeTab === 'repos') {
            const { report } = options
            if (report.type === 'team') {
              const repos = deriveRepoList(report)
              const repo = repos[state.cursorIndex]
              if (repo) {
                state.selectedRepo = repo
                render()
              }
            }
          }
          return
        }

        // Escape (single byte) or Backspace: back from detail
        if (chunk === '\x1b' || chunk === '\x7f') {
          if (state.selectedMember) {
            state.selectedMember = null
            render()
          } else if (state.selectedBlockerIndex !== null) {
            state.selectedBlockerIndex = null
            render()
          } else if (state.selectedRepo) {
            state.selectedRepo = null
            render()
          }
          return
        }

        const switchTab = (tab: TuiTab): void => {
          state.activeTab = tab
          state.cursorIndex = 0
          state.scrollOffset = 0
          state.selectedMember = null
          state.selectedBlockerIndex = null
          state.selectedRepo = null
          render()
        }

        switch (chunk) {
          case '1':
            switchTab('overview')
            return
          case '2':
            switchTab('members')
            return
          case '3':
            switchTab('blockers')
            return
          case '4':
            switchTab('repos')
            return
          default:
            return
        }
      }

      const cleanup = (): void => {
        if (cleanedUp) {
          return
        }
        cleanedUp = true
        stdin.off('data', onData)
        stdin.pause()
      }
      cleanupInput = cleanup

      stdin.on('data', onData)
    })
  } finally {
    const finalizeInput = cleanupInput as (() => void) | null
    finalizeInput?.()
    if (onResizeHandler) {
      process.stdout.off('resize', onResizeHandler)
    }
    stdin.setRawMode(Boolean(previousRawMode))
    process.stdout.write('\x1b[?1049l')
  }
}

export function renderTuiFrame(options: TuiFrameOptions): string {
  const lines: string[] = []
  const interactive = options.interactive ?? false
  const termWidth = options.termWidth ?? 80
  const linkMode = options.linkMode ?? 'plain'

  const meta = options.report.meta
  const headerLeft = colors.bold('gh-pulse', interactive)
  const headerRight = colors.dim(
    `${meta.audience}  ${meta.period_label}  repos:${meta.repos.length}  ${formatTimestamp(meta.generated_at, options.timeZone)}`,
    interactive,
  )
  lines.push(`${headerLeft}  ${headerRight}`)

  const navItems = [
    navTab('overview', options.tab, 1, interactive),
    navTab('members', options.tab, 2, interactive),
    navTab('blockers', options.tab, 3, interactive),
    navTab('repos', options.tab, 4, interactive),
  ].join(' ')
  const hints = colors.dim('[r] refresh  [q] quit', interactive)
  lines.push(`${navItems}   ${hints}`)

  lines.push('\u2500'.repeat(termWidth))

  switch (options.tab) {
    case 'overview':
      lines.push(...renderOverviewTab(options, interactive, linkMode))
      break
    case 'members':
      lines.push(...renderMembersTab(options, interactive, linkMode, termWidth))
      break
    case 'blockers':
      lines.push(...renderBlockersTab(options, interactive, linkMode, termWidth))
      break
    case 'repos':
      lines.push(...renderReposTab(options, interactive, linkMode, termWidth))
      break
    default: {
      const _exhaustive: never = options.tab
      throw new Error(`Unhandled tui tab: ${_exhaustive}`)
    }
  }

  return lines.join('\n')
}

function navTab(label: string, active: TuiTab, key: number, interactive: boolean): string {
  const slug = label as TuiTab
  const display = `[${key}] ${capitalize(label)}`
  if (active === slug) {
    return colors.cyan(`${display}*`, interactive)
  }
  return colors.dim(display, interactive)
}

function coloredTrendArrow(trend: TrendDirection, interactive: boolean): string {
  const arrow = trendArrow(trend)
  switch (trend) {
    case 'up':
      return colors.green(arrow, interactive)
    case 'down':
      return colors.red(arrow, interactive)
    case 'flat':
      return colors.dim(arrow, interactive)
    default:
      return arrow
  }
}

function renderOverviewTab(
  options: TuiFrameOptions,
  interactive: boolean,
  _linkMode: LinkMode,
): string[] {
  const { report } = options

  if (report.type === 'team') {
    const spark = aggregateActivitySparkline(options.histories)
    const rows: string[][] = [
      ['Team size', `${report.team_size}`],
      ['PRs opened', `${report.velocity.prs_opened}`],
      ['PRs merged', `${report.velocity.prs_merged}`],
      ['PRs closed', `${report.velocity.prs_closed}`],
      ['Cycle time p50', formatDurationMetric(report.velocity.cycle_time_p50)],
      ['Cycle time p90', formatDurationMetric(report.velocity.cycle_time_p90)],
      ['Review turnaround p50', formatDurationMetric(report.velocity.review_turnaround_p50)],
      ['Review turnaround p90', formatDurationMetric(report.velocity.review_turnaround_p90)],
    ]
    return [
      colors.bold('Overview', interactive),
      '',
      colors.bold('Velocity', interactive),
      renderTable(['Metric', 'Value'], rows),
      '',
      colors.bold('Activity Sparkline', interactive),
      spark,
    ]
  }

  if (report.type === 'exec') {
    const values = report.velocity_trends.map((trend) => trend.prs_merged)
    return [
      colors.bold('Overview', interactive),
      '',
      colors.bold('Velocity Trends', interactive),
      `Merged PR sparkline: ${sparkline(values)}`,
    ]
  }

  const summary = report.summary
  return [
    colors.bold('Overview', interactive),
    '',
    `PR opened ${summary.prs_opened} | merged ${summary.prs_merged} | closed ${summary.prs_closed}`,
    `Commits ${summary.commits} | lines changed ${summary.lines_changed}`,
  ]
}

function renderMembersTab(
  options: TuiFrameOptions,
  interactive: boolean,
  linkMode: LinkMode,
  termWidth: number,
): string[] {
  const { report, memberInsights, histories } = options
  const cursorIndex = options.cursorIndex ?? -1
  const selectedMember = options.selectedMember ?? null

  const members =
    report.type === 'team' ? report.members : report.type === 'exec' ? report.team_breakdown : null

  if (!members) {
    return [
      colors.bold('Members', interactive),
      '',
      'Members view is not available for this report type.',
    ]
  }

  // Detail sub-view
  if (selectedMember) {
    return renderMemberDetail(options, selectedMember, interactive, linkMode, termWidth)
  }

  // List view
  const lines: string[] = [colors.bold('Members', interactive), '']

  const memberColumns: ColumnSpec[] = [
    { header: '', fixedWidth: 2 },
    { header: 'User', flexWeight: 2, minWidth: 8 },
    { header: 'PRs', fixedWidth: 5 },
    { header: 'Reviews', fixedWidth: 7 },
    { header: 'Commits', fixedWidth: 7 },
    { header: 'Lines', fixedWidth: 7 },
    { header: 'Score', fixedWidth: 5 },
    { header: 'Trend', fixedWidth: 10 },
    { header: 'Activity', flexWeight: 1, minWidth: 8 },
  ]

  const rows: string[][] = []

  for (const [index, member] of members.slice(0, 20).entries()) {
    const key = member.user.toLowerCase()
    const insight = memberInsights?.[key]
    const userHistory = histories?.[key]
    const spark = userHistory ? sparkline(userHistory.map((p) => p.activity)) : ''
    const trendCell = insight
      ? `${coloredTrendArrow(insight.trend, interactive)} ${formatSignedPercent(insight.delta_pct)}`
      : `${colors.dim('\u2192', interactive)} 0%`
    const cursor = index === cursorIndex ? '>' : ' '
    rows.push([
      cursor,
      linkMode !== 'plain' ? userCell(member.user, linkMode) : member.user,
      `${member.prs_authored}`,
      `${member.prs_reviewed}`,
      `${member.commits}`,
      formatCompactNumber(member.lines_changed),
      formatMemberScore(member.user, memberInsights),
      trendCell,
      spark,
    ])
  }

  const scrollOffset = options.scrollOffset ?? 0
  const termHeight = options.termHeight ?? 0
  const totalItems = rows.length
  if (termHeight > 0) {
    const visibleRows = computeVisibleRows(termHeight)
    const sliced = rows.slice(scrollOffset, scrollOffset + visibleRows)
    lines.push(renderBudgetedTable(memberColumns, sliced, termWidth))
    if (totalItems > visibleRows) {
      lines.push(
        colors.dim(
          `[${scrollOffset + 1}-${Math.min(scrollOffset + visibleRows, totalItems)}/${totalItems}]${scrollOffset + visibleRows < totalItems ? ' \u25bc' : ''}`,
          interactive,
        ),
      )
    }
  } else {
    lines.push(renderBudgetedTable(memberColumns, rows, termWidth))
  }
  if (interactive) {
    lines.push('')
    lines.push(
      colors.dim(
        '[\u2191\u2193] navigate  [PgUp/Dn] page  [Enter] detail  [Esc] back',
        interactive,
      ),
    )
  }
  return lines
}

function renderMemberDetail(
  options: TuiFrameOptions,
  username: string,
  interactive: boolean,
  linkMode: LinkMode,
  termWidth: number,
): string[] {
  const { report, memberInsights, histories } = options
  const lines: string[] = []

  lines.push(
    `${colors.bold(`Member: ${username}`, interactive)}   ${colors.dim('[Esc] back to list', interactive)}`,
  )
  lines.push('')

  // Find member data
  const members =
    report.type === 'team' ? report.members : report.type === 'exec' ? report.team_breakdown : null
  const member = members?.find((m) => m.user === username)
  if (!member) {
    lines.push('No data for this member.')
    return lines
  }

  // Summary table
  lines.push(colors.bold('Summary', interactive))
  lines.push(
    renderTable(
      ['Metric', 'Value'],
      [
        ['PRs authored', `${member.prs_authored}`],
        ['PRs reviewed', `${member.prs_reviewed}`],
        ['Commits', `${member.commits}`],
        ['Lines changed', `${member.lines_changed}`],
      ],
    ),
  )
  lines.push('')

  // Insight
  const key = username.toLowerCase()
  const insight = memberInsights?.[key]
  if (insight) {
    lines.push(colors.bold('Insight', interactive))
    lines.push(
      `Score: ${insight.score}  Trend: ${coloredTrendArrow(insight.trend, interactive)} ${formatSignedPercent(insight.delta_pct)}`,
    )
    lines.push('')
  }

  // Activity sparkline
  const userHistory = histories?.[key]
  if (userHistory && userHistory.length > 0) {
    lines.push(colors.bold('Activity', interactive))
    lines.push(sparkline(userHistory.map((p) => p.activity)))
    lines.push('')
  }

  // Recent PRs from cycle_times
  if (report.type === 'team' && report.cycle_times.length > 0) {
    const authorPrs = report.cycle_times
      .filter((ct) => ct.pr.author.toLowerCase() === key)
      .slice(0, 10)
    if (authorPrs.length > 0) {
      lines.push(colors.bold('Recent PRs', interactive))
      const recentPrColumns: ColumnSpec[] = [
        { header: 'Repo', flexWeight: 2, minWidth: 10 },
        { header: 'PR', fixedWidth: 6 },
        { header: 'Title', flexWeight: 3, minWidth: 10 },
        { header: 'Cycle time', fixedWidth: 10 },
      ]
      lines.push(
        renderBudgetedTable(
          recentPrColumns,
          authorPrs.map((ct) => [
            linkMode !== 'plain' ? repoCell(ct.pr.repo, linkMode) : ct.pr.repo,
            linkMode !== 'plain' ? prCell(ct.pr.repo, ct.pr.number, linkMode) : `#${ct.pr.number}`,
            ct.pr.title,
            ct.metrics ? formatDurationMs(ct.metrics.total_time) : 'n/a',
          ]),
          termWidth,
        ),
      )
      lines.push('')
    }
  }

  // Review engagement
  if (report.type === 'team' && report.review_engagement.length > 0) {
    const authorReviews = report.review_engagement
      .filter((re) => re.pr.author.toLowerCase() === key)
      .slice(0, 5)
    if (authorReviews.length > 0) {
      lines.push(colors.bold('Review Engagement', interactive))
      lines.push(
        renderTable(
          ['Repo', 'PR', 'Reviews', 'Time to first review'],
          authorReviews.map((re) => [
            linkMode !== 'plain' ? repoCell(re.pr.repo, linkMode) : re.pr.repo,
            linkMode !== 'plain' ? prCell(re.pr.repo, re.pr.number, linkMode) : `#${re.pr.number}`,
            re.metrics ? `${re.metrics.review_count}` : '0',
            re.metrics ? formatDurationMetric(re.metrics.time_to_first_review) : 'n/a',
          ]),
        ),
      )
      lines.push('')
    }
  }

  return lines
}

const BLOCKER_COLUMNS: ColumnSpec[] = [
  { header: '', fixedWidth: 2 },
  { header: 'Repo', flexWeight: 2, minWidth: 10 },
  { header: 'PR', fixedWidth: 6 },
  { header: 'Title', flexWeight: 3, minWidth: 10 },
  { header: 'Owner', flexWeight: 1, minWidth: 8 },
  { header: 'Status', fixedWidth: 12 },
  { header: 'Days', fixedWidth: 5 },
]

function renderBlockersTab(
  options: TuiFrameOptions,
  interactive: boolean,
  linkMode: LinkMode,
  termWidth: number,
): string[] {
  const { report } = options
  const cursorIndex = options.cursorIndex ?? -1
  const selectedBlockerIndex = options.selectedBlockerIndex ?? null

  if (report.type !== 'team') {
    return [
      colors.bold('Blockers', interactive),
      '',
      'Blockers view is only available for team reports.',
    ]
  }

  if (report.blockers.length === 0) {
    return [colors.bold('Blockers', interactive), '', 'No blockers in this range.']
  }

  const collapsed = deriveTeamBlockers(report)

  // Detail sub-view
  if (selectedBlockerIndex !== null) {
    const blocker = collapsed[selectedBlockerIndex]
    if (blocker) {
      return renderBlockerDetail(report, blocker, interactive, linkMode)
    }
  }

  // List view
  const lines: string[] = [colors.bold('Blockers', interactive), '']

  const rows = collapsed.slice(0, 30).map((blocker, index) => {
    const coloredStatus = colorBlockerStatus(blocker.status, interactive)
    const cursor = index === cursorIndex ? '>' : ' '
    return [
      cursor,
      linkMode !== 'plain' ? repoCell(blocker.repo, linkMode) : blocker.repo,
      linkMode !== 'plain'
        ? prCell(blocker.repo, blocker.pr_number, linkMode)
        : `#${blocker.pr_number}`,
      blocker.pr_title ?? '',
      linkMode !== 'plain'
        ? userCell(blocker.owner ?? 'unknown', linkMode)
        : (blocker.owner ?? 'unknown'),
      coloredStatus,
      `${blocker.days}`,
    ]
  })

  const scrollOffset = options.scrollOffset ?? 0
  const termHeight = options.termHeight ?? 0
  const totalItems = rows.length
  if (termHeight > 0) {
    const visibleRows = computeVisibleRows(termHeight)
    const sliced = rows.slice(scrollOffset, scrollOffset + visibleRows)
    lines.push(renderBudgetedTable(BLOCKER_COLUMNS, sliced, termWidth))
    if (totalItems > visibleRows) {
      lines.push(
        colors.dim(
          `[${scrollOffset + 1}-${Math.min(scrollOffset + visibleRows, totalItems)}/${totalItems}]${scrollOffset + visibleRows < totalItems ? ' \u25bc' : ''}`,
          interactive,
        ),
      )
    }
  } else {
    lines.push(renderBudgetedTable(BLOCKER_COLUMNS, rows, termWidth))
  }

  if (interactive) {
    lines.push('')
    lines.push(
      colors.dim(
        '[\u2191\u2193] navigate  [PgUp/Dn] page  [Enter] detail  [Esc] back',
        interactive,
      ),
    )
  }
  return lines
}

function renderBlockerDetail(
  report: Extract<Report, { type: 'team' }>,
  blocker: import('./format').BlockerRow,
  interactive: boolean,
  linkMode: LinkMode,
): string[] {
  const lines: string[] = []
  const repoLink = linkMode !== 'plain' ? repoCell(blocker.repo, linkMode) : blocker.repo
  const prLink =
    linkMode !== 'plain'
      ? prCell(blocker.repo, blocker.pr_number, linkMode)
      : `#${blocker.pr_number}`

  lines.push(
    `${colors.bold(`Blocker: ${blocker.repo}${prLink}`, interactive)}   ${colors.dim('[Esc] back', interactive)}`,
  )
  lines.push('')

  // Find matching PR from report for full details
  const pr = report.blockers.find(
    (b) => b.pr.repo === blocker.repo && b.pr.number === blocker.pr_number,
  )?.pr

  const fields: string[][] = [
    ['Title', blocker.pr_title ?? 'n/a'],
    ['Author', blocker.owner ?? 'unknown'],
    ['Repo', repoLink],
    ['Status', blocker.status],
    ['Days', `${blocker.days}`],
  ]
  if (pr) {
    fields.push(['State', pr.state])
    fields.push(['Created', formatTimestamp(pr.created_at, 'UTC')])
    fields.push(['Updated', formatTimestamp(pr.updated_at, 'UTC')])
    if (pr.url) {
      fields.push(['Link', pr.url])
    } else {
      fields.push(['Link', `https://github.com/${blocker.repo}/pull/${blocker.pr_number}`])
    }
  }

  lines.push(renderTable(['Field', 'Value'], fields))
  return lines
}

function colorBlockerStatus(status: string, interactive: boolean): string {
  if (status.includes('stuck')) {
    return colors.red(status, interactive)
  }
  if (status.includes('stale')) {
    return colors.yellow(status, interactive)
  }
  return status
}

function deriveRepoList(report: Extract<Report, { type: 'team' }>): string[] {
  const repoCounts = deriveRepoCounts(report)
  return Array.from(repoCounts.entries())
    .toSorted((a, b) => b[1].prs - a[1].prs)
    .map(([repo]) => repo)
}

function deriveRepoCounts(
  report: Extract<Report, { type: 'team' }>,
): Map<string, { prs: number; authors: Set<string> }> {
  const repoCounts = new Map<string, { prs: number; authors: Set<string> }>()
  for (const ct of report.cycle_times) {
    const repo = ct.pr.repo
    const entry = repoCounts.get(repo) ?? { prs: 0, authors: new Set<string>() }
    entry.prs += 1
    entry.authors.add(ct.pr.author.toLowerCase())
    repoCounts.set(repo, entry)
  }
  for (const re of report.review_engagement) {
    const repo = re.pr.repo
    const entry = repoCounts.get(repo) ?? { prs: 0, authors: new Set<string>() }
    entry.authors.add(re.pr.author.toLowerCase())
    repoCounts.set(repo, entry)
  }
  return repoCounts
}

const REPO_COLUMNS: ColumnSpec[] = [
  { header: '', fixedWidth: 2 },
  { header: 'Repo', flexWeight: 3, minWidth: 10 },
  { header: 'PRs', fixedWidth: 5 },
  { header: 'Contributors', fixedWidth: 13 },
]

function renderReposTab(
  options: TuiFrameOptions,
  interactive: boolean,
  linkMode: LinkMode,
  termWidth: number,
): string[] {
  const { report, timeZone } = options
  const cursorIndex = options.cursorIndex ?? -1
  const selectedRepo = options.selectedRepo ?? null

  if (report.type === 'exec') {
    if (report.repo_health.length === 0) {
      return [colors.bold('Repos', interactive), '', 'No repo health data in this range.']
    }

    const lines: string[] = [colors.bold('Repos', interactive), '']

    const execRepoColumns: ColumnSpec[] = [
      { header: '', fixedWidth: 2 },
      { header: 'Repo', flexWeight: 3, minWidth: 10 },
      { header: 'Status', fixedWidth: 10 },
      { header: 'Last activity', fixedWidth: 20 },
    ]

    const rows = report.repo_health.slice(0, 30).map((repo, index) => {
      const cursor = index === cursorIndex ? '>' : ' '
      return [
        cursor,
        linkMode !== 'plain' ? repoCell(repo.repo, linkMode) : repo.repo,
        repo.status,
        repo.last_activity_at ? formatTimestamp(repo.last_activity_at, timeZone) : 'n/a',
      ]
    })

    const scrollOffset = options.scrollOffset ?? 0
    const termHeight = options.termHeight ?? 0
    const totalItems = rows.length
    if (termHeight > 0) {
      const visibleRows = computeVisibleRows(termHeight)
      const sliced = rows.slice(scrollOffset, scrollOffset + visibleRows)
      lines.push(renderBudgetedTable(execRepoColumns, sliced, termWidth))
      if (totalItems > visibleRows) {
        lines.push(
          colors.dim(
            `[${scrollOffset + 1}-${Math.min(scrollOffset + visibleRows, totalItems)}/${totalItems}]${scrollOffset + visibleRows < totalItems ? ' \u25bc' : ''}`,
            interactive,
          ),
        )
      }
    } else {
      lines.push(renderBudgetedTable(execRepoColumns, rows, termWidth))
    }

    if (interactive) {
      lines.push('')
      lines.push(colors.dim('[\u2191\u2193] navigate  [PgUp/Dn] page  [Esc] back', interactive))
    }
    return lines
  }

  if (report.type === 'team') {
    const repoCounts = deriveRepoCounts(report)

    if (repoCounts.size === 0) {
      return [colors.bold('Repos', interactive), '', 'No repo activity data in this range.']
    }

    // Detail sub-view
    if (selectedRepo) {
      return renderRepoDetail(report, selectedRepo, interactive, linkMode, termWidth)
    }

    // List view
    const lines: string[] = [colors.bold('Repos', interactive), '']

    const rows = Array.from(repoCounts.entries())
      .toSorted((a, b) => b[1].prs - a[1].prs)
      .map(([repo, data], index) => {
        const cursor = index === cursorIndex ? '>' : ' '
        return [
          cursor,
          linkMode !== 'plain' ? repoCell(repo, linkMode) : repo,
          `${data.prs}`,
          `${data.authors.size}`,
        ]
      })

    const scrollOffset = options.scrollOffset ?? 0
    const termHeight = options.termHeight ?? 0
    const totalItems = rows.length
    if (termHeight > 0) {
      const visibleRows = computeVisibleRows(termHeight)
      const sliced = rows.slice(scrollOffset, scrollOffset + visibleRows)
      lines.push(renderBudgetedTable(REPO_COLUMNS, sliced, termWidth))
      if (totalItems > visibleRows) {
        lines.push(
          colors.dim(
            `[${scrollOffset + 1}-${Math.min(scrollOffset + visibleRows, totalItems)}/${totalItems}]${scrollOffset + visibleRows < totalItems ? ' \u25bc' : ''}`,
            interactive,
          ),
        )
      }
    } else {
      lines.push(renderBudgetedTable(REPO_COLUMNS, rows, termWidth))
    }

    if (interactive) {
      lines.push('')
      lines.push(
        colors.dim(
          '[\u2191\u2193] navigate  [PgUp/Dn] page  [Enter] detail  [Esc] back',
          interactive,
        ),
      )
    }
    return lines
  }

  return [
    colors.bold('Repos', interactive),
    '',
    'Repos view is not available for this report type.',
  ]
}

function renderRepoDetail(
  report: Extract<Report, { type: 'team' }>,
  repoName: string,
  interactive: boolean,
  linkMode: LinkMode,
  termWidth: number,
): string[] {
  const lines: string[] = []
  const repoLink = linkMode !== 'plain' ? repoCell(repoName, linkMode) : repoName

  lines.push(
    `${colors.bold(`Repo: ${repoLink}`, interactive)}   ${colors.dim('[Esc] back', interactive)}`,
  )
  lines.push('')

  const repoCounts = deriveRepoCounts(report)
  const data = repoCounts.get(repoName)
  if (data) {
    lines.push(`PRs: ${data.prs}  Contributors: ${data.authors.size}`)
    lines.push('')
  }

  // PR list filtered by repo
  const repoPrs = report.cycle_times.filter((ct) => ct.pr.repo === repoName).slice(0, 20)

  if (repoPrs.length > 0) {
    lines.push(colors.bold('Pull Requests', interactive))
    const prColumns: ColumnSpec[] = [
      { header: 'PR', fixedWidth: 6 },
      { header: 'Title', flexWeight: 3, minWidth: 10 },
      { header: 'Author', flexWeight: 1, minWidth: 8 },
      { header: 'Cycle time', fixedWidth: 10 },
    ]
    lines.push(
      renderBudgetedTable(
        prColumns,
        repoPrs.map((ct) => [
          linkMode !== 'plain' ? prCell(ct.pr.repo, ct.pr.number, linkMode) : `#${ct.pr.number}`,
          ct.pr.title,
          linkMode !== 'plain' ? userCell(ct.pr.author, linkMode) : ct.pr.author,
          ct.metrics ? formatDurationMs(ct.metrics.total_time) : 'n/a',
        ]),
        termWidth,
      ),
    )
  }

  return lines
}

function aggregateActivitySparkline(histories?: Record<string, UserHistoryPoint[]>): string {
  if (!histories || Object.keys(histories).length === 0) {
    return sparkline([])
  }

  const aggregate = new Map<number, number>()
  for (const history of Object.values(histories)) {
    for (const point of history) {
      const previous = aggregate.get(point.bucket_start) ?? 0
      aggregate.set(point.bucket_start, previous + point.activity)
    }
  }

  const values = Array.from(aggregate.entries())
    .toSorted((a, b) => a[0] - b[0])
    .map((entry) => entry[1])
  return sparkline(values)
}

function sparkline(values: number[]): string {
  if (values.length === 0) {
    return 'n/a'
  }
  const blocks = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588'
  const max = Math.max(...values)
  if (max <= 0) {
    return blocks[0]?.repeat(values.length) ?? ''
  }
  return values
    .map((value) => {
      const normalized = Math.max(0, value) / max
      const index = Math.min(blocks.length - 1, Math.floor(normalized * (blocks.length - 1)))
      return blocks[index] ?? blocks[0] ?? ''
    })
    .join('')
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 10_000) {
    return `${(value / 1_000).toFixed(0)}k`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return `${value}`
}

function capitalize(value: string): string {
  if (value.length === 0) {
    return value
  }
  return value[0]?.toUpperCase() + value.slice(1)
}
