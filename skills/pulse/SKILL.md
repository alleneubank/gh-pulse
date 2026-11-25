---
name: pulse
version: 1.2.0
description: This skill should be used when the user asks about "GitHub stats", "PR metrics", "team velocity", "my contributions", "standup report", "engineering visibility", or wants to generate activity reports across repos. Provides GitHub analytics for standup prep, 1:1s, team reviews, and exec reporting.
---

# gh-pulse

GitHub analytics CLI for engineering visibility - aggregates PR metrics, contribution stats, and team health across multiple repositories.

## Scope

- Use for GitHub activity reports and metrics
- Generates personal, team, or exec-level summaries
- Tracks PRs, commits, reviews, and blockers
- Commit counts include unmerged PR commits (PR head branches) for all audiences
- Caches data locally to avoid repeated API calls

## Install & Setup

```bash
# Install globally
bun add -g @alleneubank/gh-pulse

# Or run directly
bunx @alleneubank/gh-pulse
```

### Authentication

Uses GitHub token in this order:

1. `github_token` in config file
2. `GITHUB_TOKEN` environment variable
3. `gh auth token` from GitHub CLI (recommended)

### Configuration

Config file: `~/.config/gh-pulse/config.yaml`

```yaml
# Orgs/users to scan (supports both)
orgs:
  - your-org
  - your-username # personal repos

# Team membership strategy
team:
  strategy: org_members # or: config_list, repo_contributors

# Exclusions
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
  large_pr_lines: 500
  blocker_max_age_days: 90 # Hide ancient blockers (0 = show all)

# Cache settings
cache:
  ttl_hours: 1 # repo list cache TTL
  sync_ttl_hours: 24 # skip recently synced repos
  concurrency: 5 # parallel API requests
  use_etags: true # conditional GitHub requests (ETag/Last-Modified)
  use_timeline: true # consolidate PR events via timeline (ignored when use_graphql is true)
  use_graphql: true # GraphQL batching (default, most aggressive)
```

## Quick Recipes

### Personal standup (default)

```bash
gh-pulse
# or explicitly:
gh-pulse --for=me --period=week
```

### Daily standup

```bash
gh-pulse --period=today
```

### Prep for 1:1 with team member

```bash
gh-pulse --for=@alice --period=week
```

### Weekly team report

```bash
gh-pulse --for=team --period=week --format=markdown
```

### Exec quarterly summary

```bash
gh-pulse --for=exec --period=quarter --format=markdown
```

### Weekly team report for Slack

```bash
gh-pulse --for=team --period=week --format=slack
# or concise (omits deploy section, caps blockers):
gh-pulse --for=team --period=week --format=slack --concise
```

### Focus on blockers

```bash
gh-pulse --for=team --blockers
```

### Filter to specific repos

```bash
gh-pulse --repos="myorg/api,myorg/web"
# or with globs:
gh-pulse --repos="myorg/web*"
```

### Force fresh sync (ignore cache)

```bash
gh-pulse --sync
```

### Verbose output (see progress)

```bash
gh-pulse --verbose
```

### JSON output for processing

```bash
gh-pulse --format=json | jq '.summary'
```

## Command Reference

```
gh-pulse [options]

AUDIENCE
  --for, -f <target>     me | team | exec | @<username>
  --period, -p <period>  today | week | sprint | month | quarter
  --since <date>         Start date (ISO 8601 or relative: 7d, 2w, 1m)
  --until <date>         End date (ISO 8601 or relative)

Note: date-only `--until` values resolve to the end of the local day.

SCOPE
  --repos, -r <pattern>  Repo filter (glob or comma-list)
  --org, -o <org>        GitHub org to scan

Note: CLI `--org`/`--repos` override the config scope when provided.

OUTPUT
  --format <fmt>         table | json | markdown | slack | internal | customer
  --concise              Omit Deploy/CI section and cap blocker lists
  --sort <field>         Sort by field
  --quiet, -q            Suppress progress output
  --verbose, -v          Show detailed progress

CONFIG
  --config, -c <path>    Config file path
  --sync                 Force fresh sync (ignore cache TTL)

FILTERS
  --blockers             Focus on stale/stuck PRs only
  --include-drafts       Include draft PRs in metrics
```

## Report Types

### Personal (`--for=me`)

- Your PRs: opened, merged, closed
- Your commits and lines changed
- Review debt: PRs waiting for your review
- Open work: your PRs still in progress

### Individual (`--for=@user`)

Same as personal, for any GitHub user (great for 1:1 prep)

### Team (`--for=team`)

- Velocity: PRs merged, commits, lines changed
- Member breakdown: contributions per person
- Blockers: stale/stuck PRs needing attention
- Review debt across team

### Exec (`--for=exec`)

- Velocity trends over time
- Repo health scores
- Highlights and blockers summary

## Output Formats

- **table** (default): Plain text tables for terminal
- **markdown**: GitHub-flavored markdown for docs/Slack
- **json**: Structured data for scripting
- **slack**: Slack mrkdwn with `*bold*` headers, `<url|text>` links, and bullet lists (pasteable into Slack)
- **internal**: Internal-audience markdown preset (full technical detail)
- **customer**: Customer-audience markdown preset (feature/fix highlights only)

