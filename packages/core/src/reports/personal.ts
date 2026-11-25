import { getEventTimestamp, type Cache } from '../cache'
import type {
  Commit,
  DailyCommitRollup,
  DailyPrRollup,
  Event,
  GitHubUsername,
  PullRequest,
  RepoFullName,
  Timestamp,
} from '../types'
import type { ReportInputs, PersonalReport } from './types'
import { buildPullRequestSummary, isInRange, splitRangeByDay } from './utils'
import { loadReportData } from './context'
import { isExcludedAuthor } from '../filters'
import { commitMatchesContributor } from '../co-authors'

/**
 * Case-insensitive username comparison.
 */
function usernameMatches(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export interface PersonalReportOptions extends ReportInputs {
  user: GitHubUsername
  meta: PersonalReport['meta']
}

export function buildPersonalReport(cache: Cache, options: PersonalReportOptions): PersonalReport {
  const { pullRequests, commits, dailyCommits, dailyPrs } = loadReportData(cache, options.repos, {
    timeRange: options.timeRange,
    timeZone: options.timeZone,
  })
  const now = options.meta.generated_at
  const exclude = options.excludeAuthors
  const userExcluded = isExcludedAuthor(options.user, exclude, options.excludeBots)

  const prLookup = buildPullRequestLookup(pullRequests)

  const events = cache
    .getEvents({ since: options.timeRange.start, until: options.timeRange.end })
    .filter((event) => options.repos.includes(event.repo))

  const rollupWindow = splitRangeByDay(options.timeRange, options.timeZone)

  const authoredPrs = pullRequests.filter(
    (pr) =>
      usernameMatches(pr.author, options.user) &&
      !isExcludedAuthor(pr.author, exclude, options.excludeBots),
  )

  const authoredSummaries = authoredPrs
    .filter(
      (pr) => pr.created_at >= options.timeRange.start && pr.created_at <= options.timeRange.end,
    )
    .map((pr) => buildPullRequestSummary(pr, now))

  const openWork = authoredPrs
    .filter((pr) => pr.state === 'open')
    .filter((pr) => options.includeDrafts || !pr.draft)
    .map((pr) => buildPullRequestSummary(pr, now))

  const requested = pullRequests
    .filter((pr) => pr.state === 'open')
    .filter((pr) => options.includeDrafts || !pr.draft)
    .filter((pr) =>
      pr.requested_reviewers.some((reviewer) => usernameMatches(reviewer, options.user)),
    )
    .filter((pr) => !isExcludedAuthor(pr.author, exclude, options.excludeBots))
    .map((pr) => buildPullRequestSummary(pr, now))

  // Use lowercase keys for case-insensitive membership checks
  const teamMembers = new Set(options.teamMembers.map((m) => m.toLowerCase()))
  const teamPrs = pullRequests
    .filter((pr) => pr.state === 'open')
    .filter((pr) => options.includeDrafts || !pr.draft)
    .filter((pr) => !usernameMatches(pr.author, options.user))
    .filter((pr) => teamMembers.has(pr.author.toLowerCase()))
    .filter((pr) => !isExcludedAuthor(pr.author, exclude, options.excludeBots))
    .map((pr) => buildPullRequestSummary(pr, now))

  const commitsForUser = commits
    .filter((commit) => commitMatchesContributor(commit, options.user))
    .filter((commit) => commit.committed_at >= options.timeRange.start)
    .filter((commit) => commit.committed_at <= options.timeRange.end)
    .filter(() => !userExcluded)

  const commitSummaries = commitsForUser.map((commit) => ({
    repo: commit.repo,
    sha: commit.sha,
    author: commit.author,
    committed_at: commit.committed_at,
    message: commit.message,
    additions: commit.additions,
    deletions: commit.deletions,
    files_changed: commit.files_changed,
  }))

  const fullPrCounts = sumDailyPrsForUser(
    dailyPrs,
    rollupWindow.fullDays,
    options.user,
    exclude,
    options.excludeBots,
  )
  const edgePrCounts = sumEdgePrEvents(events, prLookup, options.user, rollupWindow.edges)
  const prCounts = {
    opened: fullPrCounts.opened + edgePrCounts.opened,
    merged: fullPrCounts.merged + edgePrCounts.merged,
    closed: fullPrCounts.closed + edgePrCounts.closed,
  }

  const commitTotals = sumDailyCommitsForUser(
    dailyCommits,
    rollupWindow.fullDays,
    options.user,
    exclude,
    options.excludeBots,
  )
  const edgeCommitTotals = sumEdgeCommitsForUser(
    commits,
    rollupWindow.edges,
    options.user,
    exclude,
    options.excludeBots,
  )

  const reposTouched = new Set([...commitTotals.repos, ...edgeCommitTotals.repos])

  const summary = {
    prs_opened: prCounts.opened,
    prs_merged: prCounts.merged,
    prs_closed: prCounts.closed,
    commits: commitTotals.count + edgeCommitTotals.count,
    repos_touched: reposTouched.size,
    lines_changed: commitTotals.linesChanged + edgeCommitTotals.linesChanged,
  }

  return {
    type: options.meta.audience === 'individual' ? 'individual' : 'personal',
    user: options.user,
    meta: options.meta,
    summary,
    review_debt: {
      requested,
      team_prs: teamPrs,
    },
    open_work: {
      open_prs: openWork,
    },
    authored_prs: authoredSummaries,
    commits_detail: commitSummaries,
  }
}

function prMatchesAuthor(
  lookup: Map<string, PullRequest>,
  repo: RepoFullName,
  number: number,
  user: GitHubUsername,
): boolean {
  const pr = lookup.get(`${repo}#${number}`)
  return pr ? usernameMatches(pr.author, user) : false
}

function buildPullRequestLookup(pullRequests: PullRequest[]): Map<string, PullRequest> {
  return new Map(pullRequests.map((pr) => [`${pr.repo}#${pr.number}`, pr]))
}

function sumDailyPrsForUser(
  rollups: DailyPrRollup[],
  range: { start: Timestamp; end: Timestamp } | null,
  user: GitHubUsername,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): { opened: number; merged: number; closed: number } {
  if (range === null) {
    return { opened: 0, merged: 0, closed: 0 }
  }

  const opened = rollups
    .filter((entry) => isInRange(entry.day_start, range))
    .filter((entry) => usernameMatches(entry.author, user))
    .filter((entry) => !isExcludedAuthor(entry.author, exclude, excludeBots))
    .reduce((total, entry) => total + entry.opened, 0)

  const merged = rollups
    .filter((entry) => isInRange(entry.day_start, range))
    .filter((entry) => usernameMatches(entry.author, user))
    .filter((entry) => !isExcludedAuthor(entry.author, exclude, excludeBots))
    .reduce((total, entry) => total + entry.merged, 0)

  const closed = rollups
    .filter((entry) => isInRange(entry.day_start, range))
    .filter((entry) => usernameMatches(entry.author, user))
    .filter((entry) => !isExcludedAuthor(entry.author, exclude, excludeBots))
    .reduce((total, entry) => total + entry.closed, 0)

  return { opened, merged, closed }
}

function sumEdgePrEvents(
  events: Event[],
  prLookup: Map<string, PullRequest>,
  user: GitHubUsername,
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
      if (event.type === 'pr_opened' && usernameMatches(event.author, user)) {
        opened += 1
      } else if (
        event.type === 'pr_merged' &&
        prMatchesAuthor(prLookup, event.repo, event.pr_number, user)
      ) {
        merged += 1
      } else if (
        event.type === 'pr_closed' &&
        prMatchesAuthor(prLookup, event.repo, event.pr_number, user)
      ) {
        closed += 1
      }
    }
  }

  return { opened, merged, closed }
}

