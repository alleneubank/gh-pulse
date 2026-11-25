#!/usr/bin/env bun
import {
  Cache,
  GitHubClient,
  loadConfig,
  parseConventionalPrefix,
  periodToRange,
  resolveSince,
  resolveUntil,
  resolveRepos,
  resolveTeamMembers,
  syncRepos,
  formatTimestamp,
  splitRangeByDay,
  isInRange,
  commitMatchesContributor,
} from '@alleneubank/gh-pulse-core'
import pkg from '../package.json'
import type {
  ProgressEvent,
  Report,
  ReportInputs,
  Event,
  PullRequest,
} from '@alleneubank/gh-pulse-core'
import {
  buildPersonalReport,
  buildTeamReport,
  buildExecReport,
  buildReportMeta,
} from '@alleneubank/gh-pulse-core'
import { applyHistoryTrends, computeMemberTrendDeltaPct, trendFromDeltaPct } from './trends'
import { runTuiSession } from './tui'
import type { MemberInsight, UserHistoryPoint } from './tui'
import {
  colors,
  formatDurationMetric,
  repoCell,
  prCell,
  userCell,
  stripOsc8,
  renderTable,
  trendArrow,
  formatMemberScore,
  formatMemberTrend,
  collapseBlockerRows,
  deriveTeamBlockers,
} from './format'
import type { BlockerRow, LinkMode } from './format'

const VERSION_PULSE = `   ____ _       ____        _
  / ___| |__   |  _ \\ _   _| |___  ___
 | |  _| '_ \\  | |_) | | | | / __|/ _ \\
 | |_| | | | | |  __/| |_| | \\__ \\  __/
  \\____|_| |_| |_|    \\__,_|_|___/\\___|`
const VERSION_BEAT = `:: <>--<3--<>  PRs + reviews + commits  <>--<3--<> ::`

const USAGE = `gh-pulse [options]

AUDIENCE
  --for, -f <target>     me | team | exec | @<username>
  --period, -p <period>  today | week | sprint | month | quarter
  --since <date>         Start date (ISO 8601, relative: 7d/2w/1m, or today/yesterday/now)
  --until <date>         End date (ISO 8601, relative, or today/yesterday/now)

SCOPE
  --repos, -r <pattern>  Repo filter (glob or comma-list)
  --org, -o <org>        GitHub org to scan

OUTPUT
  --format <fmt>         tui | table | json | markdown | slack | csv | internal | customer
                         Default: tui on TTY, table otherwise
  --concise              Omit Deploy/CI section and cap blockers to top 10
  --hyperlinks <mode>    auto | always | never
  --compare              Compare specific users side-by-side
  --users <list>         Comma list of users for compare mode (@alice,bob)
  --bucket <size>        day | week | month (history/trend buckets)
  --sort <field>         Sort by field
  --quiet, -q            Suppress progress output
  --verbose, -v          Show detailed progress

CONFIG
  --config, -c <path>    Config file path
  --sync                 Force fresh sync (ignore cache TTL)

INFO
  --version, -V          Show version number
  --help, -h             Show this help message

FILTERS
  --blockers             Focus on stale/stuck PRs only
  --include-drafts       Include draft PRs in metrics
`

type OutputFormat = 'tui' | 'table' | 'json' | 'markdown' | 'slack' | 'csv'
type AudienceFormatPreset = 'internal' | 'customer'
type RenderFormat = 'tui' | 'table' | 'json' | 'markdown' | 'slack' | 'csv'
type HyperlinkMode = 'auto' | 'always' | 'never'
type BucketSize = 'day' | 'week' | 'month'
interface RenderOptions {
  linkMode: LinkMode
  concise?: boolean
  audiencePreset?: AudienceFormatPreset
  memberInsights?: Record<string, MemberInsight>
  histories?: Record<string, UserHistoryPoint[]>
  history?: UserHistoryPoint[]
}

type ForTarget = 'me' | 'team' | 'exec' | string

type Period = 'today' | 'week' | 'sprint' | 'month' | 'quarter'

interface CliOptions {
  forTarget: ForTarget
  period: Period
  format: OutputFormat | AudienceFormatPreset
  formatExplicit: boolean
  hyperlinks: HyperlinkMode
  compare: boolean
  users?: string
  bucket?: BucketSize
  repos?: string
  orgs?: string
  since?: string
  until?: string
  configPath?: string
  blockers: boolean
  concise: boolean
  includeDrafts: boolean
  sort?: string
  quiet: boolean
  verbose: boolean
  sync: boolean
  help: boolean
  version: boolean
}

export interface RunCliDeps {
  loadConfig: typeof loadConfig
  openCache: typeof Cache.open
  createGitHubClient: (options: { token: string; cache: Cache; useEtags: boolean }) => GitHubClient
  resolveTarget: typeof resolveTarget
  resolveRepos: typeof resolveRepos
  syncRepos: typeof syncRepos
  resolveTeamMembers: typeof resolveTeamMembers
  buildReport: typeof buildReport
  runTuiSession: typeof runTuiSession
}

const DEFAULTS: CliOptions = {
  forTarget: 'me',
  period: 'week',
  format: 'table',
  formatExplicit: false,
  hyperlinks: 'auto',
  compare: false,
  blockers: false,
  concise: false,
  includeDrafts: false,
  quiet: false,
  verbose: false,
  sync: false,
  help: false,
  version: false,
}

const DEFAULT_RUN_CLI_DEPS: RunCliDeps = {
  loadConfig,
  openCache: Cache.open,
  createGitHubClient: (options) =>
    new GitHubClient({
      token: options.token,
      cache: options.cache,
      useEtags: options.useEtags,
    }),
  resolveTarget,
  resolveRepos,
  syncRepos,
  resolveTeamMembers,
  buildReport,
  runTuiSession,
}

export function formatVersionOutput(version: string, interactive: boolean): string {
  if (!interactive) {
    return `gh-pulse ${version}`
  }

  return [
    colors.cyan(VERSION_PULSE, interactive),
    colors.green(VERSION_BEAT, interactive),
    '',
    `${colors.bold('gh-pulse', interactive)} ${colors.green(`v${version}`, interactive)}`,
    'GitHub analytics CLI for PR flow, contribution pulse, and team health.',
    '',
    colors.dim(
      `"We call it alignment when everyone is blocked in the same direction." - gh-pulse`,
      interactive,
    ),
  ].join('\n')
}

export async function runCli(
  argv = process.argv.slice(2),
  deps: RunCliDeps = DEFAULT_RUN_CLI_DEPS,
): Promise<void> {
  const args = parseArgs(argv)
  const stdoutIsTTY = Boolean(process.stdout.isTTY)
  const outputFormat = resolveOutputFormat(
    {
      format: args.format,
      formatExplicit: args.formatExplicit,
      compare: args.compare,
    },
    stdoutIsTTY,
  )
  const renderFormat = resolveRenderFormat(outputFormat)
  const audiencePreset = resolveAudiencePreset(outputFormat)
  if (args.help) {
    console.log(USAGE)
    return
  }
  if (args.version) {
    console.log(formatVersionOutput(pkg.version, stdoutIsTTY))
    return
  }
  validateOptions({ ...args, format: outputFormat })
  const linkMode = resolveLinkMode(args.hyperlinks, stdoutIsTTY, renderFormat)

  const showProgress = !args.quiet && (args.verbose || Boolean(process.stderr.isTTY))
  const onProgress = showProgress ? createProgressHandler({ verbose: args.verbose }) : undefined

  const config = await deps.loadConfig(args.configPath ? { path: args.configPath } : {})
  const cache = await deps.openCache({ path: config.cache.path })
  const github = deps.createGitHubClient({
    token: config.github_token,
    cache,
    useEtags: config.cache.use_etags,
  })

  const target = await deps.resolveTarget(args.forTarget, github)
  const orgOverrides = args.orgs
    ? args.orgs
        .split(',')
        .map((org) => org.trim())
        .filter(Boolean)
    : []
  const repoPatterns = args.repos
    ? args.repos
        .split(',')
        .map((repo) => repo.trim())
        .filter(Boolean)
    : []

  const repos = await deps.resolveRepos({
    config,
    github,
    cache,
    orgs: orgOverrides,
    repoPatterns,
    strict: true,
    forceSync: args.sync,
    ...(onProgress ? { onProgress } : {}),
  })

  if (repos.length === 0) {
    console.log('No repositories matched the current configuration.')
    cache.close()
    return
  }

  const now = new Date()
  const timeRange = resolveTimeRange(args, config.timezone, now)
  // Extend sync range to cover the prior period for trend comparison
  const periodMs = timeRange.end - timeRange.start + 1
  const syncRange = { start: timeRange.start - periodMs, end: timeRange.end }
  try {
    await deps.syncRepos({
      repos,
      cache,
      github,
      config,
      timeRange: syncRange,
      forceSync: args.sync,
      ...(onProgress ? { onProgress } : {}),
    })

    const teamMembers = await deps.resolveTeamMembers({ config, github, repos, orgs: orgOverrides })
    const excludeAuthors = new Set(config.exclude.authors)

    const reportInputs: ReportInputs = {
      repos,
      repo_descriptions: config.repo_descriptions,
      timeRange,
      timeZone: config.timezone,
      includeDrafts: args.includeDrafts,
      blockersOnly: args.blockers,
      excludeAuthors,
      excludeBots: config.exclude.bots,
      teamMembers,
      branchRoles: {
        production: config.rollout.production_branches,
        integration: config.rollout.integration_branches,
      },
      limitedSurfaces: config.rollout.limited_surfaces,
      thresholds: {
        stale_days: config.thresholds.stale_days,
        stuck_days: config.thresholds.stuck_days,
        large_pr_lines: config.thresholds.large_pr_lines ?? 500,
        blocker_max_age_days: config.thresholds.blocker_max_age_days,
      },
      ...(target.user ? { subjectUser: target.user } : {}),
    }

    if (args.compare) {
      const users = parseCompareUsers(args.users ?? '')
      await ensureUsersExist(users, github)
      const compareRows = users.map((user) => {
        const individual = buildReport({ audience: 'individual', user }, cache, {
          ...reportInputs,
          subjectUser: user,
        })
        if (individual.type !== 'individual' && individual.type !== 'personal') {
          throw new Error('Unexpected report type for compare mode')
        }
        return individual
      })
      const bucket = args.bucket ?? 'week'
      const userHistories = buildUserHistories(cache, repos, users, reportInputs.timeRange, bucket)
      const trendHistories = buildTrendHistories(
        cache,
        repos,
        users,
        reportInputs.timeRange,
        config.timezone,
      )
      const insights = buildMemberInsights(
        compareRows.map((report) => ({
          user: report.user,
          prs_authored: report.summary.prs_opened,
          prs_reviewed:
            (userHistories[report.user.toLowerCase()] ?? []).reduce(
              (sum, point) => sum + point.reviews,
              0,
            ) ?? 0,
          commits: report.summary.commits,
          lines_changed: report.summary.lines_changed,
        })),
        trendHistories,
      )
      const output = formatCompareOutput(
        compareRows,
        outputFormat,
        config.timezone,
        linkMode,
        insights,
        userHistories,
        Boolean(args.bucket),
      )
      console.log(output)
      return
    }

    const report = deps.buildReport(target, cache, reportInputs)
    if (
      (report.type === 'personal' || report.type === 'individual') &&
      isEmptyPersonalReport(report)
    ) {
      console.log(`No activity found for @${report.user} in ${report.meta.period_label}`)
      return
    }

    const sortedReport = applySort(report, args.sort)
    const renderOptions: RenderOptions = { linkMode }
    if (report.type === 'team') {
      const users = report.members.map((member) => member.user)
      const bucket = args.bucket ?? autoBucketSize(reportInputs.timeRange)
      const histories = buildUserHistories(cache, repos, users, reportInputs.timeRange, bucket)
      const trendHistories = buildTrendHistories(
        cache,
        repos,
        users,
        reportInputs.timeRange,
        config.timezone,
      )
      renderOptions.memberInsights = buildMemberInsights(report.members, trendHistories)
      renderOptions.histories = histories
    } else if (report.type === 'exec') {
      const users = report.team_breakdown.map((member) => member.user)
      const bucket = args.bucket ?? autoBucketSize(reportInputs.timeRange)
      const histories = buildUserHistories(cache, repos, users, reportInputs.timeRange, bucket)
      const trendHistories = buildTrendHistories(
        cache,
        repos,
        users,
        reportInputs.timeRange,
        config.timezone,
      )
      renderOptions.memberInsights = buildMemberInsights(report.team_breakdown, trendHistories)
      renderOptions.histories = histories
    } else if ((report.type === 'personal' || report.type === 'individual') && args.bucket) {
      renderOptions.history = buildUserHistory(
        cache,
        repos,
        report.user,
        reportInputs.timeRange,
        args.bucket,
      )
    }

    if (renderFormat === 'tui') {
      await deps.runTuiSession({
        report: sortedReport,
        timeZone: config.timezone,
        ...(renderOptions.memberInsights ? { memberInsights: renderOptions.memberInsights } : {}),
        ...(renderOptions.histories ? { histories: renderOptions.histories } : {}),
      })
      return
    }

    const output = formatReport(
      sortedReport,
      outputFormat,
      config.timezone,
      args.blockers,
      config.thresholds,
      {
        ...renderOptions,
        concise: args.concise,
        ...(audiencePreset ? { audiencePreset } : {}),
      },
    )
    console.log(output)
  } finally {
    cache.close()
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { ...DEFAULTS }

  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (!arg) {
      break
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      index += 1
      continue
    }

    if (arg === '--version' || arg === '-V') {
      options.version = true
      index += 1
      continue
    }

    if (arg === '--blockers') {
      options.blockers = true
      index += 1
      continue
    }

    if (arg === '--concise') {
      options.concise = true
      index += 1
      continue
    }

    if (arg === '--include-drafts') {
      options.includeDrafts = true
      index += 1
      continue
    }
    if (arg === '--compare') {
      options.compare = true
      index += 1
      continue
    }
    if (arg === '--quiet' || arg === '-q') {
      options.quiet = true
      index += 1
      continue
    }
    if (arg === '--verbose' || arg === '-v') {
      options.verbose = true
      index += 1
      continue
    }
    if (arg === '--sync') {
      options.sync = true
      index += 1
      continue
    }

    const [flag, inlineValue] =
      arg.startsWith('--') && arg.includes('=') ? arg.split('=') : [arg, undefined]

    if (inlineValue !== undefined) {
      applyOption(options, flag, inlineValue)
      index += 1
      continue
    }

    const next = argv[index + 1]
    if (!next || next.startsWith('-')) {
      throw new Error(`Missing value for ${flag}`)
    }

    applyOption(options, flag, next)
    index += 2
  }

  return options
}

