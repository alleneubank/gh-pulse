import { Octokit } from 'octokit'
import type { Endpoints } from '@octokit/types'
import type { Cache } from './cache'
import type { GitHubUsername, RepoFullName } from './types'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 500
const GRAPHQL_PAGE_SIZE = 100

const PULL_REQUEST_ACTIVITY_QUERY = `
  query PullRequestActivity(
    $owner: String!
    $repo: String!
    $number: Int!
    $timelineAfter: String
    $reviewsAfter: String
    $commentsAfter: String
    $fetchTimeline: Boolean!
    $fetchReviews: Boolean!
    $fetchComments: Boolean!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        body
        state
        isDraft
        author { login }
        createdAt
        updatedAt
        mergedAt
        closedAt
        baseRefName
        headRefName
        mergedBy { login }
        additions
        deletions
        commits { totalCount }
        reviewRequests(first: 100) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { name }
            }
          }
        }
        labels(first: 100) {
          nodes { name }
        }
        timelineItems(
          first: ${GRAPHQL_PAGE_SIZE}
          after: $timelineAfter
          itemTypes: [READY_FOR_REVIEW_EVENT, REOPENED_EVENT, CLOSED_EVENT]
        ) @include(if: $fetchTimeline) {
          nodes {
            __typename
            ... on ReadyForReviewEvent { createdAt }
            ... on ReopenedEvent { createdAt }
            ... on ClosedEvent { createdAt }
          }
          pageInfo { hasNextPage endCursor }
        }
        reviews(first: ${GRAPHQL_PAGE_SIZE}, after: $reviewsAfter) @include(if: $fetchReviews) {
          nodes {
            author { login }
            state
            submittedAt
          }
          pageInfo { hasNextPage endCursor }
        }
        comments(first: ${GRAPHQL_PAGE_SIZE}, after: $commentsAfter) @include(if: $fetchComments) {
          nodes {
            author { login }
            createdAt
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    rateLimit { remaining cost resetAt }
  }
`

export interface GitHubClientOptions {
  token: string
  timeoutMs?: number
  maxRetries?: number
  cache?: Cache
  useEtags?: boolean
}

export type PullRequestListItem =
  Endpoints['GET /repos/{owner}/{repo}/pulls']['response']['data'][number]
export type PullRequestDetail =
  Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response']['data']
export type PullRequestReview =
  Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews']['response']['data'][number]
export type PullRequestCommitListItem =
  Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/commits']['response']['data'][number]
export type IssueComment =
  Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/comments']['response']['data'][number]
export type IssueEvent =
  Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/events']['response']['data'][number]
export type IssueTimelineEvent =
  Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/timeline']['response']['data'][number]
export type CommitListItem =
  Endpoints['GET /repos/{owner}/{repo}/commits']['response']['data'][number]
export type CommitDetail = Endpoints['GET /repos/{owner}/{repo}/commits/{ref}']['response']['data']
export type RepoDetail = Endpoints['GET /repos/{owner}/{repo}']['response']['data']
export type Contributor =
  Endpoints['GET /repos/{owner}/{repo}/contributors']['response']['data'][number]

export interface GraphqlActor {
  login: string
}

export interface GraphqlReviewRequest {
  requestedReviewer: { __typename: string; login?: string; name?: string } | null
}

export interface GraphqlPullRequest {
  number: number
  title: string
  body: string | null
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  author: GraphqlActor | null
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  closedAt: string | null
  baseRefName: string
  headRefName: string
  mergedBy: GraphqlActor | null
  additions: number
  deletions: number
  commits: { totalCount: number }
  reviewRequests: { nodes: GraphqlReviewRequest[] }
  labels: { nodes: Array<{ name: string | null }> }
  timelineItems?: {
    nodes: GraphqlTimelineEvent[]
    pageInfo: GraphqlPageInfo
  }
  reviews?: {
    nodes: GraphqlReview[]
    pageInfo: GraphqlPageInfo
  }
  comments?: {
    nodes: GraphqlComment[]
    pageInfo: GraphqlPageInfo
  }
}

export interface GraphqlPageInfo {
  hasNextPage: boolean
  endCursor: string | null
}

export type GraphqlTimelineEvent =
  | { __typename: 'ReadyForReviewEvent'; createdAt: string }
  | { __typename: 'ReopenedEvent'; createdAt: string }
  | { __typename: 'ClosedEvent'; createdAt: string }

export interface GraphqlReview {
  author: GraphqlActor | null
  state: string | null
  submittedAt: string | null
}