function sumDailyCommitsForUser(
  rollups: DailyCommitRollup[],
  range: { start: Timestamp; end: Timestamp } | null,
  user: GitHubUsername,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): { count: number; linesChanged: number; repos: Set<RepoFullName> } {
  const repos = new Set<RepoFullName>()
  if (range === null) {
    return { count: 0, linesChanged: 0, repos }
  }

  const rows = rollups
    .filter((entry) => isInRange(entry.day_start, range))
    .filter((entry) => usernameMatches(entry.author, user))
    .filter((entry) => !isExcludedAuthor(entry.author, exclude, excludeBots))

  for (const entry of rows) {
    repos.add(entry.repo)
  }

  const count = rows.reduce((total, entry) => total + entry.commits, 0)
  const linesChanged = rows.reduce((total, entry) => total + entry.additions + entry.deletions, 0)

  return { count, linesChanged, repos }
}

function sumEdgeCommitsForUser(
  commits: Commit[],
  ranges: Array<{ start: Timestamp; end: Timestamp }>,
  user: GitHubUsername,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): { count: number; linesChanged: number; repos: Set<RepoFullName> } {
  const repos = new Set<RepoFullName>()
  if (ranges.length === 0) {
    return { count: 0, linesChanged: 0, repos }
  }
  if (isExcludedAuthor(user, exclude, excludeBots)) {
    return { count: 0, linesChanged: 0, repos }
  }

  let count = 0
  let linesChanged = 0

  for (const range of ranges) {
    for (const commit of commits) {
      if (!commitMatchesContributor(commit, user)) {
        continue
      }
      if (!isInRange(commit.committed_at, range)) {
        continue
      }
      count += 1
      linesChanged += commit.additions + commit.deletions
      repos.add(commit.repo)
    }
  }

  return { count, linesChanged, repos }
}
