# gh-pulse Specification

GitHub analytics CLI for engineering visibility. Aggregates PR metrics, contribution stats, and team health across multiple repositories.

## Overview

Detailed behavior specs are split into focused sub-specs under `spec/`:

- `spec/cli-output.md`
- `spec/member-trends.md`
- `spec/shipped-themes.md`
- `spec/tui.md`

### Vision

A library-first tool that provides engineering metrics for:

- **Personal tracking**: Understand your own contribution patterns
- **1:1 preparation**: Data-driven conversations with team members
- **Executive reporting**: Velocity trends for stakeholders
- **Blocker identification**: Surface stuck work before it becomes a problem

### Architecture Principles

1. **Library-first**: Core logic is a library; CLI is a thin wrapper
2. **Data layer focus**: Capture raw events; defer scoring/analysis to consumers (including LLMs)
3. **Plugin architecture**: PM tools (Linear, Jira, GitHub Projects) are adapters
4. **Offline-capable**: Local cache enables queries without network

## Stack

| Component     | Choice           | Rationale                               |
| ------------- | ---------------- | --------------------------------------- |
| Runtime       | Bun + TypeScript | Fast startup                            |
| GitHub API    | Octokit          | Official SDK, well-typed                |
| PM Adapter    | De-scoped        | Reserved for future adapter/plugin work |
| Cache         | SQLite or DuckDB | Local, queryable, supports history      |
| CLI Framework | TBD              | Minimal, flag parsing                   |

## CLI Interface

```
gh-pulse [options]

AUDIENCE
  --for, -f <target>     me | team | exec | @<username>
                         Default: me

TIME RANGE
  --period, -p <period>  today | week | sprint | month | quarter
                         Default: week
  --since <date>         Start date (ISO 8601, relative: 7d/2w/1m, or today/yesterday/now)
  --until <date>         End date (ISO 8601, relative, or today/yesterday/now)

SCOPE
  --repos, -r <pattern>  Repo filter (glob or comma-list)
  --org, -o <org>        GitHub org to scan

Note: CLI `--org`/`--repos` override the config scope when provided.

OUTPUT
  --format <fmt>         tui | table | json | markdown | csv
                         Default: tui on TTY, table otherwise
  --sort <field>         Sort by field (default: author alphabetical)

CONFIG
  --config, -c <path>    Config file path
                         Default: ~/.config/gh-pulse/config.yaml

FILTERS
  --blockers             Focus on stale/stuck PRs only
  --include-drafts       Include draft PRs in metrics (excluded by default)
```

## Configuration

### File Location

Default: `$XDG_CONFIG_HOME/gh-pulse/config.yaml` or `~/.config/gh-pulse/config.yaml`

Override with `--config` flag or `GH_PULSE_CONFIG` environment variable.

### Schema

```yaml
# Authentication
github_token: ${GITHUB_TOKEN} # PAT with repo read access
linear_api_key: ${LINEAR_API_KEY} # Optional

# Scope
orgs:
  - acme-co

repos:
  - acme-co/webapp
  - acme-co/cos
  - your-username/* # Glob patterns supported

# Team membership strategy
team:
  strategy: org_members # org_members | config_list | repo_contributors
  members: # Only used if strategy: config_list
    - alice
    - bob

# Exclusions (all default to true)
exclude:
  bots: true
  forks: true
  archived: true
  authors:
    - dependabot[bot]
    - renovate[bot]

# Thresholds
thresholds:
  stale_days: 2 # PR with no activity
  stuck_days: 4 # PR considered stuck

# Time
timezone: America/Los_Angeles # Default: system timezone

# Cache
cache:
  path: ${XDG_CACHE_HOME}/gh-pulse/cache.db # Default
  ttl_hours: 1 # TTL for mutable data (titles, status)
  sync_ttl_hours: 24 # Skip recently synced repos
  concurrency: 5 # Parallel API requests
  use_etags: true # Enable HTTP conditional requests
  use_timeline: true # Consolidate PR activity via timeline (ignored when use_graphql is true)
  use_graphql: true # GraphQL batching (default, most aggressive)

# Rollout
rollout:
  production_branches: [main, master] # Merges here are production
  integration_branches: [dev] # Promoted into a production branch by promotion PRs
  limited_surfaces: # Surfaces only part of the audience reaches; matched as a whole word in PR bodies
    - name: v2
      label: Closed beta
```

