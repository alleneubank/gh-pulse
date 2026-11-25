import { describe, expect, it } from 'bun:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PullRequest, RepoFullName } from './types'
import { Cache } from './cache'
import { isCovered } from './types'

async function withTempCache<T>(fn: (cache: Cache, cachePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-pulse-'))
  const cachePath = path.join(dir, 'cache.db')
  const cache = await Cache.open({ path: cachePath })
  try {
    return await fn(cache, cachePath)
  } finally {
    cache.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('daily rollups', () => {
  it('buckets commits, PRs, and reviews by local day', async () => {
    await withTempCache(async (cache) => {
      const repo: RepoFullName = 'org/repo'
      const timeZone = 'America/Los_Angeles'

      const commitBeforeMidnight = Date.parse('2026-01-20T07:00:00Z')
      const commitAfterMidnight = Date.parse('2026-01-20T09:00:00Z')
      const timeRange = { start: commitBeforeMidnight, end: commitAfterMidnight }

      cache.upsertCommit(
        {
          repo,
          sha: 'a',
          author: 'alice',
          committed_at: commitBeforeMidnight,
          message: 'before',
          additions: 2,
          deletions: 1,
          files_changed: 1,
        },
        commitBeforeMidnight,
      )

      cache.upsertCommit(
        {
          repo,
          sha: 'b',
          author: 'alice',
          committed_at: commitAfterMidnight,
          message: 'after',
          additions: 1,
          deletions: 0,
          files_changed: 1,
        },
        commitAfterMidnight,
      )

      const pr: PullRequest = {
        repo,
        number: 1,
        title: 'Test PR',
        body: null,
        state: 'merged',
        draft: false,
        author: 'alice',
        created_at: commitBeforeMidnight,
        updated_at: commitAfterMidnight,
        merged_at: commitAfterMidnight,
        closed_at: null,
        additions: 3,
        deletions: 1,
        commits: 2,
        requested_reviewers: [],
        labels: [],
        linked_issues: [],
      }

      cache.upsertPullRequest(pr, commitAfterMidnight)

      cache.insertEvent({
        type: 'pr_opened',
        repo,
        pr_number: pr.number,
        author: pr.author,
        opened_at: commitBeforeMidnight,
        is_draft: false,
      })

      cache.insertEvent({
        type: 'pr_merged',
        repo,
        pr_number: pr.number,
        merged_at: commitAfterMidnight,
        merged_by: 'alice',
      })

      cache.insertEvent({
        type: 'review_submitted',
        repo,
        pr_number: pr.number,
        reviewer: 'bob',
        state: 'approved',
        submitted_at: commitAfterMidnight,
      })

      cache.ensureDailyRollups({ repos: [repo], timeRange, timeZone })

      const commitRollups = cache.getDailyCommits({ repos: [repo] })
      const commitDays = commitRollups.map((entry) => entry.day)
      expect(commitDays).toContain('2026-01-19')
      expect(commitDays).toContain('2026-01-20')

      const prRollups = cache.getDailyPrs({ repos: [repo] })
      const opened = prRollups.find((entry) => entry.day === '2026-01-19')
      const merged = prRollups.find((entry) => entry.day === '2026-01-20')
      expect(opened?.opened).toBe(1)
      expect(merged?.merged).toBe(1)

      const reviewRollups = cache.getDailyReviews({ repos: [repo] })
      const reviewDay = reviewRollups.find((entry) => entry.day === '2026-01-20')
      expect(reviewDay?.reviews).toBe(1)

      const coverage = cache.getCoverageRanges(repo, 'rollup_commits')
      expect(isCovered(coverage, timeRange.start, timeRange.end)).toBe(true)
    })
  })

  it('builds rollups idempotently for the same range', async () => {
    await withTempCache(async (cache) => {
      const repo: RepoFullName = 'org/repo'
      const timeZone = 'UTC'
      const timestamp = Date.parse('2026-01-20T12:00:00Z')
      const timeRange = { start: timestamp - 1000, end: timestamp + 1000 }

      cache.upsertCommit(
        {
          repo,
          sha: 'c',
          author: 'alice',
          committed_at: timestamp,
          message: 'once',
          additions: 1,
          deletions: 0,
          files_changed: 1,
        },
        timestamp,
      )

      cache.ensureDailyRollups({ repos: [repo], timeRange, timeZone })
      cache.ensureDailyRollups({ repos: [repo], timeRange, timeZone })

      const rollups = cache.getDailyCommits({ repos: [repo] })
      const day = rollups.find((entry) => entry.day === '2026-01-20')
      expect(day?.commits).toBe(1)
    })
  })

  it('rebuilds commit rollups when new commits arrive in a covered range', async () => {
    await withTempCache(async (cache) => {
      const repo: RepoFullName = 'org/repo'
      const timeZone = 'UTC'
      const dayStart = Date.parse('2026-02-16T00:00:00Z')
      const dayEnd = Date.parse('2026-02-16T23:59:59Z')
      const firstCommit = Date.parse('2026-02-16T12:00:00Z')
      const secondCommit = Date.parse('2026-02-16T18:00:00Z')
      const timeRange = { start: dayStart, end: dayEnd }

      cache.upsertCommit(
        {
          repo,
          sha: 'first',
          author: 'alice',
          committed_at: firstCommit,
          message: 'first',
          additions: 10,
          deletions: 2,
          files_changed: 1,
        },
        firstCommit,
      )

      cache.ensureDailyRollups({ repos: [repo], timeRange, timeZone })

      const coveredBefore = cache.getCoverageRanges(repo, 'rollup_commits')
      expect(isCovered(coveredBefore, timeRange.start, timeRange.end)).toBe(true)

      cache.upsertCommit(
        {
          repo,
          sha: 'second',
          author: 'alice',
          committed_at: secondCommit,
          message: 'second',
          additions: 7,
          deletions: 3,
          files_changed: 2,
        },
        secondCommit,
      )

      const coveredAfterInsert = cache.getCoverageRanges(repo, 'rollup_commits')
      expect(isCovered(coveredAfterInsert, timeRange.start, timeRange.end)).toBe(false)

      cache.ensureDailyRollups({ repos: [repo], timeRange, timeZone })

      const rollups = cache.getDailyCommits({ repos: [repo] })
      const day = rollups.find((entry) => entry.day === '2026-02-16' && entry.author === 'alice')
      expect(day?.commits).toBe(2)
      expect(day?.additions).toBe(17)
      expect(day?.deletions).toBe(5)
      expect(day?.files_changed).toBe(3)
    })
  })

  it('invalidates rollup coverage for a range', async () => {
    await withTempCache(async (cache) => {
      const repo: RepoFullName = 'org/repo'
      const start = Date.parse('2026-01-01T00:00:00Z')
      const end = Date.parse('2026-01-02T00:00:00Z')

      cache.addCoverageRange(repo, 'rollup_commits', start, end, Date.now())
      expect(isCovered(cache.getCoverageRanges(repo, 'rollup_commits'), start, end)).toBe(true)

      cache.invalidateCoverageRange(repo, 'rollup_commits', start, end)
      expect(isCovered(cache.getCoverageRanges(repo, 'rollup_commits'), start, end)).toBe(false)
    })
  })

  it('emits commit rollup rows for resolved co-authors', async () => {
    await withTempCache(async (cache) => {
      const repo: RepoFullName = 'org/repo'
      const timeZone = 'UTC'
      const timestamp = Date.parse('2026-02-18T12:00:00Z')
      const timeRange = { start: timestamp - 1_000, end: timestamp + 1_000 }

      cache.upsertCommit(
        {
          repo,
          sha: 'coauthored',
          author: 'alice',
          committed_at: timestamp,
          message: 'feat: shared work',
          additions: 9,
          deletions: 3,
          files_changed: 2,
          co_authors: [{ username: 'bob', email: 'bob@example.com' }],
        },
        timestamp,
      )

      cache.ensureDailyRollups({ repos: [repo], timeRange, timeZone })

      const rollups = cache.getDailyCommits({ repos: [repo] })
      const alice = rollups.find((entry) => entry.day === '2026-02-18' && entry.author === 'alice')
      const bob = rollups.find((entry) => entry.day === '2026-02-18' && entry.author === 'bob')

      expect(alice?.commits).toBe(1)
      expect(alice?.additions).toBe(9)
      expect(alice?.deletions).toBe(3)
      expect(bob?.commits).toBe(1)
      expect(bob?.additions).toBe(9)
      expect(bob?.deletions).toBe(3)
      expect(bob?.files_changed).toBe(2)
    })
  })
})