export interface GraphqlComment {
  author: GraphqlActor | null
  createdAt: string
}

export interface PullRequestGraphqlActivity {
  pr: GraphqlPullRequest
  timeline: GraphqlTimelineEvent[]
  reviews: GraphqlReview[]
  comments: GraphqlComment[]
}

export class GitHubClient {
  private readonly octokit: Octokit
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly cache: Cache | undefined
  private readonly useEtags: boolean

  constructor(options: GitHubClientOptions) {
    this.octokit = new Octokit({ auth: options.token })
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.cache = options.cache
    this.useEtags = options.useEtags ?? true
  }

  async getAuthenticatedUsername(): Promise<GitHubUsername> {
    const response = await this.withRetry((signal) =>
      this.octokit.rest.users.getAuthenticated({ request: { signal } }),
    )
    return response.data.login
  }

  async userExists(username: GitHubUsername): Promise<boolean> {
    try {
      await this.withRetry((signal) =>
        this.octokit.rest.users.getByUsername({ username, request: { signal } }),
      )
      return true
    } catch (error) {
      const status = getStatus(error)
      if (status === 404) {
        return false
      }
      throw error
    }
  }

  async listOrgMembers(org: string): Promise<GitHubUsername[]> {
    const members = await this.withRetry((signal) =>
      this.octokit.paginate(this.octokit.rest.orgs.listMembers, {
        org,
        per_page: 100,
        request: { signal },
      }),
    )
    return members.map((member) => member.login)
  }

  async listOrgRepos(org: string): Promise<RepoFullName[]> {
    const repos = await this.withRetry((signal) =>
      this.octokit.paginate(this.octokit.rest.repos.listForOrg, {
        org,
        per_page: 100,
        type: 'all',
        request: { signal },
      }),
    )
    return repos.map((repo) => repo.full_name)
  }

  async listUserRepos(username: string): Promise<RepoFullName[]> {
    const repos = await this.withRetry((signal) =>
      this.octokit.paginate(this.octokit.rest.repos.listForUser, {
        username,
        per_page: 100,
        type: 'all',
        request: { signal },
      }),
    )
    return repos.map((repo) => repo.full_name)
  }

