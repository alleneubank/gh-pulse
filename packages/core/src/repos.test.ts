import { describe, expect, it } from 'bun:test'
import type { Config } from './config'
import type { GitHubClient } from './github'
import type { RepoFullName } from './types'
import { resolveRepos } from './repos'

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    github_token: 'token',
    orgs: ['mona-lisa'],
    repos: ['mona-lisa/special'],
    team: { strategy: 'org_members', members: [] },
    exclude: { bots: false, forks: false, archived: false, authors: [] },
    thresholds: { stale_days: 2, stuck_days: 4, large_pr_lines: 500, blocker_max_age_days: 90 },
    timezone: 'UTC',
    cache: {
      path: '',
      ttl_hours: 1,
      sync_ttl_hours: 24,
      concurrency: 1,
      use_etags: true,
      use_timeline: true,
      use_graphql: true,
    },
    ...overrides,
  }
}

class RepoGitHub {
  async listOrgRepos(org: string): Promise<RepoFullName[]> {
    if (org === 'acme-co') {
      return ['acme-co/api', 'acme-co/web']
    }
    if (org === 'mona-lisa') {
      return ['mona-lisa/tool']
    }
    return []
  }

  async listUserRepos(): Promise<RepoFullName[]> {
    return []
  }

  async ensureRepoAccessible(): Promise<void> {
    return
  }
}

describe('resolveRepos', () => {
  it('overrides config orgs and repos when --org is provided', async () => {
    const config = buildConfig()
    const github = new RepoGitHub()

    const repos = await resolveRepos({
      config,
      github: github as unknown as GitHubClient,
      orgs: ['acme-co'],
      strict: false,
    })

    expect(repos).toEqual(['acme-co/api', 'acme-co/web'])
  })

  it('overrides config orgs and repos when --repos is provided', async () => {
    const config = buildConfig()
    const github = new RepoGitHub()

    const repos = await resolveRepos({
      config,
      github: github as unknown as GitHubClient,
      repoPatterns: ['acme-co/*'],
      strict: false,
    })

    expect(repos).toEqual(['acme-co/api', 'acme-co/web'])
  })
})
