import type { GitHubUsername, PullRequest, RepoFullName, Timestamp } from '../types'
import { conventionalLabel, parseConventionalPrefix, type ConventionalType } from '../conventional'
import { isDeployPr } from '../filters'
import { dedupeAndSortUsernamesCaseInsensitive } from '../co-authors'
import type {
  DeploySection,
  RepoBreakdown,
  ShippedSection,
  ThemeGroup,
  ThemesSection,
} from './types'
import { buildPullRequestSummary, isInRange, percentile } from './utils'

const THEME_ORDER: ConventionalType[] = [
  'feat',
  'fix',
  'chore',
  'refactor',
  'docs',
  'test',
  'ci',
  'style',
  'perf',
  'build',
  'other',
]

export function buildShippedSection(mergedPrs: PullRequest[], now: Timestamp): ShippedSection {
  const mergedOnly = mergedPrs.filter((pr) => pr.state === 'merged' && pr.merged_at !== null)
  const groups = new Map<string, { author: GitHubUsername; prs: PullRequest[] }>()

  for (const pr of mergedOnly) {
    const contributors = dedupeAndSortUsernamesCaseInsensitive(pr.contributors ?? [pr.author])
    for (const contributor of contributors) {
      const key = contributor.toLowerCase()
      const existing = groups.get(key)
      if (existing) {
        existing.prs.push(pr)
        continue
      }
      groups.set(key, { author: contributor, prs: [pr] })
    }
  }

  const entries = Array.from(groups.values())
    .toSorted((a, b) => a.author.toLowerCase().localeCompare(b.author.toLowerCase()))
    .map((entry) => ({
      author: entry.author,
      prs: entry.prs.toSorted(byMergedAtDesc).map((pr) => buildPullRequestSummary(pr, now)),
    }))

  return {
    entries,
    total_merged: mergedOnly.length,
  }
}

// Per-member "shipped" LOC: sum of each merged PR's additions+deletions (its single base..head
// diff), fanned out to every contributor exactly the way buildShippedSection groups PRs
// (contributors ?? [author], case-insensitive). Keyed by lowercased login. This mirrors how
// commit LOC (lines_changed / "churn") credits co-authors, so a co-authored PR counts for each
// contributor and per-member Shipped stays consistent with the shipped section. PR-level
// accounting makes force-push/restack/squash rewrites invisible — that is the whole point of
// Shipped versus the inflated authored-commit Churn.
export function buildShippedLinesByMember(mergedPrs: PullRequest[]): Map<string, number> {
  const byMember = new Map<string, number>()
  for (const pr of mergedPrs) {
    if (pr.state !== 'merged' || pr.merged_at === null) {
      continue
    }
    const loc = pr.additions + pr.deletions
    const contributors = dedupeAndSortUsernamesCaseInsensitive(pr.contributors ?? [pr.author])
    for (const contributor of contributors) {
      const key = contributor.toLowerCase()
      byMember.set(key, (byMember.get(key) ?? 0) + loc)
    }
  }
  return byMember
}

export function buildCycleTimeP50ByMember(
  entries: Array<{ pr: PullRequest; totalTime: number | null }>,
): Map<string, number> {
  const valuesByMember = new Map<string, number[]>()

  for (const { pr, totalTime } of entries) {
    if (
      pr.state !== 'merged' ||
      pr.merged_at === null ||
      isDeployPr(pr) ||
      typeof totalTime !== 'number' ||
      !Number.isFinite(totalTime) ||
      totalTime <= 0
    ) {
      continue
    }

    const contributors = dedupeAndSortUsernamesCaseInsensitive(pr.contributors ?? [pr.author])
    for (const contributor of contributors) {
      const key = contributor.toLowerCase()
      const existing = valuesByMember.get(key)
      if (existing) {
        existing.push(totalTime)
        continue
      }
      valuesByMember.set(key, [totalTime])
    }
  }

  const p50ByMember = new Map<string, number>()
  for (const [member, values] of valuesByMember) {
    const p50 = percentile(values, 50)
    if (p50 !== null) {
      p50ByMember.set(member, p50)
    }
  }
  return p50ByMember
}

export function buildThemesSection(mergedPrs: PullRequest[], now: Timestamp): ThemesSection {
  const grouped = new Map<ConventionalType, PullRequest[]>()

  for (const pr of mergedPrs) {
    if (pr.state !== 'merged' || pr.merged_at === null) {
      continue
    }
    const { type } = parseConventionalPrefix(pr.title)
    const existing = grouped.get(type)
    if (existing) {
      existing.push(pr)
      continue
    }
    grouped.set(type, [pr])
  }

  const groups: ThemeGroup[] = THEME_ORDER.flatMap((type) => {
    const prs = grouped.get(type)
    if (!prs || prs.length === 0) {
      return []
    }
    return [
      {
        type,
        label: conventionalLabel(type),
        prs: prs.toSorted(byMergedAtDesc).map((pr) => buildPullRequestSummary(pr, now)),
      },
    ]
  })

  return { groups }
}

export function buildDeploySection(
  pullRequests: PullRequest[],
  timeRange: { start: Timestamp; end: Timestamp },
  now: Timestamp,
): DeploySection {
  const deployPrs = pullRequests
    .filter((pr) => pr.state === 'merged' && pr.merged_at !== null)
    .filter((pr) => isInRange(pr.merged_at ?? 0, timeRange))
    .filter((pr) => isDeployPr(pr))
    .toSorted(byMergedAtDesc)
    .map((pr) => buildPullRequestSummary(pr, now))

  return {
    prs: deployPrs,
    total_count: deployPrs.length,
  }
}

export function buildRepoBreakdown(
  pullRequests: PullRequest[],
  mergedPrs: PullRequest[],
  timeRange: { start: Timestamp; end: Timestamp },
  repoDescriptions: Record<RepoFullName, string>,
  now: Timestamp,
): RepoBreakdown {
  const openedInRange = pullRequests.filter((pr) => isInRange(pr.created_at, timeRange))
  const mergedInRange = mergedPrs.filter(
    (pr) => pr.merged_at !== null && isInRange(pr.merged_at ?? 0, timeRange),
  )

  const repos = new Set<string>([
    ...openedInRange.map((pr) => pr.repo),
    ...mergedInRange.map((pr) => pr.repo),
  ])

  const entries = Array.from(repos)
    .map((repo) => {
      const opened = openedInRange.filter((pr) => pr.repo === repo)
      const merged = mergedInRange.filter((pr) => pr.repo === repo).toSorted(byMergedAtDesc)
      const contributors = dedupeAndSortUsernamesCaseInsensitive(
        [...opened, ...merged].flatMap((pr) =>
          dedupeAndSortUsernamesCaseInsensitive(pr.contributors ?? [pr.author]),
        ),
      )

      return {
        repo,
        ...(repoDescriptions[repo] ? { repo_description: repoDescriptions[repo] } : {}),
        prs_opened: opened.length,
        prs_merged: merged.length,
        contributors,
        shipped: merged.map((pr) => buildPullRequestSummary(pr, now)),
      }
    })
    .toSorted((a, b) => b.prs_merged - a.prs_merged || a.repo.localeCompare(b.repo))

  return { entries }
}

function byMergedAtDesc(a: PullRequest, b: PullRequest): number {
  return (b.merged_at ?? b.updated_at) - (a.merged_at ?? a.updated_at)
}
