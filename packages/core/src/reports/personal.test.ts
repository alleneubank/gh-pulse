import { describe, expect, it } from 'bun:test'
import { Cache } from '../cache'
import { buildPersonalReport, type PersonalReportOptions } from './personal'

const REPO = 'org/repo'

async function withMemoryCache<T>(fn: (cache: Cache) => Promise<T>): Promise<T> {
  const cache = await Cache.open({ path: ':memory:' })
  try {
    return await fn(cache)
  } finally {
    cache.close()
  }
}

function buildOptions(now: number): PersonalReportOptions {
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
    teamMembers: ['alice', 'bob'],
    branchRoles: { production: ['main'], integration: ['dev'] },
    limitedSurfaces: [],
    thresholds: {
      stale_days: 2,
      stuck_days: 4,
      large_pr_lines: 500,
      blocker_max_age_days: 90,
    },
    user: 'alice',
    meta: {
      audience: 'personal',
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

describe('buildPersonalReport', () => {
  it('counts commits where the user is a resolved co-author', async () => {
    await withMemoryCache(async (cache) => {
      const now = Date.parse('2026-02-20T12:00:00.000Z')
      const committedAt = now - 1_000

      cache.upsertCommit({
        repo: REPO,
        sha: 'coauthor-commit',
        author: 'teammate',
        committed_at: committedAt,
        message: 'feat: collaborative commit',
        additions: 7,
        deletions: 2,
        files_changed: 1,
        co_authors: [{ username: 'alice', email: 'alice@example.com' }],
      })

      const report = buildPersonalReport(cache, buildOptions(now))

      expect(report.summary.commits).toBe(1)
      expect(report.summary.lines_changed).toBe(9)
      expect(report.commits_detail.map((commit) => commit.sha)).toContain('coauthor-commit')
    })
  })
})