## Reports

### Personal Report (`--for=me`)

Identity resolved via `octokit.rest.users.getAuthenticated()`.

**Sections:**

1. **Summary**: Period, repos scanned, data freshness
2. **PRs Authored**: Open, merged, closed in period
3. **Commits**: Count, repos touched, files changed
4. **Review Debt**:
   - Requested reviews (urgent): PRs where you're explicitly requested
   - Team PRs (optional): Other team PRs you could review
5. **Open Work**: Your open PRs with age and status

### Individual Report (`--for=@username`)

Same as personal report but for specified user. Used for 1:1 preparation.

### Team Report (`--for=team`)

Team membership determined by configured strategy.

**Sections:**

1. **Summary**: Period, team size, repos, data freshness
2. **Velocity**:
   - PRs opened/merged/closed
   - Cycle time (p50, p90)
   - Review turnaround (p50, p90)
3. **Member Breakdown**: Table sorted alphabetically by username
   - PRs authored
   - PRs reviewed (peer reviews only; self-reviews excluded)
   - Commits
   - Lines changed
4. **Blockers**: Stale and stuck PRs with owner and age
5. **Rollout** (`rollout`): what reached production in the window and how it is exposed
   - `promotions`: merged promotion PRs (integration -> production branch) in the window, with the
     PR numbers their commit headlines name (`(#N)` or `Merge pull request #N`) and whether the
     commit listing was complete (it caps at 250 commits)
   - `reached_production`: team-authored, non-deploy PRs whose production arrival falls in the
     window, either merged straight into a production branch or carried by a promotion (`via`),
     including PRs merged in an earlier window
   - `exposure` per entry, read from the PR body's `Ships:` line by conservative keyword rules:
     `live`, `beta`, `flag` (with the flag name), `dark`, `internal`, or `unknown`, plus `gates`:
     a closed-beta Ships line, every flag the body names, and every configured limited surface
     the body names

Sync records each PR's base and head branch, lists each merged promotion's commits once, fetches
carried PRs missing from the cache, and refetches in-window PRs cached before branches were
recorded. Rollout data lives in the existing `pull_requests` JSON documents; no table changes.

### Executive Report (`--for=exec`)

High-level metrics for stakeholders.

**Sections:**

1. **Summary**: Period, scope, data freshness
2. **Velocity Trends**: Throughput over time (PRs/week)
3. **Cycle Time Trends**: How fast work moves through the system
4. **Repo Health**: Activity level per repo (active/stale/dormant)
5. **Highlights**: Notable merges detected by:
   - Large PRs (configurable threshold)
   - Conventional commit types (feat:, fix:)
   - Labels (if used)
6. **Team Breakdown**: Aggregate contribution by person

## Data Model

### Core Types

```typescript
// Identifiers
type GitHubUsername = string
type RepoFullName = string // "owner/repo"
type PullRequestId = number
type CommitSha = string
type LinearIssueId = string

// Time
type Timestamp = number // Unix ms
type Duration = number // ms

// PR lifecycle
type PRState = 'open' | 'closed' | 'merged'
type PRDraftState = 'draft' | 'ready'

type ReviewState = 'pending' | 'commented' | 'approved' | 'changes_requested' | 'dismissed'

// Events (append-only, immutable)
interface PROpenedEvent {
  type: 'pr_opened'
  repo: RepoFullName
  pr_number: PullRequestId
  author: GitHubUsername
  opened_at: Timestamp
  is_draft: boolean
}

interface PRReadyEvent {
  type: 'pr_ready'
  repo: RepoFullName
  pr_number: PullRequestId
  ready_at: Timestamp
}

interface PRMergedEvent {
  type: 'pr_merged'
  repo: RepoFullName
  pr_number: PullRequestId
  merged_at: Timestamp
  merged_by: GitHubUsername
}

interface PRClosedEvent {
  type: 'pr_closed'
  repo: RepoFullName
  pr_number: PullRequestId
  closed_at: Timestamp
}

interface ReviewSubmittedEvent {
  type: 'review_submitted'
  repo: RepoFullName
  pr_number: PullRequestId
  reviewer: GitHubUsername
  state: ReviewState
  submitted_at: Timestamp
}

interface CommentAddedEvent {
  type: 'comment_added'
  repo: RepoFullName
  pr_number: PullRequestId
  author: GitHubUsername
  commented_at: Timestamp
}

interface CommitPushedEvent {
  type: 'commit_pushed'
  repo: RepoFullName
  sha: CommitSha
  author: GitHubUsername
  committed_at: Timestamp
  message: string
  additions: number
  deletions: number
  files_changed: number
}
```

