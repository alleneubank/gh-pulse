import { Database } from 'bun:sqlite'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  Commit,
  CommitPushedEvent,
  CoverageKind,
  CoverageRange,
  DailyActivityRollup,
  DailyCommitRollup,
  DailyPrRollup,
  DailyReviewRollup,
  Event,
  GitHubUsername,
  PullRequest,
  RepoFullName,
  Timestamp,
} from './types'
import { computeGaps, mergeRanges } from './types'
import {
  endOfDayFromTimestamp,
  formatLocalDay,
  getLocalDayStart,
  startOfDayFromTimestamp,
} from './time'
import { dedupeAndSortUsernamesCaseInsensitive } from './co-authors'

export interface CacheFreshness {
  dataAsOf: Timestamp | null
  cacheAgeMinutes: number | null
  reposSynced: number
  totalRepos: number
}

export interface CacheOptions {
  path: string
  now?: () => number
}

export interface SyncState {
  repo: RepoFullName
  last_sync: Timestamp
  cursor: string | null
  last_pr_updated_at: Timestamp | null
}

export class Cache {
  private readonly db: Database
  private readonly now: () => number

  private constructor(db: Database, now: () => number) {
    this.db = db
    this.now = now
  }

  static async open(options: CacheOptions): Promise<Cache> {
    await ensureDir(options.path)
    const db = new Database(options.path)
    const cache = new Cache(db, options.now ?? (() => Date.now()))
    cache.init()
    return cache
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS http_cache (
        key TEXT PRIMARY KEY,
        etag TEXT,
        last_modified TEXT,
        fetched_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        repo TEXT NOT NULL,
        payload JSON NOT NULL,
        timestamp INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_repo ON events(repo);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

      CREATE TABLE IF NOT EXISTS pull_requests (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        data JSON NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (repo, number)
      );

      CREATE INDEX IF NOT EXISTS idx_pr_author ON pull_requests((json_extract(data, '$.author')));
      CREATE INDEX IF NOT EXISTS idx_pr_state ON pull_requests((json_extract(data, '$.state')));

      CREATE TABLE IF NOT EXISTS commits (
        repo TEXT NOT NULL,
        sha TEXT NOT NULL,
        data JSON NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (repo, sha)
      );

      CREATE INDEX IF NOT EXISTS idx_commits_author ON commits((json_extract(data, '$.author')));
      CREATE INDEX IF NOT EXISTS idx_commits_timestamp ON commits((json_extract(data, '$.committed_at')));

      CREATE TABLE IF NOT EXISTS email_usernames (
        email TEXT PRIMARY KEY,
        username TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_email_usernames_username ON email_usernames(username);

      CREATE TABLE IF NOT EXISTS coverage (
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (repo, kind, start, end)
      );

      CREATE INDEX IF NOT EXISTS idx_coverage_repo_kind ON coverage(repo, kind);

      CREATE TABLE IF NOT EXISTS daily_commits (
        repo TEXT NOT NULL,
        author TEXT NOT NULL,
        day_start INTEGER NOT NULL,
        day TEXT NOT NULL,
        commits INTEGER NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        files_changed INTEGER NOT NULL,
        PRIMARY KEY (repo, author, day_start)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_commits_day ON daily_commits(day_start);
      CREATE INDEX IF NOT EXISTS idx_daily_commits_repo ON daily_commits(repo);

      CREATE TABLE IF NOT EXISTS daily_prs (
        repo TEXT NOT NULL,
        author TEXT NOT NULL,
        day_start INTEGER NOT NULL,
        day TEXT NOT NULL,
        opened INTEGER NOT NULL,
        merged INTEGER NOT NULL,
        closed INTEGER NOT NULL,
        PRIMARY KEY (repo, author, day_start)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_prs_day ON daily_prs(day_start);
      CREATE INDEX IF NOT EXISTS idx_daily_prs_repo ON daily_prs(repo);

      CREATE TABLE IF NOT EXISTS daily_reviews (
        repo TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        day_start INTEGER NOT NULL,
        day TEXT NOT NULL,
        reviews INTEGER NOT NULL,
        approved INTEGER NOT NULL,
        changes_requested INTEGER NOT NULL,
        commented INTEGER NOT NULL,
        dismissed INTEGER NOT NULL,
        pending INTEGER NOT NULL,
        PRIMARY KEY (repo, reviewer, day_start)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_reviews_day ON daily_reviews(day_start);
      CREATE INDEX IF NOT EXISTS idx_daily_reviews_repo ON daily_reviews(repo);

      CREATE TABLE IF NOT EXISTS daily_activity (
        repo TEXT NOT NULL,
        day_start INTEGER NOT NULL,
        day TEXT NOT NULL,
        commits INTEGER NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        files_changed INTEGER NOT NULL,
        prs_opened INTEGER NOT NULL,
        prs_merged INTEGER NOT NULL,
        prs_closed INTEGER NOT NULL,
        reviews INTEGER NOT NULL,
        PRIMARY KEY (repo, day_start)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_activity_day ON daily_activity(day_start);
      CREATE INDEX IF NOT EXISTS idx_daily_activity_repo ON daily_activity(repo);

      CREATE TABLE IF NOT EXISTS linear_issues (
        id TEXT PRIMARY KEY,
        data JSON NOT NULL,
        fetched_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_linear_state ON linear_issues((json_extract(data, '$.state')));

      CREATE TABLE IF NOT EXISTS pr_issue_links (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        issue_id TEXT NOT NULL,
        correlation_method TEXT NOT NULL,
        PRIMARY KEY (repo, pr_number, issue_id)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        repo TEXT PRIMARY KEY,
        last_sync INTEGER NOT NULL,
        cursor TEXT,
        last_pr_updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS repo_lists (
        owner TEXT PRIMARY KEY,
        repos JSON NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `)

    this.ensureColumn('sync_state', 'last_pr_updated_at', 'INTEGER')
    this.runAttributionMigration()
  }

  close(): void {
    this.db.close()
  }

  insertEvent(event: Event, fetchedAt: Timestamp = this.now()): boolean {
    const timestamp = getEventTimestamp(event)
    if (this.eventExists(event, timestamp)) {
      return false
    }

    this.db.run(
      'INSERT INTO events (type, repo, payload, timestamp, fetched_at) VALUES (?, ?, ?, ?, ?)',
      [event.type, event.repo, JSON.stringify(event), timestamp, fetchedAt],
    )

    this.invalidateRollupCoverageForEvent(event)
    return true
  }

  upsertPullRequest(pr: PullRequest, fetchedAt: Timestamp = this.now()): void {
    const serialized = JSON.stringify(pr)
    const existing = this.db
      .query('SELECT data FROM pull_requests WHERE repo = ? AND number = ?')
      .get(pr.repo, pr.number) as { data: string } | undefined
    const changed = !existing || existing.data !== serialized

    this.db.run(
      `INSERT INTO pull_requests (repo, number, data, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, number) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      [pr.repo, pr.number, serialized, fetchedAt],
    )

    if (changed) {
      this.invalidateRollupCoverage(pr.repo, ['rollup_prs', 'rollup_activity'])
    }
  }

  upsertCommit(commit: Commit, fetchedAt: Timestamp = this.now()): void {
    const serialized = JSON.stringify(commit)
    const existing = this.db
      .query('SELECT data FROM commits WHERE repo = ? AND sha = ?')
      .get(commit.repo, commit.sha) as { data: string } | undefined
    const changed = !existing || existing.data !== serialized

    this.db.run(
      `INSERT INTO commits (repo, sha, data, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, sha) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      [commit.repo, commit.sha, serialized, fetchedAt],
    )

    if (changed) {
      this.invalidateRollupCoverage(commit.repo, ['rollup_commits', 'rollup_activity'])
    }
  }

  getPullRequest(
    repo: RepoFullName,
    number: number,
  ): { data: PullRequest; fetched_at: Timestamp } | null {
    const row = this.db
      .query('SELECT data, fetched_at FROM pull_requests WHERE repo = ? AND number = ?')
      .get(repo, number) as { data: string; fetched_at: number } | undefined

    if (!row) {
      return null
    }

    return {
      data: JSON.parse(row.data) as PullRequest,
      fetched_at: row.fetched_at,
    }
  }

  getPullRequests(
    filter: {
      repo?: RepoFullName
      author?: GitHubUsername
      state?: string
    } = {},
  ): PullRequest[] {
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (filter.repo) {
      conditions.push('repo = ?')
      params.push(filter.repo)
    }

    if (filter.author) {
      conditions.push("json_extract(data, '$.author') = ?")
      params.push(filter.author)
    }

    if (filter.state) {
      conditions.push("json_extract(data, '$.state') = ?")
      params.push(filter.state)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db.query(`SELECT data FROM pull_requests ${where}`).all(...params) as Array<{
      data: string
    }>

    return rows.map((row) => JSON.parse(row.data) as PullRequest)
  }

  getCoverageRanges(repo: RepoFullName, kind: CoverageKind): CoverageRange[] {
    const rows = this.db
      .query('SELECT start, end FROM coverage WHERE repo = ? AND kind = ? ORDER BY start ASC')
      .all(repo, kind) as Array<{ start: number; end: number }>
    return rows.map((row) => ({ start: row.start, end: row.end }))
  }

  upsertEmailUsername(email: string, username: GitHubUsername): void {
    const normalizedEmail = email.trim().toLowerCase()
    const normalizedUsername = username.trim()
    if (normalizedEmail.length === 0 || normalizedUsername.length === 0) {
      return
    }

    this.db.run(
      `INSERT INTO email_usernames (email, username)
       VALUES (?, ?)
       ON CONFLICT(email) DO UPDATE SET username = excluded.username`,
      [normalizedEmail, normalizedUsername],
    )
  }

  getEmailToUsernameMap(): Map<string, GitHubUsername> {
    const rows = this.db.query('SELECT email, username FROM email_usernames').all() as Array<{
      email: string
      username: string
    }>

    const emailToUsername = new Map<string, GitHubUsername>()
    for (const row of rows) {
      emailToUsername.set(row.email, row.username)
    }
    return emailToUsername
  }

  addCoverageRange(
    repo: RepoFullName,
    kind: CoverageKind,
    start: Timestamp,
    end: Timestamp,
    fetchedAt: Timestamp = this.now(),
  ): void {
    if (start > end) {
      return
    }

    const existing = this.getCoverageRanges(repo, kind)
    const merged = mergeRanges([...existing, { start, end }])

    this.db.run('DELETE FROM coverage WHERE repo = ? AND kind = ?', [repo, kind])
    for (const range of merged) {
      this.db.run(
        'INSERT INTO coverage (repo, kind, start, end, fetched_at) VALUES (?, ?, ?, ?, ?)',
        [repo, kind, range.start, range.end, fetchedAt],
      )
    }
  }

  invalidateCoverageRange(
    repo: RepoFullName,
    kind: CoverageKind,
    start: Timestamp,
    end: Timestamp,
  ): void {
    if (start > end) {
      return
    }
    this.db.run('DELETE FROM coverage WHERE repo = ? AND kind = ? AND NOT (end < ? OR start > ?)', [
      repo,
      kind,
      start,
      end,
    ])
  }

  getCommits(
    filter: {
      repo?: RepoFullName
      author?: GitHubUsername
      since?: Timestamp
      until?: Timestamp
    } = {},
  ): Commit[] {
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (filter.repo) {
      conditions.push('repo = ?')
      params.push(filter.repo)
    }

    if (filter.author) {
      conditions.push("json_extract(data, '$.author') = ?")
      params.push(filter.author)
    }

    if (filter.since !== undefined) {
      conditions.push("json_extract(data, '$.committed_at') >= ?")
      params.push(filter.since)
    }

    if (filter.until !== undefined) {
      conditions.push("json_extract(data, '$.committed_at') <= ?")
      params.push(filter.until)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db.query(`SELECT data FROM commits ${where}`).all(...params) as Array<{
      data: string
    }>

    return rows.map((row) => JSON.parse(row.data) as Commit)
  }

  getCommit(repo: RepoFullName, sha: string): { data: Commit; fetched_at: Timestamp } | null {
    const row = this.db
      .query('SELECT data, fetched_at FROM commits WHERE repo = ? AND sha = ?')
      .get(repo, sha) as { data: string; fetched_at: number } | undefined

    if (!row) {
      return null
    }

    return {
      data: JSON.parse(row.data) as Commit,
      fetched_at: row.fetched_at,
    }
  }

  getEvents(
    filter: {
      repo?: RepoFullName
      type?: Event['type']
      since?: Timestamp
      until?: Timestamp
    } = {},
  ): Event[] {
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (filter.repo) {
      conditions.push('repo = ?')
      params.push(filter.repo)
    }

    if (filter.type) {
      conditions.push('type = ?')
      params.push(filter.type)
    }

    if (filter.since !== undefined) {
      conditions.push('timestamp >= ?')
      params.push(filter.since)
    }

    if (filter.until !== undefined) {
      conditions.push('timestamp <= ?')
      params.push(filter.until)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .query(`SELECT payload FROM events ${where} ORDER BY timestamp ASC`)
      .all(...params) as Array<{ payload: string }>

    return rows.map((row) => JSON.parse(row.payload) as Event)
  }

  getEventsForPr(repo: RepoFullName, prNumber: number): Event[] {
    const rows = this.db
      .query(
        "SELECT payload FROM events WHERE repo = ? AND json_extract(payload, '$.pr_number') = ? ORDER BY timestamp ASC",
      )
      .all(repo, prNumber) as Array<{ payload: string }>

    return rows.map((row) => JSON.parse(row.payload) as Event)
  }

  getDailyCommits(
    filter: {
      repos?: RepoFullName[]
      start?: Timestamp
      end?: Timestamp
      author?: GitHubUsername
    } = {},
  ): DailyCommitRollup[] {
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (filter.repos && filter.repos.length > 0) {
      conditions.push(`repo IN (${filter.repos.map(() => '?').join(',')})`)
      params.push(...filter.repos)
    }

    if (filter.author) {
      conditions.push('author = ?')
      params.push(filter.author)
    }

    if (filter.start !== undefined) {
      conditions.push('day_start >= ?')
      params.push(filter.start)
    }

    if (filter.end !== undefined) {
      conditions.push('day_start <= ?')
      params.push(filter.end)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .query(
        `SELECT repo, author, day_start, day, commits, additions, deletions, files_changed
         FROM daily_commits ${where} ORDER BY day_start ASC`,
      )
      .all(...params) as Array<DailyCommitRollup>

    return rows
  }

  getDailyPrs(
    filter: {
      repos?: RepoFullName[]
      start?: Timestamp
      end?: Timestamp
      author?: GitHubUsername
    } = {},
  ): DailyPrRollup[] {
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (filter.repos && filter.repos.length > 0) {
      conditions.push(`repo IN (${filter.repos.map(() => '?').join(',')})`)
      params.push(...filter.repos)
    }

    if (filter.author) {
      conditions.push('author = ?')
      params.push(filter.author)
    }

    if (filter.start !== undefined) {
      conditions.push('day_start >= ?')
      params.push(filter.start)
    }

    if (filter.end !== undefined) {
      conditions.push('day_start <= ?')
      params.push(filter.end)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .query(
        `SELECT repo, author, day_start, day, opened, merged, closed
         FROM daily_prs ${where} ORDER BY day_start ASC`,
      )
      .all(...params) as Array<DailyPrRollup>

    return rows
  }

  getDailyReviews(
    filter: {
      repos?: RepoFullName[]
      start?: Timestamp
      end?: Timestamp
      reviewer?: GitHubUsername
    } = {},
  ): DailyReviewRollup[] {
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (filter.repos && filter.repos.length > 0) {
      conditions.push(`repo IN (${filter.repos.map(() => '?').join(',')})`)
      params.push(...filter.repos)
    }

    if (filter.reviewer) {
      conditions.push('reviewer = ?')
      params.push(filter.reviewer)
    }

    if (filter.start !== undefined) {
      conditions.push('day_start >= ?')
      params.push(filter.start)
    }

    if (filter.end !== undefined) {
      conditions.push('day_start <= ?')
      params.push(filter.end)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .query(
        `SELECT repo, reviewer, day_start, day, reviews, approved, changes_requested, commented, dismissed, pending
         FROM daily_reviews ${where} ORDER BY day_start ASC`,
      )
      .all(...params) as Array<DailyReviewRollup>

    return rows
  }

  getDailyActivity(
    filter: { repos?: RepoFullName[]; start?: Timestamp; end?: Timestamp } = {},
  ): DailyActivityRollup[] {
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (filter.repos && filter.repos.length > 0) {
      conditions.push(`repo IN (${filter.repos.map(() => '?').join(',')})`)
      params.push(...filter.repos)
    }

    if (filter.start !== undefined) {
      conditions.push('day_start >= ?')
      params.push(filter.start)
    }

    if (filter.end !== undefined) {
      conditions.push('day_start <= ?')
      params.push(filter.end)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .query(
        `SELECT repo, day_start, day, commits, additions, deletions, files_changed,
                prs_opened, prs_merged, prs_closed, reviews
         FROM daily_activity ${where} ORDER BY day_start ASC`,
      )
      .all(...params) as Array<DailyActivityRollup>

    return rows
  }

  ensureDailyRollups(options: {
    repos: RepoFullName[]
    timeRange: { start: Timestamp; end: Timestamp }
    timeZone: string
    kinds?: CoverageKind[]
  }): void {
    if (options.repos.length === 0) {
      return
    }

    const rollupRange = {
      start: startOfDayFromTimestamp(options.timeRange.start, options.timeZone),
      end: endOfDayFromTimestamp(options.timeRange.end, options.timeZone),
    }

    if (rollupRange.start > rollupRange.end) {
      return
    }

    const requestedKinds = options.kinds ?? [
      'rollup_commits',
      'rollup_prs',
      'rollup_reviews',
      'rollup_activity',
    ]

    const baseKinds = requestedKinds.filter(
      (kind): kind is 'rollup_commits' | 'rollup_prs' | 'rollup_reviews' =>
        kind === 'rollup_commits' || kind === 'rollup_prs' || kind === 'rollup_reviews',
    )

    const includeActivity = requestedKinds.includes('rollup_activity')

    for (const repo of options.repos) {
      for (const kind of baseKinds) {
        const gaps = computeGaps(
          this.getCoverageRanges(repo, kind),
          rollupRange.start,
          rollupRange.end,
        )
        for (const gap of gaps) {
          switch (kind) {
            case 'rollup_commits':
              this.buildDailyCommitRollups(repo, gap, options.timeZone)
              break
            case 'rollup_prs':
              this.buildDailyPrRollups(repo, gap, options.timeZone)
              break
            case 'rollup_reviews':
              this.buildDailyReviewRollups(repo, gap, options.timeZone)
              break
            default: {
              const _exhaustive: never = kind
              throw new Error(`Unhandled rollup kind: ${_exhaustive}`)
            }
          }
          this.addCoverageRange(repo, kind, gap.start, gap.end)
        }
      }

      if (includeActivity) {
        const gaps = computeGaps(
          this.getCoverageRanges(repo, 'rollup_activity'),
          rollupRange.start,
          rollupRange.end,
        )
        for (const gap of gaps) {
          this.buildDailyActivityRollups(repo, gap)
          this.addCoverageRange(repo, 'rollup_activity', gap.start, gap.end)
        }
      }
    }
  }

  getSyncState(repo: RepoFullName): SyncState | null {
    const row = this.db
      .query('SELECT repo, last_sync, cursor, last_pr_updated_at FROM sync_state WHERE repo = ?')
      .get(repo) as
      | {
          repo: string
          last_sync: number
          cursor: string | null
          last_pr_updated_at: number | null
        }
      | undefined

    if (!row) {
      return null
    }

    return {
      repo: row.repo,
      last_sync: row.last_sync,
      cursor: row.cursor,
      last_pr_updated_at: row.last_pr_updated_at ?? null,
    }
  }

  upsertSyncState(
    repo: RepoFullName,
    lastSync: Timestamp,
    options: { cursor?: string | null; last_pr_updated_at?: Timestamp | null } = {},
  ): void {
    const cursor = options.cursor ?? null
    const lastPrUpdatedAt = options.last_pr_updated_at ?? null
    this.db.run(
      `INSERT INTO sync_state (repo, last_sync, cursor, last_pr_updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET
         last_sync = excluded.last_sync,
         cursor = excluded.cursor,
         last_pr_updated_at = excluded.last_pr_updated_at`,
      [repo, lastSync, cursor, lastPrUpdatedAt],
    )
  }

  getHttpCache(
    key: string,
  ): { etag: string | null; last_modified: string | null; fetched_at: Timestamp } | null {
    const row = this.db
      .query('SELECT etag, last_modified, fetched_at FROM http_cache WHERE key = ?')
      .get(key) as
      | { etag: string | null; last_modified: string | null; fetched_at: number }
      | undefined

    if (!row) {
      return null
    }

    return {
      etag: row.etag ?? null,
      last_modified: row.last_modified ?? null,
      fetched_at: row.fetched_at,
    }
  }

  upsertHttpCache(
    key: string,
    value: { etag?: string | null; last_modified?: string | null },
    fetchedAt: Timestamp = this.now(),
  ): void {
    const etag = value.etag ?? null
    const lastModified = value.last_modified ?? null
    if (!etag && !lastModified) {
      return
    }

    this.db.run(
      `INSERT INTO http_cache (key, etag, last_modified, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         etag = excluded.etag,
         last_modified = excluded.last_modified,
         fetched_at = excluded.fetched_at`,
      [key, etag, lastModified, fetchedAt],
    )
  }

  getFreshness(repos: RepoFullName[]): CacheFreshness {
    const now = this.now()
    const eventsMax = this.db.query('SELECT MAX(fetched_at) as max FROM events').get() as
      | { max: number | null }
      | undefined
    const prMax = this.db.query('SELECT MAX(fetched_at) as max FROM pull_requests').get() as
      | { max: number | null }
      | undefined
    const commitMax = this.db.query('SELECT MAX(fetched_at) as max FROM commits').get() as
      | { max: number | null }
      | undefined

    const values = [eventsMax?.max ?? null, prMax?.max ?? null, commitMax?.max ?? null].filter(
      (value): value is number => typeof value === 'number',
    )

    const dataAsOf = values.length > 0 ? Math.max(...values) : null
    const cacheAgeMinutes = dataAsOf !== null ? Math.floor((now - dataAsOf) / 60000) : null

    // Count only repos in the current scope that have been synced
    const placeholders = repos.map(() => '?').join(',')
    const syncedRows = this.db
      .query(`SELECT COUNT(*) as count FROM sync_state WHERE repo IN (${placeholders})`)
      .get(...repos) as { count: number }

    return {
      dataAsOf,
      cacheAgeMinutes,
      reposSynced: syncedRows.count,
      totalRepos: repos.length,
    }
  }

  isFresh(fetchedAt: Timestamp, ttlHours: number): boolean {
    return fetchedAt >= this.now() - ttlHours * 60 * 60 * 1000
  }

  getRepoList(owner: string): { repos: RepoFullName[]; fetched_at: Timestamp } | null {
    const row = this.db
      .query('SELECT repos, fetched_at FROM repo_lists WHERE owner = ?')
      .get(owner) as { repos: string; fetched_at: number } | undefined

    if (!row) {
      return null
    }

    return {
      repos: JSON.parse(row.repos) as RepoFullName[],
      fetched_at: row.fetched_at,
    }
  }

  upsertRepoList(owner: string, repos: RepoFullName[], fetchedAt: Timestamp = this.now()): void {
    this.db.run(
      `INSERT INTO repo_lists (owner, repos, fetched_at)
       VALUES (?, ?, ?)
       ON CONFLICT(owner) DO UPDATE SET repos = excluded.repos, fetched_at = excluded.fetched_at`,
      [owner, JSON.stringify(repos), fetchedAt],
    )
  }

  getCachedRepos(): RepoFullName[] {
    const rows = this.db.query('SELECT DISTINCT repo FROM sync_state').all() as Array<{
      repo: string
    }>
    return rows.map((row) => row.repo as RepoFullName)
  }

  private buildDailyCommitRollups(
    repo: RepoFullName,
    range: CoverageRange,
    timeZone: string,
  ): void {
    const rows = this.db
      .query(
        `SELECT data FROM commits
         WHERE repo = ?
           AND json_extract(data, '$.committed_at') >= ?
           AND json_extract(data, '$.committed_at') <= ?`,
      )
      .all(repo, range.start, range.end) as Array<{ data: string }>

    const rollups = new Map<string, DailyCommitRollup>()

    for (const row of rows) {
      const commit = JSON.parse(row.data) as Commit
      const dayStart = getLocalDayStart(commit.committed_at, timeZone)
      const day = formatLocalDay(commit.committed_at, timeZone)
      const contributors = dedupeAndSortUsernamesCaseInsensitive([
        commit.author,
        ...(commit.co_authors ?? []).map((coAuthor) => coAuthor.username),
      ])

      for (const contributor of contributors) {
        const key = `${contributor}|${dayStart}`
        const existing =
          rollups.get(key) ??
          ({
            repo,
            author: contributor,
            day_start: dayStart,
            day,
            commits: 0,
            additions: 0,
            deletions: 0,
            files_changed: 0,
          } satisfies DailyCommitRollup)

        existing.commits += 1
        existing.additions += commit.additions
        existing.deletions += commit.deletions
        existing.files_changed += commit.files_changed
        rollups.set(key, existing)
      }
    }

    for (const entry of rollups.values()) {
      this.db.run(
        `INSERT INTO daily_commits (repo, author, day_start, day, commits, additions, deletions, files_changed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, author, day_start) DO UPDATE SET
           day = excluded.day,
           commits = excluded.commits,
           additions = excluded.additions,
           deletions = excluded.deletions,
           files_changed = excluded.files_changed`,
        [
          entry.repo,
          entry.author,
          entry.day_start,
          entry.day,
          entry.commits,
          entry.additions,
          entry.deletions,
          entry.files_changed,
        ],
      )
    }
  }

  private buildDailyPrRollups(repo: RepoFullName, range: CoverageRange, timeZone: string): void {
    const prLookup = new Map<number, GitHubUsername>()
    for (const pr of this.getPullRequests({ repo })) {
      prLookup.set(pr.number, pr.author)
    }

    const rows = this.db
      .query(
        `SELECT payload FROM events
         WHERE repo = ?
           AND type IN ('pr_opened', 'pr_merged', 'pr_closed')
           AND timestamp >= ?
           AND timestamp <= ?`,
      )
      .all(repo, range.start, range.end) as Array<{ payload: string }>

    const rollups = new Map<string, DailyPrRollup>()

    for (const row of rows) {
      const event = JSON.parse(row.payload) as Event
      if (event.type !== 'pr_opened' && event.type !== 'pr_merged' && event.type !== 'pr_closed') {
        continue
      }

      const author =
        event.type === 'pr_opened' ? event.author : (prLookup.get(event.pr_number) ?? null)
      if (!author) {
        continue
      }

      const timestamp = getEventTimestamp(event)
      const dayStart = getLocalDayStart(timestamp, timeZone)
      const day = formatLocalDay(timestamp, timeZone)
      const key = `${author}|${dayStart}`

      const existing =
        rollups.get(key) ??
        ({
          repo,
          author,
          day_start: dayStart,
          day,
          opened: 0,
          merged: 0,
          closed: 0,
        } satisfies DailyPrRollup)

      if (event.type === 'pr_opened') {
        existing.opened += 1
      } else if (event.type === 'pr_merged') {
        existing.merged += 1
      } else if (event.type === 'pr_closed') {
        existing.closed += 1
      }

      rollups.set(key, existing)
    }

    for (const entry of rollups.values()) {
      this.db.run(
        `INSERT INTO daily_prs (repo, author, day_start, day, opened, merged, closed)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, author, day_start) DO UPDATE SET
           day = excluded.day,
           opened = excluded.opened,
           merged = excluded.merged,
           closed = excluded.closed`,
        [
          entry.repo,
          entry.author,
          entry.day_start,
          entry.day,
          entry.opened,
          entry.merged,
          entry.closed,
        ],
      )
    }
  }

  private buildDailyReviewRollups(
    repo: RepoFullName,
    range: CoverageRange,
    timeZone: string,
  ): void {
    // Join against pull_requests to get PR author, so we can exclude self-reviews
    const rows = this.db
      .query(
        `SELECT e.payload, json_extract(pr.data, '$.author') as pr_author
         FROM events e
         LEFT JOIN pull_requests pr ON pr.repo = e.repo
           AND pr.number = json_extract(e.payload, '$.pr_number')
         WHERE e.repo = ?
           AND e.type = 'review_submitted'
           AND e.timestamp >= ?
           AND e.timestamp <= ?`,
      )
      .all(repo, range.start, range.end) as Array<{
      payload: string
      pr_author: string | null
    }>

    const rollups = new Map<string, DailyReviewRollup>()

    for (const row of rows) {
      const event = JSON.parse(row.payload) as Event
      if (event.type !== 'review_submitted') {
        continue
      }

      // Exclude self-reviews: reviewer == PR author
      if (row.pr_author && event.reviewer.toLowerCase() === row.pr_author.toLowerCase()) {
        continue
      }

      const timestamp = event.submitted_at
      const dayStart = getLocalDayStart(timestamp, timeZone)
      const day = formatLocalDay(timestamp, timeZone)
      const key = `${event.reviewer}|${dayStart}`

      const existing =
        rollups.get(key) ??
        ({
          repo,
          reviewer: event.reviewer,
          day_start: dayStart,
          day,
          reviews: 0,
          approved: 0,
          changes_requested: 0,
          commented: 0,
          dismissed: 0,
          pending: 0,
        } satisfies DailyReviewRollup)

      existing.reviews += 1
      switch (event.state) {
        case 'approved':
          existing.approved += 1
          break
        case 'changes_requested':
          existing.changes_requested += 1
          break
        case 'commented':
          existing.commented += 1
          break
        case 'dismissed':
          existing.dismissed += 1
          break
        case 'pending':
          existing.pending += 1
          break
        default: {
          const _exhaustive: never = event.state
          throw new Error(`Unhandled review state: ${_exhaustive}`)
        }
      }

      rollups.set(key, existing)
    }

    for (const entry of rollups.values()) {
      this.db.run(
        `INSERT INTO daily_reviews (repo, reviewer, day_start, day, reviews, approved, changes_requested, commented, dismissed, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, reviewer, day_start) DO UPDATE SET
           day = excluded.day,
           reviews = excluded.reviews,
           approved = excluded.approved,
           changes_requested = excluded.changes_requested,
           commented = excluded.commented,
           dismissed = excluded.dismissed,
           pending = excluded.pending`,
        [
          entry.repo,
          entry.reviewer,
          entry.day_start,
          entry.day,
          entry.reviews,
          entry.approved,
          entry.changes_requested,
          entry.commented,
          entry.dismissed,
          entry.pending,
        ],
      )
    }
  }

  private buildDailyActivityRollups(repo: RepoFullName, range: CoverageRange): void {
    const commits = this.getDailyCommits({ repos: [repo], start: range.start, end: range.end })
    const prs = this.getDailyPrs({ repos: [repo], start: range.start, end: range.end })
    const reviews = this.getDailyReviews({ repos: [repo], start: range.start, end: range.end })

    const rollups = new Map<number, DailyActivityRollup>()

    for (const entry of commits) {
      const existing =
        rollups.get(entry.day_start) ??
        ({
          repo,
          day_start: entry.day_start,
          day: entry.day,
          commits: 0,
          additions: 0,
          deletions: 0,
          files_changed: 0,
          prs_opened: 0,
          prs_merged: 0,
          prs_closed: 0,
          reviews: 0,
        } satisfies DailyActivityRollup)
      existing.commits += entry.commits
      existing.additions += entry.additions
      existing.deletions += entry.deletions
      existing.files_changed += entry.files_changed
      rollups.set(entry.day_start, existing)
    }

    for (const entry of prs) {
      const existing =
        rollups.get(entry.day_start) ??
        ({
          repo,
          day_start: entry.day_start,
          day: entry.day,
          commits: 0,
          additions: 0,
          deletions: 0,
          files_changed: 0,
          prs_opened: 0,
          prs_merged: 0,
          prs_closed: 0,
          reviews: 0,
        } satisfies DailyActivityRollup)
      existing.prs_opened += entry.opened
      existing.prs_merged += entry.merged
      existing.prs_closed += entry.closed
      rollups.set(entry.day_start, existing)
    }

    for (const entry of reviews) {
      const existing =
        rollups.get(entry.day_start) ??
        ({
          repo,
          day_start: entry.day_start,
          day: entry.day,
          commits: 0,
          additions: 0,
          deletions: 0,
          files_changed: 0,
          prs_opened: 0,
          prs_merged: 0,
          prs_closed: 0,
          reviews: 0,
        } satisfies DailyActivityRollup)
      existing.reviews += entry.reviews
      rollups.set(entry.day_start, existing)
    }

    for (const entry of rollups.values()) {
      this.db.run(
        `INSERT INTO daily_activity (
           repo, day_start, day, commits, additions, deletions, files_changed, prs_opened, prs_merged, prs_closed, reviews
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, day_start) DO UPDATE SET
           day = excluded.day,
           commits = excluded.commits,
           additions = excluded.additions,
           deletions = excluded.deletions,
           files_changed = excluded.files_changed,
           prs_opened = excluded.prs_opened,
           prs_merged = excluded.prs_merged,
           prs_closed = excluded.prs_closed,
           reviews = excluded.reviews`,
        [
          entry.repo,
          entry.day_start,
          entry.day,
          entry.commits,
          entry.additions,
          entry.deletions,
          entry.files_changed,
          entry.prs_opened,
          entry.prs_merged,
          entry.prs_closed,
          entry.reviews,
        ],
      )
    }
  }

  private eventExists(event: Event, timestamp: Timestamp): boolean {
    switch (event.type) {
      case 'pr_opened':
      case 'pr_ready':
      case 'pr_merged':
      case 'pr_closed':
      case 'review_submitted':
      case 'comment_added': {
        const prNumber = 'pr_number' in event ? event.pr_number : null
        if (prNumber === null) {
          return false
        }
        const row = this.db
          .query(
            "SELECT 1 FROM events WHERE type = ? AND repo = ? AND timestamp = ? AND json_extract(payload, '$.pr_number') = ?",
          )
          .get(event.type, event.repo, timestamp, prNumber)
        return Boolean(row)
      }
      case 'commit_pushed': {
        const row = this.db
          .query(
            "SELECT 1 FROM events WHERE type = ? AND repo = ? AND json_extract(payload, '$.sha') = ?",
          )
          .get(event.type, event.repo, event.sha)
        return Boolean(row)
      }
      default: {
        const _exhaustive: never = event
        throw new Error(`Unhandled event type: ${_exhaustive}`)
      }
    }
  }

  private invalidateRollupCoverage(repo: RepoFullName, kinds: readonly CoverageKind[]): void {
    for (const kind of kinds) {
      this.db.run('DELETE FROM coverage WHERE repo = ? AND kind = ?', [repo, kind])
    }
  }

  private invalidateRollupCoverageForEvent(event: Event): void {
    switch (event.type) {
      case 'pr_opened':
      case 'pr_merged':
      case 'pr_closed':
        this.invalidateRollupCoverage(event.repo, ['rollup_prs', 'rollup_activity'])
        break
      case 'review_submitted':
        this.invalidateRollupCoverage(event.repo, ['rollup_reviews', 'rollup_activity'])
        break
      case 'pr_ready':
      case 'comment_added':
      case 'commit_pushed':
        break
      default: {
        const _exhaustive: never = event
        throw new Error(`Unhandled event type: ${_exhaustive}`)
      }
    }
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    const exists = rows.some((row) => row.name === column)
    if (!exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }

  private runAttributionMigration(): void {
    const markerKey = 'attribution_v1_migrated'
    if (this.getMetaValue(markerKey) === '1') {
      return
    }

    this.db.run(
      "DELETE FROM coverage WHERE kind IN ('commits_pr', 'rollup_commits', 'rollup_activity')",
    )
    this.setMetaValue(markerKey, '1')
  }

  private getMetaValue(key: string): string | null {
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  private setMetaValue(key: string, value: string): void {
    this.db.run(
      `INSERT INTO meta (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    )
  }
}

export function getEventTimestamp(event: Event): Timestamp {
  switch (event.type) {
    case 'pr_opened':
      return event.opened_at
    case 'pr_ready':
      return event.ready_at
    case 'pr_merged':
      return event.merged_at
    case 'pr_closed':
      return event.closed_at
    case 'review_submitted':
      return event.submitted_at
    case 'comment_added':
      return event.commented_at
    case 'commit_pushed':
      return event.committed_at
    default: {
      const _exhaustive: never = event
      throw new Error(`Unhandled event type: ${_exhaustive}`)
    }
  }
}

function isSqliteMemoryPath(dbPath: string): boolean {
  return dbPath === ':memory:' || dbPath === ''
}

async function ensureDir(dbPath: string): Promise<void> {
  if (isSqliteMemoryPath(dbPath)) {
    return
  }

  const dir = path.dirname(dbPath)
  await fs.mkdir(dir, { recursive: true })
}

export function toCommitFromEvent(event: CommitPushedEvent): Commit {
  return {
    repo: event.repo,
    sha: event.sha,
    author: event.author,
    ...(event.author_email ? { author_email: event.author_email } : {}),
    committed_at: event.committed_at,
    message: event.message,
    additions: event.additions,
    deletions: event.deletions,
    files_changed: event.files_changed,
    ...(event.co_authors ? { co_authors: event.co_authors } : {}),
  }
}
