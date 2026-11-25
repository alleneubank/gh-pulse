export type GitHubUsername = string
export type RepoFullName = string
export type PullRequestId = number
export type CommitSha = string
export type LinearIssueId = string

export type Timestamp = number
export type Duration = number

export type PRState = 'open' | 'closed' | 'merged'
export type PRDraftState = 'draft' | 'ready'

export type ReviewState = 'pending' | 'commented' | 'approved' | 'changes_requested' | 'dismissed'

export type CoverageKind =
  | 'pull_requests'
  | 'events'
  | 'commits'
  | 'commits_pr'
  | 'rollup_commits'
  | 'rollup_prs'
  | 'rollup_reviews'
  | 'rollup_activity'

export interface CoverageRange {
  start: Timestamp
  end: Timestamp
}

export interface ProgressEvent {
  phase: 'resolve' | 'sync'
  message: string
  current?: number
  total?: number
}

export interface PROpenedEvent {
  type: 'pr_opened'
  repo: RepoFullName
  pr_number: PullRequestId
  author: GitHubUsername
  opened_at: Timestamp
  is_draft: boolean
}

export interface PRReadyEvent {
  type: 'pr_ready'
  repo: RepoFullName
  pr_number: PullRequestId
  ready_at: Timestamp
}

export interface PRMergedEvent {
  type: 'pr_merged'
  repo: RepoFullName
  pr_number: PullRequestId
  merged_at: Timestamp
  merged_by: GitHubUsername
}

export interface PRClosedEvent {
  type: 'pr_closed'
  repo: RepoFullName
  pr_number: PullRequestId
  closed_at: Timestamp
}

export interface ReviewSubmittedEvent {
  type: 'review_submitted'
  repo: RepoFullName
  pr_number: PullRequestId
  reviewer: GitHubUsername
  state: ReviewState
  submitted_at: Timestamp
}

export interface CommentAddedEvent {
  type: 'comment_added'
  repo: RepoFullName
  pr_number: PullRequestId
  author: GitHubUsername
  commented_at: Timestamp
}

export interface CoAuthor {
  username: GitHubUsername
  email: string
}

export interface CommitPushedEvent {
  type: 'commit_pushed'
  repo: RepoFullName
  sha: CommitSha
  author: GitHubUsername
  author_email?: string
  committed_at: Timestamp
  message: string
  additions: number
  deletions: number
  files_changed: number
  co_authors?: CoAuthor[]
}

export type Event =
  | PROpenedEvent
  | PRReadyEvent
  | PRMergedEvent
  | PRClosedEvent
  | ReviewSubmittedEvent
  | CommentAddedEvent
  | CommitPushedEvent

export type DroppedContributorReason =
  | 'phantom-user'
  | 'name-with-spaces'
  | 'ai-tool-identity'
  | 'email-unresolved'

export interface DroppedContributor {
  login: string
  pr_number: PullRequestId
  repo: RepoFullName
  reason: DroppedContributorReason
  evidence?: {
    commit_sha?: CommitSha
    author_email?: string
  }
}

export interface PullRequestMeta {
  dropped_contributors?: DroppedContributor[]
}

export interface PullRequest {
  repo: RepoFullName
  number: PullRequestId
  title: string
  body: string | null
  state: PRState
  draft: boolean
  author: GitHubUsername
  created_at: Timestamp
  updated_at: Timestamp
  merged_at: Timestamp | null
  closed_at: Timestamp | null
  additions: number
  deletions: number
  commits: number
  requested_reviewers: GitHubUsername[]
  labels: string[]
  linked_issues: LinearIssueId[]
  contributors?: GitHubUsername[]
  meta?: PullRequestMeta
  /** Target and source branches; absent on entries cached before branches were recorded. */
  base_ref?: string
  head_ref?: string
  /** Set on merged promotion pull requests (integration -> production branch). */
  promotion?: PromotionContents
}

export interface PromotionContents {
  /** Pull request numbers named by the promotion's commit headlines, ascending. */
  included: PullRequestId[]
  /** False when the commit listing hit its cap, so `included` may be missing entries. */
  complete: boolean
}

export interface Commit {
  repo: RepoFullName
  sha: CommitSha
  author: GitHubUsername
  author_email?: string
  committed_at: Timestamp
  message: string
  additions: number
  deletions: number
  files_changed: number
  co_authors?: CoAuthor[]
}

export interface DailyCommitRollup {
  repo: RepoFullName
  author: GitHubUsername
  day_start: Timestamp
  day: string
  commits: number
  additions: number
  deletions: number
  files_changed: number
}

export interface DailyPrRollup {
  repo: RepoFullName
  author: GitHubUsername
  day_start: Timestamp
  day: string
  opened: number
  merged: number
  closed: number
}

export interface DailyReviewRollup {
  repo: RepoFullName
  reviewer: GitHubUsername
  day_start: Timestamp
  day: string
  reviews: number
  approved: number
  changes_requested: number
  commented: number
  dismissed: number
  pending: number
}

export interface DailyActivityRollup {
  repo: RepoFullName
  day_start: Timestamp
  day: string
  commits: number
  additions: number
  deletions: number
  files_changed: number
  prs_opened: number
  prs_merged: number
  prs_closed: number
  reviews: number
}

export interface CycleTimeMetrics {
  draft_time: Duration | null
  review_time: Duration | null
  merge_time: Duration | null
  total_time: Duration
}

export interface ReviewEngagement {
  time_to_first_comment: Duration | null
  time_to_first_review: Duration | null
  review_count: number
  comment_count: number
}

export type LinearIssueState = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'

export interface LinearIssue {
  id: LinearIssueId
  identifier: string
  title: string
  state: LinearIssueState
  assignee: string | null
  created_at: Timestamp
  completed_at: Timestamp | null
  linked_prs: Array<{ repo: RepoFullName; number: PullRequestId }>
}

export type LinearCorrelation =
  | { method: 'branch_name'; pattern: RegExp }
  | { method: 'pr_body'; pattern: RegExp }
  | { method: 'linear_api' }

export function mergeRanges<T extends CoverageRange>(ranges: T[]): T[] {
  if (ranges.length === 0) {
    return []
  }

  const sorted = [...ranges].toSorted((a, b) => a.start - b.start)
  const merged: T[] = [{ ...sorted[0]! } as T]

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1]!
    if (range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range } as T)
    }
  }

  return merged
}

export function computeGaps(
  coveredRanges: CoverageRange[],
  start: Timestamp,
  end: Timestamp,
): CoverageRange[] {
  if (start > end) {
    return []
  }

  if (coveredRanges.length === 0) {
    return [{ start, end }]
  }

  const sorted = [...coveredRanges].toSorted((a, b) => a.start - b.start)
  const gaps: CoverageRange[] = []
  let cursor = start

  for (const range of sorted) {
    if (range.end < cursor) {
      continue
    }
    if (range.start > end) {
      break
    }
    if (range.start > cursor) {
      gaps.push({ start: cursor, end: Math.min(range.start - 1, end) })
    }
    cursor = Math.max(cursor, range.end + 1)
    if (cursor > end) {
      break
    }
  }

  if (cursor <= end) {
    gaps.push({ start: cursor, end })
  }

  return gaps
}

export function isCovered(
  coveredRanges: CoverageRange[],
  start: Timestamp,
  end: Timestamp,
): boolean {
  return computeGaps(coveredRanges, start, end).length === 0
}
