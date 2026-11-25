import type { Cache } from './cache'
import type { Config } from './config'
import type {
  CommitDetail,
  GitHubClient,
  PullRequestDetail,
  PullRequestGraphqlActivity,
  PullRequestListItem,
  PullRequestReview,
} from './github'
import type {
  Commit,
  CommitPushedEvent,
  CoAuthor,
  CommentAddedEvent,
  CoverageKind,
  DroppedContributor,
  GitHubUsername,
  PRClosedEvent,
  PRMergedEvent,
  PROpenedEvent,
  PRReadyEvent,
  ProgressEvent,
  PullRequest,
  PullRequestMeta,
  RepoFullName,
  ReviewSubmittedEvent,
  Timestamp,
} from './types'
import { computeGaps, isCovered } from './types'
import { toCommitFromEvent } from './cache'
import { dedupeAndSortUsernamesCaseInsensitive, resolveCoAuthors } from './co-authors'
import { isDeployPr, isExcludedAuthor } from './filters'
import { PROMOTION_COMMITS_MAX, isPromotion, promotedPullRequestNumbers } from './rollout'

// Branch-sync merges should not attribute feature work to the person who merged base into the PR.
const MERGE_COMMIT_RE = /^Merge (pull request #\d+|branch '.+' into |remote-tracking branch )/
const VALID_LOGIN_RE = /^[a-zA-Z0-9-]+(\[bot\])?$/

export interface SyncOptions {
  repos: RepoFullName[]
  cache: Cache
  github: GitHubClient
  config: Config
  timeRange: { start: Timestamp; end: Timestamp }
  forceSync?: boolean
  onProgress?: (event: ProgressEvent) => void
}

export interface SyncResult {
  synced_at: Timestamp
  repos: RepoFullName[]
  events_inserted: number
  pull_requests_upserted: number
  commits_upserted: number
}

export async function syncRepos(options: SyncOptions): Promise<SyncResult> {
  const now = Date.now()
  const syncTtlMs = options.config.cache.sync_ttl_hours * 60 * 60 * 1000
  const concurrency = options.config.cache.concurrency
  const requiredKinds: CoverageKind[] = ['pull_requests', 'events', 'commits', 'commits_pr']

  // Filter repos that need syncing
  const reposToSync: RepoFullName[] = []
  const skippedRepos: RepoFullName[] = []

  for (const repo of options.repos) {
    if (options.forceSync) {
      reposToSync.push(repo)
      continue
    }

    const syncState = options.cache.getSyncState(repo)
    const withinTtl = syncState ? now - syncState.last_sync < syncTtlMs : false
    const coverageComplete = requiredKinds.every((kind) =>
      isCovered(
        options.cache.getCoverageRanges(repo, kind),
        options.timeRange.start,
        options.timeRange.end,
      ),
    )
    if (withinTtl && coverageComplete) {
      skippedRepos.push(repo)
    } else {
      reposToSync.push(repo)
    }
  }

  if (skippedRepos.length > 0) {
    options.onProgress?.({
      phase: 'sync',
      message: `Skipping ${skippedRepos.length} repos (synced within ${options.config.cache.sync_ttl_hours}h)`,
    })
  }

  if (reposToSync.length === 0) {
    options.onProgress?.({
      phase: 'sync',
      message: 'All repos up to date',
    })
    return {
      synced_at: now,
      repos: options.repos,
      events_inserted: 0,
      pull_requests_upserted: 0,
      commits_upserted: 0,
    }
  }

  let eventsInserted = 0
  let prsUpserted = 0
  let commitsUpserted = 0
  let completed = 0

  // Process repos in parallel with concurrency limit
  const processRepo = async (repo: RepoFullName): Promise<void> => {
    const repoResult = await syncRepo(repo, options, syncTtlMs)
    eventsInserted += repoResult.eventsInserted
    prsUpserted += repoResult.prsUpserted
    commitsUpserted += repoResult.commitsUpserted
    options.cache.upsertSyncState(repo, now, {
      cursor: null,
      last_pr_updated_at: repoResult.lastPrUpdatedAt,
    })
    completed += 1
    options.onProgress?.({
      phase: 'sync',
      message: `Synced ${repo} (${repoResult.prsUpserted} PRs, ${repoResult.commitsUpserted} commits)`,
      current: completed,
      total: reposToSync.length,
    })
  }

  // Run with concurrency limit
  await runWithConcurrency(reposToSync, processRepo, concurrency)

  return {
    synced_at: now,
    repos: options.repos,
    events_inserted: eventsInserted,
    pull_requests_upserted: prsUpserted,
    commits_upserted: commitsUpserted,
  }
}

async function runWithConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error(`Invalid concurrency: ${concurrency}`)
  }
  if (items.length === 0) {
    return
  }

  const queue = [...items]
  let firstError: unknown = null

  const runNext = async (): Promise<void> => {
    if (firstError) {
      return
    }
    const item = queue.shift()
    if (item === undefined) {
      return
    }
    try {
      await fn(item)
    } catch (error) {
      if (!firstError) {
        firstError = error
      }
      return
    }
    return runNext()
  }

  const workerCount = Math.min(concurrency, queue.length)
  const workers = Array.from({ length: workerCount }, () => runNext())
  await Promise.all(workers)

  if (firstError) {
    throw firstError
  }
}

function deriveInnerConcurrency(concurrency: number, upperBound = 4): number {
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    return 1
  }
  return Math.max(1, Math.min(Math.floor(concurrency), upperBound))
}

