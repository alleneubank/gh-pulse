import type { Cache } from '../cache'
import type { RepoFullName, Timestamp } from '../types'
import type { ReportAudience, ReportMeta } from './types'

export function buildReportMeta(options: {
  audience: ReportAudience
  repos: RepoFullName[]
  periodLabel: string
  start: Timestamp
  end: Timestamp
  cache: Cache
  now?: () => number
}): ReportMeta {
  const generatedAt = options.now ? options.now() : Date.now()
  return {
    audience: options.audience,
    period_label: options.periodLabel,
    start: options.start,
    end: options.end,
    start_utc: new Date(options.start).toISOString(),
    end_utc: new Date(options.end).toISOString(),
    generated_at: generatedAt,
    repos: options.repos,
    data_freshness: options.cache.getFreshness(options.repos),
  }
}
