import { describe, expect, it } from 'bun:test'
import { Cache } from '../cache'
import type { PullRequest } from '../types'
import { buildTeamReport, type TeamReportOptions } from './team'

const REPO = 'org/repo'

async function withMemoryCache<T>(fn: (cache: Cache) => Promise<T>): Promise<T> {
  const cache = await Cache.open({ path: ':memory:' })
  try {
    return await fn(cache)
  } finally {
    cache.close()
  }
}

function buildOptions(now: number, teamMembers: string[] = ['alice']): TeamReportOptions {
  return {
    repos: [REPO],
    repo_descriptions: {},
    timeRange: {
      start: now - 10_000,
      end: now + 10_000,
      label: 'custom',
    },
    timeZone: 'UTC',
    includeDrafts: true,
    blockersOnly: false,
    excludeAuthors: new Set(),
    excludeBots: false,
    teamMembers,
    branchRoles: { production: ['main'], integration: ['dev'] },
    limitedSurfaces: [],
    thresholds: {
      stale_days: 2,
      stuck_days: 4,
      large_pr_lines: 500,
      blocker_max_age_days: 90,
    },
    meta: {
      audience: 'team',
      period_label: 'custom',
      start: now - 10_000,
      end: now + 10_000,
      start_utc: new Date(now - 10_000).toISOString(),
      end_utc: new Date(now + 10_000).toISOString(),
      generated_at: now,
      repos: [REPO],
      data_freshness: {
        dataAsOf: now,
        cacheAgeMinutes: 0,
        reposSynced: 1,
        totalRepos: 1,
      },
    },
  }
}

function mergedPr(overrides: Partial<PullRequest> & Pick<PullRequest, 'number'>): PullRequest {
  const now = Date.parse('2026-02-20T12:00:00.000Z')
  return {
    repo: REPO,
    number: overrides.number,
    title: 'feat: ship it',
    body: null,
    state: 'merged',
    draft: false,
    author: 'alice',
    created_at: now - 5_000,
    updated_at: now - 500,
    merged_at: now - 500,
    closed_at: null,
    additions: 1,
    deletions: 1,
    commits: 1,
    requested_reviewers: [],
    labels: [],
    linked_issues: [],
    ...overrides,
  }
}

function insertMergedPr(cache: Cache, pr: PullRequest): void {
  if (pr.merged_at === null) {
    throw new Error('insertMergedPr requires merged_at')
  }
  cache.upsertPullRequest(pr)
  cache.insertEvent({
    type: 'pr_merged',
    repo: pr.repo,
    pr_number: pr.number,
    merged_at: pr.merged_at,
    merged_by: pr.author,
  })
}