/**
 * Deploy automation and excluded/bot authors are filtered out of every contributor metric
 * by the reports (see the `isExcludedAuthor` calls throughout reports/*.ts). Fetching their
 * per-PR reviews, comments, and commit-by-commit attribution is therefore pure waste — and
 * on PR-heavy repos (a busy monorepo can produce hundreds of bot deploy PRs per week) that
 * waste dominates sync time and can stall the whole run on a single slow response. We still
 * emit the lightweight pr_opened/pr_merged events for these PRs (so deploy counts and
 * velocity, which filter by author downstream, stay exact); only the expensive per-PR
 * network round-trips are skipped.
 */
function skipsActivitySync(
  pr: PullRequest,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): boolean {
  return isExcludedAuthor(pr.author, exclude, excludeBots) || isDeployPr(pr)
}

async function syncRepo(
  repo: RepoFullName,
  options: SyncOptions,
  syncTtlMs: number,
): Promise<{
  eventsInserted: number
  prsUpserted: number
  commitsUpserted: number
  lastPrUpdatedAt: Timestamp | null
}> {
  const { cache } = options
  const now = Date.now()
  const syncState = cache.getSyncState(repo)
  const shouldRefresh = options.forceSync || !syncState || now - syncState.last_sync >= syncTtlMs
  const emailToUsername = cache.getEmailToUsernameMap()

  const prResult = await syncPullRequests(repo, options, shouldRefresh)
  const eventResult = await syncEvents(repo, options, shouldRefresh)
  const commitResult = await syncCommits(repo, options, emailToUsername)
  const prCommitResult = await syncPullRequestCommits(repo, options, emailToUsername)
  await syncPromotions(repo, options)

  return {
    eventsInserted:
      eventResult.eventsInserted + commitResult.eventsInserted + prCommitResult.eventsInserted,
    prsUpserted: prResult.prsUpserted,
    commitsUpserted: commitResult.commitsUpserted + prCommitResult.commitsUpserted,
    lastPrUpdatedAt: prResult.lastPrUpdatedAt,
  }
}

async function syncPullRequests(
  repo: RepoFullName,
  options: SyncOptions,
  refresh: boolean,
): Promise<{ prsUpserted: number; lastPrUpdatedAt: Timestamp | null }> {
  const { cache, github, config, timeRange } = options
  const now = Date.now()
  const syncState = cache.getSyncState(repo)
  const coverage = cache.getCoverageRanges(repo, 'pull_requests')
  const gaps = computeGaps(coverage, timeRange.start, timeRange.end)

  const refreshCutoff = refresh ? (syncState?.last_pr_updated_at ?? timeRange.start) : null
  const gapStart = gaps.length > 0 ? gaps[0]!.start : null
  const targetStart =
    gapStart !== null && refreshCutoff !== null
      ? Math.min(gapStart, refreshCutoff)
      : (gapStart ?? refreshCutoff)
  const detailConcurrency = deriveInnerConcurrency(config.cache.concurrency)

  let prsUpserted = 0
  let lastPrUpdatedAt = syncState?.last_pr_updated_at ?? null

  const upsertPullRequestFromListItem = async (prListItem: PullRequestListItem): Promise<void> => {
    const updatedAt = Date.parse(prListItem.updated_at)
    if (!Number.isFinite(updatedAt)) {
      return
    }
    if (lastPrUpdatedAt === null || updatedAt > lastPrUpdatedAt) {
      lastPrUpdatedAt = updatedAt
    }
    if (prListItem.state !== 'open' && updatedAt < timeRange.start) {
      return
    }

    const existing = cache.getPullRequest(repo, prListItem.number)
    if (existing && existing.data.updated_at === updatedAt) {
      if (cache.isFresh(existing.fetched_at, config.cache.ttl_hours) || !config.cache.use_etags) {
        // Entries cached before branches were recorded take them from the list item.
        cache.upsertPullRequest(
          { ...existing.data, base_ref: prListItem.base.ref, head_ref: prListItem.head.ref },
          now,
        )
        return
      }
      const prDetail = await github.getPullRequest(repo, prListItem.number)
      if (!prDetail) {
        cache.upsertPullRequest(existing.data, now)
        return
      }
      const pr = toPullRequest(repo, prDetail)
      cache.upsertPullRequest(pr, now)
      prsUpserted += 1
      return
    }

    const prDetail = await github.getPullRequest(repo, prListItem.number)
    if (!prDetail) {
      if (existing) {
        cache.upsertPullRequest(existing.data, now)
      }
      return
    }
    const pr = toPullRequest(repo, prDetail)
    cache.upsertPullRequest(pr, now)
    prsUpserted += 1
  }

  if (targetStart !== null) {
    let page = 1
    const perPage = 100
    let shouldContinue = true

    while (shouldContinue) {
      // eslint-disable-next-line no-await-in-loop -- page-based pagination must be sequential.
      const pageItems = await github.listPullRequestsPage(repo, { page, perPage, state: 'all' })
      if (pageItems.length === 0) {
        break
      }

      // eslint-disable-next-line no-await-in-loop -- preserves ordered cutoff handling via shouldContinue.
      await forEachSequential(pageItems, async (prListItem) => {
        if (!shouldContinue) {
          return
        }
        const updatedAt = Date.parse(prListItem.updated_at)
        if (!Number.isFinite(updatedAt)) {
          return
        }
        if (updatedAt < targetStart) {
          shouldContinue = false
          return
        }
        await upsertPullRequestFromListItem(prListItem)
      })

      if (!shouldContinue || pageItems.length < perPage) {
        break
      }
      page += 1
    }

    cache.addCoverageRange(repo, 'pull_requests', targetStart, now)

    // Ensure open PRs are up to date even if they predate the cutoff
    let openPage = 1
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- page-based pagination must be sequential.
      const openItems = await github.listPullRequestsPage(repo, {
        page: openPage,
        perPage,
        state: 'open',
      })
      if (openItems.length === 0) {
        break
      }
      // eslint-disable-next-line no-await-in-loop -- each page is processed before requesting next page.
      await runWithConcurrency(
        openItems,
        (prListItem) => upsertPullRequestFromListItem(prListItem),
        detailConcurrency,
      )
      if (openItems.length < perPage) {
        break
      }
      openPage += 1
    }
  }

  return { prsUpserted, lastPrUpdatedAt }
}