### Coverage & Rollups

To guarantee calendar-correct ranges and incremental sync, the cache tracks coverage per repo and data kind.

```typescript
type CoverageKind =
  | 'pull_requests'
  | 'events'
  | 'commits'
  | 'commits_pr'
  | 'rollup_commits'
  | 'rollup_prs'
  | 'rollup_reviews'
  | 'rollup_activity'

interface CoverageRange {
  start: Timestamp
  end: Timestamp
}
```

Daily rollups are stored by local calendar day (timezone-aware):

```typescript
interface DailyCommitRollup {
  repo: RepoFullName
  author: GitHubUsername
  day_start: Timestamp // UTC ms for local day start
  day: string // YYYY-MM-DD in local timezone
  commits: number
  additions: number
  deletions: number
  files_changed: number
}

interface DailyPrRollup {
  repo: RepoFullName
  author: GitHubUsername
  day_start: Timestamp
  day: string
  opened: number
  merged: number
  closed: number
}

// Self-reviews (reviewer == PR author) are excluded at rollup time.
// Only peer reviews are counted.
interface DailyReviewRollup {
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
```

## Cache & Sync

- Coverage is stored per repo/kind to determine missing ranges.
- Sync runs per kind: pull requests, events, commits (default branch), PR commits (head branches).
- Commit counts include unmerged PR commits for all audiences; commits are deduped by `(repo, sha)`.
- Daily rollups are built on demand (timezone-aware) and used by reports by default.

## Time Semantics

- `--until` with a date-only value resolves to the end of that local day.
- Report metadata includes the exact UTC range used.

```typescript
type Event =
  | PROpenedEvent
  | PRReadyEvent
  | PRMergedEvent
  | PRClosedEvent
  | ReviewSubmittedEvent
  | CommentAddedEvent
  | CommitPushedEvent

// Mutable state (TTL cached)
interface PullRequest {
  repo: RepoFullName
  number: PullRequestId
  title: string
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
}

// Computed metrics
interface CycleTimeMetrics {
  draft_time: Duration | null // Time in draft state
  review_time: Duration // Ready to first review
  merge_time: Duration // First review to merge
  total_time: Duration // Open to merge
}

interface ReviewEngagement {
  time_to_first_comment: Duration | null
  time_to_first_review: Duration | null
  review_count: number
  comment_count: number
}
```

### Linear Integration Types

```typescript
type LinearIssueState = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'

interface LinearIssue {
  id: LinearIssueId
  identifier: string // "ENG-123"
  title: string
  state: LinearIssueState
  assignee: string | null
  created_at: Timestamp
  completed_at: Timestamp | null
  linked_prs: Array<{ repo: RepoFullName; number: PullRequestId }>
}

// Correlation methods
type LinearCorrelation =
  | { method: 'branch_name'; pattern: RegExp }
  | { method: 'pr_body'; pattern: RegExp }
  | { method: 'linear_api' }
```

## Database Schema

SQLite schema for local cache.

