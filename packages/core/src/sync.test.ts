import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitHubClient } from './github'
import type { Config } from './config'
import type { RepoFullName, Timestamp } from './types'
import { Cache } from './cache'
import { syncRepos } from './sync'

const DAY_MS = 24 * 60 * 60 * 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

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

function buildConfig(cachePath: string, overrides: Partial<Config['cache']> = {}): Config {
  return {
    github_token: 'token',
    orgs: [],
    repos: [],
    team: { strategy: 'org_members', members: [] },
    exclude: {
      bots: true,
      forks: true,
      archived: true,
      authors: [],
      ai_identities: [
        'claude',
        'cursor',
        'github-copilot[bot]',
        'aider',
        'devin-ai-integration[bot]',
      ],
    },
    thresholds: { stale_days: 2, stuck_days: 4, large_pr_lines: 500, blocker_max_age_days: 90 },
    timezone: 'UTC',
    cache: {
      path: cachePath,
      ttl_hours: 1,
      sync_ttl_hours: 24,
      concurrency: 2,
      use_etags: true,
      use_timeline: true,
      use_graphql: true,
      ...overrides,
    },
    rollout: {
      production_branches: ['main', 'master'],
      integration_branches: ['dev'],
      limited_surfaces: [],
    },
  }
}

function buildTimeRange(now: Timestamp): { start: Timestamp; end: Timestamp } {
  return { start: now - DAY_MS, end: now }
}

interface ContributorClassificationCommitFixture {
  sha: string
  author: string
  email?: string
  message?: string
}

interface ContributorClassificationPrFixture {
  number: number
  author: string
  updatedAt: string
  commits: ContributorClassificationCommitFixture[]
}

class ContributorClassificationGitHub {
  readonly userExistsCalls = new Map<string, number>()
  getCommitCalls = 0

  constructor(
    private readonly prs: ContributorClassificationPrFixture[],
    private readonly existingUsers: ReadonlyMap<string, boolean> = new Map(),
  ) {}

  async listPullRequestsPage(
    _repo: RepoFullName,
    options: { page?: number } = {},
  ): Promise<
    Array<{
      number: number
      updated_at: string
      state: 'open'
      base: { ref: string }
      head: { ref: string }
    }>
  > {
    const page = options.page ?? 1
    if (page > 1) {
      return []
    }
    return this.prs.map((pr) => ({
      number: pr.number,
      updated_at: pr.updatedAt,
      state: 'open',
      base: { ref: 'main' },
      head: { ref: 'feature' },
    }))
  }

  async getPullRequest(
    _repo: RepoFullName,
    number: number,
  ): Promise<{
    number: number
    title: string
    body: string | null
    state: 'open'
    draft: boolean
    user: { login: string }
    created_at: string
    updated_at: string
    merged_at: null
    closed_at: null
    additions: number
    deletions: number
    commits: number
    requested_reviewers: []
    labels: []
  }> {
    const pr = this.prs.find((fixture) => fixture.number === number)
    if (!pr) {
      throw new Error(`Unexpected PR ${number}`)
    }
    return {
      number,
      title: `Classification PR ${number}`,
      body: null,
      state: 'open',
      draft: false,
      user: { login: pr.author },
      created_at: new Date(Date.parse(pr.updatedAt) - 10_000).toISOString(),
      updated_at: pr.updatedAt,
      merged_at: null,
      closed_at: null,
      additions: 1,
      deletions: 0,
      commits: pr.commits.length,
      requested_reviewers: [],
      labels: [],
      base: { ref: 'main' },
      head: { ref: 'feature' },
    }
  }

  async listIssueEvents(): Promise<[]> {
    return []
  }

  async listPullRequestReviews(): Promise<[]> {
    return []
  }

  async listIssueComments(): Promise<[]> {
    return []
  }

  async listCommits(): Promise<[]> {
    return []
  }

  async listPullRequestCommits(
    _repo: RepoFullName,
    number: number,
  ): Promise<Array<{ sha: string; commit: { author: { date: string } } }>> {
    const pr = this.prs.find((fixture) => fixture.number === number)
    if (!pr) {
      throw new Error(`Unexpected PR ${number}`)
    }
    return pr.commits.map((commit) => ({
      sha: commit.sha,
      commit: { author: { date: pr.updatedAt } },
    }))
  }

  async getCommit(
    _repo: RepoFullName,
    sha: string,
  ): Promise<{
    sha: string
    author: { login: string }
    commit: { author: { date: string; name: string; email: string }; message: string }
    stats: { additions: number; deletions: number; total: number }
    files: Array<{ filename: string }>
  }> {
    this.getCommitCalls += 1
    const pr = this.prs.find((fixture) => fixture.commits.some((commit) => commit.sha === sha))
    const commit = pr?.commits.find((fixture) => fixture.sha === sha)
    if (!pr || !commit) {
      throw new Error(`Unexpected commit ${sha}`)
    }
    return {
      sha,
      author: { login: commit.author },
      commit: {
        author: {
          date: pr.updatedAt,
          name: commit.author,
          email: commit.email ?? `${commit.author.toLowerCase()}@example.com`,
        },
        message: commit.message ?? 'feat: contributor work',
      },
      stats: { additions: 1, deletions: 0, total: 1 },
      files: [{ filename: 'README.md' }],
    }
  }

  async userExists(login: string): Promise<boolean> {
    this.userExistsCalls.set(login, (this.userExistsCalls.get(login) ?? 0) + 1)
    return this.existingUsers.get(login.toLowerCase()) ?? true
  }
}

class CountingGitHub {
  listPullRequestsCalls: RepoFullName[] = []
  listCommitsCalls: RepoFullName[] = []

  async listPullRequestsPage(repo: RepoFullName): Promise<[]> {
    this.listPullRequestsCalls.push(repo)
    return []
  }

  async listCommits(repo: RepoFullName): Promise<[]> {
    this.listCommitsCalls.push(repo)
    return []
  }

  async listPullRequestCommits(): Promise<[]> {
    return []
  }

  async userExists(): Promise<boolean> {
    return true
  }
}

class ConcurrencyGitHub {
  active = 0
  maxActive = 0
  calls: RepoFullName[] = []

  async listPullRequestsPage(repo: RepoFullName): Promise<[]> {
    this.calls.push(repo)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    await delay(20)
    this.active -= 1
    return []
  }

  async listCommits(): Promise<[]> {
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    await delay(20)
    this.active -= 1
    return []
  }

  async listPullRequestCommits(): Promise<[]> {
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    await delay(20)
    this.active -= 1
    return []
  }

  async userExists(): Promise<boolean> {
    return true
  }
}

class EventConcurrencyGitHub {
  activeIssueEvents = 0
  maxActiveIssueEvents = 0

  async listPullRequestsPage(): Promise<[]> {
    return []
  }

  async listIssueEvents(): Promise<[]> {
    this.activeIssueEvents += 1
    this.maxActiveIssueEvents = Math.max(this.maxActiveIssueEvents, this.activeIssueEvents)
    await delay(20)
    this.activeIssueEvents -= 1
    return []
  }

  async listPullRequestReviews(): Promise<[]> {
    return []
  }

  async listIssueComments(): Promise<[]> {
    return []
  }

  async listCommits(): Promise<[]> {
    return []
  }

  async listPullRequestCommits(): Promise<[]> {
    return []
  }

  async userExists(): Promise<boolean> {
    return true
  }
}

class ErrorGitHub {
  started: RepoFullName[] = []

  async listPullRequestsPage(repo: RepoFullName): Promise<[]> {
    this.started.push(repo)
    if (repo === 'org/bad') {
      await delay(1)
      throw new Error('boom')
    }
    await delay(20)
    return []
  }

  async listCommits(): Promise<[]> {
    await delay(10)
    return []
  }

  async listPullRequestCommits(): Promise<[]> {
    await delay(10)
    return []
  }

  async userExists(): Promise<boolean> {
    return true
  }
}

class CommitGapGitHub {
  listCommitsCalls: Array<{ repo: RepoFullName; since?: string; until?: string }> = []
  listPullRequestCommitsCalls: number[] = []