async function syncEvents(
  repo: RepoFullName,
  options: SyncOptions,
  refresh: boolean,
): Promise<{ eventsInserted: number }> {
  const { cache, github, config, timeRange } = options
  const now = Date.now()
  const syncState = cache.getSyncState(repo)
  const coverage = cache.getCoverageRanges(repo, 'events')
  const gaps = computeGaps(coverage, timeRange.start, timeRange.end)

  const refreshCutoff = refresh ? (syncState?.last_pr_updated_at ?? timeRange.start) : null
  const gapStart = gaps.length > 0 ? gaps[0]!.start : null
  const targetStart =
    gapStart !== null && refreshCutoff !== null
      ? Math.min(gapStart, refreshCutoff)
      : (gapStart ?? refreshCutoff)

  if (targetStart === null) {
    return { eventsInserted: 0 }
  }

  let eventsInserted = 0
  const prs = cache.getPullRequests({ repo }).filter((pr) => pr.updated_at >= targetStart)
  const prConcurrency = deriveInnerConcurrency(config.cache.concurrency)
  const excludeSet = new Set(config.exclude.authors)
  const excludeBots = config.exclude.bots

  await runWithConcurrency(
    prs,
    async (pr) => {
      if (skipsActivitySync(pr, excludeSet, excludeBots)) {
        // Record the cheap lifecycle events only; skip the per-PR reviews/comments fetch.
        eventsInserted += insertPrEvents(cache, pr)
        return
      }

      if (config.cache.use_graphql) {
        const prGraphql = await github.getPullRequestGraphqlActivity(repo, pr.number)
        const prFromGraphql = toPullRequestFromGraphql(repo, prGraphql.pr)
        const withContributors: PullRequest = {
          ...prFromGraphql,
          ...(pr.contributors ? { contributors: pr.contributors } : {}),
          ...(pr.meta ? { meta: pr.meta } : {}),
        }
        cache.upsertPullRequest(withContributors, now)
        eventsInserted += insertPrEvents(
          cache,
          withContributors,
          prGraphql.pr.mergedBy?.login ?? withContributors.author,
        )
        eventsInserted += insertGraphqlActivityEvents(cache, withContributors, prGraphql)
        return
      }

      eventsInserted += insertPrEvents(cache, pr)
      eventsInserted += await insertPrActivityEvents(cache, github, pr, config)
    },
    prConcurrency,
  )

  cache.addCoverageRange(repo, 'events', targetStart, now)

  return { eventsInserted }
}

async function syncCommits(
  repo: RepoFullName,
  options: SyncOptions,
  emailToUsername: Map<string, GitHubUsername>,
): Promise<{ commitsUpserted: number; eventsInserted: number }> {
  const { cache, github, timeRange, config } = options
  const now = Date.now()
  let commitsUpserted = 0
  let eventsInserted = 0
  const commitConcurrency = deriveInnerConcurrency(config.cache.concurrency)

  const commitGaps = computeGaps(
    cache.getCoverageRanges(repo, 'commits'),
    timeRange.start,
    timeRange.end,
  )

  for (const gap of commitGaps) {
    let commitsInsertedInGap = 0
    // eslint-disable-next-line no-await-in-loop -- each gap has distinct since/until bounds.
    const commitList = await github.listCommits(repo, {
      since: new Date(gap.start).toISOString(),
      until: new Date(gap.end).toISOString(),
    })

    // eslint-disable-next-line no-await-in-loop -- gap coverage updates happen after processing this gap.
    await runWithConcurrency(
      commitList,
      async (commitItem) => {
        const sha = commitItem.sha
        const existingCommit = cache.getCommit(repo, sha)

        if (existingCommit) {
          const enrichedCommit = withResolvedCoAuthors(existingCommit.data, emailToUsername)
          if (enrichedCommit !== existingCommit.data) {
            cache.upsertCommit(enrichedCommit, now)
          }
          const commitEvent = toCommitEventFromCommit(repo, enrichedCommit)
          const inserted = cache.insertEvent(commitEvent, now)
          if (inserted) {
            eventsInserted += 1
          }
          return
        }

        const commitDetail = await github.getCommit(repo, sha)
        if (!commitDetail) {
          throw new Error(`Commit ${repo}@${sha} not modified but missing cache entry`)
        }

        registerCommitAuthorEmail(cache, emailToUsername, commitDetail)
        const commitEvent = toCommitEvent(repo, commitDetail, emailToUsername)
        const inserted = cache.insertEvent(commitEvent, now)
        if (inserted) {
          eventsInserted += 1
        }

        cache.upsertCommit(toCommitFromEvent(commitEvent), now)
        commitsUpserted += 1
        commitsInsertedInGap += 1
      },
      commitConcurrency,
    )

    cache.addCoverageRange(repo, 'commits', gap.start, gap.end, now)
    if (commitsInsertedInGap > 0) {
      cache.invalidateCoverageRange(repo, 'rollup_commits', gap.start, gap.end)
      cache.invalidateCoverageRange(repo, 'rollup_activity', gap.start, gap.end)
    }
  }

  return { commitsUpserted, eventsInserted }
}