## Common Workflows

### Morning standup prep

```bash
# What did I do yesterday? What's blocked?
gh-pulse --period=today
```

### Weekly team sync

```bash
# Team velocity and blockers for the week
gh-pulse --for=team --period=week --format=markdown > team-report.md
```

### Before a 1:1

```bash
# See what your report has been working on
gh-pulse --for=@alice --period=week
```

### Board/exec reporting

```bash
# Quarterly engineering summary
gh-pulse --for=exec --period=quarter --format=markdown
```

## Recommended Workflow

Use gh-pulse as raw signal, then synthesize for the user's audience.

1. Run gh-pulse to collect the underlying activity data.
2. Interpret the output and produce an audience-appropriate narrative.

Do not treat the CLI output as the final answer when the user asks for a summary/update.

## Agent Workflow

When presenting gh-pulse data, tune output to audience:

- **Internal team update**
  - Group work by person first.
  - Include technical details, per-repo breakdown, and infra/CI work.
  - Keep blockers visible and actionable.
- **Customer-facing update**
  - Include only user-visible changes (features and bug fixes).
  - Exclude CI/deploy/infra/docs/chore-only changes.
  - Use plain language and avoid internal implementation jargon.
- **Exec summary**
  - Focus on velocity metrics, themes, and notable highlights.
  - Keep detail brief; emphasize trends and risk areas.

Example prompt patterns:

- Internal: "Summarize this for an internal weekly engineering update. Group by person, include repo-level details and infra/CI work."
- Customer: "Turn this into a customer-facing shipped update. Include only user-visible features/fixes and use plain language."
- Exec: "Create an exec summary from this report focused on velocity, trends, highlights, and top blockers."

## Output Triage

Prioritize high-signal sections first:

- Start with **What Shipped** and **Themes**.
- Skip **Deploy/CI Activity** by default unless the user explicitly asks about deploy cadence/frequency.
- Summarize **Blockers** (count + top items) instead of listing every blocker in full.

## PR Drill-Down

If PR titles are vague (for example: "Deploy", "Some improvements", "fixes"), fetch PR body context before summarizing.

- Heuristic: drill into PRs when title has fewer than 5 words, or does not include a conventional prefix (`feat:`, `fix:`, `refactor:`, etc.).
- Command:

```bash
gh pr view <number> --repo <owner/repo> --json body
```

Use the PR body to extract real user impact, rollout notes, and hidden context not visible in titles.

## Attribution Guardrails

When turning `gh-pulse` output into a weekly writeup or standings narrative:

- Treat `gh-pulse` as contributor-aware, not opener-only. A PR may belong in multiple people's highlights when `contributors` includes multiple humans.
- Do not collapse shared work to a single person unless the user explicitly asks for author-of-record attribution.
- If a PR is authored by one person but clearly shipping another person's work (for example, cherry-picks, deploys, version bumps), say that explicitly instead of rewriting authorship.
- For low-line members, check whether they have open PRs, contributor-only work, deploy/cherry-pick activity, or stale blockers before calling their week "quiet".
- If a narrative claim depends on behavior not obvious from the title, verify with `gh pr view --json body` and inspect the diff when needed.
- If contributors outside the org member list materially contributed to highlighted work, keep that shared credit visible in the narrative even if they are absent from the standings table.

## Blocker Triage

- Prioritize blockers owned by the requesting user first.
- For blockers stale for more than 30 days, suggest close-or-refresh action with a short rationale.
- In team reports, group blockers by owner so assignment is clear.
- Highlight potential cross-repo blockers (for example, PR in one repo that appears to block related work in another).

## Caching Behavior

- Data cached in SQLite at `~/.cache/gh-pulse/cache.db`
- **Repo lists**: Cached per org/user, refreshed every `ttl_hours` (default 1h)
- **Coverage tracking**: Per repo/kind ranges ensure historical requests are complete
- **PR data**: Repos synced within `sync_ttl_hours` (default 24h) are skipped only when coverage is complete
- **Daily rollups**: Built on demand for the report range (timezone-aware)
- Use `--sync` to force fresh data (refreshes both repo lists and PR data)
- Cache includes: repo lists, PRs, commits, reviews, events, rollups, coverage

## Troubleshooting

| Problem            | Solution                                              |
| ------------------ | ----------------------------------------------------- |
| No repos found     | Check config has `orgs` or `repos` defined            |
| 401 Unauthorized   | Run `gh auth login` or check `GITHUB_TOKEN`           |
| Slow first run     | Normal - syncing all repos. Subsequent runs use cache |
| Stale data         | Use `--sync` to force refresh                         |
| Missing user repos | Add username to `orgs` list (falls back to user API)  |

## Integration Ideas

- **Slack bot**: Run daily and post to channel
- **CI/CD**: Generate reports on schedule
- **MCP server**: Expose as a tool for coding agents
