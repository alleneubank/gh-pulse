import { getEventTimestamp, type Cache } from '../cache'
import type {
  Commit,
  DailyCommitRollup,
  DailyPrRollup,
  DailyReviewRollup,
  Event,
  GitHubUsername,
  PullRequest,
  RepoFullName,
  Timestamp,
} from '../types'
import type { ReportInputs, TeamReport, TeamMemberBreakdown, BlockerEntry } from './types'
import {
  buildPullRequestSummary,
  computeCycleTime,
  computeReviewEngagement,
  percentile,
  splitRangeByDay,
  isInRange,
} from './utils'
import { loadReportData } from './context'
import { isDeployPr, isExcludedAuthor } from '../filters'
import { buildRolloutSection, isPromotion } from '../rollout'
import { commitMatchesContributor } from '../co-authors'
import {
  buildCycleTimeP50ByMember,
  buildDeploySection,
  buildRepoBreakdown,
  buildShippedLinesByMember,
  buildShippedSection,
  buildThemesSection,
} from './sections'

export interface TeamReportOptions extends ReportInputs {
  meta: TeamReport['meta']
}

export function buildTeamReport(cache: Cache, options: TeamReportOptions): TeamReport {
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
  // Use lowercase keys for case-insensitive membership checks
  const teamSet = new Set(options.teamMembers.map((m) => m.toLowerCase()))

  const prLookup = buildPullRequestLookup(pullRequests)

  const events = cache
    .getEvents({ since: options.timeRange.start, until: options.timeRange.end })
    .filter((event) => options.repos.includes(event.repo))

  const rollupWindow = splitRangeByDay(options.timeRange, options.timeZone)

  const fullDayCounts = sumDailyPrsForTeam(
    dailyPrs,
    rollupWindow.fullDays,
    teamSet,
    exclude,
    options.excludeBots,
  )
  const edgeCounts = sumEdgePrEventsForTeam(
    events,
    prLookup,
    teamSet,
    exclude,
    options.excludeBots,
    rollupWindow.edges,
  )

  const opened = fullDayCounts.opened + edgeCounts.opened
  const merged = fullDayCounts.merged + edgeCounts.merged
  const closed = fullDayCounts.closed + edgeCounts.closed

  const mergedPrs = events
    .filter(
      (event): event is Event & { type: 'pr_merged'; pr_number: number } =>
        event.type === 'pr_merged',
    )
    .filter((event) =>
      prAuthorInTeam(prLookup, teamSet, event.repo, event.pr_number, exclude, options.excludeBots),
    )
    .map((event) => prLookup.get(`${event.repo}#${event.pr_number}`))
    .filter((pr): pr is PullRequest => Boolean(pr))

  const visiblePullRequests = pullRequests
    .filter((pr) => teamSet.has(pr.author.toLowerCase()))
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

  const cycleTimeEntries = mergedPrs.map((pr) => {
    const prEventsForPr = cache.getEventsForPr(pr.repo, pr.number)
    const metrics = computeCycleTime(pr, prEventsForPr)
    return { pr, metrics }
  })

  const cycleTimes = cycleTimeEntries.map(({ pr, metrics }) => {
    return { pr: buildPullRequestSummary(pr, now), metrics }
  })

  const cycleTimeValues = cycleTimes
    .map((entry) => entry.metrics?.total_time)
    .filter((value): value is number => typeof value === 'number' && value > 0)

  const reviewValues = cycleTimes
    .map((entry) => entry.metrics?.review_time)
    .filter((value): value is number => typeof value === 'number' && value >= 0)

  const reviewEngagement = mergedPrs.map((pr) => {
    const prEventsForPr = cache.getEventsForPr(pr.repo, pr.number)
    const metrics = computeReviewEngagement(pr, prEventsForPr)
    return { pr: buildPullRequestSummary(pr, now), metrics }
  })

  const shippedLinesByMember = buildShippedLinesByMember(mergedPrs)
  const cycleTimeP50ByMember = buildCycleTimeP50ByMember(
    cycleTimeEntries.map(({ pr, metrics }) => ({
      pr,
      totalTime: metrics?.total_time ?? null,
    })),
  )

  const memberBreakdown = buildMemberBreakdown(
    options.teamMembers,
    commits,
    dailyCommits,
    dailyPrs,
    dailyReviews,
    events,
    exclude,
    options.excludeBots,
    options.timeRange,
    options.timeZone,
    prLookup,
    shippedLinesByMember,
    cycleTimeP50ByMember,
  )

  const rollout = buildRolloutSection({
    roles: options.branchRoles,
    surfaces: options.limitedSurfaces,
    window: options.timeRange,
    candidates: rolloutCandidates(cache, options, teamSet, mergedPrs),
    promotions: options.repos.flatMap((repo) =>
      cache.getPullRequests({ repo }).filter((pr) => isPromotion(pr, options.branchRoles)),
    ),
  })

  const blockers = findBlockers(
    pullRequests,
    options.includeDrafts,
    exclude,
    options.excludeBots,
    options.thresholds,
    now,
    options.timeRange,
  )

  return {
    type: 'team',
    meta: options.meta,
    team_size: options.teamMembers.length,
    velocity: {
      prs_opened: opened,
      prs_merged: merged,
      prs_closed: closed,
      cycle_time_p50: percentile(cycleTimeValues, 50),
      cycle_time_p90: percentile(cycleTimeValues, 90),
      review_turnaround_p50: percentile(reviewValues, 50),
      review_turnaround_p90: percentile(reviewValues, 90),
    },
    members: memberBreakdown,
    shipped,
    themes,
    deploy_activity: deployActivity,
    repo_breakdown: repoBreakdown,
    blockers,
    cycle_times: cycleTimes,
    review_engagement: reviewEngagement,
    rollout,
  }
}