describe('buildTeamReport', () => {
  it('counts an in-window merged PR consistently when its draft flag remains true', async () => {
    await withMemoryCache(async (cache) => {
      const now = Date.parse('2026-02-20T12:00:00.000Z')

      insertMergedPr(
        cache,
        mergedPr({
          number: 6,
          draft: true,
          created_at: now - 5_000,
          merged_at: now - 500,
          updated_at: now - 500,
        }),
      )

      const report = buildTeamReport(cache, { ...buildOptions(now), includeDrafts: false })
      const repo = report.repo_breakdown.entries.find((entry) => entry.repo === REPO)

      expect(report.velocity.prs_merged).toBe(1)
      expect(report.shipped.total_merged).toBe(1)
      expect(repo?.prs_merged).toBe(1)
    })
  })

  it('attributes member commit metrics when the member is a resolved co-author', async () => {
    await withMemoryCache(async (cache) => {
      const now = Date.parse('2026-02-20T12:00:00.000Z')
      const committedAt = now - 1_000

      cache.upsertCommit({
        repo: REPO,
        sha: 'team-coauthor-commit',
        author: 'teammate',
        committed_at: committedAt,
        message: 'feat: collaborative commit',
        additions: 6,
        deletions: 4,
        files_changed: 2,
        co_authors: [{ username: 'alice', email: 'alice@example.com' }],
      })

      const report = buildTeamReport(cache, buildOptions(now))
      const alice = report.members.find((member) => member.user === 'alice')

      expect(alice?.commits).toBe(1)
      expect(alice?.lines_changed).toBe(10)
    })
  })

  it('computes shipped_lines from merged-PR diffs, independent of authored-commit churn', async () => {
    await withMemoryCache(async (cache) => {
      const now = Date.parse('2026-02-20T12:00:00.000Z')

      // A standalone commit by alice — contributes to churn (lines_changed) only. This stands
      // in for the force-push/restack activity that inflates the authored-LOC view.
      cache.upsertCommit({
        repo: REPO,
        sha: 'alice-wip-commit',
        author: 'alice',
        committed_at: now - 1_000,
        message: 'wip: restacked twice',
        additions: 6,
        deletions: 4,
        files_changed: 1,
      })

      // A merged PR by alice — contributes to shipped_lines only, via its single base..head
      // diff (100+50), regardless of how many commits/rewrites produced it.
      cache.upsertPullRequest({
        repo: REPO,
        number: 7,
        title: 'feat: ship it',
        body: null,
        state: 'merged',
        draft: false,
        author: 'alice',
        created_at: now - 5_000,
        updated_at: now - 500,
        merged_at: now - 500,
        closed_at: null,
        additions: 100,
        deletions: 50,
        commits: 3,
        requested_reviewers: [],
        labels: [],
        linked_issues: [],
      })
      cache.insertEvent({
        type: 'pr_merged',
        repo: REPO,
        pr_number: 7,
        merged_at: now - 500,
        merged_by: 'alice',
      })

      const report = buildTeamReport(cache, buildOptions(now))
      const alice = report.members.find((member) => member.user === 'alice')

      // Churn = authored-commit LOC (6+4); the PR's 150-line diff does not touch it.
      expect(alice?.lines_changed).toBe(10)
      // Shipped = merged-PR LOC (100+50); the 10-line commit churn does not touch it.
      expect(alice?.shipped_lines).toBe(150)
    })
  })

  it('includes co-authors in repo_breakdown contributors without requiring authored PRs', async () => {
    await withMemoryCache(async (cache) => {
      const now = Date.parse('2026-02-20T12:00:00.000Z')

      insertMergedPr(
        cache,
        mergedPr({
          number: 9,
          author: 'alice',
          contributors: ['alice', 'bob'],
          additions: 20,
          deletions: 5,
          created_at: now - 5_000,
          merged_at: now - 500,
          updated_at: now - 500,
        }),
      )

      const report = buildTeamReport(cache, buildOptions(now, ['alice', 'bob']))
      const repo = report.repo_breakdown.entries.find((entry) => entry.repo === REPO)
      const bob = report.members.find((member) => member.user === 'bob')

      expect(repo?.contributors).toEqual(['alice', 'bob'])
      expect(bob?.prs_authored).toBe(0)
    })
  })

  it('computes member cycle_time_p50 across qualifying merged PRs', async () => {
    await withMemoryCache(async (cache) => {
      const now = Date.parse('2026-02-20T12:00:00.000Z')

      insertMergedPr(
        cache,
        mergedPr({
          number: 11,
          created_at: now - 9_000,
          merged_at: now - 8_000,
          updated_at: now - 8_000,
        }),
      )
      insertMergedPr(
        cache,
        mergedPr({
          number: 12,
          created_at: now - 7_000,
          merged_at: now - 4_000,
          updated_at: now - 4_000,
        }),
      )
      insertMergedPr(
        cache,
        mergedPr({
          number: 13,
          created_at: now - 5_000,
          merged_at: now,
          updated_at: now,
        }),
      )

      const report = buildTeamReport(cache, buildOptions(now))
      const alice = report.members.find((member) => member.user === 'alice')

      expect(alice?.cycle_time_p50).toBe(3_000)
    })
  })

  it('excludes deploy PRs from member cycle_time_p50', async () => {
    await withMemoryCache(async (cache) => {
      const now = Date.parse('2026-02-20T12:00:00.000Z')

      insertMergedPr(
        cache,
        mergedPr({
          number: 21,
          title: 'feat: normal work',
          created_at: now - 5_000,
          merged_at: now - 3_000,
          updated_at: now - 3_000,
        }),
      )
      insertMergedPr(
        cache,
        mergedPr({
          number: 22,
          title: '[deploy] promote manifests',
          created_at: now - 9_000,
          merged_at: now,
          updated_at: now,
        }),
      )

      const report = buildTeamReport(cache, buildOptions(now))
      const alice = report.members.find((member) => member.user === 'alice')

      expect(alice?.cycle_time_p50).toBe(2_000)
    })
  })

  it('reports null member cycle_time_p50 with commits but no qualifying merged PRs', async () => {
    await withMemoryCache(async (cache) => {
      const now = Date.parse('2026-02-20T12:00:00.000Z')

      cache.upsertCommit({
        repo: REPO,
        sha: 'bob-commit',
        author: 'bob',
        committed_at: now - 1_000,
        message: 'feat: work without merged prs',
        additions: 10,
        deletions: 1,
        files_changed: 2,
      })

      const report = buildTeamReport(cache, buildOptions(now, ['alice', 'bob']))
      const bob = report.members.find((member) => member.user === 'bob')

      expect(bob?.commits).toBe(1)
      expect(bob?.cycle_time_p50).toBeNull()
    })
  })
})