  async listPullRequests(repo: RepoFullName): Promise<PullRequestListItem[]> {
    const results: PullRequestListItem[] = []
    let page = 1
    const perPage = 100
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- page-based pagination must be sequential.
      const pageItems = await this.listPullRequestsPage(repo, { page, perPage })
      if (pageItems.length === 0) {
        break
      }
      results.push(...pageItems)
      if (pageItems.length < perPage) {
        break
      }
      page += 1
    }
    return results
  }

  async listPullRequestsPage(
    repo: RepoFullName,
    options: { page?: number; perPage?: number; state?: 'all' | 'open' | 'closed' } = {},
  ): Promise<PullRequestListItem[]> {
    const { owner, name } = splitRepoFullName(repo)
    const perPage = options.perPage ?? 100
    const page = options.page ?? 1
    const state = options.state ?? 'all'
    const result = await this.requestCached<PullRequestListItem[]>(
      'GET /repos/{owner}/{repo}/pulls',
      {
        owner,
        repo: name,
        per_page: perPage,
        page,
        state,
        sort: 'updated',
        direction: 'desc',
      },
    )
    if (result.notModified) {
      return []
    }
    return result.data
  }

  async getPullRequest(repo: RepoFullName, number: number): Promise<PullRequestDetail | null> {
    const { owner, name } = splitRepoFullName(repo)
    const result = await this.requestCached<PullRequestDetail>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      {
        owner,
        repo: name,
        pull_number: number,
      },
    )
    if (result.notModified) {
      return null
    }
    return result.data
  }

  async getPullRequestGraphqlActivity(
    repo: RepoFullName,
    number: number,
  ): Promise<PullRequestGraphqlActivity> {
    const { owner, name } = splitRepoFullName(repo)
    let timelineAfter: string | null = null
    let reviewsAfter: string | null = null
    let commentsAfter: string | null = null
    let fetchTimeline = true
    let fetchReviews = true
    let fetchComments = true
    let pullRequest: GraphqlPullRequest | null = null
    const timeline: GraphqlTimelineEvent[] = []
    const reviews: GraphqlReview[] = []
    const comments: GraphqlComment[] = []
    let pageCount = 0

    while (fetchTimeline || fetchReviews || fetchComments) {
      pageCount += 1
      if (pageCount > 50) {
        throw new Error(`GraphQL pagination exceeded for ${repo}#${number}`)
      }

      const responsePromise: Promise<{
        repository: { pullRequest: GraphqlPullRequest | null } | null
        rateLimit?: { remaining: number; cost: number; resetAt: string }
      }> = this.graphqlRequest(PULL_REQUEST_ACTIVITY_QUERY, {
        owner,
        repo: name,
        number,
        timelineAfter,
        reviewsAfter,
        commentsAfter,
        fetchTimeline,
        fetchReviews,
        fetchComments,
      })
      // eslint-disable-next-line no-await-in-loop -- cursors come from the previous GraphQL page.
      const response = await responsePromise

      const pr: GraphqlPullRequest | null = response.repository?.pullRequest ?? null
      if (!pr) {
        throw new Error(`Pull request not found for ${repo}#${number}`)
      }
      if (!pullRequest) {
        pullRequest = pr
      }

      if (fetchTimeline && pr.timelineItems) {
        timeline.push(...pr.timelineItems.nodes)
        fetchTimeline = pr.timelineItems.pageInfo.hasNextPage
        timelineAfter = pr.timelineItems.pageInfo.endCursor ?? null
      } else {
        fetchTimeline = false
      }

      if (fetchReviews && pr.reviews) {
        reviews.push(...pr.reviews.nodes)
        fetchReviews = pr.reviews.pageInfo.hasNextPage
        reviewsAfter = pr.reviews.pageInfo.endCursor ?? null
      } else {
        fetchReviews = false
      }

      if (fetchComments && pr.comments) {
        comments.push(...pr.comments.nodes)
        fetchComments = pr.comments.pageInfo.hasNextPage
        commentsAfter = pr.comments.pageInfo.endCursor ?? null
      } else {
        fetchComments = false
      }

      if (response.rateLimit && response.rateLimit.remaining <= response.rateLimit.cost) {
        throw new Error(
          `GraphQL rate limit nearly exhausted (remaining ${response.rateLimit.remaining}) for ${repo}#${number}`,
        )
      }
    }

    if (!pullRequest) {
      throw new Error(`Pull request data missing for ${repo}#${number}`)
    }

    return { pr: pullRequest, timeline, reviews, comments }
  }

  async listPullRequestReviews(repo: RepoFullName, number: number): Promise<PullRequestReview[]> {
    const { owner, name } = splitRepoFullName(repo)
    return this.withRetry((signal) =>
      this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
        owner,
        repo: name,
        pull_number: number,
        per_page: 100,
        request: { signal },
      }),
    )
  }

  async listIssueComments(repo: RepoFullName, number: number): Promise<IssueComment[]> {
    const { owner, name } = splitRepoFullName(repo)
    return this.withRetry((signal) =>
      this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner,
        repo: name,
        issue_number: number,
        per_page: 100,
        request: { signal },
      }),
    )
  }

  async listIssueEvents(repo: RepoFullName, number: number): Promise<IssueEvent[]> {
    const { owner, name } = splitRepoFullName(repo)
    return this.withRetry((signal) =>
      this.octokit.paginate(this.octokit.rest.issues.listEvents, {
        owner,
        repo: name,
        issue_number: number,
        per_page: 100,
        request: { signal },
      }),
    )
  }

  async listIssueTimeline(repo: RepoFullName, number: number): Promise<IssueTimelineEvent[]> {
    const { owner, name } = splitRepoFullName(repo)
    return this.paginateCached<IssueTimelineEvent>(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline',
      {
        owner,
        repo: name,
        issue_number: number,
        mediaType: { previews: ['mockingbird'] },
      },
    )
  }

  async listCommits(
    repo: RepoFullName,
    options: { since?: string; until?: string } = {},
  ): Promise<CommitListItem[]> {
    const { owner, name } = splitRepoFullName(repo)
    return this.withRetry((signal) => {
      const params: {
        owner: string
        repo: string
        per_page: number
        request: { signal: AbortSignal }
        since?: string
        until?: string
      } = {
        owner,
        repo: name,
        per_page: 100,
        request: { signal },
      }

      if (options.since) {
        params.since = options.since
      }
      if (options.until) {
        params.until = options.until
      }

      return this.octokit.paginate(this.octokit.rest.repos.listCommits, params)
    })
  }

  async listPullRequestCommits(
    repo: RepoFullName,
    number: number,
  ): Promise<PullRequestCommitListItem[]> {
    const { owner, name } = splitRepoFullName(repo)
    return this.withRetry((signal) =>
      this.octokit.paginate(this.octokit.rest.pulls.listCommits, {
        owner,
        repo: name,
        pull_number: number,
        per_page: 100,
        request: { signal },
      }),
    )
  }

  async getCommit(repo: RepoFullName, sha: string): Promise<CommitDetail | null> {
    const { owner, name } = splitRepoFullName(repo)
    const result = await this.requestCached<CommitDetail>(
      'GET /repos/{owner}/{repo}/commits/{ref}',
      {
        owner,
        repo: name,
        ref: sha,
      },
    )
    if (result.notModified) {
      return null
    }
    return result.data
  }

  async ensureRepoAccessible(repo: RepoFullName): Promise<void> {
    const { owner, name } = splitRepoFullName(repo)
    await this.withRetry((signal) =>
      this.octokit.rest.repos.get({ owner, repo: name, request: { signal } }),
    )
  }

  async listContributors(repo: RepoFullName): Promise<GitHubUsername[]> {
    const { owner, name } = splitRepoFullName(repo)
    const contributors = await this.withRetry((signal) =>
      this.octokit.paginate(this.octokit.rest.repos.listContributors, {
        owner,
        repo: name,
        per_page: 100,
        request: { signal },
      }),
    )
    return contributors
      .map((contributor) => contributor.login)
      .filter((login): login is string => Boolean(login))
  }

  async getRepo(repo: RepoFullName): Promise<RepoDetail> {
    const { owner, name } = splitRepoFullName(repo)
    const response = await this.withRetry((signal) =>
      this.octokit.rest.repos.get({ owner, repo: name, request: { signal } }),
    )
    return response.data
  }

  private async withRetry<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options: { passthroughStatuses?: number[] } = {},
  ): Promise<T> {
    let lastError: unknown

    const attemptRequest = async (attempt: number): Promise<T> => {
      if (attempt >= this.maxRetries) {
        throw wrapError(lastError, 'GitHub API request failed')
      }
      try {
        return await withTimeout(fn, this.timeoutMs)
      } catch (error) {
        lastError = error
        const status = getStatus(error)
        if (status !== undefined && options.passthroughStatuses?.includes(status)) {
          throw error
        }
        const retryAfter = await this.getRetryDelay(error, attempt)
        if (retryAfter === null) {
          throw wrapError(lastError, 'GitHub API request failed')
        }
        await delay(retryAfter)
        return attemptRequest(attempt + 1)
      }
    }

    return attemptRequest(0)
  }

  private async graphqlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return this.withRetry((signal) =>
      this.octokit.graphql<T>(query, {
        ...variables,
        request: { signal },
      }),
    )
  }

  private async requestCached<T>(
    route: string,
    params: Record<string, unknown>,
  ): Promise<{ data: T; notModified: boolean }> {
    const cacheKey = buildRequestFingerprint(route, params)
    const cached = this.useEtags && this.cache ? this.cache.getHttpCache(cacheKey) : null
    const headers: Record<string, string> = {}
    if (cached?.etag) {
      headers['if-none-match'] = cached.etag
    }
    if (cached?.last_modified) {
      headers['if-modified-since'] = cached.last_modified
    }

    try {
      const response = await this.withRetry(
        (signal) => {
          const requestParams = {
            ...params,
            request: { signal },
          }
          const requestHeaders = Object.keys(headers).length > 0 ? { headers } : {}
          return this.octokit.request(route, { ...requestParams, ...requestHeaders })
        },
        { passthroughStatuses: [304] },
      )
      this.storeHttpCache(cacheKey, response.headers)
      return { data: response.data as T, notModified: false }
    } catch (error) {
      const status = getStatus(error)
      if (status === 304) {
        this.storeHttpCache(cacheKey, getResponseHeaders(error))
        return { data: undefined as T, notModified: true }
      }
      throw error
    }
  }

  private async paginateCached<T>(route: string, params: Record<string, unknown>): Promise<T[]> {
    const results: T[] = []
    let page = 1
    const perPage = 100
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- page-based pagination must be sequential.
      const response = await this.requestCached<T[]>(route, {
        ...params,
        per_page: perPage,
        page,
      })
      if (response.notModified) {
        break
      }
      const items = response.data ?? []
      if (items.length === 0) {
        break
      }
      results.push(...items)
      if (items.length < perPage) {
        break
      }
      page += 1
    }
    return results
  }

  private storeHttpCache(key: string, headers?: Record<string, string | number | undefined>): void {
    if (!this.useEtags || !this.cache) {
      return
    }
    const etag = headers?.etag !== undefined && headers?.etag !== null ? String(headers.etag) : null
    const lastModified =
      headers?.['last-modified'] !== undefined && headers?.['last-modified'] !== null
        ? String(headers['last-modified'])
        : null
    const existing = this.cache.getHttpCache(key)
    this.cache.upsertHttpCache(key, {
      etag: etag ?? existing?.etag ?? null,
      last_modified: lastModified ?? existing?.last_modified ?? null,
    })
  }

  private async getRetryDelay(error: unknown, attempt: number): Promise<number | null> {
    const status = getStatus(error)
    if (status === 403) {
      const reset = getHeader(error, 'x-ratelimit-reset')
      const remaining = getHeader(error, 'x-ratelimit-remaining')
      if (remaining === '0' && reset) {
        const resetMs = Number(reset) * 1000
        const wait = Math.max(resetMs - Date.now(), DEFAULT_BASE_DELAY_MS)
        return Math.min(wait, 60_000)
      }
    }

    if (status && status < 500 && status !== 429) {
      return null
    }

    const backoff = DEFAULT_BASE_DELAY_MS * Math.pow(2, attempt)
    return Math.min(backoff, 8_000)
  }
}