function createProgressHandler(options: { verbose: boolean }): (event: ProgressEvent) => void {
  return (event) => {
    const progress =
      typeof event.current === 'number' && typeof event.total === 'number'
        ? ` (${event.current}/${event.total})`
        : ''
    const prefix = options.verbose ? `[${event.phase}] ` : ''
    process.stderr.write(`${prefix}${event.message}${progress}\n`)
  }
}

function applyOption(options: CliOptions, flag: string, value: string): void {
  switch (flag) {
    case '--for':
    case '-f':
      options.forTarget = value
      return
    case '--period':
    case '-p':
      options.period = value as Period
      return
    case '--format':
      options.format = value as OutputFormat | AudienceFormatPreset
      options.formatExplicit = true
      return
    case '--hyperlinks':
      options.hyperlinks = value as HyperlinkMode
      return
    case '--users':
      options.users = value
      return
    case '--bucket':
      options.bucket = value as BucketSize
      return
    case '--repos':
    case '-r':
      options.repos = value
      return
    case '--org':
    case '-o':
      options.orgs = value
      return
    case '--since':
      options.since = value
      return
    case '--until':
      options.until = value
      return
    case '--config':
    case '-c':
      options.configPath = value
      return
    case '--sort':
      options.sort = value
      return
    default:
      throw new Error(`Unknown argument: ${flag}`)
  }
}

function validateOptions(options: CliOptions): void {
  const validPeriods: Period[] = ['today', 'week', 'sprint', 'month', 'quarter']
  if (!validPeriods.includes(options.period)) {
    throw new Error(`Invalid period: ${options.period}`)
  }

  const validFormats: Array<OutputFormat | AudienceFormatPreset> = [
    'tui',
    'table',
    'json',
    'markdown',
    'slack',
    'csv',
    'internal',
    'customer',
  ]
  if (!validFormats.includes(options.format)) {
    throw new Error(`Invalid format: ${options.format}`)
  }

  const validHyperlinkModes: HyperlinkMode[] = ['auto', 'always', 'never']
  if (!validHyperlinkModes.includes(options.hyperlinks)) {
    throw new Error(`Invalid hyperlinks mode: ${options.hyperlinks}`)
  }

  if (options.bucket) {
    const validBuckets: BucketSize[] = ['day', 'week', 'month']
    if (!validBuckets.includes(options.bucket)) {
      throw new Error(`Invalid bucket: ${options.bucket}`)
    }
  }

  if (options.compare && (!options.users || options.users.trim().length === 0)) {
    throw new Error('Compare mode requires --users')
  }
}

function resolveLinkMode(
  mode: HyperlinkMode,
  stdoutIsTTY: boolean,
  format: RenderFormat,
): LinkMode {
  if (mode === 'never') {
    return 'plain'
  }
  if (format === 'tui') {
    return 'plain'
  }
  if (format === 'slack') {
    return 'slack'
  }
  if (format === 'markdown' && !stdoutIsTTY) {
    return 'markdown'
  }

  switch (mode) {
    case 'always':
      return stdoutIsTTY ? 'osc8' : 'plain'
    case 'auto':
      return stdoutIsTTY ? 'osc8' : 'plain'
    default: {
      const _exhaustive: never = mode
      throw new Error(`Unhandled link mode: ${_exhaustive}`)
    }
  }
}

export function resolveOutputFormat(
  options: {
    format: OutputFormat | AudienceFormatPreset
    formatExplicit: boolean
    compare: boolean
  },
  stdoutIsTTY: boolean,
): OutputFormat | AudienceFormatPreset {
  const resolved: OutputFormat | AudienceFormatPreset = options.formatExplicit
    ? options.format
    : stdoutIsTTY
      ? 'tui'
      : 'table'
  if (options.compare && resolved === 'tui') {
    return 'table'
  }
  return resolved
}

function resolveRenderFormat(format: OutputFormat | AudienceFormatPreset): RenderFormat {
  if (format === 'internal' || format === 'customer') {
    return 'markdown'
  }
  return format
}

function resolveAudiencePreset(
  format: OutputFormat | AudienceFormatPreset,
): AudienceFormatPreset | undefined {
  if (format === 'internal' || format === 'customer') {
    return format
  }
  return undefined
}

async function resolveTarget(
  forTarget: ForTarget,
  github: GitHubClient,
): Promise<{
  audience: 'personal' | 'individual' | 'team' | 'exec'
  user?: string
}> {
  if (forTarget === 'team') {
    return { audience: 'team' }
  }
  if (forTarget === 'exec') {
    return { audience: 'exec' }
  }
  if (forTarget === 'me') {
    const user = await github.getAuthenticatedUsername()
    return { audience: 'personal', user }
  }

  const user = forTarget.startsWith('@') ? forTarget.slice(1) : forTarget
  const exists = await github.userExists(user)
  if (!exists) {
    throw new Error(`User not found: ${user}`)
  }
  return { audience: 'individual', user }
}

function resolveTimeRange(
  options: CliOptions,
  timeZone: string,
  now: Date,
): {
  start: number
  end: number
  label: string
} {
  const basePeriod = periodToRange(options.period, now, timeZone)

  if (options.since || options.until) {
    const start = options.since ? resolveSince(options.since, now, timeZone) : basePeriod.start
    const end = options.until ? resolveUntil(options.until, now, timeZone) : now.getTime()
    if (start > end) {
      throw new Error('Invalid time range: start is after end')
    }
    const label = `custom ${options.since ?? 'start'} → ${options.until ?? 'now'}`
    return { start, end, label }
  }

  return basePeriod
}

function parseCompareUsers(raw: string): string[] {
  const users = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => (value.startsWith('@') ? value.slice(1) : value))

  const seen = new Set<string>()
  const unique: string[] = []
  for (const user of users) {
    const key = user.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(user)
  }
  return unique
}

async function ensureUsersExist(users: string[], github: GitHubClient): Promise<void> {
  const checks = await Promise.all(
    users.map(async (user) => ({
      user,
      exists: await github.userExists(user),
    })),
  )

  for (const check of checks) {
    if (!check.exists) {
      throw new Error(`User not found: ${check.user}`)
    }
  }
}

function autoBucketSize(timeRange: { start: number; end: number }): BucketSize {
  const rangeDays = (timeRange.end - timeRange.start) / (24 * 60 * 60 * 1000)
  if (rangeDays < 28) return 'day'
  return 'week'
}

function buildUserHistories(
  cache: Cache,
  repos: string[],
  users: string[],
  timeRange: { start: number; end: number },
  bucket: BucketSize,
): Record<string, UserHistoryPoint[]> {
  const histories: Record<string, UserHistoryPoint[]> = {}
  for (const user of users) {
    histories[user.toLowerCase()] = buildUserHistory(cache, repos, user, timeRange, bucket)
  }
  return histories
}

