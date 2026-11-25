import { type Cache } from '../cache'
import type {
  Commit,
  DailyCommitRollup,
  DailyPrRollup,
  DailyReviewRollup,
  Event,
  GitHubUsername,
  PRMergedEvent,
  PullRequest,
  RepoFullName,
  Timestamp,
} from '../types'
import type {
  ExecReport,
  HighlightEntry,
  ReportInputs,
  TeamMemberBreakdown,
  TrendPoint,
} from './types'
import {
  buildPullRequestSummary,
  computeCycleTime,
  percentile,
  splitRangeByDay,
  isInRange,
} from './utils'
import { loadReportData } from './context'
import { isExcludedAuthor } from '../filters'
import { endOfDayFromTimestamp, startOfDayFromTimestamp } from '../time'
import { parseConventionalPrefix } from '../conventional'
import { commitMatchesContributor } from '../co-authors'
import {
  buildCycleTimeP50ByMember,
  buildDeploySection,
  buildRepoBreakdown,
  buildShippedLinesByMember,
  buildShippedSection,
  buildThemesSection,
} from './sections'

export interface ExecReportOptions extends ReportInputs {
  meta: ExecReport['meta']
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function buildExecReport(cache: Cache, options: ExecReportOptions): ExecReport {
  const { pullRequests, commits, dailyCommits, dailyPrs, dailyReviews } = loadReportData(
    cache,
    options.repos,
    {
      timeRange: options.timeRange,
      timeZone: options.timeZone,
    },
  )
  const now = options.meta.generated_at
  const exclude = options.excludeAuthors
  const teamMembers = options.teamMembers

  const prLookup = buildPullRequestLookup(pullRequests)

  const events = cache
    .getEvents({ since: options.timeRange.start, until: options.timeRange.end })
    .filter((event) => options.repos.includes(event.repo))
  const mergedEvents = events.filter(
    (event): event is PRMergedEvent =>
      event.type === 'pr_merged' && prAuthorAllowed(prLookup, event, exclude, options.excludeBots),
  )

  const mergedPrs = mergedEvents
    .map((event) => prLookup.get(`${event.repo}#${event.pr_number}`))
    .filter((pr): pr is PullRequest => Boolean(pr))
    .filter((pr) => options.includeDrafts || !pr.draft)

  const visiblePullRequests = pullRequests
    .filter((pr) => !isExcludedAuthor(pr.author, exclude, options.excludeBots))
    .filter((pr) => options.includeDrafts || !pr.draft)

  const shipped = buildShippedSection(mergedPrs, now)
  const themes = buildThemesSection(mergedPrs, now)
  const deployActivity = buildDeploySection(pullRequests, options.timeRange, now)
  const repoBreakdown = buildRepoBreakdown(
    visiblePullRequests,
    mergedPrs,
    options.timeRange,
    options.repo_descriptions,
    now,
  )

  const trendBuckets = buildWeeklyBuckets(
    options.timeRange.start,
    options.timeRange.end,
    options.timeZone,
  )
  const velocityTrends = trendBuckets.map((bucket) =>
    buildTrendPoint(cache, mergedEvents, prLookup, bucket, dailyPrs, exclude, options.excludeBots),
  )
  const cycleTimeTrends = velocityTrends

  const repoHealth = buildRepoHealth(pullRequests, commits, options.repos, options.thresholds, now)
  const highlights = buildHighlights(mergedPrs, options.thresholds.large_pr_lines, now)
  const shippedLinesByMember = buildShippedLinesByMember(mergedPrs)
  const cycleTimeP50ByMember = buildCycleTimeP50ByMember(
    mergedPrs.map((pr) => ({
      pr,
      totalTime: computeCycleTime(pr, cache.getEventsForPr(pr.repo, pr.number))?.total_time ?? null,
    })),
  )
  const teamBreakdown = buildTeamBreakdown(
    teamMembers,
    commits,
    dailyCommits,
    dailyPrs,
    dailyReviews,
    events,
    exclude,
    options.excludeBots,
    prLookup,
    options.timeRange,
    options.timeZone,
    shippedLinesByMember,
    cycleTimeP50ByMember,
  )

  return {
    type: 'exec',
    meta: options.meta,
    velocity_trends: velocityTrends,
    cycle_time_trends: cycleTimeTrends,
    repo_health: repoHealth,
    highlights,
    team_breakdown: teamBreakdown,
    shipped,
    themes,
    deploy_activity: deployActivity,
    repo_breakdown: repoBreakdown,
  }
}

function buildWeeklyBuckets(
  start: Timestamp,
  end: Timestamp,
  timeZone: string,
): Array<{ start: Timestamp; end: Timestamp }> {
  const buckets: Array<{ start: Timestamp; end: Timestamp }> = []
  const bucketStart = startOfDayFromTimestamp(start, timeZone)
  const bucketEndLimit = endOfDayFromTimestamp(end, timeZone)
  let cursor = bucketStart
  while (cursor <= bucketEndLimit) {
    const next = cursor + WEEK_MS - 1
    const bucketEnd = Math.min(next, bucketEndLimit)
    buckets.push({ start: cursor, end: bucketEnd })
    cursor = bucketEnd + 1
  }
  return buckets
}

function buildTrendPoint(
  cache: Cache,
  mergedEvents: PRMergedEvent[],
  prLookup: Map<string, PullRequest>,
  bucket: { start: Timestamp; end: Timestamp },
  dailyPrs: DailyPrRollup[],
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): TrendPoint {
  const bucketEvents = mergedEvents.filter(
    (event) =>
      event.type === 'pr_merged' &&
      event.merged_at >= bucket.start &&
      event.merged_at <= bucket.end,
  )

  const cycleTimes = bucketEvents
    .map((event) => prLookup.get(`${event.repo}#${event.pr_number}`))
    .filter((pr): pr is PullRequest => Boolean(pr))
    .map((pr) => computeCycleTime(pr, cache.getEventsForPr(pr.repo, pr.number)))
    .map((metrics) => metrics?.total_time)
    .filter((value): value is number => typeof value === 'number' && value > 0)

  return {
    bucket_start: bucket.start,
    bucket_end: bucket.end,
    prs_merged: sumDailyMerged(dailyPrs, bucket, exclude, excludeBots),
    cycle_time_p50: percentile(cycleTimes, 50),
  }
}

function buildRepoHealth(
  pullRequests: PullRequest[],
  commits: Commit[],
  repos: RepoFullName[],
  thresholds: { stale_days: number; stuck_days: number },
  now: Timestamp,
): ExecReport['repo_health'] {
  return repos.map((repo) => {
    const prActivity = pullRequests.filter((pr) => pr.repo === repo).map((pr) => pr.updated_at)
    const commitActivity = commits
      .filter((commit) => commit.repo === repo)
      .map((commit) => commit.committed_at)
    const latest = maxTimestamp([...prActivity, ...commitActivity])
    const ageDays = latest ? Math.floor((now - latest) / (24 * 60 * 60 * 1000)) : null
    let status: 'active' | 'stale' | 'dormant' = 'dormant'

    if (ageDays === null) {
      status = 'dormant'
    } else if (ageDays <= thresholds.stale_days) {
      status = 'active'
    } else if (ageDays <= thresholds.stuck_days) {
      status = 'stale'
    } else {
      status = 'dormant'
    }

    return {
      repo,
      status,
      last_activity_at: latest,
    }
  })
}

function buildHighlights(
  mergedPrs: PullRequest[],
  largePrThreshold: number,
  now: Timestamp,
): HighlightEntry[] {
  return mergedPrs
    .map((pr) => {
      const reasons: string[] = []
      if (pr.additions + pr.deletions >= largePrThreshold) {
        reasons.push(`large change (${pr.additions + pr.deletions} lines)`)
      }
      const conventional = parseConventionalPrefix(pr.title)
      if (conventional.type === 'feat' || conventional.type === 'fix') {
        reasons.push('conventional commit title')
      }
      if (pr.labels.length > 0) {
        reasons.push(`labels: ${pr.labels.slice(0, 3).join(', ')}`)
      }

      if (reasons.length === 0) {
        return null
      }

      return {
        pr: buildPullRequestSummary(pr, now),
        reasons,
      }
    })
    .filter((entry): entry is HighlightEntry => Boolean(entry))
}

/**
 * Case-insensitive username comparison.
 */
function usernameMatches(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Deduplicate team members case-insensitively, preserving first occurrence.
 */
function dedupeMembers(members: GitHubUsername[]): GitHubUsername[] {
  const seen = new Map<string, GitHubUsername>()
  for (const member of members) {
    const key = member.toLowerCase()
    if (!seen.has(key)) {
      seen.set(key, member)
    }
  }
  return Array.from(seen.values())
}

function sumDailyMerged(
  rollups: DailyPrRollup[],
  range: { start: Timestamp; end: Timestamp },
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): number {
  return rollups
    .filter((entry) => isInRange(entry.day_start, range))
    .filter((entry) => !isExcludedAuthor(entry.author, exclude, excludeBots))
    .reduce((total, entry) => total + entry.merged, 0)
}

function sumDailyPrsForMember(
  rollups: DailyPrRollup[],
  range: { start: Timestamp; end: Timestamp } | null,
  member: GitHubUsername,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): number {
  if (!range) {
    return 0
  }

  return rollups
    .filter((entry) => isInRange(entry.day_start, range))
    .filter((entry) => usernameMatches(entry.author, member))
    .filter((entry) => !isExcludedAuthor(entry.author, exclude, excludeBots))
    .reduce((total, entry) => total + entry.opened, 0)
}

function sumEdgePrOpenedForMember(
  events: Event[],
  member: GitHubUsername,
  ranges: Array<{ start: Timestamp; end: Timestamp }>,
): number {
  if (ranges.length === 0) {
    return 0
  }

  let count = 0
  for (const range of ranges) {
    for (const event of events) {
      if (event.type !== 'pr_opened') {
        continue
      }
      if (!usernameMatches(event.author, member)) {
        continue
      }
      if (isInRange(event.opened_at, range)) {
        count += 1
      }
    }
  }
  return count
}

function sumDailyReviewsForMember(
  rollups: DailyReviewRollup[],
  range: { start: Timestamp; end: Timestamp } | null,
  member: GitHubUsername,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): number {
  if (!range) {
    return 0
  }

  return rollups
    .filter((entry) => isInRange(entry.day_start, range))
    .filter((entry) => usernameMatches(entry.reviewer, member))
    .filter((entry) => !isExcludedAuthor(entry.reviewer, exclude, excludeBots))
    .reduce((total, entry) => total + entry.reviews, 0)
}

function sumEdgeReviewsForMember(
  events: Event[],
  member: GitHubUsername,
  ranges: Array<{ start: Timestamp; end: Timestamp }>,
  prLookup: Map<string, PullRequest>,
): number {
  if (ranges.length === 0) {
    return 0
  }

  let count = 0
  for (const range of ranges) {
    for (const event of events) {
      if (event.type !== 'review_submitted') {
        continue
      }
      if (!usernameMatches(event.reviewer, member)) {
        continue
      }
      // Exclude self-reviews: reviewer == PR author
      const pr = prLookup.get(`${event.repo}#${event.pr_number}`)
      if (pr && event.reviewer.toLowerCase() === pr.author.toLowerCase()) {
        continue
      }
      if (isInRange(event.submitted_at, range)) {
        count += 1
      }
    }
  }
  return count
}

function sumDailyCommitsForMember(
  rollups: DailyCommitRollup[],
  range: { start: Timestamp; end: Timestamp } | null,
  member: GitHubUsername,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): { count: number; linesChanged: number } {
  if (!range) {
    return { count: 0, linesChanged: 0 }
  }

  const rows = rollups
    .filter((entry) => isInRange(entry.day_start, range))
    .filter((entry) => usernameMatches(entry.author, member))
    .filter((entry) => !isExcludedAuthor(entry.author, exclude, excludeBots))

  return {
    count: rows.reduce((total, entry) => total + entry.commits, 0),
    linesChanged: rows.reduce((total, entry) => total + entry.additions + entry.deletions, 0),
  }
}

function sumEdgeCommitsForMember(
  commits: Commit[],
  member: GitHubUsername,
  ranges: Array<{ start: Timestamp; end: Timestamp }>,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): { count: number; linesChanged: number } {
  if (ranges.length === 0) {
    return { count: 0, linesChanged: 0 }
  }
  if (isExcludedAuthor(member, exclude, excludeBots)) {
    return { count: 0, linesChanged: 0 }
  }

  let count = 0
  let linesChanged = 0

  for (const range of ranges) {
    for (const commit of commits) {
      if (!commitMatchesContributor(commit, member)) {
        continue
      }
      if (!isInRange(commit.committed_at, range)) {
        continue
      }
      count += 1
      linesChanged += commit.additions + commit.deletions
    }
  }

  return { count, linesChanged }
}

function buildTeamBreakdown(
  teamMembers: GitHubUsername[],
  commits: Commit[],
  dailyCommits: DailyCommitRollup[],
  dailyPrs: DailyPrRollup[],
  dailyReviews: DailyReviewRollup[],
  events: Event[],
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
  prLookup: Map<string, PullRequest>,
  timeRange: { start: Timestamp; end: Timestamp },
  timeZone: string,
  shippedLinesByMember: Map<string, number>,
  cycleTimeP50ByMember: Map<string, number>,
): TeamMemberBreakdown[] {
  const rollupWindow = splitRangeByDay(timeRange, timeZone)
  const edgeRanges = rollupWindow.edges
  // Dedupe members case-insensitively
  const uniqueMembers = dedupeMembers(teamMembers)

  return uniqueMembers
    .filter((member) => !isExcludedAuthor(member, exclude, excludeBots))
    .map((member) => {
      const prsAuthored = sumDailyPrsForMember(
        dailyPrs,
        rollupWindow.fullDays,
        member,
        exclude,
        excludeBots,
      )
      const edgePrsAuthored = sumEdgePrOpenedForMember(events, member, edgeRanges)

      const reviews = sumDailyReviewsForMember(
        dailyReviews,
        rollupWindow.fullDays,
        member,
        exclude,
        excludeBots,
      )
      const edgeReviews = sumEdgeReviewsForMember(events, member, edgeRanges, prLookup)

      const commitStats = sumDailyCommitsForMember(
        dailyCommits,
        rollupWindow.fullDays,
        member,
        exclude,
        excludeBots,
      )
      const edgeCommitStats = sumEdgeCommitsForMember(
        commits,
        member,
        edgeRanges,
        exclude,
        excludeBots,
      )

      return {
        user: member,
        prs_authored: prsAuthored + edgePrsAuthored,
        prs_reviewed: reviews + edgeReviews,
        commits: commitStats.count + edgeCommitStats.count,
        lines_changed: commitStats.linesChanged + edgeCommitStats.linesChanged,
        shipped_lines: shippedLinesByMember.get(member.toLowerCase()) ?? 0,
        cycle_time_p50: cycleTimeP50ByMember.get(member.toLowerCase()) ?? null,
      }
    })
    .toSorted((a, b) => a.user.localeCompare(b.user))
}

function prAuthorAllowed(
  lookup: Map<string, PullRequest>,
  event: PRMergedEvent,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): boolean {
  const pr = lookup.get(`${event.repo}#${event.pr_number}`)
  if (!pr) {
    return false
  }
  return !isExcludedAuthor(pr.author, exclude, excludeBots)
}

function maxTimestamp(values: Array<Timestamp | undefined>): Timestamp | null {
  const filtered = values.filter((value): value is Timestamp => typeof value === 'number')
  if (filtered.length === 0) {
    return null
  }
  return Math.max(...filtered)
}

function buildPullRequestLookup(pullRequests: PullRequest[]): Map<string, PullRequest> {
  return new Map(pullRequests.map((pr) => [`${pr.repo}#${pr.number}`, pr]))
}
