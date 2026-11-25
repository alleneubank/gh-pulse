import { describe, expect, it, mock } from 'bun:test'
import type { Cache, GitHubClient, Report } from '@dave/gh-pulse-core'
import { runCli } from './index'
import type { RunCliDeps } from './index'

describe('cli tui smoke', () => {
  it('runs --format=tui via entrypoint and exits cleanly', async () => {
    const close = mock(() => {})
    const runTuiSession = mock(async () => {})

    const personalReport: Extract<Report, { type: 'personal' }> = {
      type: 'personal',
      user: 'Mona-Lisa',
      meta: {
        audience: 'personal',
        period_label: 'last 7 days',
        start: Date.parse('2026-02-10T00:00:00.000Z'),
        end: Date.parse('2026-02-17T00:00:00.000Z'),
        start_utc: '2026-02-10T00:00:00.000Z',
        end_utc: '2026-02-17T00:00:00.000Z',
        generated_at: Date.parse('2026-02-17T00:00:00.000Z'),
        repos: ['acme/repo'],
        data_freshness: {
          dataAsOf: Date.parse('2026-02-17T00:00:00.000Z'),
          cacheAgeMinutes: 0,
          reposSynced: 1,
          totalRepos: 1,
        },
      },
      summary: {
        prs_opened: 1,
        prs_merged: 0,
        prs_closed: 0,
        commits: 0,
        repos_touched: 1,
        lines_changed: 12,
      },
      review_debt: {
        requested: [],
        team_prs: [],
      },
      open_work: {
        open_prs: [],
      },
      authored_prs: [],
      commits_detail: [],
    }

    const fakeCache = { close } as unknown as Cache
    const deps: RunCliDeps = {
      loadConfig: async () => ({
        github_token: 'fake-token',
        timezone: 'UTC',
        orgs: [],
        repos: ['acme/repo'],
        repo_descriptions: {},
        exclude: {
          authors: [],
          bots: false,
          forks: false,
          archived: false,
        },
        thresholds: {
          stale_days: 14,
          stuck_days: 14,
          blocker_max_age_days: 30,
          large_pr_lines: 500,
        },
        cache: {
          path: ':memory:',
          ttl_hours: 24,
          sync_ttl_hours: 24,
          concurrency: 5,
          use_etags: false,
          use_timeline: true,
          use_graphql: true,
        },
        rollout: {
          production_branches: ['main'],
          integration_branches: ['dev'],
          limited_surfaces: [],
        },
      }),
      openCache: async (_options) => fakeCache,
      createGitHubClient: (_options) => ({}) as GitHubClient,
      resolveTarget: async () => ({ audience: 'personal' as const, user: 'Mona-Lisa' }),
      resolveRepos: async () => ['acme/repo'],
      syncRepos: async () => {},
      resolveTeamMembers: async () => [],
      buildReport: () => personalReport,
      runTuiSession,
    }

    await runCli(['--for=me', '--format=tui', '--quiet'], deps)

    expect(runTuiSession).toHaveBeenCalledTimes(1)
    expect(runTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        report: expect.objectContaining({ type: 'personal', user: 'Mona-Lisa' }),
        timeZone: 'UTC',
      }),
    )
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('respects --hyperlinks=never for slack output', async () => {
    const close = mock(() => {})
    const runTuiSession = mock(async () => {})

    const personalReport: Extract<Report, { type: 'personal' }> = {
      type: 'personal',
      user: 'Mona-Lisa',
      meta: {
        audience: 'personal',
        period_label: 'last 7 days',
        start: Date.parse('2026-02-10T00:00:00.000Z'),
        end: Date.parse('2026-02-17T00:00:00.000Z'),
        start_utc: '2026-02-10T00:00:00.000Z',
        end_utc: '2026-02-17T00:00:00.000Z',
        generated_at: Date.parse('2026-02-17T00:00:00.000Z'),
        repos: ['acme/repo'],
        data_freshness: {
          dataAsOf: Date.parse('2026-02-17T00:00:00.000Z'),
          cacheAgeMinutes: 0,
          reposSynced: 1,
          totalRepos: 1,
        },
      },
      summary: {
        prs_opened: 1,
        prs_merged: 0,
        prs_closed: 0,
        commits: 0,
        repos_touched: 1,
        lines_changed: 12,
      },
      review_debt: {
        requested: [],
        team_prs: [],
      },
      open_work: {
        open_prs: [
          {
            repo: 'acme/repo',
            number: 123,
            title: 'Fix output formatting',
            author: 'Mona-Lisa',
            state: 'open',
            draft: false,
            updated_at: Date.parse('2026-02-16T00:00:00.000Z'),
            created_at: Date.parse('2026-02-15T00:00:00.000Z'),
            age_days: 1,
          },
        ],
      },
      authored_prs: [],
      commits_detail: [],
    }

    const fakeCache = { close } as unknown as Cache
    const deps: RunCliDeps = {
      loadConfig: async () => ({
        github_token: 'fake-token',
        timezone: 'UTC',
        orgs: [],
        repos: ['acme/repo'],
        repo_descriptions: {},
        exclude: {
          authors: [],
          bots: false,
          forks: false,
          archived: false,
        },
        thresholds: {
          stale_days: 14,
          stuck_days: 14,
          blocker_max_age_days: 30,
          large_pr_lines: 500,
        },
        cache: {
          path: ':memory:',
          ttl_hours: 24,
          sync_ttl_hours: 24,
          concurrency: 5,
          use_etags: false,
          use_timeline: true,
          use_graphql: true,
        },
        rollout: {
          production_branches: ['main'],
          integration_branches: ['dev'],
          limited_surfaces: [],
        },
      }),
      openCache: async (_options) => fakeCache,
      createGitHubClient: (_options) => ({}) as GitHubClient,
      resolveTarget: async () => ({ audience: 'personal' as const, user: 'Mona-Lisa' }),
      resolveRepos: async () => ['acme/repo'],
      syncRepos: async () => {},
      resolveTeamMembers: async () => [],
      buildReport: () => personalReport,
      runTuiSession,
    }

    const messages: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      messages.push(args.map((arg) => String(arg)).join(' '))
    }

    try {
      await runCli(['--for=me', '--format=slack', '--hyperlinks=never', '--quiet'], deps)
    } finally {
      console.log = originalLog
    }

    const output = messages.join('\n')
    expect(output).toContain('acme/repo')
    expect(output).toContain('#123')
    expect(output).not.toContain('<https://github.com/')
  })
})
