# Shipped and Themes Spec

## Scope

Applies to `team` and `exec` reports.

Adds four qualitative sections:

- `shipped`
- `themes`
- `deploy_activity`
- `repo_breakdown`

Also adds PR body persistence in the core Pull Request model.

## Shipped

`shipped` summarizes merged PRs in the report window.

- Group merged PRs by contributor, not just the PR opener.
- Use `pr.contributors` when present, case-insensitively deduped.
- Fall back to `pr.author` only when contributor data is unavailable.
- Sort contributor groups alphabetically (case-insensitive).
- Sort each contributor's PRs by `merged_at` descending.
- Include `total_merged` as the merged PR count across all author groups.

Narrative implication:

- A single merged PR may appear under multiple people when work was shared.
- Downstream summaries must preserve shared credit instead of collapsing the PR to one person.
- If a human-facing update needs a single "author of record", label it explicitly and distinguish it from contributors/co-authors.

## Themes

`themes` groups merged PRs by conventional commit prefix parsed from PR title.

Supported types:

- `feat`
- `fix`
- `chore`
- `refactor`
- `docs`
- `test`
- `ci`
- `style`
- `perf`
- `build`
- `other`

Rules:

- Parse type/scope from `type(scope)!: message` and `type: message` forms.
- Normalize type case-insensitively.
- Unknown or missing prefixes map to `other`.
- Group ordering is `feat`, `fix`, then remaining known types, with `other` always last.

## Deploy/CI Activity

`deploy_activity` isolates merged deploy/automation work from feature delivery noise.

Classification is true when either:

- PR author is a bot (`isBotUsername()`), or
- Title matches deploy/release patterns:
  - `^deploy\\b`
  - `^release\\b`
  - `version packages` (case-insensitive)
  - `update.*manifests` (case-insensitive)

Behavior:

- Evaluate against unfiltered PR data (before bot/author exclusion).
- Include only merged PRs in the report window.
- Return PR list plus `total_count`.

## Repo Breakdown

`repo_breakdown` summarizes activity per repository in the report window.

Each entry includes:

- `repo`
- `prs_opened`
- `prs_merged`
- `contributors` (unique author usernames, sorted alphabetically)
- `shipped` (merged PR summaries for that repo, newest merge first)

Ordering:

- Sort repositories by `prs_merged` descending.
- Tie-break by repo name ascending.

## PR Body Capture

`PullRequest` includes:

- `body: string | null`

Sync behavior:

- REST mapping stores `pr.body ?? null`.
- GraphQL mapping stores `pr.body ?? null`.

Compatibility:

- Existing cached PR rows without `body` remain valid.
- Consumers must treat missing `body` as `null`.