export class RequestTimeoutError extends Error {
  constructor(ms: number) {
    super(`GitHub API request timed out after ${ms}ms`)
    this.name = 'RequestTimeoutError'
  }
}

/**
 * Runs `factory` with a hard wall-clock deadline. The factory receives an AbortSignal so
 * it can cooperatively cancel, but the race against `timeout` is the real guarantee: a
 * socket that is connected yet silent (observed with Bun's fetch on stalled GitHub
 * responses) never honors the abort and would otherwise hang the entire sync forever.
 * Racing ensures we always settle within `ms` and let `withRetry` back off and move on.
 */
export async function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      reject(new RequestTimeoutError(ms))
    }, ms)
  })
  const work = factory(controller.signal)
  // If the timeout wins the race the abandoned work may settle (reject) later; swallow it
  // here so a late rejection from a stalled socket is never an unhandled rejection.
  work.catch(() => {})
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}

export function splitRepoFullName(repo: RepoFullName): { owner: string; name: string } {
  const [owner, name] = repo.split('/')
  if (!owner || !name) {
    throw new Error(`Invalid repo full name: ${repo}`)
  }
  return { owner, name }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error && 'status' in error) {
    const status = (error as { status?: number }).status
    return status
  }
  return undefined
}

function getHeader(error: unknown, name: string): string | undefined {
  if (typeof error === 'object' && error && 'response' in error) {
    const response = (
      error as {
        response?: { headers?: Record<string, string | number | undefined> }
      }
    ).response
    const value = response?.headers?.[name]
    return value !== undefined && value !== null ? String(value) : undefined
  }
  return undefined
}

