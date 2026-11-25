# gh-pulse

GitHub analytics CLI for engineering visibility across multiple repositories.

This is a retroactive README: it documents what is implemented today in this repo (CLI, core library, cache, TUI, and output formats), not just the original MVP idea.

## What It Does

- Builds engineering activity reports from GitHub data:
  - Personal (`--for=me`)
  - Individual (`--for=@username`)
  - Team (`--for=team`)
  - Exec (`--for=exec`)
- Syncs PRs, events, reviews, comments, and commits into a local SQLite cache.
- Supports multiple output targets:
  - `tui`, `table`, `json`, `markdown`, `slack`, `csv`
  - Audience presets: `internal`, `customer`
- Includes blocker detection (`stale` / `stuck`), shipped/theme summaries, repo breakdowns, and trend history.
- Attributes work to PR contributors and commit co-authors (via `Co-authored-by` trailers) where possible.

## Stack

- Runtime: Bun + TypeScript
- GitHub API: Octokit (REST + GraphQL)
- Validation/config parsing: Zod + YAML
- Local cache: SQLite (`bun:sqlite`)
- Monorepo layout: `apps/*` + `packages/*`

## Quick Start

### 1. Install dependencies

```bash
bun install
```

### 2. Create config

```bash
mkdir -p ~/.config/gh-pulse
cp examples/config.yaml ~/.config/gh-pulse/config.yaml
```

Edit the copied file for your org/repos/team settings.

### 3. Authenticate GitHub

`gh-pulse` resolves a GitHub token in this order:

1. `github_token` in config (supports `${ENV_VAR}` substitution)
2. `gh auth token` from GitHub CLI

If neither is available, the CLI exits with an explicit error.

### 4. Run it

```bash
./gh-pulse --for=me --period=today
```

## CLI Usage

```text
gh-pulse [options]

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
```

## Examples

```bash
# Personal daily standup
./gh-pulse --for=me --period=today

# Team weekly markdown report
./gh-pulse --for=team --period=week --format=markdown

# Exec report in Slack-ready format
./gh-pulse --for=exec --period=month --format=slack

# Compare contributors side-by-side
./gh-pulse --compare --users=@alice,@bob --period=sprint --format=table

# Only blockers, concise output
./gh-pulse --for=team --blockers --concise

# Customer-facing summary from shipped feat/fix themes
./gh-pulse --for=team --period=week --format=customer
```

## Config Reference

Default config path resolution:

1. `--config <path>`
2. `GH_PULSE_CONFIG`
3. `$XDG_CONFIG_HOME/gh-pulse/config.yaml`
4. `~/.config/gh-pulse/config.yaml`

Default cache path resolution:

1. `cache.path` from config
2. `$XDG_CACHE_HOME/gh-pulse/cache.db`
3. `~/.cache/gh-pulse/cache.db`

Example:

```yaml
# Optional if gh CLI auth is configured
github_token: ${GITHUB_TOKEN}
linear_api_key: ${LINEAR_API_KEY}

orgs:
  - acme-co

repos:
  - acme-co/webapp
  - acme-co/cos
  - your-username/*

repo_descriptions:
  acme-co/webapp: Customer web app

team:
  strategy: org_members # org_members | config_list | repo_contributors
  members: [] # used when strategy=config_list

exclude:
  bots: true
  forks: true
  archived: true
  authors:
    - dependabot[bot]
    - renovate[bot]

thresholds:
  stale_days: 2
  stuck_days: 4
  large_pr_lines: 500
  blocker_max_age_days: 90

timezone: America/Los_Angeles

cache:
  path: ${XDG_CACHE_HOME}/gh-pulse/cache.db
  ttl_hours: 1
  sync_ttl_hours: 24
  concurrency: 5
  use_etags: true
  use_timeline: true
  use_graphql: true
```

## Report Sections (Current)

- Personal / Individual:
  - Summary
  - Open Work
  - Review Debt (requested + team PRs)
  - Optional blockers-only view
- Team:
  - Velocity
  - Member Breakdown (+ trend score)
  - What Shipped
  - Themes
  - Deploy/CI Activity
  - Repo Breakdown
  - Blockers
- Exec:
  - Velocity Trends
  - Cycle Time Trends
  - Repo Health
  - Highlights
  - Team Breakdown
  - What Shipped
  - Themes
  - Deploy/CI Activity
  - Repo Breakdown

## TUI Mode

- Default output when `stdout` is a TTY and `--format` is not explicitly set.
- Keyboard-driven tabs for overview/members/blockers/repos.
- Drill-down views, scrolling, adaptive sparkline buckets, and ANSI styling.
- Compare mode is intentionally non-interactive and falls back away from TUI.

## Architecture

```text
apps/cli/          # CLI entrypoint, arg parsing, formatting, TUI
packages/core/     # Config, GitHub sync, cache, report builders
packages/utils/    # Small helper package (version passthrough currently)
spec/              # Behavior specs (output, trends, TUI, shipped/themes)
examples/          # Example config
```

Design principle: library-first core + thin CLI wrapper.

## Development

```bash
# lint/type/format checks
bun run check

# individual checks
bun run typecheck
bun run lint
bun run format:check

# tests
bun test

# build packages
bun run build
```

## Notes and Known Boundaries

- Linear support is represented in config/types/cache schema but is not yet a first-class reporting data source in current CLI flows.
- GitHub App auth is future work; current implementation uses PAT and/or GitHub CLI auth.
- Cache freshness and coverage tracking are used heavily to avoid unnecessary API calls; `--sync` bypasses sync TTL.

## License

MIT