/**
 * Record which pull requests each merged promotion carried into production, and make sure each
 * carried pull request is cached so its rollout can be read even when it merged before the window.
 * A promotion's contents never change after merge, so it is listed once.
 */
async function syncPromotions(repo: RepoFullName, options: SyncOptions): Promise<void> {
  const { cache, github, config, timeRange } = options
  const now = Date.now()
  const roles = {
    production: config.rollout.production_branches,
    integration: config.rollout.integration_branches,
  }
  const mergedInWindow = (pr: PullRequest): boolean =>
    pr.merged_at !== null && pr.merged_at >= timeRange.start && pr.merged_at <= timeRange.end

  // Entries cached before branches were recorded are refetched once (conditional requests), so
  // promotions and production merges in the window can be recognized.
  const unrecorded = cache
    .getPullRequests({ repo })
    .filter((pr) => pr.base_ref === undefined && mergedInWindow(pr))
  await forEachSequential(unrecorded, async (cached) => {
    const detail = await github.getPullRequest(repo, cached.number)
    if (detail !== null) {
      cache.upsertPullRequest(
        { ...cached, base_ref: detail.base.ref, head_ref: detail.head.ref },
        now,
      )
    }
  })

  const pending = cache
    .getPullRequests({ repo })
    .filter((pr) => pr.promotion === undefined && mergedInWindow(pr) && isPromotion(pr, roles))

  await forEachSequential(pending, async (promotionPr) => {
    const commits = await github.listPullRequestCommits(repo, promotionPr.number)
    const included = promotedPullRequestNumbers(commits.map((item) => item.commit.message))
    const promotion = {
      included,
      complete: commits.length < PROMOTION_COMMITS_MAX && commits.length >= promotionPr.commits,
    }
    cache.upsertPullRequest({ ...promotionPr, promotion }, now)

    const missing = included.filter((number) => cache.getPullRequest(repo, number) === null)
    await forEachSequential(missing, async (number) => {
      const detail = await github.getPullRequest(repo, number)
      if (detail !== null) {
        cache.upsertPullRequest(toPullRequest(repo, detail), now)
      }
    })
  })
}

async function syncPullRequestCommits(
  repo: RepoFullName,
  options: SyncOptions,
  emailToUsername: Map<string, GitHubUsername>,
): Promise<{ commitsUpserted: number; eventsInserted: number }> {
  const { cache, github, timeRange, config } = options
  const now = Date.now()
  let commitsUpserted = 0
  let eventsInserted = 0
  const prConcurrency = deriveInnerConcurrency(config.cache.concurrency)

  const gaps = computeGaps(
    cache.getCoverageRanges(repo, 'commits_pr'),
    timeRange.start,
    timeRange.end,
  )
  // Even when `commits_pr` is fully covered (no gaps to fetch), we still walk the PRs
  // in the time range so the contributor-resolution loop below applies the current
  // merge-commit filter (MERGE_COMMIT_RE, gh-pulse#7) to previously-cached
  // `contributors[]` arrays. Commits hit the cache inside `syncPrCommitBySha`, so
  // `listPullRequestCommits` is the only fresh network call per PR on the warm path.
  const targetStart = gaps.length > 0 ? gaps[0]!.start : timeRange.start
  const prs = cache.getPullRequests({ repo }).filter((pr) => pr.updated_at >= targetStart)
  const inFlightBySha = new Map<string, Promise<Commit>>()
  const userValidityCache = new Map<string, Promise<boolean>>()
  const excludeSet = new Set(config.exclude.authors)
  const excludeBots = config.exclude.bots
  const aiIdentitiesLowered = new Set(
    (config.exclude.ai_identities ?? []).map((identity) => identity.toLowerCase()),
  )

  const syncPrCommitBySha = async (sha: string): Promise<Commit> => {
    const existingCommit = cache.getCommit(repo, sha)
    if (existingCommit) {
      const enrichedCommit = withResolvedCoAuthors(existingCommit.data, emailToUsername)
      if (enrichedCommit !== existingCommit.data) {
        cache.upsertCommit(enrichedCommit, now)
      }
      const commitEvent = toCommitEventFromCommit(repo, enrichedCommit)
      const inserted = cache.insertEvent(commitEvent, now)
      if (inserted) {
        eventsInserted += 1
      }
      return enrichedCommit
    }

    const existingInFlight = inFlightBySha.get(sha)
    if (existingInFlight) {
      return existingInFlight
    }

    const syncTask = (async (): Promise<Commit> => {
      const commitDetail = await github.getCommit(repo, sha)
      if (!commitDetail) {
        throw new Error(`Commit ${repo}@${sha} not modified but missing cache entry`)
      }

      registerCommitAuthorEmail(cache, emailToUsername, commitDetail)
      const commitEvent = toCommitEvent(repo, commitDetail, emailToUsername)
      const inserted = cache.insertEvent(commitEvent, now)
      if (inserted) {
        eventsInserted += 1
      }

      const commit = toCommitFromEvent(commitEvent)
      cache.upsertCommit(commit, now)
      commitsUpserted += 1
      return commit
    })().finally(() => {
      inFlightBySha.delete(sha)
    })

    inFlightBySha.set(sha, syncTask)
    return syncTask
  }

  await runWithConcurrency(
    prs,
    async (pr) => {
      // Deploy/bot PRs are excluded from contributor metrics downstream, so skip the
      // per-PR commit fetch and contributor classification entirely (the costly path).
      if (skipsActivitySync(pr, excludeSet, excludeBots)) {
        return
      }

      const commitList = await github.listPullRequestCommits(repo, pr.number)
      const contributors = new Set<GitHubUsername>([pr.author])
      const dropped: DroppedContributor[] = []

      const classifyContributor = async (
        login: GitHubUsername,
        evidence: DroppedContributor['evidence'] = undefined,
      ): Promise<void> => {
        const result = await classifyPullRequestContributor({
          repo,
          prNumber: pr.number,
          login,
          evidence,
          aiIdentitiesLowered,
          userValidityCache,
          github,
        })
        if (result === 'keep') {
          contributors.add(login)
          return
        }
        contributors.delete(login)
        dropped.push(result)
      }

      await classifyContributor(pr.author)

      await forEachSequential(commitList, async (commitItem) => {
        const commit = await syncPrCommitBySha(commitItem.sha)
        if (MERGE_COMMIT_RE.test(commit.message)) {
          return
        }
        await classifyContributor(commit.author, {
          commit_sha: commit.sha,
          ...(commit.author_email ? { author_email: commit.author_email } : {}),
        })
        await forEachSequential(commit.co_authors ?? [], async (coAuthor) => {
          await classifyContributor(coAuthor.username, {
            commit_sha: commit.sha,
            author_email: coAuthor.email,
          })
        })
      })

      const resolvedContributors = dedupeAndSortUsernamesCaseInsensitive(Array.from(contributors))
      const droppedContributors = sortDroppedContributors(dropped)
      const meta: PullRequestMeta | undefined =
        droppedContributors.length > 0 ? { dropped_contributors: droppedContributors } : undefined
      if (
        !sameUsernames(pr.contributors, resolvedContributors) ||
        !sameDroppedContributors(pr.meta?.dropped_contributors, meta?.dropped_contributors)
      ) {
        const { meta: _meta, ...prWithoutMeta } = pr
        cache.upsertPullRequest(
          { ...prWithoutMeta, contributors: resolvedContributors, ...(meta ? { meta } : {}) },
          now,
        )
      }
    },
    prConcurrency,
  )

  for (const gap of gaps) {
    cache.addCoverageRange(repo, 'commits_pr', gap.start, gap.end, now)
  }
  if (commitsUpserted > 0) {
    for (const gap of gaps) {
      cache.invalidateCoverageRange(repo, 'rollup_commits', gap.start, gap.end)
      cache.invalidateCoverageRange(repo, 'rollup_activity', gap.start, gap.end)
    }
  }

  return { commitsUpserted, eventsInserted }
}

