# TUI Spec (v3)

## Scope

A keyboard-driven terminal UI for interactive report exploration with ANSI colors, budgeted column tables, viewport scrolling, universal drill-down navigation, blocker deduplication, adaptive sparkline buckets, and per-member activity sparklines.

## Entry

- TTY default uses `tui` when `--format` is not explicitly set.
- `--format=tui` forces TUI mode.
- Non-TTY output does not enter interactive mode; renders a single frame without ANSI codes.

## Layout

The screen is full-frame text with:

1. **Header line**: bold `gh-pulse` label, dim metadata (audience, period/range, repo count, freshness timestamp).
2. **Navigation line**: tab hints with active tab highlighted in cyan with `*` indicator; inactive tabs dim. Keybinding hints in dim.
3. **Separator**: box-drawing character (`─`) repeated to terminal width.
4. **Body panel**: active tab content using budgeted column tables (`renderBudgetedTable`).
5. **Position indicator**: shown when list items exceed viewport; format `[start-end/total] ▼`.
6. **Hint bar**: keybinding hints when interactive.

## ANSI Color Scheme

Colors are only applied when `interactive: true` (set by `runTuiSession` on TTY). Tests and non-TTY output produce no ANSI codes.

| Element                      | Style             |
| ---------------------------- | ----------------- |
| Header label (`gh-pulse`)    | bold              |
| Header metadata              | dim               |
| Active tab                   | cyan + `*` suffix |
| Inactive tabs                | dim               |
| Section headers              | bold              |
| Keybinding hints             | dim               |
| Trend arrow ▲ (up)           | green             |
| Trend arrow ▼ (down)         | red               |
| Trend arrow → (flat)         | dim               |
| Blocker status `stuck`       | red               |
| Blocker status `stale`       | yellow            |
| Blocker status `stale+stuck` | red               |
| Position indicator           | dim               |
| Separator                    | box-drawing `─`   |

## Terminal Dimensions

`runTuiSession` reads `process.stdout.columns ?? 80` as `termWidth` and `process.stdout.rows ?? 24` as `termHeight` on each render. Both values are re-read on resize (SIGWINCH). The separator line and all budgeted tables respect `termWidth`. Viewport slicing respects `termHeight`.

## Column Width Budgeting

All list-view tables use `renderBudgetedTable` instead of `renderTable` to prevent row wrapping.

### ColumnSpec

```typescript
interface ColumnSpec {
  header: string
  fixedWidth?: number // exact char width
  flexWeight?: number // share of remaining space (default: 1)
  minWidth?: number // floor for flex columns (default: 5)
}
```

### Algorithm

1. Sum fixed column widths + separators (`(cols - 1) * 3` for `|`).
2. Remaining = `totalWidth - fixedTotal - separatorTotal`.
3. Distribute remaining among flex columns by weight, respecting minWidth.
4. If minWidth enforcement causes overflow, trim flex columns from right.
5. Truncate each cell to its allocated width via `truncateToWidth`.

### Tab Column Specs

**Members**: `[cursor:2] [User:flex2,min8] [PRs:5] [Reviews:7] [Commits:7] [Lines:7] [Score:5] [Trend:10] [Activity:flex1,min8]`

**Blockers**: `[cursor:2] [Repo:flex2,min10] [PR:6] [Title:flex3,min10] [Owner:flex1,min8] [Status:12] [Days:5]`

**Repos**: `[cursor:2] [Repo:flex3,min10] [PRs:5] [Contributors:13]`

**Member Detail Recent PRs**: `[Repo:flex2,min10] [PR:6] [Title:flex3,min10] [Cycle time:10]`

**Repo Detail PRs**: `[PR:6] [Title:flex3,min10] [Author:flex1,min8] [Cycle time:10]`

## Viewport Scrolling

### Chrome lines

`CHROME_LINES = 10` (header + nav + separator + section header + blank + table header + table sep + position + blank + hints).

### Visible rows

`computeVisibleRows(termHeight) = max(1, termHeight - CHROME_LINES)`

### Scroll behavior

- Each list tab slices data to `items.slice(scrollOffset, scrollOffset + visibleRows)`.
- Auto-scroll via `ensureCursorVisible`: adjusts `scrollOffset` when cursor would move outside the viewport.
- Position indicator shown when total items > visible rows: `[start-end/total] ▼`.
- Tab switch resets both `cursorIndex = 0` and `scrollOffset = 0`.

## Tabs

Tabs are keyed by number:

- `1` Overview
- `2` Members
- `3` Blockers
- `4` Repos

Behavior by report type:

- **Team report**: Overview (velocity metrics table, activity sparkline), Members (with sparklines), Blockers (deduplicated, with PR titles and colored status), Repos (derived from cycle_times/review_engagement).
- **Exec report**: Overview (velocity trend sparkline), Members, Repos (repo_health table).
- **Personal/Individual report**: Overview is populated; unsupported tabs show a clear message.

## Overview Tab

### Team reports

Renders a `renderTable` with metrics:

- Team size
- PRs opened / merged / closed
- Cycle time p50 / p90
- Review turnaround p50 / p90
- Aggregate activity sparkline

### Exec reports

Velocity trends with merged PR sparkline.

### Personal reports

PR and commit summary.

## Members Tab

### List view

Budgeted table with cursor indicator column. Viewport-sliced.

- First column shows cursor indicator (`>` for selected row, space for others).
- Score and Trend from `memberInsights`.
- Activity column shows per-member sparkline from `histories[user]`.
- Hint bar: `[↑↓] navigate  [PgUp/Dn] page  [Enter] detail  [Esc] back`

