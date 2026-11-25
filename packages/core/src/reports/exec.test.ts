import { describe, expect, it } from 'bun:test'
import { Cache } from '../cache'
import { buildExecReport, type ExecReportOptions } from './exec'

const REPO = 'org/repo'

async function withMemoryCache<T>(fn: (cache: Cache) => Promise<T>): Promise<T> {
  const cache = await Cache.open({ path: ':memory:' })
  try {
    return await fn(cache)
  } finally {
    cache.close()
  }
}

function buildOptions(now: number): ExecReportOptions {
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
    teamMembers: ['alice'],
    branchRoles: { production: ['main'], integration: ['dev'] },
    limitedSurfaces: [],
    thresholds: {
      stale_days: 2,
      stuck_days: 4,
      large_pr_lines: 500,
      blocker_max_age_days: 90,
    },
    meta: {
      audience: 'exec',
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

describe('buildExecReport', () => {
  it('attributes team breakdown commit metrics when member is a resolved co-author', async () => {
    await withMemoryCache(async (cache) => {
      const now = Date.parse('2026-02-20T12:00:00.000Z')
      const committedAt = now - 1_000

      cache.upsertCommit({
        repo: REPO,
        sha: 'exec-coauthor-commit',
        author: 'teammate',
        committed_at: committedAt,
        message: 'feat: collaborative commit',
        additions: 8,
        deletions: 2,
        files_changed: 1,
        co_authors: [{ username: 'alice', email: 'alice@example.com' }],
      })

      const report = buildExecReport(cache, buildOptions(now))
      const alice = report.team_breakdown.find((member) => member.user === 'alice')

      expect(alice?.commits).toBe(1)
      expect(alice?.lines_changed).toBe(10)
    })
  })
})
