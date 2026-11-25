import picomatch from 'picomatch'
import type { Cache } from './cache'
import type { Config } from './config'
import type { GitHubClient } from './github'
import type { ProgressEvent, RepoFullName } from './types'

export interface ResolveReposOptions {
  config: Config
  github: GitHubClient
  cache?: Cache
  orgs?: string[]
  repoPatterns?: string[]
  strict?: boolean
  forceSync?: boolean
  onProgress?: (event: ProgressEvent) => void
}

export async function resolveRepos(options: ResolveReposOptions): Promise<RepoFullName[]> {
  const hasOrgOverride = (options.orgs ?? []).length > 0
  const hasRepoOverride = (options.repoPatterns ?? []).length > 0

  const orgs = uniqueStrings(
    hasOrgOverride ? (options.orgs ?? []) : hasRepoOverride ? [] : (options.config.orgs ?? []),
  )
  const repoSources = hasRepoOverride
    ? (options.repoPatterns ?? [])
    : hasOrgOverride
      ? []
      : (options.config.repos ?? [])
  const repoPatterns = hasRepoOverride ? [] : (options.repoPatterns ?? [])
  const { cache, forceSync } = options
  const cacheTtlHours = options.config.cache.ttl_hours

  const repoSet = new Set<RepoFullName>()

  // orgs can include GitHub orgs OR usernames - we try org first, fall back to user
  await forEachSequential(orgs, async (org, index) => {
    // Check cache first (unless forceSync)
    if (cache && !forceSync) {
      const cached = cache.getRepoList(org)
      if (cached && cache.isFresh(cached.fetched_at, cacheTtlHours)) {
        options.onProgress?.({
          phase: 'resolve',
          message: `Using cached repos for ${org}`,
          current: index + 1,
          total: orgs.length,
        })
        cached.repos.forEach((repo) => repoSet.add(repo))
        return
      }
    }

    options.onProgress?.({
      phase: 'resolve',
      message: `Resolving repos for ${org}`,
      current: index + 1,
      total: orgs.length,
    })
    const repos = await listOwnerRepos(options.github, org)
    repos.forEach((repo) => repoSet.add(repo))

    // Cache the result
    if (cache) {
      cache.upsertRepoList(org, repos)
    }
  })

  await forEachSequential(repoSources, async (pattern) => {
    if (!pattern.includes('*')) {
      repoSet.add(pattern as RepoFullName)
      return
    }

    const owner = pattern.split('/')[0] ?? ''
    if (!owner) {
      throw new Error(`Invalid repo pattern: ${pattern}`)
    }

    // Check cache first (unless forceSync)
    let repos: RepoFullName[]
    if (cache && !forceSync) {
      const cached = cache.getRepoList(owner)
      if (cached && cache.isFresh(cached.fetched_at, cacheTtlHours)) {
        options.onProgress?.({
          phase: 'resolve',
          message: `Using cached repos for ${owner}`,
        })
        repos = cached.repos
      } else {
        options.onProgress?.({
          phase: 'resolve',
          message: `Resolving repos for ${owner}`,
        })
        repos = await listOwnerRepos(options.github, owner)
        cache.upsertRepoList(owner, repos)
      }
    } else {
      options.onProgress?.({
        phase: 'resolve',
        message: `Resolving repos for ${owner}`,
      })
      repos = await listOwnerRepos(options.github, owner)
      if (cache) {
        cache.upsertRepoList(owner, repos)
      }
    }

    const matcher = picomatch(pattern)
    repos.filter((repo) => matcher(repo)).forEach((repo) => repoSet.add(repo))
  })

  let repos = [...repoSet]

  const patterns = repoPatterns
    .flatMap((pattern) => pattern.split(',').map((p) => p.trim()))
    .filter(Boolean)
  const needsFilter =
    patterns.length > 0 || options.config.exclude.forks || options.config.exclude.archived
  if (repos.length > 0 || needsFilter) {
    options.onProgress?.({
      phase: 'resolve',
      message: `Found ${repos.length} repos${needsFilter ? ', filtering...' : ''}`,
    })
  }

  if (patterns.length > 0) {
    const matcher = picomatch(patterns)
    repos = repos.filter((repo) => matcher(repo))
  }

  if (options.config.exclude.forks || options.config.exclude.archived) {
    repos = await filterRepoStates(repos, options)
  } else if (options.strict ?? true) {
    await verifyReposAccessible(repos, options)
  }

  return repos.toSorted()
}

async function listOwnerRepos(github: GitHubClient, owner: string): Promise<RepoFullName[]> {
  try {
    return await github.listOrgRepos(owner)
  } catch (error) {
    const status = getStatus(error)
    if (status === 404) {
      return github.listUserRepos(owner)
    }
    throw error
  }
}

async function filterRepoStates(
  repos: RepoFullName[],
  options: ResolveReposOptions,
): Promise<RepoFullName[]> {
  const results: RepoFullName[] = []
  await forEachSequential(repos, async (repo) => {
    const detail = await options.github.getRepo(repo)
    if (options.config.exclude.forks && detail.fork) {
      return
    }
    if (options.config.exclude.archived && detail.archived) {
      return
    }
    results.push(detail.full_name as RepoFullName)
  })
  return results
}

async function verifyReposAccessible(
  repos: RepoFullName[],
  options: ResolveReposOptions,
): Promise<void> {
  await forEachSequential(repos, (repo) => options.github.ensureRepoAccessible(repo))
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function forEachSequential<T>(
  items: T[],
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  return items.reduce(
    (promise, item, index) => promise.then(() => fn(item, index)),
    Promise.resolve(),
  )
}

function getStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error && 'status' in error) {
    return (error as { status?: number }).status
  }
  return undefined
}