### Member detail sub-view

When a member is selected (via Enter key), the members tab shows:

1. **Header**: `Member: {username}` with `[Esc] back to list` hint.
2. **Summary table**: PRs authored, reviewed, commits, lines changed.
3. **Insight**: Score and colored trend arrow with delta percentage.
4. **Activity sparkline**: from `histories[user]`.
5. **Recent PRs**: from `report.cycle_times` filtered by author. Budgeted table with repo, PR#, title, cycle time. Limit 10 rows.
6. **Review engagement**: from `report.review_engagement` filtered by author. Shows repo, PR#, review count, time to first review. Limit 5 rows.

## Blockers Tab

### Blocker deduplication

Raw `report.blockers` are processed through `deriveTeamBlockers()` → `collapseBlockerRows()` before rendering. A PR that is both stale and stuck appears once with status `stale+stuck` and the maximum days value.

### List view

Budgeted table with cursor indicator column. Viewport-sliced.

- PR title automatically truncated to fit column budget.
- PR number shown as OSC8 hyperlink when interactive.
- Status colored: `stuck` in red, `stale` in yellow, combined `stale+stuck` in red.
- Only available for team reports.
- Hint bar: `[↑↓] navigate  [PgUp/Dn] page  [Enter] detail  [Esc] back`

### Blocker detail sub-view

When a blocker is selected (via Enter key), shows:

1. **Header**: `Blocker: repo#number` with `[Esc] back` hint.
2. **Detail table**: Title, Author, Repo, Status, Days, State, Created, Updated, Link.

## Repos Tab

### List view (team reports)

Budgeted table with cursor indicator column. Viewport-sliced.

Derives repo activity from `report.cycle_times` and `report.review_engagement`:

- Groups by `pr.repo`
- Counts PRs per repo and unique contributors
- Sorted by PR count descending.
- Hint bar: `[↑↓] navigate  [PgUp/Dn] page  [Enter] detail  [Esc] back`

### Repo detail sub-view

When a repo is selected (via Enter key), shows:

1. **Header**: `Repo: org/name` with `[Esc] back` hint.
2. **Summary**: PR count, contributor count.
3. **PR list**: from `report.cycle_times` filtered by repo. Budgeted table with PR#, title, author, cycle time. Limit 20 rows.

### Exec reports

Renders `repo_health` table: `Repo | Status | Last activity`.

## Adaptive Sparkline Buckets

`BucketSize` supports `'day' | 'week' | 'month'`.

When no explicit `--bucket` flag is provided, `autoBucketSize()` selects:

- `'day'` for ranges < 28 days (produces daily sparkline bars)
- `'week'` for ranges ≥ 28 days

This ensures meaningful sparklines for sub-month ranges (e.g., 2-week sprint shows 14 daily bars instead of 2 weekly bars).

## Charts

- Sparkline sequences using Unicode block characters (`▁▂▃▄▅▆▇█`).
- Aggregate sparkline in overview; per-member sparklines in members tab.

## Keybindings

| Key                     | Action                                              |
| ----------------------- | --------------------------------------------------- |
| `1`..`4`                | Switch tabs (resets cursor, scroll, all selections) |
| `r`                     | Re-render current frame                             |
| `q`                     | Quit                                                |
| `Ctrl+C`                | Quit                                                |
| `↑` / `↓`               | Navigate cursor in any list tab                     |
| `Page Up` / `Page Down` | Move cursor by one page                             |
| `Home`                  | Jump to first item                                  |
| `End`                   | Jump to last item                                   |
| `Enter`                 | Open detail sub-view (members, blockers, repos)     |
| `Esc` / `Backspace`     | Back from any detail to list                        |

Escape vs arrow sequence disambiguation: if input chunk is exactly `\x1b` (1 byte), treat as Escape; if it starts with `\x1b[`, treat as arrow/page/home/end key sequence.

### Key sequences

| Sequence              | Key        |
| --------------------- | ---------- |
| `\x1b[A`              | Arrow Up   |
| `\x1b[B`              | Arrow Down |
| `\x1b[5~`             | Page Up    |
| `\x1b[6~`             | Page Down  |
| `\x1b[H` or `\x1b[1~` | Home       |
| `\x1b[F` or `\x1b[4~` | End        |

## SIGWINCH Resize

`runTuiSession` listens for `process.stdout` `resize` events and re-renders the frame with fresh `termWidth`/`termHeight`. The listener is removed on cleanup.

## Hyperlinks

When running in interactive TTY mode, OSC8 hyperlinks are enabled for repo names, PR numbers, and usernames. Non-TTY output uses plain text.

## Compare Mode

Compare mode remains non-interactive in v3 and does not open TUI.

## Shared Formatting Module

`format.ts` provides shared utilities used by both TUI and table/markdown/csv formatters:

- `style`, `colors` (cyan, green, red, yellow, dim, bold, underline)
- `renderTable`, `renderBudgetedTable`, `ColumnSpec`
- `visibleWidth`, `stripOsc8`, `stripAnsi`, `truncateToWidth`
- `formatDurationMs`, `formatDurationMetric`
- `formatHyperlink`, `githubRepoUrl`, `githubPullRequestUrl`, `githubUserUrl`
- `repoCell`, `prCell`, `userCell`
- `trendArrow`, `formatSignedPercent`, `formatMemberScore`, `formatMemberTrend`
- `BlockerRow`, `collapseBlockerRows`, `deriveTeamBlockers`, `blockerStatusOrder`
- `LinkMode` type
