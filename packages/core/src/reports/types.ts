import type {
  Commit,
  CycleTimeMetrics,
  GitHubUsername,
  PullRequest,
  RepoFullName,
  ReviewEngagement,
  Timestamp,
} from '../types'
import type { CacheFreshness } from '../cache'
import type { ConventionalType } from '../conventional'
import type { BranchRoles, LimitedSurface, RolloutSection } from '../rollout'

export type ReportAudience = 'personal' | 'individual' | 'team' | 'exec'

export interface ReportMeta {
  audience: ReportAudience
  period_label: string
  start: Timestamp
  end: Timestamp
  start_utc: string
  end_utc: string
  generated_at: Timestamp
  repos: RepoFullName[]
  data_freshness: CacheFreshness
}

export interface PullRequestSummary {
  repo: RepoFullName
  number: number
  title: string
  body_snippet?: string
  author: GitHubUsername
  contributors?: GitHubUsername[]
  state: string
  draft: boolean
  updated_at: Timestamp
  created_at: Timestamp
  age_days: number
  url?: string
}

export interface CommitSummary {
  repo: RepoFullName
  sha: string
  author: GitHubUsername
  committed_at: Timestamp
  message: string
  additions: number
  deletions: number
  files_changed: number
}

export interface ReviewDebtSection {
  requested: PullRequestSummary[]
  team_prs: PullRequestSummary[]
}

export interface OpenWorkSection {
  open_prs: PullRequestSummary[]
}

export interface PersonalSummarySection {
  prs_opened: number
  prs_merged: number
  prs_closed: number
  commits: number
  repos_touched: number
  lines_changed: number
}

export interface PersonalReport {
  type: 'personal' | 'individual'
  user: GitHubUsername
  meta: ReportMeta
  summary: PersonalSummarySection
  review_debt: ReviewDebtSection
  open_work: OpenWorkSection
  authored_prs: PullRequestSummary[]
  commits_detail: CommitSummary[]
}

export interface TeamVelocitySection {
  prs_opened: number
  prs_merged: number
  prs_closed: number
  cycle_time_p50: number | null
  cycle_time_p90: number | null
  review_turnaround_p50: number | null
  review_turnaround_p90: number | null
}

export interface TeamMemberBreakdown {
  user: GitHubUsername
  prs_authored: number
  prs_reviewed: number
  commits: number
  // Authored-commit LOC across ALL commits in-window regardless of merge (aka "churn").
  // Force-push/restack rewrites inflate this on purpose — it is the all-activity view.
  lines_changed: number
  // Merged-PR LOC (additions+deletions) in-window, attributed to each contributor the same
  // way the shipped section groups them (aka "shipped"). PR-level, so force-push/restack/squash
  // rewrites are invisible: each PR's base..head diff is counted once. Context stat, never scored.
  shipped_lines: number
  // Median (p50) cycle time across the member's deploy-excluded merged PRs in-window,
  // attributed to contributors the same way shipped_lines is. Same units as
  // TeamVelocitySection.cycle_time_p50. Null when the member has no qualifying merged PRs.
  // Context stat, never scored.
  cycle_time_p50: number | null
}

export interface ShippedEntry {
  author: GitHubUsername
  prs: PullRequestSummary[]
}

export interface ShippedSection {
  entries: ShippedEntry[]
  total_merged: number
}

export interface ThemeGroup {
  type: ConventionalType
  label: string
  prs: PullRequestSummary[]
}

export interface ThemesSection {
  groups: ThemeGroup[]
}

export interface DeploySection {
  prs: PullRequestSummary[]
  total_count: number
}

export interface RepoBreakdownEntry {
  repo: RepoFullName
  repo_description?: string
  prs_opened: number
  prs_merged: number
  contributors: GitHubUsername[]
  shipped: PullRequestSummary[]
}

export interface RepoBreakdown {
  entries: RepoBreakdownEntry[]
}

export interface BlockerEntry {
  pr: PullRequestSummary
  status: 'stale' | 'stuck'
  days: number
}

export interface TeamReport {
  type: 'team'
  meta: ReportMeta
  team_size: number
  velocity: TeamVelocitySection
  members: TeamMemberBreakdown[]
  shipped: ShippedSection
  themes: ThemesSection
  deploy_activity: DeploySection
  repo_breakdown: RepoBreakdown
  blockers: BlockerEntry[]
  cycle_times: Array<{ pr: PullRequestSummary; metrics: CycleTimeMetrics | null }>
  review_engagement: Array<{ pr: PullRequestSummary; metrics: ReviewEngagement | null }>
  rollout: RolloutSection
}

export interface TrendPoint {
  bucket_start: Timestamp
  bucket_end: Timestamp
  prs_merged: number
  cycle_time_p50: number | null
}

export interface RepoHealthEntry {
  repo: RepoFullName
  status: 'active' | 'stale' | 'dormant'
  last_activity_at: Timestamp | null
}

export interface HighlightEntry {
  pr: PullRequestSummary
  reasons: string[]
}

export interface ExecReport {
  type: 'exec'
  meta: ReportMeta
  velocity_trends: TrendPoint[]
  cycle_time_trends: TrendPoint[]
  repo_health: RepoHealthEntry[]
  highlights: HighlightEntry[]
  team_breakdown: TeamMemberBreakdown[]
  shipped: ShippedSection
  themes: ThemesSection
  deploy_activity: DeploySection
  repo_breakdown: RepoBreakdown
}

export type Report = PersonalReport | TeamReport | ExecReport

export interface ReportInputs {
  repos: RepoFullName[]
  repo_descriptions: Record<RepoFullName, string>
  timeRange: { start: Timestamp; end: Timestamp; label: string }
  timeZone: string
  includeDrafts: boolean
  blockersOnly: boolean
  excludeAuthors: Set<GitHubUsername>
  excludeBots: boolean
  teamMembers: GitHubUsername[]
  branchRoles: BranchRoles
  limitedSurfaces: readonly LimitedSurface[]
  subjectUser?: GitHubUsername
  thresholds: {
    stale_days: number
    stuck_days: number
    large_pr_lines: number
    blocker_max_age_days: number
  }
}

export interface ReportDataContext {
  pullRequests: PullRequest[]
  commits: Commit[]
}