type ContributorClassification = 'keep' | DroppedContributor

async function classifyPullRequestContributor(options: {
  repo: RepoFullName
  prNumber: number
  login: GitHubUsername
  evidence?: DroppedContributor['evidence']
  aiIdentitiesLowered: ReadonlySet<string>
  userValidityCache: Map<string, Promise<boolean>>
  github: GitHubClient
}): Promise<ContributorClassification> {
  const login = options.login.trim()
  const baseDrop = {
    login: options.login,
    pr_number: options.prNumber,
    repo: options.repo,
    ...(options.evidence ? { evidence: options.evidence } : {}),
  }

  if (!VALID_LOGIN_RE.test(login)) {
    return { ...baseDrop, reason: 'name-with-spaces' }
  }

  const normalizedLogin = login.toLowerCase()
  if (options.aiIdentitiesLowered.has(normalizedLogin)) {
    return { ...baseDrop, reason: 'ai-tool-identity' }
  }

  const exists = await getCachedUserExists(
    normalizedLogin,
    login,
    options.userValidityCache,
    options.github,
  )
  if (!exists) {
    return { ...baseDrop, reason: 'phantom-user' }
  }

  return 'keep'
}

function getCachedUserExists(
  cacheKey: string,
  login: GitHubUsername,
  userValidityCache: Map<string, Promise<boolean>>,
  github: GitHubClient,
): Promise<boolean> {
  const cached = userValidityCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const lookup = github.userExists(login)
  userValidityCache.set(cacheKey, lookup)
  return lookup
}

function sortDroppedContributors(dropped: DroppedContributor[]): DroppedContributor[] {
  return dropped.toSorted((a, b) => {
    const loginComparison = a.login.toLowerCase().localeCompare(b.login.toLowerCase())
    if (loginComparison !== 0) {
      return loginComparison
    }

    const reasonComparison = a.reason.localeCompare(b.reason)
    if (reasonComparison !== 0) {
      return reasonComparison
    }

    const shaComparison = (a.evidence?.commit_sha ?? '').localeCompare(b.evidence?.commit_sha ?? '')
    if (shaComparison !== 0) {
      return shaComparison
    }

    return (a.evidence?.author_email ?? '').localeCompare(b.evidence?.author_email ?? '')
  })
}