function getResponseHeaders(
  source: unknown,
): Record<string, string | number | undefined> | undefined {
  if (typeof source === 'object' && source && 'response' in source) {
    const response = (
      source as {
        response?: { headers?: Record<string, string | number | undefined> }
      }
    ).response
    if (response?.headers) {
      return response.headers
    }
  }
  if (
    typeof source === 'object' &&
    source &&
    Object.prototype.hasOwnProperty.call(source, 'headers')
  ) {
    const headers = (source as { headers?: Record<string, string | number | undefined> }).headers
    return headers
  }
  return undefined
}

function buildRequestFingerprint(route: string, params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .filter(([key]) => key !== 'request')
    .toSorted(([a], [b]) => a.localeCompare(b))
  const normalized = entries.map(([key, value]) => `${key}=${stableStringify(value)}`).join('&')
  return `${route}?${normalized}`
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([_, val]) => val !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, val]) => `${key}:${stableStringify(val)}`).join(',')}}`
  }
  return String(value)
}

function wrapError(error: unknown, message: string): Error {
  if (error instanceof Error) {
    const wrapped = new Error(`${message}: ${error.message}`)
    // Preserve status for HTTP errors (e.g., Octokit RequestError)
    if ('status' in error && typeof (error as { status?: unknown }).status === 'number') {
      ;(wrapped as Error & { status: number }).status = (error as { status: number }).status
    }
    return wrapped
  }
  return new Error(message)
}
