import type { Config } from './config'
import type { GitHubClient } from './github'
import type { GitHubUsername, RepoFullName } from './types'

export interface ResolveTeamOptions {
  config: Config
  github: GitHubClient
  repos: RepoFullName[]
  orgs?: string[]
}

export async function resolveTeamMembers(options: ResolveTeamOptions): Promise<GitHubUsername[]> {
  const strategy = options.config.team.strategy

  switch (strategy) {
    case 'config_list':
      return unique(options.config.team.members)
    case 'org_members': {
      const orgs = unique([...options.config.orgs, ...(options.orgs ?? [])])
      const members = await Promise.all(orgs.map((org) => listOwnerMembers(options.github, org)))
      return unique(members.flat())
    }
    case 'repo_contributors': {
      const contributors = await Promise.all(
        options.repos.map((repo) => options.github.listContributors(repo)),
      )
      return unique(contributors.flat())
    }
    default: {
      const _exhaustive: never = strategy
      throw new Error(`Unhandled team strategy: ${_exhaustive}`)
    }
  }
}

/**
 * Deduplicate usernames case-insensitively.
 * Preserves the first occurrence's casing (typically the canonical GitHub casing).
 */
function unique(values: GitHubUsername[]): GitHubUsername[] {
  const seen = new Map<string, GitHubUsername>()
  for (const value of values) {
    const key = value.toLowerCase()
    if (!seen.has(key)) {
      seen.set(key, value)
    }
  }
  return Array.from(seen.values())
}

async function listOwnerMembers(github: GitHubClient, owner: string): Promise<GitHubUsername[]> {
  try {
    return await github.listOrgMembers(owner)
  } catch (error) {
    const status = getStatus(error)
    if (status === 404) {
      // Owner is a user, not an org - return the user as sole "member"
      return [owner as GitHubUsername]
    }
    throw error
  }
}

function getStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error && 'status' in error) {
    return (error as { status?: number }).status
  }
  return undefined
}