```sql
-- Metadata
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Events (append-only)
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  repo TEXT NOT NULL,
  payload JSON NOT NULL,
  timestamp INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_repo ON events(repo);
CREATE INDEX idx_events_timestamp ON events(timestamp);

-- Pull Requests (mutable, TTL cached)
CREATE TABLE pull_requests (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  data JSON NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE INDEX idx_pr_author ON pull_requests((json_extract(data, '$.author')));
CREATE INDEX idx_pr_state ON pull_requests((json_extract(data, '$.state')));

-- Commits
CREATE TABLE commits (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  data JSON NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (repo, sha)
);

CREATE INDEX idx_commits_author ON commits((json_extract(data, '$.author')));
CREATE INDEX idx_commits_timestamp ON commits((json_extract(data, '$.committed_at')));

-- Linear Issues (optional)
CREATE TABLE linear_issues (
  id TEXT PRIMARY KEY,
  data JSON NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX idx_linear_state ON linear_issues((json_extract(data, '$.state')));

-- PR to Linear Issue links
CREATE TABLE pr_issue_links (
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  issue_id TEXT NOT NULL,
  correlation_method TEXT NOT NULL,
  PRIMARY KEY (repo, pr_number, issue_id)
);

-- Sync state
CREATE TABLE sync_state (
  repo TEXT PRIMARY KEY,
  last_sync INTEGER NOT NULL,
  cursor TEXT -- For pagination
);
```

## Behavior

### Strict Mode

Config errors cause immediate failure:

- Invalid repo (doesn't exist or no access): **Fail**
- Invalid username in `--for=@user`: **Fail**
- Missing required config (github_token): **Fail**

### Empty Results

When a query returns no data:

- Display explicit message: "No activity found for @alice in the past week"
- Exit code 0 (not an error)

### Data Freshness

Every report includes freshness metadata:

```
Data as of: 2024-01-15 10:30 PST
Cache age: 12 minutes
Repos synced: 5/5
```

### Draft PR Handling

- Draft time tracked separately from review time
- Excluded from cycle time by default
- Included with `--include-drafts` flag

### PR Reopens

Each open→close cycle is tracked as a separate data point. Reopened PRs will have multiple cycles in the event log.

## Linear Correlation

PRs are linked to Linear issues using multiple methods (all applied, results merged):

1. **Branch name parsing**: Extract `ENG-123` from `feat/ENG-123-description`
2. **PR body/title parsing**: Find `ENG-123` or Linear URLs
3. **Linear API**: Query Linear for PRs linked via their GitHub integration

## Error Handling

| Scenario                | Behavior                                                     |
| ----------------------- | ------------------------------------------------------------ |
| GitHub API rate limited | Retry with exponential backoff, use cached data if available |
| Repo not found          | Fail with clear error message                                |
| User not found          | Fail with clear error message                                |
| Linear not configured   | Skip silently, no Linear data in reports                     |
| Network error           | Retry 3x, then fail with cached data warning                 |
| Invalid config          | Fail with validation error details                           |

## PAT Scopes Required

Document for users (not enforced programmatically):

- `repo` - Read access to repositories
- `read:org` - Read org membership
- `read:user` - Read user profile

For private repos, the PAT must have access to those repos.

## Future Considerations

### Scoring Layer

Raw data capture enables future scoring:

- Review engagement score (speed + thoroughness + outcome)
- Velocity score (throughput + cycle time composite)
- Repo health score (staleness + coverage + activity)

Scoring logic can be delegated to LLMs (Claude, Codex) or custom models.

### Query Subcommand

Future `gh-pulse query` subcommand for raw data exploration:

```bash
gh-pulse query "SELECT author, COUNT(*) FROM events WHERE type = 'pr_merged' GROUP BY author"
```

### Sync Command

Future explicit cache warming:

```bash
gh-pulse sync              # Sync all configured repos
gh-pulse sync --repo=x/y   # Sync specific repo
```

### MCP Integration

Library architecture enables:

- MCP server exposing metrics to Claude/CoS
- Shared library import for programmatic access
- Claude Code SDK tool for AI-assisted analysis

### Additional PM Adapters

Plugin pattern supports:

- Jira
- GitHub Projects
- Notion
- Asana
