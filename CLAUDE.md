# gh-pulse

GitHub analytics CLI for engineering visibility. Aggregates PR metrics, contribution stats, and team health across multiple repos.

## Vision

Standalone CLI tool that can later be exposed to agent workflows as an MCP server or shared library.

## Stack

- **Runtime:** Bun + TypeScript
- **GitHub API:** Octokit
- **Linear API:** @linear/sdk (for issue tracking)
- **Auth:** PAT to start, GitHub App later
- **Output:** Terminal tables, JSON, Markdown

## CLI Interface

```bash
gh-pulse [options]

# Audience
--for, -f       me | team | exec | <username>

# Time range
--period, -p    today | week | sprint | month | quarter
--since         Custom start date (ISO or relative: 7d, 2w)
--until         Custom end date

# Scope
--repos, -r     Repo filter (glob pattern or comma-list)
--org, -o       GitHub org to scan

# Output
--format        table | json | markdown
--config, -c    Path to config file

# Filters
--blockers      Focus on stuck/stale PRs
```

## Example Usage

```bash
# Personal daily standup
gh-pulse --for=me --period=today

# Prep for 1:1 with team member
gh-pulse --for=@alice --period=week

# Weekly team report
gh-pulse --for=team --period=week --format=markdown

# Exec quarterly summary
gh-pulse --for=exec --period=quarter --format=markdown

# Check blockers across all repos
gh-pulse --for=team --blockers
```

## Config File (`~/.gh-pulse.yaml`)

```yaml
github_token: ${GITHUB_TOKEN}
linear_api_key: ${LINEAR_API_KEY}

orgs:
  - acme-co

repos:
  - acme-co/webapp
  - acme-co/cos
  - your-username/* # personal repos

exclude:
  bots: true
  forks: true
  archived: true
  authors:
    - dependabot[bot]
    - renovate[bot]
```

## MVP Reports

| Report         | Flags         | Outputs                                            |
| -------------- | ------------- | -------------------------------------------------- |
| **Personal**   | `--for=me`    | Your commits, PRs, reviews, open work, review debt |
| **Individual** | `--for=@user` | Same as personal for specific user (for 1:1s)      |
| **Team**       | `--for=team`  | All members, comparison, blockers, velocity        |
| **Exec**       | `--for=exec`  | Velocity trends, repo health, highlights           |

## MVP Metrics

### PR Metrics

- **Cycle time:** Time from PR open to merge
- **Review turnaround:** Time to first review, time in review
- **Throughput:** PRs merged per day/week/person
- **Stale/stuck PRs:** Open too long, blocked, needs attention

### Contribution Metrics

- **Commit count:** Per author/repo
- **Lines changed:** Added/removed (with caveats about gaming)
- **Files touched:** Breadth of changes
- **Review activity:** PRs reviewed, comments given

### Issue Tracking

- GitHub Issues: open/close rates, labels
- Linear issues: aggregate across both systems

## Use Cases

1. **1:1s and reviews:** Data to have better conversations with reports
2. **Board/exec reporting:** Show engineering velocity to stakeholders
3. **Identify blockers:** PRs stuck in review, stale branches, bottlenecks
4. **Personal tracking:** Understand your own contribution patterns

## Default Exclusions

- Bot accounts (dependabot, renovate, etc.)
- Forked repositories
- Archived repositories

## Future Integration

This tool may later be exposed as:

- An MCP server that agents can query for analytics
- A shared library for programmatic access
- A data source for Claude Code SDK workflows