  async listPullRequestsPage(): Promise<[]> {
    return []
  }

  async listCommits(
    repo: RepoFullName,
    options: { since?: string; until?: string } = {},
  ): Promise<[]> {
    this.listCommitsCalls.push({ repo, since: options.since, until: options.until })
    return []
  }

  async listPullRequestCommits(_repo: RepoFullName, number: number): Promise<[]> {
    this.listPullRequestCommitsCalls.push(number)
    return []
  }

  async userExists(): Promise<boolean> {
    return true
  }
}

describe('syncRepos', () => {
  it('skips repos synced within TTL unless forced', async () => {
    await withTempCache(async (cache, cachePath) => {
      const github = new CountingGitHub()
      const config = buildConfig(cachePath)
      const now = Date.now()
      const timeRange = buildTimeRange(now)

      cache.upsertSyncState('org/repo', now - 60 * 60 * 1000, { cursor: null })
      cache.addCoverageRange('org/repo', 'pull_requests', timeRange.start, timeRange.end, now)
      cache.addCoverageRange('org/repo', 'events', timeRange.start, timeRange.end, now)
      cache.addCoverageRange('org/repo', 'commits', timeRange.start, timeRange.end, now)
      cache.addCoverageRange('org/repo', 'commits_pr', timeRange.start, timeRange.end, now)

      await syncRepos({
        repos: ['org/repo'],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      expect(github.listPullRequestsCalls.length).toBe(0)

      github.listPullRequestsCalls.length = 0

      await syncRepos({
        repos: ['org/repo'],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
        forceSync: true,
      })

      expect(github.listPullRequestsCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('syncs when coverage is missing even within TTL', async () => {
    await withTempCache(async (cache, cachePath) => {
      const github = new CountingGitHub()
      const config = buildConfig(cachePath)
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const repo: RepoFullName = 'org/repo'

      cache.upsertSyncState(repo, now - 60 * 60 * 1000, { cursor: null })
      cache.addCoverageRange(repo, 'pull_requests', timeRange.start, timeRange.end, now)
      cache.addCoverageRange(repo, 'events', timeRange.start, timeRange.end, now)

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      expect(github.listCommitsCalls.length).toBeGreaterThan(0)
    })
  })

  it('limits concurrent repo syncs', async () => {
    await withTempCache(async (cache, cachePath) => {
      const github = new ConcurrencyGitHub()
      const config = buildConfig(cachePath, { concurrency: 2 })
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const repos: RepoFullName[] = ['org/one', 'org/two', 'org/three', 'org/four', 'org/five']

      await syncRepos({
        repos,
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      expect(github.calls.length).toBeGreaterThanOrEqual(repos.length)
      expect(github.maxActive).toBeLessThanOrEqual(config.cache.concurrency)
    })
  })

  it('processes PR activity in parallel within a repo using bounded concurrency', async () => {
    await withTempCache(async (cache, cachePath) => {
      const github = new EventConcurrencyGitHub()
      const config = buildConfig(cachePath, {
        concurrency: 3,
        use_graphql: false,
        use_timeline: false,
      })
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const repo: RepoFullName = 'org/repo'

      cache.upsertSyncState(repo, now - 60 * 60 * 1000, { cursor: null })
      cache.addCoverageRange(repo, 'pull_requests', timeRange.start, timeRange.end, now)
      cache.addCoverageRange(repo, 'commits', timeRange.start, timeRange.end, now)
      cache.addCoverageRange(repo, 'commits_pr', timeRange.start, timeRange.end, now)

      for (let number = 1; number <= 6; number += 1) {
        cache.upsertPullRequest(
          {
            repo,
            number,
            title: `PR ${number}`,
            body: null,
            state: 'open',
            draft: false,
            author: 'alice',
            created_at: now - 10_000,
            updated_at: now - 5_000,
            merged_at: null,
            closed_at: null,
            additions: 0,
            deletions: 0,
            commits: 1,
            requested_reviewers: [],
            labels: [],
            linked_issues: [],
          },
          now,
        )
      }

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      expect(github.maxActiveIssueEvents).toBeGreaterThan(1)
      expect(github.maxActiveIssueEvents).toBeLessThanOrEqual(config.cache.concurrency)
    })
  })

  it('stops scheduling new repos after error', async () => {
    await withTempCache(async (cache, cachePath) => {
      const github = new ErrorGitHub()
      const config = buildConfig(cachePath, { concurrency: 2 })
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const repos: RepoFullName[] = ['org/good-1', 'org/bad', 'org/good-2']

      await expect(
        syncRepos({
          repos,
          cache,
          github: github as unknown as GitHubClient,
          config,
          timeRange,
        }),
      ).rejects.toThrow('boom')

      expect(github.started).toContain('org/good-1')
      expect(github.started).toContain('org/bad')
      expect(github.started).not.toContain('org/good-2')
    })
  })

  it('skips unchanged PRs without fetching details', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { use_timeline: true })
      const repo: RepoFullName = 'org/repo'
      const updatedAt = now - 10_000

      cache.upsertPullRequest(
        {
          repo,
          number: 1,
          title: 'Existing',
          body: null,
          state: 'open',
          draft: false,
          author: 'alice',
          created_at: updatedAt - 5_000,
          updated_at: updatedAt,
          merged_at: null,
          closed_at: null,
          additions: 0,
          deletions: 0,
          commits: 0,
          requested_reviewers: [],
          labels: [],
          linked_issues: [],
        },
        now,
      )
      cache.upsertSyncState(repo, now - 10 * 60 * 1000, {
        cursor: null,
        last_pr_updated_at: updatedAt,
      })
      cache.addCoverageRange(repo, 'events', timeRange.start, timeRange.end, now)

      class PrSkipGitHub {
        getPullRequestCalls = 0
        listIssueTimelineCalls = 0

        async listPullRequestsPage(): Promise<unknown[]> {
          return [
            {
              number: 1,
              updated_at: new Date(updatedAt).toISOString(),
              base: { ref: 'main' },
              head: { ref: 'feature' },
              state: 'open',
            },
          ]
        }

        async getPullRequest(): Promise<null> {
          this.getPullRequestCalls += 1
          return null
        }

        async listIssueTimeline(): Promise<[]> {
          this.listIssueTimelineCalls += 1
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(): Promise<[]> {
          return []
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      const github = new PrSkipGitHub()

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      expect(github.getPullRequestCalls).toBe(0)
      expect(github.listIssueTimelineCalls).toBe(0)
    })
  })

  it('fetches commit ranges when coverage is missing', async () => {
    await withTempCache(async (cache, cachePath) => {
      const github = new CommitGapGitHub()
      const config = buildConfig(cachePath)
      const now = Date.now()
      const timeRange = { start: now - 5 * DAY_MS, end: now - 4 * DAY_MS }
      const repo: RepoFullName = 'org/repo'

      cache.upsertSyncState(repo, now - 2 * DAY_MS, { cursor: null })
      cache.addCoverageRange(repo, 'pull_requests', timeRange.start, timeRange.end, now)
      cache.addCoverageRange(repo, 'events', timeRange.start, timeRange.end, now)

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      expect(github.listCommitsCalls).toEqual([
        {
          repo,
          since: new Date(timeRange.start).toISOString(),
          until: new Date(timeRange.end).toISOString(),
        },
      ])
    })
  })

  it('skips commit fetching when range is already covered', async () => {
    await withTempCache(async (cache, cachePath) => {
      const github = new CommitGapGitHub()
      const config = buildConfig(cachePath)
      const now = Date.now()
      const timeRange = { start: now - 3 * DAY_MS, end: now - 2 * DAY_MS }
      const repo: RepoFullName = 'org/repo'

      cache.upsertSyncState(repo, now - 60 * 60 * 1000, { cursor: null })
      cache.addCoverageRange(repo, 'commits', timeRange.start, timeRange.end, now)

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      expect(github.listCommitsCalls.length).toBe(0)
    })
  })

  it('skips per-PR activity and commit fetching for deploy and bot PRs', async () => {
    await withTempCache(async (cache, cachePath) => {
      const config = buildConfig(cachePath)
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const repo: RepoFullName = 'org/repo'
      const updatedAt = now - 5_000
      const mergedAt = now - 4_000

      // Three PRs in range: a bot author, a deploy-titled PR, and a real feature PR.
      // Only the real PR should incur the expensive per-PR network work; the bot and
      // deploy PRs are filtered out of every contributor metric downstream, so fetching
      // their activity/commits is wasted work that also risks stalling huge repos.
      const seedPr = (number: number, author: string, title: string): void => {
        cache.upsertPullRequest(
          {
            repo,
            number,
            title,
            body: null,
            state: 'merged',
            draft: false,
            author,
            created_at: updatedAt - 5_000,
            updated_at: updatedAt,
            merged_at: mergedAt,
            closed_at: null,
            additions: 1,
            deletions: 0,
            commits: 1,
            requested_reviewers: [],
            labels: [],
            linked_issues: [],
            base_ref: 'main',
            head_ref: 'feature',
          },
          now,
        )
      }
      seedPr(1, 'github-actions[bot]', 'deploy(testnet): update manifests to abc')
      seedPr(2, 'alice', 'deploy(testnet): update manifests to def')
      seedPr(3, 'alice', 'feat: real engineering work')

      // Mark pull_requests + commits covered so only events + commits_pr phases run,
      // and keep sync state fresh so this is the warm (non-refresh) path.
      cache.upsertSyncState(repo, now - 60 * 60 * 1000, {
        cursor: null,
        last_pr_updated_at: updatedAt,
      })
      cache.addCoverageRange(repo, 'pull_requests', timeRange.start, timeRange.end, now)
      cache.addCoverageRange(repo, 'commits', timeRange.start, timeRange.end, now)

      class SkipActivityGitHub {
        graphqlCalls: number[] = []
        listPullRequestCommitsCalls: number[] = []
        userExistsCalls = 0

        async listPullRequestsPage(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async getPullRequestGraphqlActivity(_repo: RepoFullName, number: number): Promise<unknown> {
          this.graphqlCalls.push(number)
          return {
            pr: {
              number,
              title: 'feat: real engineering work',
              body: null,
              state: 'MERGED',
              isDraft: false,
              author: { login: 'alice' },
              createdAt: new Date(updatedAt - 5_000).toISOString(),
              updatedAt: new Date(updatedAt).toISOString(),
              mergedAt: new Date(mergedAt).toISOString(),
              baseRefName: 'main',
              headRefName: 'feature',
              closedAt: null,
              mergedBy: { login: 'alice' },
              additions: 1,
              deletions: 0,
              commits: { totalCount: 1 },
              reviewRequests: { nodes: [] },
              labels: { nodes: [] },
            },
            timeline: [],
            reviews: [],
            comments: [],
          }
        }

        async listPullRequestCommits(_repo: RepoFullName, number: number): Promise<[]> {
          this.listPullRequestCommitsCalls.push(number)
          return []
        }

        async userExists(): Promise<boolean> {
          this.userExistsCalls += 1
          return true
        }
      }

      const github = new SkipActivityGitHub()

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      // Expensive per-PR work runs only for the real PR (#3).
      expect(github.graphqlCalls).toEqual([3])
      expect(github.listPullRequestCommitsCalls).toEqual([3])

      // Lightweight pr_merged events are still recorded for every PR so deploy counts
      // and velocity (which filter by author downstream) remain exact.
      for (const number of [1, 2, 3]) {
        const events = cache.getEventsForPr(repo, number)
        expect(events.some((event) => event.type === 'pr_merged')).toBe(true)
      }
    })
  })

  it('uses conditional request for stale but unchanged PRs', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { ttl_hours: 1, use_etags: true, use_graphql: false })
      const repo: RepoFullName = 'org/repo'
      const updatedAt = now - 5_000
      const staleFetchedAt = now - 2 * 60 * 60 * 1000

      cache.upsertPullRequest(
        {
          repo,
          number: 2,
          title: 'Stale',
          body: null,
          state: 'open',
          draft: false,
          author: 'alice',
          created_at: updatedAt - 5_000,
          updated_at: updatedAt,
          merged_at: null,
          closed_at: null,
          additions: 0,
          deletions: 0,
          commits: 0,
          requested_reviewers: [],
          labels: [],
          linked_issues: [],
        },
        staleFetchedAt,
      )
      cache.upsertSyncState(repo, now - 10 * 60 * 1000, {
        cursor: null,
        last_pr_updated_at: updatedAt,
      })
      cache.addCoverageRange(repo, 'events', timeRange.start, timeRange.end, now)

      class ConditionalGitHub {
        getPullRequestCalls = 0
        listIssueTimelineCalls = 0

        async listPullRequestsPage(): Promise<unknown[]> {
          return [
            {
              number: 2,
              updated_at: new Date(updatedAt).toISOString(),
              base: { ref: 'main' },
              head: { ref: 'feature' },
              state: 'open',
            },
          ]
        }

        async getPullRequest(): Promise<null> {
          this.getPullRequestCalls += 1
          return null
        }

        async listIssueTimeline(): Promise<[]> {
          this.listIssueTimelineCalls += 1
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(): Promise<[]> {
          return []
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      const github = new ConditionalGitHub()

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      expect(github.getPullRequestCalls).toBe(1)
      expect(github.listIssueTimelineCalls).toBe(0)
    })
  })

  it('stops pagination once PR updates precede the watermark', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const cutoff = now - 60 * 60 * 1000
      const timeRange = { start: cutoff, end: now }
      const config = buildConfig(cachePath, { use_timeline: false, use_graphql: false })
      const repo: RepoFullName = 'org/repo'

      cache.upsertSyncState(repo, now - 2 * 60 * 60 * 1000, {
        cursor: null,
        last_pr_updated_at: cutoff,
      })

      const pageCalls: number[] = []
      const page1Items = Array.from({ length: 100 }, (_, index) => ({
        number: index + 1,
        updated_at: new Date(now - index * 1000).toISOString(),
        state: 'open',
        base: { ref: 'main' },
        head: { ref: 'feature' },
      }))
      const page2Items = [
        {
          number: 999,
          updated_at: new Date(cutoff - 10_000).toISOString(),
          base: { ref: 'main' },
          head: { ref: 'feature' },
          state: 'open',
        },
      ]

      class PaginationGitHub {
        async listPullRequestsPage(
          _repo: RepoFullName,
          options: { page?: number },
        ): Promise<unknown[]> {
          const page = options.page ?? 1
          pageCalls.push(page)
          if (page === 1) {
            return page1Items
          }
          if (page === 2) {
            return page2Items
          }
          return []
        }

        async getPullRequest(
          _repo: RepoFullName,
          number: number,
        ): Promise<{
          number: number
          title: string
          body: string | null
          state: 'open'
          draft: boolean
          user: { login: string }
          created_at: string
          updated_at: string
          merged_at: null
          closed_at: null
          additions: number
          deletions: number
          commits: number
          requested_reviewers: []
          labels: []
        }> {
          return {
            number,
            title: `PR ${number}`,
            body: null,
            state: 'open',
            draft: false,
            user: { login: 'alice' },
            created_at: new Date(now - 10_000).toISOString(),
            updated_at: new Date(now - 5_000).toISOString(),
            merged_at: null,
            closed_at: null,
            additions: 0,
            deletions: 0,
            commits: 0,
            requested_reviewers: [],
            labels: [],
            base: { ref: 'main' },
            head: { ref: 'feature' },
          }
        }

        async listIssueEvents(): Promise<[]> {
          return []
        }

        async listPullRequestReviews(): Promise<[]> {
          return []
        }

        async listIssueComments(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(): Promise<[]> {
          return []
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      const github = new PaginationGitHub()

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
        forceSync: true,
      })

      expect(pageCalls).toEqual([1, 2, 1, 2])
    })
  })

  it('fetches PR activity via GraphQL when enabled', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { use_graphql: true })
      const repo: RepoFullName = 'org/repo'
      const prNumber = 7
      const createdAt = new Date(now - 20_000).toISOString()
      const updatedAt = new Date(now - 10_000).toISOString()

      class GraphqlGitHub {
        graphqlCalls = 0

        async listPullRequestsPage(): Promise<unknown[]> {
          return [
            {
              number: prNumber,
              updated_at: updatedAt,
              base: { ref: 'main' },
              head: { ref: 'feature' },
              state: 'open',
            },
          ]
        }

        async getPullRequest(): Promise<{
          number: number
          title: string
          body: string | null
          state: 'open'
          draft: boolean
          user: { login: string }
          created_at: string
          updated_at: string
          merged_at: null
          closed_at: null
          additions: number
          deletions: number
          commits: number
          requested_reviewers: []
          labels: []
        }> {
          return {
            number: prNumber,
            title: 'GraphQL PR',
            body: 'REST body',
            state: 'open',
            draft: false,
            user: { login: 'alice' },
            created_at: createdAt,
            updated_at: updatedAt,
            merged_at: null,
            closed_at: null,
            additions: 5,
            deletions: 1,
            commits: 1,
            requested_reviewers: [],
            labels: [],
            base: { ref: 'main' },
            head: { ref: 'feature' },
          }
        }

        async getPullRequestGraphqlActivity(): Promise<{
          pr: {
            number: number
            title: string
            body: string | null
            state: 'OPEN'
            isDraft: boolean
            author: { login: string }
            createdAt: string
            updatedAt: string
            mergedAt: null
            closedAt: null
            mergedBy: null
            additions: number
            deletions: number
            commits: { totalCount: number }
            reviewRequests: { nodes: [] }
            labels: { nodes: [] }
          }
          timeline: Array<{ __typename: 'ReadyForReviewEvent'; createdAt: string }>
          reviews: Array<{ author: { login: string }; state: string; submittedAt: string }>
          comments: Array<{ author: { login: string }; createdAt: string }>
        }> {
          this.graphqlCalls += 1
          return {
            pr: {
              number: prNumber,
              title: 'GraphQL PR',
              body: 'GraphQL body',
              state: 'OPEN',
              isDraft: false,
              author: { login: 'alice' },
              createdAt,
              updatedAt,
              mergedAt: null,
              baseRefName: 'main',
              headRefName: 'feature',
              closedAt: null,
              mergedBy: null,
              additions: 5,
              deletions: 1,
              commits: { totalCount: 1 },
              reviewRequests: { nodes: [] },
              labels: { nodes: [] },
            },
            timeline: [{ __typename: 'ReadyForReviewEvent', createdAt: updatedAt }],
            reviews: [
              {
                author: { login: 'bob' },
                state: 'APPROVED',
                submittedAt: updatedAt,
              },
            ],
            comments: [{ author: { login: 'carol' }, createdAt: updatedAt }],
          }
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(): Promise<[]> {
          return []
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      const github = new GraphqlGitHub()

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
        forceSync: true,
      })

      const events = cache.getEventsForPr(repo, prNumber)
      const eventTypes = events.map((event) => event.type)
      const pr = cache.getPullRequest(repo, prNumber)?.data
      expect(github.graphqlCalls).toBe(1)
      expect(eventTypes).toContain('pr_opened')
      expect(eventTypes).toContain('pr_ready')
      expect(eventTypes).toContain('review_submitted')
      expect(eventTypes).toContain('comment_added')
      expect(pr?.body).toBe('GraphQL body')
    })
  })

  it('persists REST body and maps missing body to null', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
      const repo: RepoFullName = 'org/repo'

      class RestBodyGitHub {
        async listPullRequestsPage(
          _repo: RepoFullName,
          options: { page?: number } = {},
        ): Promise<
          Array<{
            number: number
            updated_at: string
            state: 'open'
            base: { ref: string }
            head: { ref: string }
          }>
        > {
          const page = options.page ?? 1
          if (page > 1) {
            return []
          }
          return [
            {
              number: 1,
              updated_at: new Date(now - 10_000).toISOString(),
              state: 'open',
              base: { ref: 'main' },
              head: { ref: 'feature' },
            },
            {
              number: 2,
              updated_at: new Date(now - 9_000).toISOString(),
              state: 'open',
              base: { ref: 'main' },
              head: { ref: 'feature' },
            },
          ]
        }

        async getPullRequest(_repo: RepoFullName, number: number): Promise<unknown> {
          if (number === 1) {
            return {
              number,
              title: 'feat: has body',
              body: 'REST body',
              state: 'open',
              draft: false,
              user: { login: 'alice' },
              created_at: new Date(now - 20_000).toISOString(),
              updated_at: new Date(now - 10_000).toISOString(),
              merged_at: null,
              closed_at: null,
              additions: 1,
              deletions: 0,
              commits: 1,
              requested_reviewers: [],
              labels: [],
              base: { ref: 'main' },
              head: { ref: 'feature' },
            }
          }

          return {
            number,
            title: 'fix: no body',
            state: 'open',
            draft: false,
            user: { login: 'bob' },
            created_at: new Date(now - 18_000).toISOString(),
            updated_at: new Date(now - 9_000).toISOString(),
            merged_at: null,
            closed_at: null,
            additions: 1,
            deletions: 0,
            commits: 1,
            requested_reviewers: [],
            labels: [],
            base: { ref: 'main' },
            head: { ref: 'feature' },
          }
        }

        async listIssueEvents(): Promise<[]> {
          return []
        }

        async listPullRequestReviews(): Promise<[]> {
          return []
        }

        async listIssueComments(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(): Promise<[]> {
          return []
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      const github = new RestBodyGitHub()

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
        forceSync: true,
      })

      const first = cache.getPullRequest(repo, 1)?.data
      const second = cache.getPullRequest(repo, 2)?.data

      expect(first?.body).toBe('REST body')
      expect(second?.body).toBeNull()
    })
  })

  it('syncs commits from pull request branches', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
      const repo: RepoFullName = 'org/repo'
      const prNumber = 42
      const commitSha = 'abc123'
      const commitDate = new Date(now - 5_000).toISOString()

      class PrCommitGitHub {
        listPullRequestCommitsCalls: number[] = []

        async listPullRequestsPage(): Promise<unknown[]> {
          return [
            {
              number: prNumber,
              updated_at: commitDate,
              base: { ref: 'main' },
              head: { ref: 'feature' },
              state: 'open',
            },
          ]
        }

        async getPullRequest(): Promise<{
          number: number
          title: string
          body: string | null
          state: 'open'
          draft: boolean
          user: { login: string }
          created_at: string
          updated_at: string
          merged_at: null
          closed_at: null
          additions: number
          deletions: number
          commits: number
          requested_reviewers: []
          labels: []
        }> {
          return {
            number: prNumber,
            title: 'PR commits',
            body: null,
            state: 'open',
            draft: false,
            user: { login: 'apollo-function' },
            created_at: new Date(now - 10_000).toISOString(),
            updated_at: commitDate,
            merged_at: null,
            closed_at: null,
            additions: 1,
            deletions: 0,
            commits: 1,
            requested_reviewers: [],
            labels: [],
            base: { ref: 'main' },
            head: { ref: 'feature' },
          }
        }

        async listIssueEvents(): Promise<[]> {
          return []
        }

        async listPullRequestReviews(): Promise<[]> {
          return []
        }

        async listIssueComments(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(
          _repo: RepoFullName,
          number: number,
        ): Promise<Array<{ sha: string; commit: { author: { date: string } } }>> {
          this.listPullRequestCommitsCalls.push(number)
          return [{ sha: commitSha, commit: { author: { date: commitDate } } }]
        }

        async getCommit(): Promise<{
          sha: string
          author: { login: string }
          commit: { author: { date: string; name: string }; message: string }
          stats: { additions: number; deletions: number; total: number }
          files: Array<{ filename: string }>
        }> {
          return {
            sha: commitSha,
            author: { login: 'apollo-function' },
            commit: {
              author: { date: commitDate, name: 'Apollo' },
              message: 'Add feature',
            },
            stats: { additions: 1, deletions: 0, total: 1 },
            files: [{ filename: 'README.md' }],
          }
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      const github = new PrCommitGitHub()

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
        forceSync: true,
      })

      const commits = cache.getCommits({ repo })
      expect(github.listPullRequestCommitsCalls).toEqual([prNumber])
      expect(commits.some((commit) => commit.sha === commitSha)).toBe(true)
    })
  })

  it('deduplicates overlapping commit SHAs across concurrent PR commit sync', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, {
        concurrency: 3,
        use_graphql: false,
        use_timeline: false,
      })
      const repo: RepoFullName = 'org/repo'
      const sharedSha = 'shared123'
      const commitDate = new Date(now - 5_000).toISOString()

      cache.upsertSyncState(repo, now - 60 * 60 * 1000, { cursor: null })
      cache.addCoverageRange(repo, 'pull_requests', timeRange.start, timeRange.end, now)
      cache.addCoverageRange(repo, 'events', timeRange.start, timeRange.end, now)
      cache.addCoverageRange(repo, 'commits', timeRange.start, timeRange.end, now)

      for (const number of [101, 102]) {
        cache.upsertPullRequest(
          {
            repo,
            number,
            title: `PR ${number}`,
            body: null,
            state: 'open',
            draft: false,
            author: 'alice',
            created_at: now - 10_000,
            updated_at: now - 3_000,
            merged_at: null,
            closed_at: null,
            additions: 0,
            deletions: 0,
            commits: 1,
            requested_reviewers: [],
            labels: [],
            linked_issues: [],
          },
          now,
        )
      }

      class OverlapPrCommitGitHub {
        getCommitCalls = 0

        async listPullRequestsPage(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(
          _repo: RepoFullName,
          _number: number,
        ): Promise<Array<{ sha: string; commit: { author: { date: string } } }>> {
          return [{ sha: sharedSha, commit: { author: { date: commitDate } } }]
        }

        async getCommit(): Promise<{
          sha: string
          author: { login: string }
          commit: { author: { date: string; name: string }; message: string }
          stats: { additions: number; deletions: number; total: number }
          files: Array<{ filename: string }>
        }> {
          this.getCommitCalls += 1
          await delay(20)
          return {
            sha: sharedSha,
            author: { login: 'alice' },
            commit: {
              author: { date: commitDate, name: 'Alice' },
              message: 'Shared commit',
            },
            stats: { additions: 1, deletions: 0, total: 1 },
            files: [{ filename: 'README.md' }],
          }
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      const github = new OverlapPrCommitGitHub()
      const result = await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      expect(github.getCommitCalls).toBe(1)
      expect(result.commits_upserted).toBe(1)
    })
  })

  it('treats commits as immutable and skips cached commit fetches', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath)
      const repo: RepoFullName = 'org/repo'

      cache.upsertCommit(
        {
          repo,
          sha: 'abc123',
          author: 'alice',
          committed_at: now - 1000,
          message: 'Initial',
          additions: 1,
          deletions: 0,
          files_changed: 1,
        },
        now,
      )

      class CommitGitHub {
        getCommitCalls = 0

        async listPullRequestsPage(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<Array<{ sha: string; commit: { author: { date: string } } }>> {
          return [
            {
              sha: 'abc123',
              commit: { author: { date: new Date(now - 1000).toISOString() } },
            },
          ]
        }

        async getCommit(): Promise<null> {
          this.getCommitCalls += 1
          return null
        }

        async listPullRequestCommits(): Promise<[]> {
          return []
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      const github = new CommitGitHub()

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
      })

      expect(github.getCommitCalls).toBe(0)
    })
  })

  it('populates PR contributors from opener, commit authors, and resolved commit co-authors', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
      const repo: RepoFullName = 'org/repo'
      const prNumber = 77
      const commitSha = 'contrib123'
      const commitDate = new Date(now - 2_000).toISOString()

      cache.upsertEmailUsername('collab@example.com', 'Collab')

      class ContributorGitHub {
        async listPullRequestsPage(
          _repo: RepoFullName,
          options: { page?: number } = {},
        ): Promise<
          Array<{
            number: number
            updated_at: string
            state: 'open'
            base: { ref: string }
            head: { ref: string }
          }>
        > {
          const page = options.page ?? 1
          if (page > 1) {
            return []
          }
          return [
            {
              number: prNumber,
              updated_at: commitDate,
              state: 'open',
              base: { ref: 'main' },
              head: { ref: 'feature' },
            },
          ]
        }

        async getPullRequest(): Promise<{
          number: number
          title: string
          body: string | null
          state: 'open'
          draft: boolean
          user: { login: string }
          created_at: string
          updated_at: string
          merged_at: null
          closed_at: null
          additions: number
          deletions: number
          commits: number
          requested_reviewers: []
          labels: []
        }> {
          return {
            number: prNumber,
            title: 'Contributors PR',
            body: null,
            state: 'open',
            draft: false,
            user: { login: 'opener' },
            created_at: new Date(now - 10_000).toISOString(),
            updated_at: commitDate,
            merged_at: null,
            closed_at: null,
            additions: 1,
            deletions: 0,
            commits: 1,
            requested_reviewers: [],
            labels: [],
            base: { ref: 'main' },
            head: { ref: 'feature' },
          }
        }

        async listIssueEvents(): Promise<[]> {
          return []
        }

        async listPullRequestReviews(): Promise<[]> {
          return []
        }

        async listIssueComments(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(): Promise<
          Array<{ sha: string; commit: { author: { date: string } } }>
        > {
          return [{ sha: commitSha, commit: { author: { date: commitDate } } }]
        }

        async getCommit(): Promise<{
          sha: string
          author: { login: string }
          commit: { author: { date: string; name: string; email: string }; message: string }
          stats: { additions: number; deletions: number; total: number }
          files: Array<{ filename: string }>
        }> {
          return {
            sha: commitSha,
            author: { login: 'primary' },
            commit: {
              author: { date: commitDate, name: 'Primary', email: 'primary@example.com' },
              message:
                'feat: shared commit\n\nCo-authored-by: Collab Human <collab@example.com>\nCo-authored-by: Collab Human <COLLAB@example.com>',
            },
            stats: { additions: 4, deletions: 1, total: 5 },
            files: [{ filename: 'README.md' }],
          }
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      await syncRepos({
        repos: [repo],
        cache,
        github: new ContributorGitHub() as unknown as GitHubClient,
        config,
        timeRange,
        forceSync: true,
      })

      const pr = cache.getPullRequest(repo, prNumber)?.data
      const commit = cache.getCommit(repo, commitSha)?.data

      expect(pr?.contributors).toEqual(['Collab', 'opener', 'primary'])
      expect(commit?.co_authors).toEqual([{ username: 'Collab', email: 'collab@example.com' }])
    })
  })

  it('excludes merge-only commit authors from PR contributors', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
      const repo: RepoFullName = 'org/repo'
      const prNumber = 78
      const commitSha = 'merge-only'
      const commitDate = new Date(now - 2_000).toISOString()

      class ContributorGitHub {
        async listPullRequestsPage(
          _repo: RepoFullName,
          options: { page?: number } = {},
        ): Promise<
          Array<{
            number: number
            updated_at: string
            state: 'open'
            base: { ref: string }
            head: { ref: string }
          }>
        > {
          const page = options.page ?? 1
          if (page > 1) {
            return []
          }
          return [
            {
              number: prNumber,
              updated_at: commitDate,
              state: 'open',
              base: { ref: 'main' },
              head: { ref: 'feature' },
            },
          ]
        }

        async getPullRequest(): Promise<{
          number: number
          title: string
          body: string | null
          state: 'open'
          draft: boolean
          user: { login: string }
          created_at: string
          updated_at: string
          merged_at: null
          closed_at: null
          additions: number
          deletions: number
          commits: number
          requested_reviewers: []
          labels: []
        }> {
          return {
            number: prNumber,
            title: 'Merge-only PR',
            body: null,
            state: 'open',
            draft: false,
            user: { login: 'alice' },
            created_at: new Date(now - 10_000).toISOString(),
            updated_at: commitDate,
            merged_at: null,
            closed_at: null,
            additions: 1,
            deletions: 0,
            commits: 1,
            requested_reviewers: [],
            labels: [],
            base: { ref: 'main' },
            head: { ref: 'feature' },
          }
        }

        async listIssueEvents(): Promise<[]> {
          return []
        }

        async listPullRequestReviews(): Promise<[]> {
          return []
        }

        async listIssueComments(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(): Promise<
          Array<{ sha: string; commit: { author: { date: string } } }>
        > {
          return [{ sha: commitSha, commit: { author: { date: commitDate } } }]
        }

        async getCommit(): Promise<{
          sha: string
          author: { login: string }
          commit: { author: { date: string; name: string; email: string }; message: string }
          stats: { additions: number; deletions: number; total: number }
          files: Array<{ filename: string }>
        }> {
          return {
            sha: commitSha,
            author: { login: 'bob' },
            commit: {
              author: { date: commitDate, name: 'Bob', email: 'bob@example.com' },
              message: 'Merge pull request #42 from org/dev',
            },
            stats: { additions: 0, deletions: 0, total: 0 },
            files: [],
          }
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      await syncRepos({
        repos: [repo],
        cache,
        github: new ContributorGitHub() as unknown as GitHubClient,
        config,
        timeRange,
        forceSync: true,
      })

      const pr = cache.getPullRequest(repo, prNumber)?.data

      expect(pr?.contributors).toEqual(['alice'])
    })
  })

  it('keeps contributors with both merge-sync and real commits on a PR', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
      const repo: RepoFullName = 'org/repo'
      const prNumber = 79
      const mergeCommitSha = 'merge-sync'
      const featureCommitSha = 'feature-work'
      const commitDate = new Date(now - 2_000).toISOString()

      class ContributorGitHub {
        async listPullRequestsPage(
          _repo: RepoFullName,
          options: { page?: number } = {},
        ): Promise<
          Array<{
            number: number
            updated_at: string
            state: 'open'
            base: { ref: string }
            head: { ref: string }
          }>
        > {
          const page = options.page ?? 1
          if (page > 1) {
            return []
          }
          return [
            {
              number: prNumber,
              updated_at: commitDate,
              state: 'open',
              base: { ref: 'main' },
              head: { ref: 'feature' },
            },
          ]
        }

        async getPullRequest(): Promise<{
          number: number
          title: string
          body: string | null
          state: 'open'
          draft: boolean
          user: { login: string }
          created_at: string
          updated_at: string
          merged_at: null
          closed_at: null
          additions: number
          deletions: number
          commits: number
          requested_reviewers: []
          labels: []
        }> {
          return {
            number: prNumber,
            title: 'Mixed contributor PR',
            body: null,
            state: 'open',
            draft: false,
            user: { login: 'alice' },
            created_at: new Date(now - 10_000).toISOString(),
            updated_at: commitDate,
            merged_at: null,
            closed_at: null,
            additions: 3,
            deletions: 1,
            commits: 2,
            requested_reviewers: [],
            labels: [],
            base: { ref: 'main' },
            head: { ref: 'feature' },
          }
        }

        async listIssueEvents(): Promise<[]> {
          return []
        }

        async listPullRequestReviews(): Promise<[]> {
          return []
        }

        async listIssueComments(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(): Promise<
          Array<{ sha: string; commit: { author: { date: string } } }>
        > {
          return [
            { sha: mergeCommitSha, commit: { author: { date: commitDate } } },
            { sha: featureCommitSha, commit: { author: { date: commitDate } } },
          ]
        }

        async getCommit(
          _repo: RepoFullName,
          sha: string,
        ): Promise<{
          sha: string
          author: { login: string }
          commit: { author: { date: string; name: string; email: string }; message: string }
          stats: { additions: number; deletions: number; total: number }
          files: Array<{ filename: string }>
        }> {
          if (sha === mergeCommitSha) {
            return {
              sha,
              author: { login: 'bob' },
              commit: {
                author: { date: commitDate, name: 'Bob', email: 'bob@example.com' },
                message: 'Merge pull request #42 from org/dev',
              },
              stats: { additions: 0, deletions: 0, total: 0 },
              files: [],
            }
          }

          return {
            sha,
            author: { login: 'bob' },
            commit: {
              author: { date: commitDate, name: 'Bob', email: 'bob@example.com' },
              message: 'feat: add widget',
            },
            stats: { additions: 4, deletions: 1, total: 5 },
            files: [{ filename: 'widget.ts' }],
          }
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      await syncRepos({
        repos: [repo],
        cache,
        github: new ContributorGitHub() as unknown as GitHubClient,
        config,
        timeRange,
        forceSync: true,
      })

      const pr = cache.getPullRequest(repo, prNumber)?.data

      expect(pr?.contributors).toEqual(['alice', 'bob'])
    })
  })

  it('keeps the PR author in contributors even when every commit is a merge', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
      const repo: RepoFullName = 'org/repo'
      const prNumber = 80
      const commitSha = 'author-merge'
      const commitDate = new Date(now - 2_000).toISOString()

      class ContributorGitHub {
        async listPullRequestsPage(
          _repo: RepoFullName,
          options: { page?: number } = {},
        ): Promise<
          Array<{
            number: number
            updated_at: string
            state: 'open'
            base: { ref: string }
            head: { ref: string }
          }>
        > {
          const page = options.page ?? 1
          if (page > 1) {
            return []
          }
          return [
            {
              number: prNumber,
              updated_at: commitDate,
              state: 'open',
              base: { ref: 'main' },
              head: { ref: 'feature' },
            },
          ]
        }

        async getPullRequest(): Promise<{
          number: number
          title: string
          body: string | null
          state: 'open'
          draft: boolean
          user: { login: string }
          created_at: string
          updated_at: string
          merged_at: null
          closed_at: null
          additions: number
          deletions: number
          commits: number
          requested_reviewers: []
          labels: []
        }> {
          return {
            number: prNumber,
            title: 'Author merge PR',
            body: null,
            state: 'open',
            draft: false,
            user: { login: 'alice' },
            created_at: new Date(now - 10_000).toISOString(),
            updated_at: commitDate,
            merged_at: null,
            closed_at: null,
            additions: 0,
            deletions: 0,
            commits: 1,
            requested_reviewers: [],
            labels: [],
            base: { ref: 'main' },
            head: { ref: 'feature' },
          }
        }

        async listIssueEvents(): Promise<[]> {
          return []
        }

        async listPullRequestReviews(): Promise<[]> {
          return []
        }

        async listIssueComments(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(): Promise<
          Array<{ sha: string; commit: { author: { date: string } } }>
        > {
          return [{ sha: commitSha, commit: { author: { date: commitDate } } }]
        }

        async getCommit(): Promise<{
          sha: string
          author: { login: string }
          commit: { author: { date: string; name: string; email: string }; message: string }
          stats: { additions: number; deletions: number; total: number }
          files: Array<{ filename: string }>
        }> {
          return {
            sha: commitSha,
            author: { login: 'alice' },
            commit: {
              author: { date: commitDate, name: 'Alice', email: 'alice@example.com' },
              message: "Merge branch 'main' into feature",
            },
            stats: { additions: 0, deletions: 0, total: 0 },
            files: [],
          }
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      await syncRepos({
        repos: [repo],
        cache,
        github: new ContributorGitHub() as unknown as GitHubClient,
        config,
        timeRange,
        forceSync: true,
      })

      const pr = cache.getPullRequest(repo, prNumber)?.data

      expect(pr?.contributors).toEqual(['alice'])
    })
  })

  it('recomputes stale cached contributors[] so pre-filter merge-only entries are dropped on resync', async () => {
    // Regression for gh-pulse#7 review finding: when `commits_pr` has full coverage
    // (no gaps to fetch), the sync path used to return early and skip the
    // contributor-resolution loop, so rows written before MERGE_COMMIT_RE shipped
    // kept their stale `contributors[]`. This test seeds that exact state and
    // verifies the resync rebuilds the array with the filter applied.
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
      const repo: RepoFullName = 'org/repo'
      const prNumber = 99
      const commitSha = 'stale-merge-sha'
      const createdAt = now - 10_000
      const updatedAt = now - 5_000
      const committedAt = now - 7_000
      const updatedAtIso = new Date(updatedAt).toISOString()

      cache.upsertPullRequest(
        {
          repo,
          number: prNumber,
          title: 'Pre-fix PR',
          body: null,
          state: 'open',
          draft: false,
          author: 'alice',
          created_at: createdAt,
          updated_at: updatedAt,
          merged_at: null,
          closed_at: null,
          additions: 0,
          deletions: 0,
          commits: 1,
          requested_reviewers: [],
          labels: [],
          linked_issues: [],
          contributors: ['alice', 'bob'],
        },
        now,
      )
      cache.upsertCommit(
        {
          repo,
          sha: commitSha,
          author: 'bob',
          committed_at: committedAt,
          message: 'Merge pull request #42 from org/dev',
          additions: 0,
          deletions: 0,
          files_changed: 0,
        },
        now,
      )
      cache.addCoverageRange(repo, 'pull_requests', timeRange.start, timeRange.end, now)
      cache.addCoverageRange(repo, 'events', timeRange.start, timeRange.end, now)
      cache.addCoverageRange(repo, 'commits', timeRange.start, timeRange.end, now)
      cache.addCoverageRange(repo, 'commits_pr', timeRange.start, timeRange.end, now)

      class StaleCacheGitHub {
        getCommitCalls = 0

        async listPullRequestsPage(
          _repo: RepoFullName,
          options: { page?: number } = {},
        ): Promise<
          Array<{
            number: number
            updated_at: string
            state: 'open'
            base: { ref: string }
            head: { ref: string }
          }>
        > {
          const page = options.page ?? 1
          if (page > 1) {
            return []
          }
          return [
            {
              number: prNumber,
              updated_at: updatedAtIso,
              state: 'open',
              base: { ref: 'main' },
              head: { ref: 'feature' },
            },
          ]
        }

        async getPullRequest(): Promise<null> {
          return null
        }

        async listIssueEvents(): Promise<[]> {
          return []
        }

        async listPullRequestReviews(): Promise<[]> {
          return []
        }

        async listIssueComments(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<[]> {
          return []
        }

        async listPullRequestCommits(): Promise<
          Array<{ sha: string; commit: { author: { date: string } } }>
        > {
          return [
            { sha: commitSha, commit: { author: { date: new Date(committedAt).toISOString() } } },
          ]
        }

        async getCommit(): Promise<never> {
          this.getCommitCalls += 1
          throw new Error('unexpected getCommit call — commit should be served from cache')
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      const github = new StaleCacheGitHub()

      await syncRepos({
        repos: [repo],
        cache,
        github: github as unknown as GitHubClient,
        config,
        timeRange,
        forceSync: true,
      })

      const pr = cache.getPullRequest(repo, prNumber)?.data

      expect(pr?.contributors).toEqual(['alice'])
      expect(github.getCommitCalls).toBe(0)
    })
  })

  describe('contributor classification', () => {
    it('drops phantom-user contributors and records commit evidence', async () => {
      await withTempCache(async (cache, cachePath) => {
        const now = Date.now()
        const timeRange = buildTimeRange(now)
        const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
        const repo: RepoFullName = 'org/repo'
        const commitDate = new Date(now - 2_000).toISOString()
        const github = new ContributorClassificationGitHub(
          [
            {
              number: 113,
              author: 'dave',
              updatedAt: commitDate,
              commits: [
                {
                  sha: 'phantom-sha',
                  author: 'bhanuprasad14',
                  email: 'test@example.com',
                },
              ],
            },
          ],
          new Map([['bhanuprasad14', false]]),
        )

        await syncRepos({
          repos: [repo],
          cache,
          github: github as unknown as GitHubClient,
          config,
          timeRange,
          forceSync: true,
        })

        const pr = cache.getPullRequest(repo, 113)?.data

        expect(pr?.contributors).toEqual(['dave'])
        expect(pr?.meta?.dropped_contributors).toEqual([
          {
            login: 'bhanuprasad14',
            pr_number: 113,
            repo,
            reason: 'phantom-user',
            evidence: { commit_sha: 'phantom-sha', author_email: 'test@example.com' },
          },
        ])
      })
    })

    it('drops name-with-spaces contributors without a user lookup', async () => {
      await withTempCache(async (cache, cachePath) => {
        const now = Date.now()
        const timeRange = buildTimeRange(now)
        const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
        const repo: RepoFullName = 'org/repo'
        const commitDate = new Date(now - 2_000).toISOString()
        const github = new ContributorClassificationGitHub([
          {
            number: 2508,
            author: 'youngkidwarrior',
            updatedAt: commitDate,
            commits: [
              {
                sha: 'name-with-spaces-sha',
                author: 'Victor Ginelli',
                email: 'victor@example.com',
              },
            ],
          },
        ])

        await syncRepos({
          repos: [repo],
          cache,
          github: github as unknown as GitHubClient,
          config,
          timeRange,
          forceSync: true,
        })

        const pr = cache.getPullRequest(repo, 2508)?.data

        expect(pr?.contributors).toEqual(['youngkidwarrior'])
        expect(pr?.meta?.dropped_contributors?.[0]).toMatchObject({
          login: 'Victor Ginelli',
          reason: 'name-with-spaces',
          evidence: { commit_sha: 'name-with-spaces-sha' },
        })
        expect(github.userExistsCalls.get('Victor Ginelli') ?? 0).toBe(0)
      })
    })

    it('drops default AI-tool identities before user lookup', async () => {
      await withTempCache(async (cache, cachePath) => {
        const now = Date.now()
        const timeRange = buildTimeRange(now)
        const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
        const repo: RepoFullName = 'org/repo'
        const commitDate = new Date(now - 2_000).toISOString()
        const github = new ContributorClassificationGitHub([
          {
            number: 3715,
            author: 'carol',
            updatedAt: commitDate,
            commits: [
              { sha: 'claude-sha', author: 'claude', email: 'claude@example.com' },
              { sha: 'bob-sha', author: 'bob', email: 'bob@example.com' },
            ],
          },
        ])

        await syncRepos({
          repos: [repo],
          cache,
          github: github as unknown as GitHubClient,
          config,
          timeRange,
          forceSync: true,
        })

        const pr = cache.getPullRequest(repo, 3715)?.data

        expect(pr?.contributors).toEqual(['bob', 'carol'])
        expect(pr?.meta?.dropped_contributors?.[0]).toMatchObject({
          login: 'claude',
          reason: 'ai-tool-identity',
        })
        expect(github.userExistsCalls.get('claude') ?? 0).toBe(0)
        expect(github.userExistsCalls.get('bob')).toBe(1)
      })
    })

    it('caches user validity once per login per sync run', async () => {
      await withTempCache(async (cache, cachePath) => {
        const now = Date.now()
        const timeRange = buildTimeRange(now)
        const config = buildConfig(cachePath, {
          concurrency: 2,
          use_graphql: false,
          use_timeline: false,
        })
        const repo: RepoFullName = 'org/repo'
        const commitDate = new Date(now - 2_000).toISOString()
        const github = new ContributorClassificationGitHub(
          [
            {
              number: 201,
              author: 'dave',
              updatedAt: commitDate,
              commits: [{ sha: 'phantom-one', author: 'bhanuprasad14', email: 'test@example.com' }],
            },
            {
              number: 202,
              author: 'bob',
              updatedAt: commitDate,
              commits: [{ sha: 'phantom-two', author: 'bhanuprasad14', email: 'test@example.com' }],
            },
          ],
          new Map([['bhanuprasad14', false]]),
        )

        await syncRepos({
          repos: [repo],
          cache,
          github: github as unknown as GitHubClient,
          config,
          timeRange,
          forceSync: true,
        })

        expect(github.userExistsCalls.get('bhanuprasad14')).toBe(1)
      })
    })

    it('preserves real contributors after classification', async () => {
      await withTempCache(async (cache, cachePath) => {
        const now = Date.now()
        const timeRange = buildTimeRange(now)
        const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
        const repo: RepoFullName = 'org/repo'
        const commitDate = new Date(now - 2_000).toISOString()
        const github = new ContributorClassificationGitHub([
          {
            number: 301,
            author: 'alice',
            updatedAt: commitDate,
            commits: [
              { sha: 'alice-sha', author: 'alice', email: 'alice@example.com' },
              { sha: 'bob-sha', author: 'bob', email: 'bob@example.com' },
            ],
          },
        ])

        await syncRepos({
          repos: [repo],
          cache,
          github: github as unknown as GitHubClient,
          config,
          timeRange,
          forceSync: true,
        })

        const pr = cache.getPullRequest(repo, 301)?.data

        expect(pr?.contributors).toEqual(['alice', 'bob'])
        expect(pr?.meta?.dropped_contributors).toBeUndefined()
      })
    })

    it('matches configured AI identities case-insensitively', async () => {
      await withTempCache(async (cache, cachePath) => {
        const now = Date.now()
        const timeRange = buildTimeRange(now)
        const baseConfig = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
        const config: Config = {
          ...baseConfig,
          exclude: { ...baseConfig.exclude, ai_identities: ['Claude'] },
        }
        const repo: RepoFullName = 'org/repo'
        const commitDate = new Date(now - 2_000).toISOString()
        const github = new ContributorClassificationGitHub([
          {
            number: 401,
            author: 'dave',
            updatedAt: commitDate,
            commits: [{ sha: 'case-ai-sha', author: 'claude', email: 'claude@example.com' }],
          },
        ])

        await syncRepos({
          repos: [repo],
          cache,
          github: github as unknown as GitHubClient,
          config,
          timeRange,
          forceSync: true,
        })

        const pr = cache.getPullRequest(repo, 401)?.data

        expect(pr?.contributors).toEqual(['dave'])
        expect(pr?.meta?.dropped_contributors?.[0]?.reason).toBe('ai-tool-identity')
        expect(github.userExistsCalls.get('claude') ?? 0).toBe(0)
      })
    })

    it('drops an AI-tool opener from contributors and records metadata', async () => {
      await withTempCache(async (cache, cachePath) => {
        const now = Date.now()
        const timeRange = buildTimeRange(now)
        const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
        const repo: RepoFullName = 'org/repo'
        const commitDate = new Date(now - 2_000).toISOString()
        const github = new ContributorClassificationGitHub([
          { number: 501, author: 'claude', updatedAt: commitDate, commits: [] },
        ])

        await syncRepos({
          repos: [repo],
          cache,
          github: github as unknown as GitHubClient,
          config,
          timeRange,
          forceSync: true,
        })

        const pr = cache.getPullRequest(repo, 501)?.data

        expect(pr?.contributors).toEqual([])
        expect(pr?.meta?.dropped_contributors).toEqual([
          { login: 'claude', pr_number: 501, repo, reason: 'ai-tool-identity' },
        ])
      })
    })

    it('produces stable dropped_contributors evidence across fresh and cached commit paths', async () => {
      await withTempCache(async (cache, cachePath) => {
        const now = Date.now()
        const timeRange = buildTimeRange(now)
        const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
        const repo: RepoFullName = 'org/repo'
        const commitDate = new Date(now - 2_000).toISOString()
        const github = new ContributorClassificationGitHub(
          [
            {
              number: 113,
              author: 'dave',
              updatedAt: commitDate,
              commits: [
                {
                  sha: 'phantom-sha',
                  author: 'bhanuprasad14',
                  email: 'test@example.com',
                },
              ],
            },
          ],
          new Map([['bhanuprasad14', false]]),
        )

        await syncRepos({
          repos: [repo],
          cache,
          github: github as unknown as GitHubClient,
          config,
          timeRange,
          forceSync: true,
        })

        const firstSync = cache.getPullRequest(repo, 113)?.data
        const firstGetCommitCalls = github.getCommitCalls

        await syncRepos({
          repos: [repo],
          cache,
          github: github as unknown as GitHubClient,
          config,
          timeRange,
          forceSync: true,
        })

        const secondSync = cache.getPullRequest(repo, 113)?.data

        expect(firstSync?.meta?.dropped_contributors).toEqual([
          {
            login: 'bhanuprasad14',
            pr_number: 113,
            repo,
            reason: 'phantom-user',
            evidence: { commit_sha: 'phantom-sha', author_email: 'test@example.com' },
          },
        ])
        expect(secondSync?.meta?.dropped_contributors).toEqual(
          firstSync?.meta?.dropped_contributors,
        )
        expect(github.getCommitCalls).toBe(firstGetCommitCalls)
      })
    })
  })

  it('preserves co_authors when creating commit events from cached commits', async () => {
    await withTempCache(async (cache, cachePath) => {
      const now = Date.now()
      const timeRange = buildTimeRange(now)
      const config = buildConfig(cachePath, { use_graphql: false, use_timeline: false })
      const repo: RepoFullName = 'org/repo'
      const sha = 'cached-commit'

      cache.upsertCommit({
        repo,
        sha,
        author: 'alice',
        committed_at: now - 1_000,
        message: 'feat: cached commit',
        additions: 3,
        deletions: 1,
        files_changed: 1,
        co_authors: [{ username: 'bob', email: 'bob@example.com' }],
      })

      class CachedCommitGitHub {
        async listPullRequestsPage(): Promise<[]> {
          return []
        }

        async listCommits(): Promise<Array<{ sha: string; commit: { author: { date: string } } }>> {
          return [{ sha, commit: { author: { date: new Date(now - 1_000).toISOString() } } }]
        }

        async listPullRequestCommits(): Promise<[]> {
          return []
        }

        async userExists(): Promise<boolean> {
          return true
        }
      }

      await syncRepos({
        repos: [repo],
        cache,
        github: new CachedCommitGitHub() as unknown as GitHubClient,
        config,
        timeRange,
      })

      const events = cache
        .getEvents({ repo, type: 'commit_pushed' })
        .filter(
          (event): event is { type: 'commit_pushed'; sha: string; co_authors?: unknown } =>
            event.type === 'commit_pushed',
        )

      expect(events.some((event) => event.sha === sha)).toBe(true)
      expect(events.find((event) => event.sha === sha)?.co_authors).toEqual([
        { username: 'bob', email: 'bob@example.com' },
      ])
    })
  })

  it('invalidates attribution coverage kinds once via migration marker', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-pulse-'))
    const cachePath = path.join(dir, 'cache.db')
    const repo: RepoFullName = 'org/repo'
    const start = Date.parse('2026-02-01T00:00:00.000Z')
    const end = Date.parse('2026-02-02T00:00:00.000Z')

    try {
      const cache = await Cache.open({ path: cachePath })
      cache.addCoverageRange(repo, 'pull_requests', start, end, Date.now())
      cache.addCoverageRange(repo, 'commits_pr', start, end, Date.now())
      cache.addCoverageRange(repo, 'rollup_commits', start, end, Date.now())
      cache.addCoverageRange(repo, 'rollup_activity', start, end, Date.now())
      cache.close()

      const db = new Database(cachePath)
      db.run("DELETE FROM meta WHERE key = 'attribution_v1_migrated'")
      db.close()

      const migrated = await Cache.open({ path: cachePath })
      expect(migrated.getCoverageRanges(repo, 'pull_requests').length).toBe(1)
      expect(migrated.getCoverageRanges(repo, 'commits_pr').length).toBe(0)
      expect(migrated.getCoverageRanges(repo, 'rollup_commits').length).toBe(0)
      expect(migrated.getCoverageRanges(repo, 'rollup_activity').length).toBe(0)

      migrated.addCoverageRange(repo, 'commits_pr', start, end, Date.now())
      migrated.close()

      const reopened = await Cache.open({ path: cachePath })
      expect(reopened.getCoverageRanges(repo, 'commits_pr').length).toBe(1)
      reopened.close()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