function buildUserHistory(
  cache: Cache,
  repos: string[],
  user: string,
  timeRange: { start: number; end: number },
  bucket: BucketSize,
): UserHistoryPoint[] {
  const dayMs = 24 * 60 * 60 * 1000
  const bucketSizeMs = bucket === 'day' ? dayMs : bucket === 'week' ? 7 * dayMs : 30 * dayMs
  const buckets: Array<{ start: number; end: number }> = []
  for (let cursor = timeRange.start; cursor <= timeRange.end; cursor += bucketSizeMs) {
    const end = Math.min(cursor + bucketSizeMs - 1, timeRange.end)
    buckets.push({ start: cursor, end })
  }

  const authorKey = user.toLowerCase()
  const dailyPrs = cache
    .getDailyPrs({ repos, start: timeRange.start, end: timeRange.end })
    .filter((entry) => entry.author.toLowerCase() === authorKey)
  const dailyCommits = cache
    .getDailyCommits({ repos, start: timeRange.start, end: timeRange.end })
    .filter((entry) => entry.author.toLowerCase() === authorKey)
  const dailyReviews = cache
    .getDailyReviews({ repos, start: timeRange.start, end: timeRange.end })
    .filter((entry) => entry.reviewer.toLowerCase() === authorKey)

  const points = buckets.map((bucketRange) => {
    const prsRows = dailyPrs.filter(
      (row) => row.day_start >= bucketRange.start && row.day_start <= bucketRange.end,
    )
    const commitRows = dailyCommits.filter(
      (row) => row.day_start >= bucketRange.start && row.day_start <= bucketRange.end,
    )
    const reviewRows = dailyReviews.filter(
      (row) => row.day_start >= bucketRange.start && row.day_start <= bucketRange.end,
    )

    const prsOpened = prsRows.reduce((sum, row) => sum + row.opened, 0)
    const prsMerged = prsRows.reduce((sum, row) => sum + row.merged, 0)
    const prsClosed = prsRows.reduce((sum, row) => sum + row.closed, 0)
    const commits = commitRows.reduce((sum, row) => sum + row.commits, 0)
    const reviews = reviewRows.reduce((sum, row) => sum + row.reviews, 0)
    const linesChanged = commitRows.reduce((sum, row) => sum + row.additions + row.deletions, 0)
    const activity = prsOpened + prsMerged + prsClosed + commits + reviews

    return {
      bucket_start: bucketRange.start,
      bucket_end: bucketRange.end,
      prs_opened: prsOpened,
      prs_merged: prsMerged,
      prs_closed: prsClosed,
      commits,
      reviews,
      lines_changed: linesChanged,
      activity,
      trend: 'flat' as const,
    }
  })

  return applyHistoryTrends(points)
}

export function buildTrendBuckets(
  cache: Cache,
  repos: string[],
  user: string,
  timeRange: { start: number; end: number },
  timeZone: string,
): UserHistoryPoint[] {
  // Uses the same full-day rollups + edge events/commits approach as the
  // core report builders (splitRangeByDay). This ensures trend activity
  // counts match report totals exactly for both current and prior periods.
  const periodMs = timeRange.end - timeRange.start + 1
  const ranges = [
    { start: timeRange.start - periodMs, end: timeRange.start - 1 },
    { start: timeRange.start, end: timeRange.end },
  ]

  return ranges.map((range) => {
    const totals = sumActivityForRange(cache, repos, user, range, timeZone)
    const activity =
      totals.prsOpened + totals.prsMerged + totals.prsClosed + totals.commits + totals.reviews

    return {
      bucket_start: range.start,
      bucket_end: range.end,
      prs_opened: totals.prsOpened,
      prs_merged: totals.prsMerged,
      prs_closed: totals.prsClosed,
      commits: totals.commits,
      reviews: totals.reviews,
      lines_changed: totals.linesChanged,
      activity,
      trend: 'flat' as const,
    }
  })
}

function sumActivityForRange(
  cache: Cache,
  repos: string[],
  user: string,
  range: { start: number; end: number },
  timeZone: string,
): {
  prsOpened: number
  prsMerged: number
  prsClosed: number
  commits: number
  reviews: number
  linesChanged: number
} {
  const { fullDays, edges } = splitRangeByDay(range, timeZone)
  const authorKey = user.toLowerCase()

  let prsOpened = 0
  let prsMerged = 0
  let prsClosed = 0
  let commits = 0
  let reviews = 0
  let linesChanged = 0

  // Full-day rollups (same as core report builders)
  if (fullDays) {
    const dailyPrs = cache
      .getDailyPrs({ repos, start: fullDays.start, end: fullDays.end })
      .filter((entry) => entry.author.toLowerCase() === authorKey)
    const dailyCommits = cache
      .getDailyCommits({ repos, start: fullDays.start, end: fullDays.end })
      .filter((entry) => entry.author.toLowerCase() === authorKey)
    const dailyReviews = cache
      .getDailyReviews({ repos, start: fullDays.start, end: fullDays.end })
      .filter((entry) => entry.reviewer.toLowerCase() === authorKey)

    prsOpened += dailyPrs.reduce((sum, row) => sum + row.opened, 0)
    prsMerged += dailyPrs.reduce((sum, row) => sum + row.merged, 0)
    prsClosed += dailyPrs.reduce((sum, row) => sum + row.closed, 0)
    commits += dailyCommits.reduce((sum, row) => sum + row.commits, 0)
    reviews += dailyReviews.reduce((sum, row) => sum + row.reviews, 0)
    linesChanged += dailyCommits.reduce((sum, row) => sum + row.additions + row.deletions, 0)
  }

  // Edge events/commits for partial days (same as core report builders)
  if (edges.length > 0) {
    const events = cache
      .getEvents({ since: range.start, until: range.end })
      .filter((event) => repos.includes(event.repo))
    // Use commitMatchesContributor for co-author attribution (matches team.ts)
    const edgeCommits = cache
      .getCommits({ since: range.start, until: range.end })
      .filter((commit) => repos.includes(commit.repo) && commitMatchesContributor(commit, user))
    // Build PR lookup for merged/closed attribution (matches personal.ts)
    const prLookup = buildTrendPrLookup(cache, repos)

    for (const edge of edges) {
      const edgeCounts = countEdgeEventsForUser(events, prLookup, authorKey, edge)
      prsOpened += edgeCounts.prsOpened
      prsMerged += edgeCounts.prsMerged
      prsClosed += edgeCounts.prsClosed
      reviews += edgeCounts.reviews
      for (const commit of edgeCommits) {
        if (isInRange(commit.committed_at, edge)) {
          commits++
          linesChanged += commit.additions + commit.deletions
        }
      }
    }
  }

  return { prsOpened, prsMerged, prsClosed, commits, reviews, linesChanged }
}

function buildTrendPrLookup(cache: Cache, repos: string[]): Map<string, PullRequest> {
  const prs: PullRequest[] = []
  for (const repo of repos) {
    prs.push(...cache.getPullRequests({ repo }))
  }
  return new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]))
}

function countEdgeEventsForUser(
  events: Event[],
  prLookup: Map<string, PullRequest>,
  authorKey: string,
  edge: { start: number; end: number },
): { prsOpened: number; prsMerged: number; prsClosed: number; reviews: number } {
  let prsOpened = 0
  let prsMerged = 0
  let prsClosed = 0
  let reviews = 0
  for (const event of events) {
    if (
      event.type === 'pr_opened' &&
      event.author.toLowerCase() === authorKey &&
      isInRange(event.opened_at, edge)
    ) {
      prsOpened++
    } else if (event.type === 'pr_merged' && isInRange(event.merged_at, edge)) {
      const pr = prLookup.get(`${event.repo}#${event.pr_number}`)
      if (pr && pr.author.toLowerCase() === authorKey) {
        prsMerged++
      }
    } else if (event.type === 'pr_closed' && isInRange(event.closed_at, edge)) {
      const pr = prLookup.get(`${event.repo}#${event.pr_number}`)
      if (pr && pr.author.toLowerCase() === authorKey) {
        prsClosed++
      }
    } else if (
      event.type === 'review_submitted' &&
      event.reviewer.toLowerCase() === authorKey &&
      isInRange(event.submitted_at, edge)
    ) {
      reviews++
    }
  }
  return { prsOpened, prsMerged, prsClosed, reviews }
}

function buildTrendHistories(
  cache: Cache,
  repos: string[],
  users: string[],
  timeRange: { start: number; end: number },
  timeZone: string,
): Record<string, UserHistoryPoint[]> {
  // Ensure daily rollups are materialized for the prior period.
  // The report path only materializes rollups for timeRange via loadReportData.
  const periodMs = timeRange.end - timeRange.start + 1
  const priorRange = { start: timeRange.start - periodMs, end: timeRange.start - 1 }
  cache.ensureDailyRollups({ repos, timeRange: priorRange, timeZone })

  const histories: Record<string, UserHistoryPoint[]> = {}
  for (const user of users) {
    histories[user.toLowerCase()] = buildTrendBuckets(cache, repos, user, timeRange, timeZone)
  }
  return histories
}

function buildMemberInsights(
  members: Array<{
    user: string
    prs_authored: number
    prs_reviewed: number
    commits: number
    lines_changed: number
  }>,
  trendHistories: Record<string, UserHistoryPoint[]>,
): Record<string, MemberInsight> {
  const maxAuthored = Math.max(1, ...members.map((member) => member.prs_authored))
  const maxReviewed = Math.max(1, ...members.map((member) => member.prs_reviewed))
  const maxCommits = Math.max(1, ...members.map((member) => member.commits))
  const maxLines = Math.max(1, ...members.map((member) => member.lines_changed))

  const insights: Record<string, MemberInsight> = {}
  for (const member of members) {
    const score = Math.round(
      100 *
        ((member.prs_authored / maxAuthored) * 0.45 +
          (member.prs_reviewed / maxReviewed) * 0.25 +
          (member.commits / maxCommits) * 0.2 +
          (member.lines_changed / maxLines) * 0.1),
    )

    const history = trendHistories[member.user.toLowerCase()] ?? []
    const deltaPct = computeMemberTrendDeltaPct(history)
    const trend = trendFromDeltaPct(deltaPct)

    insights[member.user.toLowerCase()] = {
      score,
      trend,
      delta_pct: deltaPct,
    }
  }

  return insights
}

