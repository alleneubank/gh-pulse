import type { Cache } from '../cache'
import type {
  Commit,
  DailyCommitRollup,
  DailyPrRollup,
  DailyReviewRollup,
  PullRequest,
  RepoFullName,
  Timestamp,
} from '../types'
import { endOfDayFromTimestamp, startOfDayFromTimestamp } from '../time'

export interface ReportContextData {
  pullRequests: PullRequest[]
  commits: Commit[]
  dailyCommits: DailyCommitRollup[]
  dailyPrs: DailyPrRollup[]
  dailyReviews: DailyReviewRollup[]
  rollupRange: { start: Timestamp; end: Timestamp }
}

export function loadReportData(
  cache: Cache,
  repos: RepoFullName[],
  options: { timeRange: { start: Timestamp; end: Timestamp }; timeZone: string },
): ReportContextData {
  const rollupRange = {
    start: startOfDayFromTimestamp(options.timeRange.start, options.timeZone),
    end: endOfDayFromTimestamp(options.timeRange.end, options.timeZone),
  }

  cache.ensureDailyRollups({
    repos,
    timeRange: options.timeRange,
    timeZone: options.timeZone,
  })

  const pullRequests = repos.flatMap((repo) => cache.getPullRequests({ repo }))
  const commits = repos.flatMap((repo) => cache.getCommits({ repo }))
  const dailyCommits = cache.getDailyCommits({
    repos,
    start: rollupRange.start,
    end: rollupRange.end,
  })
  const dailyPrs = cache.getDailyPrs({
    repos,
    start: rollupRange.start,
    end: rollupRange.end,
  })
  const dailyReviews = cache.getDailyReviews({
    repos,
    start: rollupRange.start,
    end: rollupRange.end,
  })
  return { pullRequests, commits, dailyCommits, dailyPrs, dailyReviews, rollupRange }
}