function insertPrEvents(cache: Cache, pr: PullRequest, mergedBy?: GitHubUsername): number {
  let count = 0
  const openedEvent: PROpenedEvent = {
    type: 'pr_opened',
    repo: pr.repo,
    pr_number: pr.number,
    author: pr.author,
    opened_at: pr.created_at,
    is_draft: pr.draft,
  }
  if (cache.insertEvent(openedEvent)) {
    count += 1
  }

  if (pr.merged_at) {
    const mergedEvent: PRMergedEvent = {
      type: 'pr_merged',
      repo: pr.repo,
      pr_number: pr.number,
      merged_at: pr.merged_at,
      merged_by: mergedBy ?? pr.author,
    }
    if (cache.insertEvent(mergedEvent)) {
      count += 1
    }
  } else if (pr.closed_at) {
    const closedEvent: PRClosedEvent = {
      type: 'pr_closed',
      repo: pr.repo,
      pr_number: pr.number,
      closed_at: pr.closed_at,
    }
    if (cache.insertEvent(closedEvent)) {
      count += 1
    }
  }

  return count
}

async function insertIssueEvents(
  cache: Cache,
  github: GitHubClient,
  pr: PullRequest,
): Promise<number> {
  let count = 0
  const events = await github.listIssueEvents(pr.repo, pr.number)
  for (const event of events) {
    if (event.event === 'ready_for_review') {
      const readyEvent: PRReadyEvent = {
        type: 'pr_ready',
        repo: pr.repo,
        pr_number: pr.number,
        ready_at: Date.parse(event.created_at),
      }
      if (cache.insertEvent(readyEvent)) {
        count += 1
      }
    }

    if (event.event === 'reopened') {
      const reopenedEvent: PROpenedEvent = {
        type: 'pr_opened',
        repo: pr.repo,
        pr_number: pr.number,
        author: pr.author,
        opened_at: Date.parse(event.created_at),
        is_draft: false,
      }
      if (cache.insertEvent(reopenedEvent)) {
        count += 1
      }
    }

    if (event.event === 'closed' && pr.merged_at === null) {
      const closedEvent: PRClosedEvent = {
        type: 'pr_closed',
        repo: pr.repo,
        pr_number: pr.number,
        closed_at: Date.parse(event.created_at),
      }
      if (cache.insertEvent(closedEvent)) {
        count += 1
      }
    }
  }
  return count
}

async function insertTimelineActivityEvents(
  cache: Cache,
  github: GitHubClient,
  pr: PullRequest,
): Promise<number> {
  let count = 0
  const events = await github.listIssueTimeline(pr.repo, pr.number)
  for (const event of events) {
    if (!('event' in event)) {
      continue
    }
    if (event.event === 'ready_for_review') {
      const createdAt = 'created_at' in event ? getStringField(event.created_at) : null
      if (createdAt) {
        const readyEvent: PRReadyEvent = {
          type: 'pr_ready',
          repo: pr.repo,
          pr_number: pr.number,
          ready_at: Date.parse(createdAt),
        }
        if (cache.insertEvent(readyEvent)) {
          count += 1
        }
      }
    }

    if (event.event === 'reviewed') {
      const reviewer =
        ('user' in event ? getLogin(event.user) : null) ??
        ('actor' in event ? getLogin(event.actor) : null)
      const submittedAt =
        ('submitted_at' in event ? getStringField(event.submitted_at) : null) ??
        ('created_at' in event ? getStringField(event.created_at) : null)
      if (reviewer && submittedAt) {
        const reviewEvent: ReviewSubmittedEvent = {
          type: 'review_submitted',
          repo: pr.repo,
          pr_number: pr.number,
          reviewer,
          state:
            'state' in event && typeof event.state === 'string'
              ? normalizeReviewState(event.state as PullRequestReview['state'])
              : 'commented',
          submitted_at: Date.parse(submittedAt),
        }
        if (cache.insertEvent(reviewEvent)) {
          count += 1
        }
      }
    }

    if (event.event === 'commented') {
      const author =
        ('user' in event ? getLogin(event.user) : null) ??
        ('actor' in event ? getLogin(event.actor) : null)
      const commentedAt = 'created_at' in event ? getStringField(event.created_at) : null
      if (author && commentedAt) {
        const commentEvent: CommentAddedEvent = {
          type: 'comment_added',
          repo: pr.repo,
          pr_number: pr.number,
          author,
          commented_at: Date.parse(commentedAt),
        }
        if (cache.insertEvent(commentEvent)) {
          count += 1
        }
      }
    }

    if (event.event === 'reopened') {
      const createdAt = 'created_at' in event ? getStringField(event.created_at) : null
      if (createdAt) {
        const reopenedEvent: PROpenedEvent = {
          type: 'pr_opened',
          repo: pr.repo,
          pr_number: pr.number,
          author: pr.author,
          opened_at: Date.parse(createdAt),
          is_draft: false,
        }
        if (cache.insertEvent(reopenedEvent)) {
          count += 1
        }
      }
    }

    if (event.event === 'closed' && pr.merged_at === null) {
      const createdAt = 'created_at' in event ? getStringField(event.created_at) : null
      if (createdAt) {
        const closedEvent: PRClosedEvent = {
          type: 'pr_closed',
          repo: pr.repo,
          pr_number: pr.number,
          closed_at: Date.parse(createdAt),
        }
        if (cache.insertEvent(closedEvent)) {
          count += 1
        }
      }
    }
  }
  return count
}