export function formatCompareOutput(
  reports: Array<Extract<Report, { type: 'personal' | 'individual' }>>,
  format: OutputFormat | AudienceFormatPreset,
  timeZone: string,
  linkMode: LinkMode,
  insights: Record<string, MemberInsight>,
  histories?: Record<string, UserHistoryPoint[]>,
  showHistory = false,
): string {
  const compareFormat =
    format === 'tui'
      ? 'table'
      : format === 'internal' || format === 'customer'
        ? 'markdown'
        : format
  const rows = reports.map((report) => {
    const history = histories?.[report.user.toLowerCase()] ?? []
    const reviews = history.reduce((sum, point) => sum + point.reviews, 0)
    return {
      user: report.user,
      prs_opened: report.summary.prs_opened,
      prs_merged: report.summary.prs_merged,
      prs_closed: report.summary.prs_closed,
      reviews,
      commits: report.summary.commits,
      lines_changed: report.summary.lines_changed,
    }
  })
  const displayUserByKey = new Map<string, string>(
    rows.map((row) => [row.user.toLowerCase(), row.user] as const),
  )

  if (compareFormat === 'json') {
    return JSON.stringify(
      {
        type: 'compare',
        rows: rows.map((row) => ({
          ...row,
          score: formatMemberScore(row.user, insights),
          trend: formatMemberTrend(row.user, insights),
        })),
        ...(showHistory && histories ? { histories } : {}),
      },
      null,
      2,
    )
  }

  const headers = [
    'User',
    'PRs opened',
    'PRs merged',
    'PRs closed',
    'Reviews',
    'Commits',
    'Lines changed',
    'Score',
    'Trend',
  ]
  const data = rows.map((row) => [
    compareFormat === 'markdown' || compareFormat === 'table' || compareFormat === 'slack'
      ? userCell(row.user, linkMode)
      : row.user,
    `${row.prs_opened}`,
    `${row.prs_merged}`,
    `${row.prs_closed}`,
    `${row.reviews}`,
    `${row.commits}`,
    `${row.lines_changed}`,
    formatMemberScore(row.user, insights),
    formatMemberTrend(row.user, insights),
  ])

  if (compareFormat === 'csv') {
    return renderCsv(
      headers.map((header) => header.toLowerCase().replaceAll(' ', '_')),
      data.map((row) => row.map((value) => stripOsc8(value))),
    )
  }

  if (compareFormat === 'markdown') {
    const lines: string[] = ['# gh-pulse compare report', '']
    lines.push(`| ${headers.join(' | ')} |`)
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`)
    for (const row of data) {
      lines.push(`| ${row.join(' | ')} |`)
    }
    lines.push('')
    if (showHistory && histories) {
      lines.push('## History')
      lines.push(
        '| User | Bucket start | Opened | Merged | Closed | Commits | Reviews | Lines | Trend |',
      )
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
      for (const [userKey, history] of Object.entries(histories)) {
        const displayUser = displayUserByKey.get(userKey) ?? userKey
        for (const point of history) {
          lines.push(
            `| ${userCell(displayUser, linkMode)} | ${formatTimestamp(point.bucket_start, timeZone)} | ${point.prs_opened} | ${point.prs_merged} | ${point.prs_closed} | ${point.commits} | ${point.reviews} | ${point.lines_changed} | ${trendArrow(point.trend)} |`,
          )
        }
      }
    }
    return lines.join('\n')
  }

  if (compareFormat === 'slack') {
    const lines: string[] = ['*gh-pulse compare report*', '']
    for (const row of rows) {
      lines.push(
        `- *${userCell(row.user, linkMode)}*: opened=${row.prs_opened}, merged=${row.prs_merged}, closed=${row.prs_closed}, reviews=${row.reviews}, commits=${row.commits}, lines=${row.lines_changed}, score=${formatMemberScore(row.user, insights)}, trend=${formatMemberTrend(row.user, insights)}`,
      )
    }
    lines.push('')
    if (showHistory && histories) {
      lines.push('*History*')
      for (const [userKey, history] of Object.entries(histories)) {
        const displayUser = displayUserByKey.get(userKey) ?? userKey
        lines.push(`- *${userCell(displayUser, linkMode)}*`)
        for (const point of history) {
          lines.push(
            `  - ${formatTimestamp(point.bucket_start, timeZone)}: opened=${point.prs_opened}, merged=${point.prs_merged}, closed=${point.prs_closed}, commits=${point.commits}, reviews=${point.reviews}, lines=${point.lines_changed}, trend=${trendArrow(point.trend)}`,
          )
        }
      }
    }
    return lines.join('\n')
  }

  const sections: string[] = ['gh-pulse compare report', '', renderTable(headers, data)]
  if (showHistory && histories) {
    const historyRows: string[][] = []
    for (const [userKey, history] of Object.entries(histories)) {
      const displayUser = displayUserByKey.get(userKey) ?? userKey
      for (const point of history) {
        historyRows.push([
          userCell(displayUser, linkMode),
          formatTimestamp(point.bucket_start, timeZone),
          `${point.prs_opened}`,
          `${point.prs_merged}`,
          `${point.prs_closed}`,
          `${point.commits}`,
          `${point.reviews}`,
          `${point.lines_changed}`,
          trendArrow(point.trend),
        ])
      }
    }
    sections.push(
      '',
      'History',
      renderTable(
        [
          'User',
          'Bucket start',
          'Opened',
          'Merged',
          'Closed',
          'Commits',
          'Reviews',
          'Lines',
          'Trend',
        ],
        historyRows,
      ),
    )
  }
  return sections.join('\n')
}

function buildReport(
  target: { audience: 'personal' | 'individual' | 'team' | 'exec'; user?: string },
  cache: Cache,
  inputs: ReportInputs,
): Report {
  const meta = buildReportMeta({
    audience: target.audience,
    repos: inputs.repos,
    periodLabel: inputs.timeRange.label,
    start: inputs.timeRange.start,
    end: inputs.timeRange.end,
    cache,
  })

  switch (target.audience) {
    case 'personal':
    case 'individual':
      if (!target.user) {
        throw new Error('Missing user for personal report')
      }
      return buildPersonalReport(cache, {
        ...inputs,
        user: target.user,
        meta,
      })
    case 'team':
      return buildTeamReport(cache, { ...inputs, meta })
    case 'exec':
      return buildExecReport(cache, { ...inputs, meta })
    default: {
      const _exhaustive: never = target.audience
      throw new Error(`Unhandled audience: ${_exhaustive}`)
    }
  }
}

export function formatReport(
  report: Report,
  format: OutputFormat | AudienceFormatPreset,
  timeZone: string,
  blockersOnly: boolean,
  thresholds: { stale_days: number; stuck_days: number },
  renderOptions: RenderOptions = { linkMode: 'plain' },
): string {
  const linkMode = renderOptions.linkMode ?? 'plain'
  const concise = renderOptions.concise ?? false
  const audiencePreset =
    renderOptions.audiencePreset ??
    (format === 'internal' || format === 'customer' ? format : undefined)
  const resolvedFormat = resolveRenderFormat(format)

  if (audiencePreset === 'customer') {
    return formatCustomerMarkdown(report, timeZone, linkMode)
  }

  if (resolvedFormat === 'json') {
    return JSON.stringify(prepareJsonReport(report, concise), null, 2)
  }

  if (resolvedFormat === 'csv') {
    return formatCsv(report, blockersOnly, thresholds, renderOptions)
  }

  if (resolvedFormat === 'markdown') {
    return formatMarkdown(
      report,
      timeZone,
      blockersOnly,
      thresholds,
      linkMode,
      concise,
      renderOptions.memberInsights,
      renderOptions.history,
    )
  }

  if (resolvedFormat === 'slack') {
    return formatSlack(
      report,
      timeZone,
      blockersOnly,
      thresholds,
      linkMode,
      concise,
      renderOptions.memberInsights,
      renderOptions.history,
    )
  }

  return formatTable(
    report,
    timeZone,
    blockersOnly,
    thresholds,
    linkMode,
    concise,
    renderOptions.memberInsights,
    renderOptions.history,
  )
}

function formatHeader(report: Report, timeZone: string): string[] {
  const meta = report.meta
  const lines: string[] = []
  lines.push(`Audience: ${meta.audience}`)
  lines.push(`Period: ${meta.period_label}`)
  lines.push(
    `Range: ${formatTimestamp(meta.start, timeZone)} → ${formatTimestamp(meta.end, timeZone)}`,
  )
  lines.push(`Range (UTC): ${meta.start_utc} → ${meta.end_utc}`)
  lines.push(`Repos: ${meta.repos.length}`)

  const freshness = meta.data_freshness
  if (freshness.dataAsOf) {
    lines.push(`Data as of: ${formatTimestamp(freshness.dataAsOf, timeZone)}`)
  }
  if (freshness.cacheAgeMinutes !== null) {
    lines.push(`Cache age: ${freshness.cacheAgeMinutes} minutes`)
  }
  lines.push(`Repos synced: ${freshness.reposSynced}/${freshness.totalRepos}`)
  return lines
}

function limitTeamBlockers(
  rows: BlockerRow[],
  concise: boolean,
): { rows: BlockerRow[]; omitted: number } {
  if (!concise) {
    return { rows, omitted: 0 }
  }

  const sorted = rows.toSorted(
    (a, b) => b.days - a.days || a.repo.localeCompare(b.repo) || a.pr_number - b.pr_number,
  )
  const max = 10
  if (sorted.length <= max) {
    return { rows: sorted, omitted: 0 }
  }
  return { rows: sorted.slice(0, max), omitted: sorted.length - max }
}

function formatRepoHeading(
  entry: { repo: string; repo_description?: string },
  linkMode: LinkMode,
): string {
  const repo = repoCell(entry.repo, linkMode)
  if (!entry.repo_description) {
    return repo
  }
  return `${repo} - ${entry.repo_description}`
}

function prepareJsonReport(report: Report, concise: boolean): unknown {
  if (!concise) {
    return report
  }

  if (report.type === 'team') {
    const { deploy_activity: _deployActivity, ...rest } = report
    return {
      ...rest,
      blockers: report.blockers.toSorted((a, b) => b.days - a.days).slice(0, 10),
    }
  }

  if (report.type === 'exec') {
    const { deploy_activity: _deployActivity, ...rest } = report
    return rest
  }

  return report
}

function formatCustomerMarkdown(report: Report, timeZone: string, linkMode: LinkMode): string {
  const lines: string[] = ['# gh-pulse customer update', '']
  lines.push(`- Period: ${report.meta.period_label}`)
  lines.push(
    `- Range: ${formatTimestamp(report.meta.start, timeZone)} → ${formatTimestamp(report.meta.end, timeZone)}`,
  )
  lines.push('')

  if (report.type !== 'team' && report.type !== 'exec') {
    lines.push('No customer-facing summary is available for this report type.')
    return lines.join('\n')
  }

  const groups = report.themes.groups.filter(
    (group) => group.type === 'feat' || group.type === 'fix',
  )
  if (groups.length === 0) {
    lines.push('No customer-visible features or bug fixes shipped in this range.')
    return lines.join('\n')
  }

  for (const group of groups) {
    lines.push(`## ${group.label}`)
    for (const pr of group.prs) {
      const summary = buildCustomerSummary(pr.title, pr.body_snippet)
      lines.push(`- ${summary} (${prCell(pr.repo, pr.number, linkMode)})`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function buildCustomerSummary(title: string, bodySnippet?: string): string {
  const normalized = toSentenceCase(stripConventionalPrefix(title))
  if (!bodySnippet) {
    return normalized
  }
  const snippet = toSentenceCase(bodySnippet)
  if (snippet.length === 0) {
    return normalized
  }
  return `${normalized}: ${snippet}`
}

function stripConventionalPrefix(title: string): string {
  const parsed = parseConventionalPrefix(title)
  if (parsed.type === 'other') {
    return title.trim()
  }
  return title.replace(/^\w+(?:\([^)]+\))?!?\s*:\s*/, '').trim()
}

function toSentenceCase(value: string): string {
  const normalized = value.replaceAll('_', ' ').trim()
  if (normalized.length === 0) {
    return normalized
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function formatTable(
  report: Report,
  timeZone: string,
  blockersOnly: boolean,
  thresholds: { stale_days: number; stuck_days: number },
  linkMode: LinkMode,
  concise: boolean,
  memberInsights?: Record<string, MemberInsight>,
  history?: UserHistoryPoint[],
): string {
  const sections: string[] = []
  sections.push('gh-pulse report')
  sections.push(...formatHeader(report, timeZone))
  sections.push('')

  switch (report.type) {
    case 'personal':
    case 'individual': {
      if (blockersOnly) {
        sections.push('Blockers')
        const blockers = deriveBlockers(report, thresholds)
        sections.push(
          renderTable(
            ['Repo', 'PR', 'Status', 'Days'],
            blockers.map((b) => [
              repoCell(b.repo, linkMode),
              prCell(b.repo, b.pr_number, linkMode),
              b.status,
              `${b.days}`,
            ]),
          ),
        )
        break
      }

      sections.push('Summary')
      sections.push(
        renderTable(
          ['Metric', 'Value'],
          [
            ['PRs opened', `${report.summary.prs_opened}`],
            ['PRs merged', `${report.summary.prs_merged}`],
            ['PRs closed', `${report.summary.prs_closed}`],
            ['Commits', `${report.summary.commits}`],
            ['Repos touched', `${report.summary.repos_touched}`],
            ['Lines changed', `${report.summary.lines_changed}`],
          ],
        ),
      )

      sections.push('Open Work')
      sections.push(
        renderTable(
          ['Repo', 'PR', 'Age (days)', 'Title'],
          report.open_work.open_prs.map((pr) => [
            repoCell(pr.repo, linkMode),
            prCell(pr.repo, pr.number, linkMode),
            `${pr.age_days}`,
            pr.title,
          ]),
        ),
      )

      sections.push('Review Debt - Requested')
      sections.push(
        renderTable(
          ['Repo', 'PR', 'Author', 'Age (days)', 'Title'],
          report.review_debt.requested.map((pr) => [
            repoCell(pr.repo, linkMode),
            prCell(pr.repo, pr.number, linkMode),
            userCell(pr.author, linkMode),
            `${pr.age_days}`,
            pr.title,
          ]),
        ),
      )

      sections.push('Review Debt - Team PRs')
      sections.push(
        renderTable(
          ['Repo', 'PR', 'Author', 'Age (days)', 'Title'],
          report.review_debt.team_prs.map((pr) => [
            repoCell(pr.repo, linkMode),
            prCell(pr.repo, pr.number, linkMode),
            userCell(pr.author, linkMode),
            `${pr.age_days}`,
            pr.title,
          ]),
        ),
      )
      break
    }
    case 'team': {
      if (blockersOnly) {
        const blockerResult = limitTeamBlockers(deriveTeamBlockers(report), concise)
        sections.push('Blockers')
        sections.push(
          renderTable(
            ['Repo', 'PR', 'Owner', 'Status', 'Days'],
            blockerResult.rows.map((blocker) => [
              repoCell(blocker.repo, linkMode),
              prCell(blocker.repo, blocker.pr_number, linkMode),
              userCell(blocker.owner ?? 'unknown', linkMode),
              blocker.status,
              `${blocker.days}`,
            ]),
          ),
        )
        if (blockerResult.omitted > 0) {
          sections.push(`and ${blockerResult.omitted} more...`)
        }
        break
      }

      sections.push('Velocity')
      sections.push(
        renderTable(
          ['Metric', 'Value'],
          [
            ['PRs opened', `${report.velocity.prs_opened}`],
            ['PRs merged', `${report.velocity.prs_merged}`],
            ['PRs closed', `${report.velocity.prs_closed}`],
            ['Cycle time p50', formatDurationMetric(report.velocity.cycle_time_p50)],
            ['Cycle time p90', formatDurationMetric(report.velocity.cycle_time_p90)],
            ['Review turnaround p50', formatDurationMetric(report.velocity.review_turnaround_p50)],
            ['Review turnaround p90', formatDurationMetric(report.velocity.review_turnaround_p90)],
          ],
        ),
      )

      sections.push('Member Breakdown')
      sections.push(
        renderTable(
          ['User', 'PRs authored', 'PRs reviewed', 'Commits', 'Lines changed', 'Score', 'Trend'],
          report.members.map((member) => [
            userCell(member.user, linkMode),
            `${member.prs_authored}`,
            `${member.prs_reviewed}`,
            `${member.commits}`,
            `${member.lines_changed}`,
            formatMemberScore(member.user, memberInsights),
            formatMemberTrend(member.user, memberInsights),
          ]),
        ),
      )

      sections.push(`What Shipped (${report.shipped.total_merged} PRs merged)`)
      if (report.shipped.entries.length === 0) {
        sections.push('No merged PRs in range.')
      } else {
        for (const entry of report.shipped.entries) {
          sections.push(`${userCell(entry.author, linkMode)}`)
          for (const pr of entry.prs) {
            sections.push(
              `  ${prCell(pr.repo, pr.number, linkMode)} ${pr.title} (${repoCell(pr.repo, linkMode)})`,
            )
            if (pr.body_snippet) {
              sections.push(`    ${pr.body_snippet}`)
            }
          }
        }
      }

      sections.push('Themes')
      sections.push(
        renderTable(
          ['Category', 'Count'],
          report.themes.groups.map((group) => [group.label, `${group.prs.length}`]),
        ),
      )

      if (!concise) {
        sections.push(`Deploy/CI Activity (${report.deploy_activity.total_count} PRs)`)
        sections.push(
          renderTable(
            ['Repo', 'PR', 'Author', 'Title'],
            report.deploy_activity.prs.map((pr) => [
              repoCell(pr.repo, linkMode),
              prCell(pr.repo, pr.number, linkMode),
              userCell(pr.author, linkMode),
              pr.title,
            ]),
          ),
        )
      }

      sections.push('Repo Breakdown')
      if (report.repo_breakdown.entries.length === 0) {
        sections.push('No repository activity in range.')
      } else {
        for (const entry of report.repo_breakdown.entries) {
          sections.push(
            `${formatRepoHeading(entry, linkMode)}  opened=${entry.prs_opened} merged=${entry.prs_merged} contributors=${entry.contributors.length}`,
          )
          if (entry.shipped.length > 0) {
            sections.push(
              renderTable(
                ['PR', 'Author', 'Title'],
                entry.shipped.map((pr) => [
                  prCell(pr.repo, pr.number, linkMode),
                  userCell(pr.author, linkMode),
                  pr.title,
                ]),
              ),
            )
          }
        }
      }

      sections.push('Blockers')
      const blockerResult = limitTeamBlockers(deriveTeamBlockers(report), concise)
      sections.push(
        renderTable(
          ['Repo', 'PR', 'Owner', 'Status', 'Days'],
          blockerResult.rows.map((blocker) => [
            repoCell(blocker.repo, linkMode),
            prCell(blocker.repo, blocker.pr_number, linkMode),
            userCell(blocker.owner ?? 'unknown', linkMode),
            blocker.status,
            `${blocker.days}`,
          ]),
        ),
      )
      if (blockerResult.omitted > 0) {
        sections.push(`and ${blockerResult.omitted} more...`)
      }
      break
    }
    case 'exec': {
      sections.push('Velocity Trends')
      sections.push(
        renderTable(
          ['Week start', 'PRs merged', 'Cycle time p50'],
          report.velocity_trends.map((trend) => [
            formatTimestamp(trend.bucket_start, timeZone),
            `${trend.prs_merged}`,
            formatDurationMetric(trend.cycle_time_p50),
          ]),
        ),
      )

      sections.push('Cycle Time Trends')
      sections.push(
        renderTable(
          ['Week start', 'Cycle time p50'],
          report.cycle_time_trends.map((trend) => [
            formatTimestamp(trend.bucket_start, timeZone),
            formatDurationMetric(trend.cycle_time_p50),
          ]),
        ),
      )

      sections.push('Repo Health')
      sections.push(
        renderTable(
          ['Repo', 'Status', 'Last activity'],
          report.repo_health.map((entry) => [
            repoCell(entry.repo, linkMode),
            entry.status,
            entry.last_activity_at ? formatTimestamp(entry.last_activity_at, timeZone) : 'n/a',
          ]),
        ),
      )

      sections.push('Highlights')
      sections.push(
        renderTable(
          ['Repo', 'PR', 'Reasons'],
          report.highlights.map((entry) => [
            repoCell(entry.pr.repo, linkMode),
            prCell(entry.pr.repo, entry.pr.number, linkMode),
            entry.reasons.join('; '),
          ]),
        ),
      )

      sections.push('Team Breakdown')
      sections.push(
        renderTable(
          ['User', 'PRs authored', 'PRs reviewed', 'Commits', 'Lines changed', 'Score', 'Trend'],
          report.team_breakdown.map((member) => [
            userCell(member.user, linkMode),
            `${member.prs_authored}`,
            `${member.prs_reviewed}`,
            `${member.commits}`,
            `${member.lines_changed}`,
            formatMemberScore(member.user, memberInsights),
            formatMemberTrend(member.user, memberInsights),
          ]),
        ),
      )

      sections.push(`What Shipped (${report.shipped.total_merged} PRs merged)`)
      if (report.shipped.entries.length === 0) {
        sections.push('No merged PRs in range.')
      } else {
        for (const entry of report.shipped.entries) {
          sections.push(`${userCell(entry.author, linkMode)}`)
          for (const pr of entry.prs) {
            sections.push(
              `  ${prCell(pr.repo, pr.number, linkMode)} ${pr.title} (${repoCell(pr.repo, linkMode)})`,
            )
            if (pr.body_snippet) {
              sections.push(`    ${pr.body_snippet}`)
            }
          }
        }
      }

      sections.push('Themes')
      sections.push(
        renderTable(
          ['Category', 'Count'],
          report.themes.groups.map((group) => [group.label, `${group.prs.length}`]),
        ),
      )

      if (!concise) {
        sections.push(`Deploy/CI Activity (${report.deploy_activity.total_count} PRs)`)
        sections.push(
          renderTable(
            ['Repo', 'PR', 'Author', 'Title'],
            report.deploy_activity.prs.map((pr) => [
              repoCell(pr.repo, linkMode),
              prCell(pr.repo, pr.number, linkMode),
              userCell(pr.author, linkMode),
              pr.title,
            ]),
          ),
        )
      }

      sections.push('Repo Breakdown')
      if (report.repo_breakdown.entries.length === 0) {
        sections.push('No repository activity in range.')
      } else {
        for (const entry of report.repo_breakdown.entries) {
          sections.push(
            `${formatRepoHeading(entry, linkMode)}  opened=${entry.prs_opened} merged=${entry.prs_merged} contributors=${entry.contributors.length}`,
          )
          if (entry.shipped.length > 0) {
            sections.push(
              renderTable(
                ['PR', 'Author', 'Title'],
                entry.shipped.map((pr) => [
                  prCell(pr.repo, pr.number, linkMode),
                  userCell(pr.author, linkMode),
                  pr.title,
                ]),
              ),
            )
          }
        }
      }
      break
    }
    default: {
      const _exhaustive: never = report
      throw new Error(`Unhandled report type: ${_exhaustive}`)
    }
  }

  if (
    (report.type === 'personal' || report.type === 'individual') &&
    history &&
    history.length > 0
  ) {
    sections.push('History')
    sections.push(
      renderTable(
        ['Bucket start', 'Opened', 'Merged', 'Closed', 'Commits', 'Reviews', 'Lines', 'Trend'],
        history.map((point) => [
          formatTimestamp(point.bucket_start, timeZone),
          `${point.prs_opened}`,
          `${point.prs_merged}`,
          `${point.prs_closed}`,
          `${point.commits}`,
          `${point.reviews}`,
          `${point.lines_changed}`,
          trendArrow(point.trend),
        ]),
      ),
    )
  }

  return sections.join('\n')
}

function formatMarkdown(
  report: Report,
  timeZone: string,
  blockersOnly: boolean,
  thresholds: { stale_days: number; stuck_days: number },
  linkMode: LinkMode,
  concise: boolean,
  memberInsights?: Record<string, MemberInsight>,
  history?: UserHistoryPoint[],
): string {
  const lines: string[] = []
  lines.push(`# gh-pulse ${report.type} report`)
  lines.push('')
  formatHeader(report, timeZone).forEach((line) => lines.push(`- ${line}`))
  lines.push('')

  const renderMarkdownTable = (headers: string[], rows: string[][]): void => {
    lines.push(`| ${headers.join(' | ')} |`)
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`)
    rows.forEach((row) => lines.push(`| ${row.join(' | ')} |`))
    lines.push('')
  }

  switch (report.type) {
    case 'personal':
    case 'individual': {
      if (blockersOnly) {
        lines.push('## Blockers')
        const blockers = deriveBlockers(report, thresholds)
        renderMarkdownTable(
          ['Repo', 'PR', 'Status', 'Days'],
          blockers.map((b) => [
            repoCell(b.repo, linkMode),
            prCell(b.repo, b.pr_number, linkMode),
            b.status,
            `${b.days}`,
          ]),
        )
        break
      }

      lines.push('## Summary')
      renderMarkdownTable(
        ['Metric', 'Value'],
        [
          ['PRs opened', `${report.summary.prs_opened}`],
          ['PRs merged', `${report.summary.prs_merged}`],
          ['PRs closed', `${report.summary.prs_closed}`],
          ['Commits', `${report.summary.commits}`],
          ['Repos touched', `${report.summary.repos_touched}`],
          ['Lines changed', `${report.summary.lines_changed}`],
        ],
      )

      lines.push('## Open Work')
      renderMarkdownTable(
        ['Repo', 'PR', 'Age (days)', 'Title'],
        report.open_work.open_prs.map((pr) => [
          repoCell(pr.repo, linkMode),
          prCell(pr.repo, pr.number, linkMode),
          `${pr.age_days}`,
          pr.title,
        ]),
      )

      lines.push('## Review Debt - Requested')
      renderMarkdownTable(
        ['Repo', 'PR', 'Author', 'Age (days)', 'Title'],
        report.review_debt.requested.map((pr) => [
          repoCell(pr.repo, linkMode),
          prCell(pr.repo, pr.number, linkMode),
          userCell(pr.author, linkMode),
          `${pr.age_days}`,
          pr.title,
        ]),
      )

      lines.push('## Review Debt - Team PRs')
      renderMarkdownTable(
        ['Repo', 'PR', 'Author', 'Age (days)', 'Title'],
        report.review_debt.team_prs.map((pr) => [
          repoCell(pr.repo, linkMode),
          prCell(pr.repo, pr.number, linkMode),
          userCell(pr.author, linkMode),
          `${pr.age_days}`,
          pr.title,
        ]),
      )
      break
    }
    case 'team': {
      if (blockersOnly) {
        const blockerResult = limitTeamBlockers(deriveTeamBlockers(report), concise)
        lines.push('## Blockers')
        renderMarkdownTable(
          ['Repo', 'PR', 'Owner', 'Status', 'Days'],
          blockerResult.rows.map((blocker) => [
            repoCell(blocker.repo, linkMode),
            prCell(blocker.repo, blocker.pr_number, linkMode),
            userCell(blocker.owner ?? 'unknown', linkMode),
            blocker.status,
            `${blocker.days}`,
          ]),
        )
        if (blockerResult.omitted > 0) {
          lines.push(`and ${blockerResult.omitted} more...`)
          lines.push('')
        }
        break
      }

      lines.push('## Velocity')
      renderMarkdownTable(
        ['Metric', 'Value'],
        [
          ['PRs opened', `${report.velocity.prs_opened}`],
          ['PRs merged', `${report.velocity.prs_merged}`],
          ['PRs closed', `${report.velocity.prs_closed}`],
          ['Cycle time p50', formatDurationMetric(report.velocity.cycle_time_p50)],
          ['Cycle time p90', formatDurationMetric(report.velocity.cycle_time_p90)],
          ['Review turnaround p50', formatDurationMetric(report.velocity.review_turnaround_p50)],
          ['Review turnaround p90', formatDurationMetric(report.velocity.review_turnaround_p90)],
        ],
      )

      lines.push('## Member Breakdown')
      renderMarkdownTable(
        ['User', 'PRs authored', 'PRs reviewed', 'Commits', 'Lines changed', 'Score', 'Trend'],
        report.members.map((member) => [
          userCell(member.user, linkMode),
          `${member.prs_authored}`,
          `${member.prs_reviewed}`,
          `${member.commits}`,
          `${member.lines_changed}`,
          formatMemberScore(member.user, memberInsights),
          formatMemberTrend(member.user, memberInsights),
        ]),
      )

      lines.push(`## What Shipped (${report.shipped.total_merged} PRs merged)`)
      if (report.shipped.entries.length === 0) {
        lines.push('No merged PRs in range.')
        lines.push('')
      } else {
        for (const entry of report.shipped.entries) {
          lines.push(`### ${userCell(entry.author, linkMode)}`)
          for (const pr of entry.prs) {
            lines.push(
              `- ${prCell(pr.repo, pr.number, linkMode)} ${pr.title} (${repoCell(pr.repo, linkMode)})`,
            )
            if (pr.body_snippet) {
              lines.push(`  ${pr.body_snippet}`)
            }
          }
          lines.push('')
        }
      }

      lines.push('## Themes')
      renderMarkdownTable(
        ['Category', 'Count'],
        report.themes.groups.map((group) => [group.label, `${group.prs.length}`]),
      )

      if (!concise) {
        lines.push(`## Deploy/CI Activity (${report.deploy_activity.total_count} PRs)`)
        renderMarkdownTable(
          ['Repo', 'PR', 'Author', 'Title'],
          report.deploy_activity.prs.map((pr) => [
            repoCell(pr.repo, linkMode),
            prCell(pr.repo, pr.number, linkMode),
            userCell(pr.author, linkMode),
            pr.title,
          ]),
        )
      }

      lines.push('## Repo Breakdown')
      if (report.repo_breakdown.entries.length === 0) {
        lines.push('No repository activity in range.')
        lines.push('')
      } else {
        for (const entry of report.repo_breakdown.entries) {
          lines.push(`### ${formatRepoHeading(entry, linkMode)}`)
          lines.push(
            `Opened: ${entry.prs_opened}  Merged: ${entry.prs_merged}  Contributors: ${entry.contributors.join(', ') || 'none'}`,
          )
          lines.push('')
          renderMarkdownTable(
            ['PR', 'Author', 'Title'],
            entry.shipped.map((pr) => [
              prCell(pr.repo, pr.number, linkMode),
              userCell(pr.author, linkMode),
              pr.title,
            ]),
          )
        }
      }

      lines.push('## Blockers')
      const blockerResult = limitTeamBlockers(deriveTeamBlockers(report), concise)
      renderMarkdownTable(
        ['Repo', 'PR', 'Owner', 'Status', 'Days'],
        blockerResult.rows.map((blocker) => [
          repoCell(blocker.repo, linkMode),
          prCell(blocker.repo, blocker.pr_number, linkMode),
          userCell(blocker.owner ?? 'unknown', linkMode),
          blocker.status,
          `${blocker.days}`,
        ]),
      )
      if (blockerResult.omitted > 0) {
        lines.push(`and ${blockerResult.omitted} more...`)
        lines.push('')
      }
      break
    }
    case 'exec': {
      lines.push('## Velocity Trends')
      renderMarkdownTable(
        ['Week start', 'PRs merged', 'Cycle time p50'],
        report.velocity_trends.map((trend) => [
          formatTimestamp(trend.bucket_start, timeZone),
          `${trend.prs_merged}`,
          formatDurationMetric(trend.cycle_time_p50),
        ]),
      )

      lines.push('## Cycle Time Trends')
      renderMarkdownTable(
        ['Week start', 'Cycle time p50'],
        report.cycle_time_trends.map((trend) => [
          formatTimestamp(trend.bucket_start, timeZone),
          formatDurationMetric(trend.cycle_time_p50),
        ]),
      )

      lines.push('## Repo Health')
      renderMarkdownTable(
        ['Repo', 'Status', 'Last activity'],
        report.repo_health.map((entry) => [
          repoCell(entry.repo, linkMode),
          entry.status,
          entry.last_activity_at ? formatTimestamp(entry.last_activity_at, timeZone) : 'n/a',
        ]),
      )

      lines.push('## Highlights')
      renderMarkdownTable(
        ['Repo', 'PR', 'Reasons'],
        report.highlights.map((entry) => [
          repoCell(entry.pr.repo, linkMode),
          prCell(entry.pr.repo, entry.pr.number, linkMode),
          entry.reasons.join('; '),
        ]),
      )

      lines.push('## Team Breakdown')
      renderMarkdownTable(
        ['User', 'PRs authored', 'PRs reviewed', 'Commits', 'Lines changed', 'Score', 'Trend'],
        report.team_breakdown.map((member) => [
          userCell(member.user, linkMode),
          `${member.prs_authored}`,
          `${member.prs_reviewed}`,
          `${member.commits}`,
          `${member.lines_changed}`,
          formatMemberScore(member.user, memberInsights),
          formatMemberTrend(member.user, memberInsights),
        ]),
      )

      lines.push(`## What Shipped (${report.shipped.total_merged} PRs merged)`)
      if (report.shipped.entries.length === 0) {
        lines.push('No merged PRs in range.')
        lines.push('')
      } else {
        for (const entry of report.shipped.entries) {
          lines.push(`### ${userCell(entry.author, linkMode)}`)
          for (const pr of entry.prs) {
            lines.push(
              `- ${prCell(pr.repo, pr.number, linkMode)} ${pr.title} (${repoCell(pr.repo, linkMode)})`,
            )
            if (pr.body_snippet) {
              lines.push(`  ${pr.body_snippet}`)
            }
          }
          lines.push('')
        }
      }

      lines.push('## Themes')
      renderMarkdownTable(
        ['Category', 'Count'],
        report.themes.groups.map((group) => [group.label, `${group.prs.length}`]),
      )

      if (!concise) {
        lines.push(`## Deploy/CI Activity (${report.deploy_activity.total_count} PRs)`)
        renderMarkdownTable(
          ['Repo', 'PR', 'Author', 'Title'],
          report.deploy_activity.prs.map((pr) => [
            repoCell(pr.repo, linkMode),
            prCell(pr.repo, pr.number, linkMode),
            userCell(pr.author, linkMode),
            pr.title,
          ]),
        )
      }

      lines.push('## Repo Breakdown')
      if (report.repo_breakdown.entries.length === 0) {
        lines.push('No repository activity in range.')
        lines.push('')
      } else {
        for (const entry of report.repo_breakdown.entries) {
          lines.push(`### ${formatRepoHeading(entry, linkMode)}`)
          lines.push(
            `Opened: ${entry.prs_opened}  Merged: ${entry.prs_merged}  Contributors: ${entry.contributors.join(', ') || 'none'}`,
          )
          lines.push('')
          renderMarkdownTable(
            ['PR', 'Author', 'Title'],
            entry.shipped.map((pr) => [
              prCell(pr.repo, pr.number, linkMode),
              userCell(pr.author, linkMode),
              pr.title,
            ]),
          )
        }
      }
      break
    }
    default: {
      const _exhaustive: never = report
      throw new Error(`Unhandled report type: ${_exhaustive}`)
    }
  }

  if (
    (report.type === 'personal' || report.type === 'individual') &&
    history &&
    history.length > 0
  ) {
    lines.push('## History')
    renderMarkdownTable(
      ['Bucket start', 'Opened', 'Merged', 'Closed', 'Commits', 'Reviews', 'Lines', 'Trend'],
      history.map((point) => [
        formatTimestamp(point.bucket_start, timeZone),
        `${point.prs_opened}`,
        `${point.prs_merged}`,
        `${point.prs_closed}`,
        `${point.commits}`,
        `${point.reviews}`,
        `${point.lines_changed}`,
        trendArrow(point.trend),
      ]),
    )
  }

  return lines.join('\n')
}

function formatSlack(
  report: Report,
  timeZone: string,
  blockersOnly: boolean,
  thresholds: { stale_days: number; stuck_days: number },
  linkMode: LinkMode,
  concise: boolean,
  memberInsights?: Record<string, MemberInsight>,
  history?: UserHistoryPoint[],
): string {
  const lines: string[] = []
  lines.push(`*gh-pulse ${report.type} report*`)
  lines.push('')
  formatHeader(report, timeZone).forEach((line) => lines.push(`- ${line}`))
  lines.push('')

  const pushSection = (title: string): void => {
    lines.push(`*${title}*`)
  }

  const pushKeyValues = (rows: Array<{ key: string; value: string }>): void => {
    for (const row of rows) {
      lines.push(`- ${row.key}: ${row.value}`)
    }
    lines.push('')
  }

  const pushPrList = (
    prs: Array<{
      repo: string
      number: number
      title: string
      author: string
      age_days: number
    }>,
    options: { showAuthor: boolean; showAge: boolean; showSnippet?: boolean },
  ): void => {
    if (prs.length === 0) {
      lines.push('- none')
      lines.push('')
      return
    }
    for (const pr of prs) {
      const parts = [
        prCell(pr.repo, pr.number, linkMode),
        pr.title,
        `(${repoCell(pr.repo, linkMode)})`,
      ]
      if (options.showAuthor) {
        parts.push(`author=${userCell(pr.author, linkMode)}`)
      }
      if (options.showAge) {
        parts.push(`age=${pr.age_days}d`)
      }
      lines.push(`- ${parts.join(' ')}`)
      if (options.showSnippet && 'body_snippet' in pr && pr.body_snippet) {
        lines.push(`  ${pr.body_snippet}`)
      }
    }
    lines.push('')
  }

  switch (report.type) {
    case 'personal':
    case 'individual': {
      if (blockersOnly) {
        pushSection('Blockers')
        const blockers = deriveBlockers(report, thresholds)
        if (blockers.length === 0) {
          lines.push('- none')
        } else {
          for (const blocker of blockers) {
            lines.push(
              `- ${repoCell(blocker.repo, linkMode)} ${prCell(blocker.repo, blocker.pr_number, linkMode)} status=${blocker.status} days=${blocker.days}`,
            )
          }
        }
        break
      }

      pushSection('Summary')
      pushKeyValues([
        { key: 'PRs opened', value: `${report.summary.prs_opened}` },
        { key: 'PRs merged', value: `${report.summary.prs_merged}` },
        { key: 'PRs closed', value: `${report.summary.prs_closed}` },
        { key: 'Commits', value: `${report.summary.commits}` },
        { key: 'Repos touched', value: `${report.summary.repos_touched}` },
        { key: 'Lines changed', value: `${report.summary.lines_changed}` },
      ])

      pushSection('Open Work')
      pushPrList(report.open_work.open_prs, { showAuthor: false, showAge: true })

      pushSection('Review Debt - Requested')
      pushPrList(report.review_debt.requested, { showAuthor: true, showAge: true })

      pushSection('Review Debt - Team PRs')
      pushPrList(report.review_debt.team_prs, { showAuthor: true, showAge: true })
      break
    }
    case 'team': {
      if (blockersOnly) {
        const blockerResult = limitTeamBlockers(deriveTeamBlockers(report), concise)
        pushSection('Blockers')
        if (blockerResult.rows.length === 0) {
          lines.push('- none')
        } else {
          for (const blocker of blockerResult.rows) {
            lines.push(
              `- ${repoCell(blocker.repo, linkMode)} ${prCell(blocker.repo, blocker.pr_number, linkMode)} owner=${userCell(blocker.owner ?? 'unknown', linkMode)} status=${blocker.status} days=${blocker.days}`,
            )
          }
        }
        if (blockerResult.omitted > 0) {
          lines.push(`and ${blockerResult.omitted} more...`)
        }
        break
      }

      pushSection('Velocity')
      pushKeyValues([
        { key: 'PRs opened', value: `${report.velocity.prs_opened}` },
        { key: 'PRs merged', value: `${report.velocity.prs_merged}` },
        { key: 'PRs closed', value: `${report.velocity.prs_closed}` },
        { key: 'Cycle time p50', value: formatDurationMetric(report.velocity.cycle_time_p50) },
        { key: 'Cycle time p90', value: formatDurationMetric(report.velocity.cycle_time_p90) },
        {
          key: 'Review turnaround p50',
          value: formatDurationMetric(report.velocity.review_turnaround_p50),
        },
        {
          key: 'Review turnaround p90',
          value: formatDurationMetric(report.velocity.review_turnaround_p90),
        },
      ])

      pushSection('Member Breakdown')
      if (report.members.length === 0) {
        lines.push('- none')
      } else {
        for (const member of report.members) {
          lines.push(
            `- ${userCell(member.user, linkMode)} authored=${member.prs_authored} reviewed=${member.prs_reviewed} commits=${member.commits} lines=${member.lines_changed} score=${formatMemberScore(member.user, memberInsights)} trend=${formatMemberTrend(member.user, memberInsights)}`,
          )
        }
      }
      lines.push('')

      pushSection(`What Shipped (${report.shipped.total_merged} PRs merged)`)
      if (report.shipped.entries.length === 0) {
        lines.push('- No merged PRs in range.')
      } else {
        for (const entry of report.shipped.entries) {
          lines.push(`- *${userCell(entry.author, linkMode)}*`)
          for (const pr of entry.prs) {
            lines.push(
              `  - ${prCell(pr.repo, pr.number, linkMode)} ${pr.title} (${repoCell(pr.repo, linkMode)})`,
            )
            if (pr.body_snippet) {
              lines.push(`    ${pr.body_snippet}`)
            }
          }
        }
      }
      lines.push('')

      pushSection('Themes')
      if (report.themes.groups.length === 0) {
        lines.push('- none')
      } else {
        for (const group of report.themes.groups) {
          lines.push(`- ${group.label}: ${group.prs.length}`)
        }
      }
      lines.push('')

      if (!concise) {
        pushSection('Deploy/CI Activity')
        lines.push(`- ${report.deploy_activity.total_count} deploy/CI PRs`)
        lines.push('')
      }

      pushSection('Repo Breakdown')
      if (report.repo_breakdown.entries.length === 0) {
        lines.push('- No repository activity in range.')
      } else {
        for (const entry of report.repo_breakdown.entries) {
          lines.push(
            `- *${formatRepoHeading(entry, linkMode)}* opened=${entry.prs_opened} merged=${entry.prs_merged} contributors=${entry.contributors.length}`,
          )
          for (const pr of entry.shipped) {
            lines.push(
              `  - ${prCell(pr.repo, pr.number, linkMode)} ${pr.title} author=${userCell(pr.author, linkMode)}`,
            )
          }
        }
      }
      lines.push('')

      pushSection('Blockers')
      const blockerResult = limitTeamBlockers(deriveTeamBlockers(report), concise)
      if (blockerResult.rows.length === 0) {
        lines.push('- none')
      } else {
        for (const blocker of blockerResult.rows) {
          lines.push(
            `- ${repoCell(blocker.repo, linkMode)} ${prCell(blocker.repo, blocker.pr_number, linkMode)} owner=${userCell(blocker.owner ?? 'unknown', linkMode)} status=${blocker.status} days=${blocker.days}`,
          )
        }
      }
      if (blockerResult.omitted > 0) {
        lines.push(`and ${blockerResult.omitted} more...`)
      }
      break
    }
    case 'exec': {
      pushSection('Velocity Trends')
      if (report.velocity_trends.length === 0) {
        lines.push('- none')
      } else {
        for (const trend of report.velocity_trends) {
          lines.push(
            `- ${formatTimestamp(trend.bucket_start, timeZone)} merged=${trend.prs_merged} cycle_time_p50=${formatDurationMetric(trend.cycle_time_p50)}`,
          )
        }
      }
      lines.push('')

      pushSection('Cycle Time Trends')
      if (report.cycle_time_trends.length === 0) {
        lines.push('- none')
      } else {
        for (const trend of report.cycle_time_trends) {
          lines.push(
            `- ${formatTimestamp(trend.bucket_start, timeZone)} cycle_time_p50=${formatDurationMetric(trend.cycle_time_p50)}`,
          )
        }
      }
      lines.push('')

      pushSection('Repo Health')
      if (report.repo_health.length === 0) {
        lines.push('- none')
      } else {
        for (const entry of report.repo_health) {
          lines.push(
            `- ${repoCell(entry.repo, linkMode)} status=${entry.status} last_activity=${entry.last_activity_at ? formatTimestamp(entry.last_activity_at, timeZone) : 'n/a'}`,
          )
        }
      }
      lines.push('')

      pushSection('Highlights')
      if (report.highlights.length === 0) {
        lines.push('- none')
      } else {
        for (const entry of report.highlights) {
          lines.push(
            `- ${repoCell(entry.pr.repo, linkMode)} ${prCell(entry.pr.repo, entry.pr.number, linkMode)} reasons=${entry.reasons.join('; ')}`,
          )
        }
      }
      lines.push('')

      pushSection('Team Breakdown')
      if (report.team_breakdown.length === 0) {
        lines.push('- none')
      } else {
        for (const member of report.team_breakdown) {
          lines.push(
            `- ${userCell(member.user, linkMode)} authored=${member.prs_authored} reviewed=${member.prs_reviewed} commits=${member.commits} lines=${member.lines_changed} score=${formatMemberScore(member.user, memberInsights)} trend=${formatMemberTrend(member.user, memberInsights)}`,
          )
        }
      }
      lines.push('')

      pushSection(`What Shipped (${report.shipped.total_merged} PRs merged)`)
      if (report.shipped.entries.length === 0) {
        lines.push('- No merged PRs in range.')
      } else {
        for (const entry of report.shipped.entries) {
          lines.push(`- *${userCell(entry.author, linkMode)}*`)
          for (const pr of entry.prs) {
            lines.push(
              `  - ${prCell(pr.repo, pr.number, linkMode)} ${pr.title} (${repoCell(pr.repo, linkMode)})`,
            )
            if (pr.body_snippet) {
              lines.push(`    ${pr.body_snippet}`)
            }
          }
        }
      }
      lines.push('')

      pushSection('Themes')
      if (report.themes.groups.length === 0) {
        lines.push('- none')
      } else {
        for (const group of report.themes.groups) {
          lines.push(`- ${group.label}: ${group.prs.length}`)
        }
      }
      lines.push('')

      if (!concise) {
        pushSection('Deploy/CI Activity')
        lines.push(`- ${report.deploy_activity.total_count} deploy/CI PRs`)
        lines.push('')
      }

      pushSection('Repo Breakdown')
      if (report.repo_breakdown.entries.length === 0) {
        lines.push('- No repository activity in range.')
      } else {
        for (const entry of report.repo_breakdown.entries) {
          lines.push(
            `- *${formatRepoHeading(entry, linkMode)}* opened=${entry.prs_opened} merged=${entry.prs_merged} contributors=${entry.contributors.length}`,
          )
          for (const pr of entry.shipped) {
            lines.push(
              `  - ${prCell(pr.repo, pr.number, linkMode)} ${pr.title} author=${userCell(pr.author, linkMode)}`,
            )
          }
        }
      }
      break
    }
    default: {
      const _exhaustive: never = report
      throw new Error(`Unhandled report type: ${_exhaustive}`)
    }
  }

  if (
    (report.type === 'personal' || report.type === 'individual') &&
    history &&
    history.length > 0
  ) {
    lines.push('')
    pushSection('History')
    for (const point of history) {
      lines.push(
        `- ${formatTimestamp(point.bucket_start, timeZone)} opened=${point.prs_opened} merged=${point.prs_merged} closed=${point.prs_closed} commits=${point.commits} reviews=${point.reviews} lines=${point.lines_changed} trend=${trendArrow(point.trend)}`,
      )
    }
  }

  return lines.join('\n')
}

function formatCsv(
  report: Report,
  blockersOnly: boolean,
  thresholds: { stale_days: number; stuck_days: number },
  renderOptions: RenderOptions,
): string {
  const concise = renderOptions.concise ?? false

  if (report.type === 'personal' || report.type === 'individual') {
    if (blockersOnly) {
      const blockers = deriveBlockers(report, thresholds)
      return renderCsv(
        ['repo', 'pr', 'status', 'days'],
        blockers.map((blocker) => [
          blocker.repo,
          `#${blocker.pr_number}`,
          blocker.status,
          `${blocker.days}`,
        ]),
      )
    }

    const rows: string[][] = [
      ['prs_opened', `${report.summary.prs_opened}`],
      ['prs_merged', `${report.summary.prs_merged}`],
      ['prs_closed', `${report.summary.prs_closed}`],
      ['commits', `${report.summary.commits}`],
      ['repos_touched', `${report.summary.repos_touched}`],
      ['lines_changed', `${report.summary.lines_changed}`],
    ]
    if (renderOptions.history && renderOptions.history.length > 0) {
      rows.push(
        ...renderOptions.history.map((point) => [
          `history_${new Date(point.bucket_start).toISOString()}`,
          `opened=${point.prs_opened};merged=${point.prs_merged};closed=${point.prs_closed};commits=${point.commits};reviews=${point.reviews};lines=${point.lines_changed};trend=${trendArrow(point.trend)}`,
        ]),
      )
    }
    return renderCsv(['metric', 'value'], rows)
  }

  if (report.type === 'team') {
    if (blockersOnly) {
      const blockers = limitTeamBlockers(deriveTeamBlockers(report), concise).rows
      return renderCsv(
        ['repo', 'pr', 'owner', 'status', 'days'],
        blockers.map((blocker) => [
          blocker.repo,
          `#${blocker.pr_number}`,
          blocker.owner ?? 'unknown',
          blocker.status,
          `${blocker.days}`,
        ]),
      )
    }

    return renderCsv(
      [
        'section',
        'user',
        'prs_authored',
        'prs_reviewed',
        'commits',
        'lines_changed',
        'score',
        'trend',
        'author',
        'repo',
        'pr_number',
        'title',
        'category',
        'count',
        'prs_opened',
        'prs_merged',
        'contributors',
      ],
      [
        ...report.members.map((member) => [
          'member',
          member.user,
          `${member.prs_authored}`,
          `${member.prs_reviewed}`,
          `${member.commits}`,
          `${member.lines_changed}`,
          formatMemberScore(member.user, renderOptions.memberInsights),
          formatMemberTrend(member.user, renderOptions.memberInsights),
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ]),
        ...report.shipped.entries.flatMap((entry) =>
          entry.prs.map((pr) => [
            'shipped',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            entry.author,
            pr.repo,
            `${pr.number}`,
            pr.title,
            '',
            '',
            '',
            '',
            '',
          ]),
        ),
        ...report.themes.groups.map((group) => [
          'theme',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          group.label,
          `${group.prs.length}`,
          '',
          '',
          '',
        ]),
        ...(concise
          ? []
          : report.deploy_activity.prs.map((pr) => [
              'deploy_activity',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              pr.author,
              pr.repo,
              `${pr.number}`,
              pr.title,
              '',
              '',
              '',
              '',
              '',
            ])),
        ...report.repo_breakdown.entries.map((entry) => [
          'repo_breakdown',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          entry.repo,
          '',
          '',
          '',
          '',
          `${entry.prs_opened}`,
          `${entry.prs_merged}`,
          entry.contributors.join(';'),
        ]),
      ],
    )
  }

  if (report.type === 'exec') {
    return renderCsv(
      [
        'section',
        'user',
        'prs_authored',
        'prs_reviewed',
        'commits',
        'lines_changed',
        'score',
        'trend',
        'author',
        'repo',
        'pr_number',
        'title',
        'category',
        'count',
        'prs_opened',
        'prs_merged',
        'contributors',
      ],
      [
        ...report.team_breakdown.map((member) => [
          'member',
          member.user,
          `${member.prs_authored}`,
          `${member.prs_reviewed}`,
          `${member.commits}`,
          `${member.lines_changed}`,
          formatMemberScore(member.user, renderOptions.memberInsights),
          formatMemberTrend(member.user, renderOptions.memberInsights),
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ]),
        ...report.shipped.entries.flatMap((entry) =>
          entry.prs.map((pr) => [
            'shipped',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            entry.author,
            pr.repo,
            `${pr.number}`,
            pr.title,
            '',
            '',
            '',
            '',
            '',
          ]),
        ),
        ...report.themes.groups.map((group) => [
          'theme',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          group.label,
          `${group.prs.length}`,
          '',
          '',
          '',
        ]),
        ...(concise
          ? []
          : report.deploy_activity.prs.map((pr) => [
              'deploy_activity',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              pr.author,
              pr.repo,
              `${pr.number}`,
              pr.title,
              '',
              '',
              '',
              '',
              '',
            ])),
        ...report.repo_breakdown.entries.map((entry) => [
          'repo_breakdown',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          entry.repo,
          '',
          '',
          '',
          '',
          `${entry.prs_opened}`,
          `${entry.prs_merged}`,
          entry.contributors.join(';'),
        ]),
      ],
    )
  }

  throw new Error(`Unhandled report type: ${report.type}`)
}

function renderCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','))
  }
  return lines.join('\n')
}