/**
 * Team engineering that can reach production in the window: this window's merges plus pull
 * requests that earlier windows merged into an integration branch and a promotion now carries.
 */
function rolloutCandidates(
  cache: Cache,
  options: TeamReportOptions,
  teamSet: Set<string>,
  mergedPrs: readonly PullRequest[],
): PullRequest[] {
  const byKey = new Map(mergedPrs.map((pr) => [`${pr.repo}#${pr.number}`, pr]))
  for (const repo of options.repos) {
    const promotions = cache
      .getPullRequests({ repo })
      .filter(
        (pr) =>
          isPromotion(pr, options.branchRoles) &&
          pr.merged_at !== null &&
          isInRange(pr.merged_at, options.timeRange),
      )
    for (const number of promotions.flatMap((pr) => pr.promotion?.included ?? [])) {
      const carried = cache.getPullRequest(repo, number)?.data
      if (carried !== undefined) {
        byKey.set(`${repo}#${number}`, carried)
      }
    }
  }
  return [...byKey.values()].filter(
    (pr) =>
      pr.state === 'merged' &&
      !isDeployPr(pr) &&
      teamSet.has(pr.author.toLowerCase()) &&
      !isExcludedAuthor(pr.author, options.excludeAuthors, options.excludeBots),
  )
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

function sumDailyPrsForTeam(
  rollups: DailyPrRollup[],
  range: { start: Timestamp; end: Timestamp } | null,
  teamSet: Set<string>,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): { opened: number; merged: number; closed: number } {
  if (!range) {
    return { opened: 0, merged: 0, closed: 0 }
  }

  const rows = rollups
    .filter((entry) => isInRange(entry.day_start, range))
    .filter((entry) => teamSet.has(entry.author.toLowerCase()))
    .filter((entry) => !isExcludedAuthor(entry.author, exclude, excludeBots))

  return {
    opened: rows.reduce((total, entry) => total + entry.opened, 0),
    merged: rows.reduce((total, entry) => total + entry.merged, 0),
    closed: rows.reduce((total, entry) => total + entry.closed, 0),
  }
}

function sumEdgePrEventsForTeam(
  events: Event[],
  prLookup: Map<string, PullRequest>,
  teamSet: Set<string>,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
  ranges: Array<{ start: Timestamp; end: Timestamp }>,
): { opened: number; merged: number; closed: number } {
  if (ranges.length === 0) {
    return { opened: 0, merged: 0, closed: 0 }
  }

  let opened = 0
  let merged = 0
  let closed = 0

  for (const range of ranges) {
    for (const event of events) {
      const timestamp = getEventTimestamp(event)
      if (!isInRange(timestamp, range)) {
        continue
      }
      if (event.type === 'pr_opened') {
        if (
          teamSet.has(event.author.toLowerCase()) &&
          !isExcludedAuthor(event.author, exclude, excludeBots)
        ) {
          opened += 1
        }
        continue
      }
      if (event.type === 'pr_merged' || event.type === 'pr_closed') {
        const pr = prLookup.get(`${event.repo}#${event.pr_number}`)
        if (!pr) {
          continue
        }
        if (
          teamSet.has(pr.author.toLowerCase()) &&
          !isExcludedAuthor(pr.author, exclude, excludeBots)
        ) {
          if (event.type === 'pr_merged') {
            merged += 1
          } else {
            closed += 1
          }
        }
      }
    }
  }

  return { opened, merged, closed }
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

function buildMemberBreakdown(
  teamMembers: GitHubUsername[],
  commits: Commit[],
  dailyCommits: DailyCommitRollup[],
  dailyPrs: DailyPrRollup[],
  dailyReviews: DailyReviewRollup[],
  events: Event[],
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
  timeRange: { start: Timestamp; end: Timestamp },
  timeZone: string,
  prLookup: Map<string, PullRequest>,
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

interface BlockerThresholds {
  stale_days: number
  stuck_days: number
  blocker_max_age_days: number
}

/**
 * Find blockers (stale/stuck PRs) with configurable age filtering.
 *
 * A PR is included in the blocker list if:
 * - It had activity (was updated) within the time range, OR
 * - It was created within the time range, OR
 * - blocker_max_age_days is 0 (disabled), OR
 * - The PR is younger than blocker_max_age_days
 */
function findBlockers(
  pullRequests: PullRequest[],
  includeDrafts: boolean,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
  thresholds: BlockerThresholds,
  now: Timestamp,
  timeRange: { start: Timestamp; end: Timestamp },
): BlockerEntry[] {
  const maxAgeDays = thresholds.blocker_max_age_days

  return pullRequests
    .filter((pr) => pr.state === 'open')
    .filter((pr) => includeDrafts || !pr.draft)
    .filter((pr) => !isExcludedAuthor(pr.author, exclude, excludeBots))
    .filter((pr) => {
      // If max age is disabled (0), include all
      if (maxAgeDays === 0) return true

      const prAgeDays = diffDays(pr.created_at, now)
      const hadActivityInRange = pr.updated_at >= timeRange.start && pr.updated_at <= timeRange.end
      const createdInRange = pr.created_at >= timeRange.start && pr.created_at <= timeRange.end
      const withinMaxAge = prAgeDays <= maxAgeDays

      // Include if: had recent activity, was created in range, or is within max age
      return hadActivityInRange || createdInRange || withinMaxAge
    })
    .flatMap((pr) => {
      const blockers: BlockerEntry[] = []
      const summary = buildPullRequestSummary(pr, now)
      const staleDays = diffDays(pr.updated_at, now)
      const stuckDays = diffDays(pr.created_at, now)
      if (staleDays >= thresholds.stale_days) {
        blockers.push({ pr: summary, status: 'stale', days: staleDays })
      }
      if (stuckDays >= thresholds.stuck_days) {
        blockers.push({ pr: summary, status: 'stuck', days: stuckDays })
      }
      return blockers
    })
    .toSorted((a, b) => b.days - a.days)
}

function diffDays(start: Timestamp, end: Timestamp): number {
  return Math.floor((end - start) / (24 * 60 * 60 * 1000))
}

/**
 * Case-insensitive check if author is in team.
 */
function teamHasAuthor(team: Set<string>, author: GitHubUsername): boolean {
  return team.has(author.toLowerCase())
}

function prAuthorInTeam(
  lookup: Map<string, PullRequest>,
  team: Set<GitHubUsername>,
  repo: RepoFullName,
  number: number,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): boolean {
  const pr = lookup.get(`${repo}#${number}`)
  if (!pr || isExcludedAuthor(pr.author, exclude, excludeBots)) {
    return false
  }
  return teamHasAuthor(team, pr.author)
}

function buildPullRequestLookup(pullRequests: PullRequest[]): Map<string, PullRequest> {
  return new Map(pullRequests.map((pr) => [`${pr.repo}#${pr.number}`, pr]))
}