function insertGraphqlActivityEvents(
  cache: Cache,
  pr: PullRequest,
  activity: PullRequestGraphqlActivity,
): number {
  let count = 0

  for (const event of activity.timeline) {
    switch (event.__typename) {
      case 'ReadyForReviewEvent': {
        const readyEvent: PRReadyEvent = {
          type: 'pr_ready',
          repo: pr.repo,
          pr_number: pr.number,
          ready_at: Date.parse(event.createdAt),
        }
        if (cache.insertEvent(readyEvent)) {
          count += 1
        }
        break
      }
      case 'ReopenedEvent': {
        const reopenedEvent: PROpenedEvent = {
          type: 'pr_opened',
          repo: pr.repo,
          pr_number: pr.number,
          author: pr.author,
          opened_at: Date.parse(event.createdAt),
          is_draft: false,
        }
        if (cache.insertEvent(reopenedEvent)) {
          count += 1
        }
        break
      }
      case 'ClosedEvent': {
        if (pr.merged_at === null) {
          const closedEvent: PRClosedEvent = {
            type: 'pr_closed',
            repo: pr.repo,
            pr_number: pr.number,
            closed_at: Date.parse(event.createdAt),
          }
          if (cache.insertEvent(closedEvent)) {
            count += 1
          }
        }
        break
      }
      default: {
        const _exhaustive: never = event
        throw new Error(`Unhandled timeline event: ${_exhaustive}`)
      }
    }
  }

  for (const review of activity.reviews) {
    const reviewer = review.author?.login
    if (!reviewer || !review.submittedAt) {
      continue
    }
    const reviewEvent: ReviewSubmittedEvent = {
      type: 'review_submitted',
      repo: pr.repo,
      pr_number: pr.number,
      reviewer,
      state: normalizeGraphqlReviewState(review.state),
      submitted_at: Date.parse(review.submittedAt),
    }
    if (cache.insertEvent(reviewEvent)) {
      count += 1
    }
  }

  for (const comment of activity.comments) {
    const author = comment.author?.login
    if (!author) {
      continue
    }
    const commentEvent: CommentAddedEvent = {
      type: 'comment_added',
      repo: pr.repo,
      pr_number: pr.number,
      author,
      commented_at: Date.parse(comment.createdAt),
    }
    if (cache.insertEvent(commentEvent)) {
      count += 1
    }
  }

  return count
}

async function insertPrActivityEvents(
  cache: Cache,
  github: GitHubClient,
  pr: PullRequest,
  config: Config,
): Promise<number> {
  if (config.cache.use_graphql) {
    throw new Error('GraphQL activity sync should be handled before insertPrActivityEvents')
  }
  if (config.cache.use_timeline) {
    return insertTimelineActivityEvents(cache, github, pr)
  }
  let count = 0
  count += await insertIssueEvents(cache, github, pr)
  count += await insertReviewEvents(cache, github, pr)
  count += await insertCommentEvents(cache, github, pr)
  return count
}

async function insertReviewEvents(
  cache: Cache,
  github: GitHubClient,
  pr: PullRequest,
): Promise<number> {
  let count = 0
  const reviews = await github.listPullRequestReviews(pr.repo, pr.number)
  for (const review of reviews) {
    const reviewer = review.user?.login
    if (!reviewer || !review.submitted_at) {
      continue
    }
    const reviewEvent: ReviewSubmittedEvent = {
      type: 'review_submitted',
      repo: pr.repo,
      pr_number: pr.number,
      reviewer,
      state: normalizeReviewState(review.state),
      submitted_at: Date.parse(review.submitted_at),
    }
    if (cache.insertEvent(reviewEvent)) {
      count += 1
    }
  }
  return count
}

async function insertCommentEvents(
  cache: Cache,
  github: GitHubClient,
  pr: PullRequest,
): Promise<number> {
  let count = 0
  const comments = await github.listIssueComments(pr.repo, pr.number)
  for (const comment of comments) {
    const author = comment.user?.login
    if (!author) {
      continue
    }
    const commentEvent: CommentAddedEvent = {
      type: 'comment_added',
      repo: pr.repo,
      pr_number: pr.number,
      author,
      commented_at: Date.parse(comment.created_at),
    }
    if (cache.insertEvent(commentEvent)) {
      count += 1
    }
  }
  return count
}

function toPullRequest(repo: RepoFullName, pr: PullRequestDetail): PullRequest {
  return {
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    state: pr.merged_at ? 'merged' : pr.state,
    draft: pr.draft ?? false,
    author: pr.user?.login ?? 'unknown',
    created_at: Date.parse(pr.created_at),
    updated_at: Date.parse(pr.updated_at),
    merged_at: pr.merged_at ? Date.parse(pr.merged_at) : null,
    closed_at: pr.closed_at ? Date.parse(pr.closed_at) : null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    commits: pr.commits ?? 0,
    base_ref: pr.base.ref,
    head_ref: pr.head.ref,
    requested_reviewers: (pr.requested_reviewers ?? []).map(
      (reviewer) => reviewer.login ?? 'unknown',
    ),
    labels: (pr.labels ?? []).map((label) =>
      typeof label === 'string' ? label : (label.name ?? 'unknown'),
    ),
    linked_issues: [],
  }
}

function toPullRequestFromGraphql(
  repo: RepoFullName,
  pr: PullRequestGraphqlActivity['pr'],
): PullRequest {
  const requestedReviewers = (pr.reviewRequests?.nodes ?? [])
    .map((request) => {
      const reviewer = request.requestedReviewer
      if (!reviewer) {
        return null
      }
      if (typeof reviewer.login === 'string' && reviewer.login.length > 0) {
        return reviewer.login
      }
      if (typeof reviewer.name === 'string' && reviewer.name.length > 0) {
        return reviewer.name
      }
      return null
    })
    .filter((reviewer): reviewer is string => Boolean(reviewer))

  const labels = (pr.labels?.nodes ?? [])
    .map((label) => label.name ?? null)
    .filter((label): label is string => Boolean(label))

  const state = pr.mergedAt
    ? 'merged'
    : pr.state === 'OPEN'
      ? 'open'
      : pr.state === 'CLOSED'
        ? 'closed'
        : 'merged'

  return {
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    state,
    draft: pr.isDraft,
    author: pr.author?.login ?? 'unknown',
    created_at: Date.parse(pr.createdAt),
    updated_at: Date.parse(pr.updatedAt),
    merged_at: pr.mergedAt ? Date.parse(pr.mergedAt) : null,
    closed_at: pr.closedAt ? Date.parse(pr.closedAt) : null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    commits: pr.commits?.totalCount ?? 0,
    base_ref: pr.baseRefName,
    head_ref: pr.headRefName,
    requested_reviewers: requestedReviewers,
    labels,
    linked_issues: [],
  }
}