function csvEscape(value: string): string {
  const escaped = value.replaceAll('"', '""')
  if (
    escaped.includes(',') ||
    escaped.includes('\n') ||
    escaped.includes('\r') ||
    escaped.includes('"')
  ) {
    return `"${escaped}"`
  }
  return escaped
}

export { renderTable }

function applySort(report: Report, sortField?: string): Report {
  if (!sortField) {
    return report
  }

  const sort = sortField.trim().toLowerCase()

  if (report.type === 'team') {
    return {
      ...report,
      members: sortMembers(report.members, sort),
    }
  }

  if (report.type === 'exec') {
    return {
      ...report,
      team_breakdown: sortMembers(report.team_breakdown, sort),
    }
  }

  return report
}

// Generic over the element type so sorting preserves the full member shape (e.g. shipped_lines)
// rather than narrowing it away — the function only reads the sort-key fields.
function sortMembers<
  T extends {
    user: string
    prs_authored: number
    prs_reviewed: number
    commits: number
    lines_changed: number
    shipped_lines: number
    cycle_time_p50: number | null
  },
>(members: T[], sort: string): T[] {
  switch (sort) {
    case 'user':
    case 'author':
      return [...members].toSorted((a, b) => a.user.localeCompare(b.user))
    case 'prs_authored':
      return [...members].toSorted((a, b) => b.prs_authored - a.prs_authored)
    case 'prs_reviewed':
      return [...members].toSorted((a, b) => b.prs_reviewed - a.prs_reviewed)
    case 'commits':
      return [...members].toSorted((a, b) => b.commits - a.commits)
    case 'lines_changed':
      return [...members].toSorted((a, b) => b.lines_changed - a.lines_changed)
    case 'shipped_lines':
      return [...members].toSorted((a, b) => b.shipped_lines - a.shipped_lines)
    case 'cycle_time_p50':
      return [...members].toSorted((a, b) => compareNullableAsc(a.cycle_time_p50, b.cycle_time_p50))
    default:
      return members
  }
}