function toCommitEvent(
  repo: RepoFullName,
  commit: CommitDetail,
  emailToUsername: ReadonlyMap<string, GitHubUsername>,
): CommitPushedEvent {
  const author = commit.author?.login ?? commit.commit.author?.name ?? 'unknown'
  const authorEmail = commit.commit.author?.email?.trim()
  const message = commit.commit.message ?? ''
  const stats = commit.stats ?? { additions: 0, deletions: 0, total: 0 }
  const filesChanged = commit.files ? commit.files.length : 0
  const committedAt = commit.commit.author?.date
    ? Date.parse(commit.commit.author.date)
    : Date.now()

  const resolvedCoAuthors = resolveCoAuthors(message, author, emailToUsername)

  return {
    type: 'commit_pushed',
    repo,
    sha: commit.sha,
    author,
    ...(authorEmail ? { author_email: authorEmail } : {}),
    committed_at: committedAt,
    message,
    additions: stats.additions ?? 0,
    deletions: stats.deletions ?? 0,
    files_changed: filesChanged,
    ...(resolvedCoAuthors.length > 0 ? { co_authors: resolvedCoAuthors } : {}),
  }
}

function toCommitEventFromCommit(repo: RepoFullName, commit: Commit): CommitPushedEvent {
  return {
    type: 'commit_pushed',
    repo,
    sha: commit.sha,
    author: commit.author,
    ...(commit.author_email ? { author_email: commit.author_email } : {}),
    committed_at: commit.committed_at,
    message: commit.message,
    additions: commit.additions,
    deletions: commit.deletions,
    files_changed: commit.files_changed,
    ...(commit.co_authors ? { co_authors: commit.co_authors } : {}),
  }
}

function normalizeReviewState(state: PullRequestReview['state']): ReviewSubmittedEvent['state'] {
  switch (state) {
    case 'approved':
      return 'approved'
    case 'changes_requested':
      return 'changes_requested'
    case 'commented':
      return 'commented'
    case 'dismissed':
      return 'dismissed'
    case 'pending':
      return 'pending'
    default:
      return 'commented'
  }
}

function normalizeGraphqlReviewState(state: string | null): ReviewSubmittedEvent['state'] {
  switch (state) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'COMMENTED':
      return 'commented'
    case 'DISMISSED':
      return 'dismissed'
    case 'PENDING':
      return 'pending'
    default:
      return 'commented'
  }
}

function getLogin(value: unknown): GitHubUsername | null {
  if (value && typeof value === 'object' && 'login' in value) {
    const login = (value as { login?: unknown }).login
    if (typeof login === 'string' && login.length > 0) {
      return login
    }
  }
  return null
}

function getStringField(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  return null
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

function registerCommitAuthorEmail(
  cache: Cache,
  emailToUsername: Map<string, GitHubUsername>,
  commit: CommitDetail,
): void {
  const username = commit.author?.login?.trim()
  const email = commit.commit.author?.email?.trim().toLowerCase()
  if (!username || !email) {
    return
  }

  cache.upsertEmailUsername(email, username)
  emailToUsername.set(email, username)
}

function withResolvedCoAuthors(
  commit: Commit,
  emailToUsername: Map<string, GitHubUsername>,
): Commit {
  const resolved = resolveCoAuthors(commit.message, commit.author, emailToUsername)
  if (resolved.length === 0 || sameCoAuthors(commit.co_authors, resolved)) {
    return commit
  }
  return { ...commit, co_authors: resolved }
}

function sameCoAuthors(left?: CoAuthor[], right?: CoAuthor[]): boolean {
  const leftItems = left ?? []
  const rightItems = right ?? []

  if (leftItems.length !== rightItems.length) {
    return false
  }

  return leftItems.every((coAuthor, index) => {
    const other = rightItems[index]
    return (
      other !== undefined && coAuthor.username === other.username && coAuthor.email === other.email
    )
  })
}

function sameUsernames(left: GitHubUsername[] | undefined, right: GitHubUsername[]): boolean {
  if (!left) {
    return right.length === 0
  }
  if (left.length !== right.length) {
    return false
  }
  return left.every((username, index) => username === right[index])
}

function sameDroppedContributors(
  left: DroppedContributor[] | undefined,
  right: DroppedContributor[] | undefined,
): boolean {
  const leftItems = sortDroppedContributors(left ?? [])
  const rightItems = sortDroppedContributors(right ?? [])

  if (leftItems.length !== rightItems.length) {
    return false
  }

  return leftItems.every((item, index) => {
    const other = rightItems[index]
    return (
      other !== undefined &&
      item.pr_number === other.pr_number &&
      item.repo === other.repo &&
      item.login === other.login &&
      item.reason === other.reason &&
      (item.evidence?.commit_sha ?? null) === (other.evidence?.commit_sha ?? null) &&
      (item.evidence?.author_email ?? null) === (other.evidence?.author_email ?? null)
    )
  })
}