function compareNullableAsc(a: number | null, b: number | null): number {
  if (a === null && b === null) {
    return 0
  }
  if (a === null) {
    return 1
  }
  if (b === null) {
    return -1
  }
  return a - b
}

function deriveBlockers(
  report: Extract<Report, { type: 'personal' | 'individual' }>,
  thresholds: { stale_days: number; stuck_days: number },
): BlockerRow[] {
  const staleDays = thresholds.stale_days
  const stuckDays = thresholds.stuck_days
  const rows = report.open_work.open_prs.flatMap((pr) => {
    const blockers: BlockerRow[] = []
    const stale = Math.floor((Date.now() - pr.updated_at) / (24 * 60 * 60 * 1000))
    const stuck = Math.floor((Date.now() - pr.created_at) / (24 * 60 * 60 * 1000))
    if (stale >= staleDays) {
      blockers.push({ repo: pr.repo, pr_number: pr.number, status: 'stale', days: stale })
    }
    if (stuck >= stuckDays) {
      blockers.push({ repo: pr.repo, pr_number: pr.number, status: 'stuck', days: stuck })
    }
    return blockers
  })
  return collapseBlockerRows(rows)
}

function isEmptyPersonalReport(report: Report): boolean {
  if (report.type !== 'personal' && report.type !== 'individual') {
    return false
  }

  const summary = report.summary
  const hasSummary =
    summary.prs_opened > 0 ||
    summary.prs_merged > 0 ||
    summary.prs_closed > 0 ||
    summary.commits > 0

  const hasOpenWork = report.open_work.open_prs.length > 0
  const hasReviewDebt =
    report.review_debt.requested.length > 0 || report.review_debt.team_prs.length > 0

  return !(hasSummary || hasOpenWork || hasReviewDebt)
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(`gh-pulse error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
