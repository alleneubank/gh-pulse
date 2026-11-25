import type { CycleTimeMetrics, Event, PullRequest, ReviewEngagement, Timestamp } from '../types'
import { diffInDays, endOfDayFromTimestamp, startOfDayFromTimestamp } from '../time'
import type { PullRequestSummary } from './types'
import { dedupeAndSortUsernamesCaseInsensitive } from '../co-authors'

export function buildPullRequestSummary(pr: PullRequest, now: Timestamp): PullRequestSummary {
  const bodySnippet = extractBodySnippet(pr.body)
  return {
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    ...(bodySnippet ? { body_snippet: bodySnippet } : {}),
    author: pr.author,
    ...(pr.contributors && pr.contributors.length > 0
      ? { contributors: dedupeAndSortUsernamesCaseInsensitive(pr.contributors) }
      : {}),
    state: pr.state,
    draft: pr.draft,
    updated_at: pr.updated_at,
    created_at: pr.created_at,
    age_days: diffInDays(pr.created_at, now),
  }
}

function extractBodySnippet(body: string | null): string | undefined {
  if (!body || body.trim().length === 0) {
    return undefined
  }

  const lines = body
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => stripMarkdown(line).trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('```'))

  if (lines.length === 0) {
    return undefined
  }

  const snippet = lines.slice(0, 2).join(' ')
  if (snippet.length <= 280) {
    return snippet
  }
  return `${snippet.slice(0, 277)}...`
}

function stripMarkdown(input: string): string {
  return input
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^[-*+]\s+\[[ xX]\]\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/<[^>]+>/g, '')
}

export function computeCycleTime(pr: PullRequest, events: Event[]): CycleTimeMetrics | null {
  if (pr.merged_at === null) {
    return null
  }

  const openedAt = minTimestamp(
    events.filter((event) => event.type === 'pr_opened').map((e) => e.opened_at),
  )
  const readyAt = minTimestamp(
    events.filter((event) => event.type === 'pr_ready').map((e) => e.ready_at),
  )
  const firstReviewAt = minTimestamp(
    events.filter((event) => event.type === 'review_submitted').map((event) => event.submitted_at),
  )

  const openTime = openedAt ?? pr.created_at
  const readyTime = readyAt ?? openTime
  const reviewStart = firstReviewAt ?? null

  const draftTime = readyAt ? readyTime - openTime : null
  const reviewTime = reviewStart !== null ? reviewStart - readyTime : null
  const mergeTime = reviewStart !== null ? pr.merged_at - reviewStart : null
  const totalTime = pr.merged_at - openTime

  return {
    draft_time: draftTime,
    review_time: reviewTime,
    merge_time: mergeTime,
    total_time: totalTime,
  }
}

export function computeReviewEngagement(pr: PullRequest, events: Event[]): ReviewEngagement | null {
  const comments = events.filter((event) => event.type === 'comment_added')
  const reviews = events.filter((event) => event.type === 'review_submitted')

  if (comments.length === 0 && reviews.length === 0) {
    return null
  }

  const firstComment = minTimestamp(comments.map((event) => event.commented_at))
  const firstReview = minTimestamp(reviews.map((event) => event.submitted_at))

  return {
    time_to_first_comment: firstComment ? firstComment - pr.created_at : null,
    time_to_first_review: firstReview ? firstReview - pr.created_at : null,
    review_count: reviews.length,
    comment_count: comments.length,
  }
}

export function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].toSorted((a, b) => a - b)
  const index = Math.floor((pct / 100) * (sorted.length - 1))
  return sorted[index] ?? null
}

export function splitRangeByDay(
  timeRange: { start: Timestamp; end: Timestamp },
  timeZone: string,
): {
  fullDays: { start: Timestamp; end: Timestamp } | null
  edges: Array<{ start: Timestamp; end: Timestamp }>
} {
  if (timeRange.start > timeRange.end) {
    return { fullDays: null, edges: [] }
  }

  const startDayStart = startOfDayFromTimestamp(timeRange.start, timeZone)
  const endDayStart = startOfDayFromTimestamp(timeRange.end, timeZone)

  if (startDayStart === endDayStart) {
    return { fullDays: null, edges: [{ start: timeRange.start, end: timeRange.end }] }
  }

  const startDayEnd = endOfDayFromTimestamp(timeRange.start, timeZone)
  const endDayEnd = endOfDayFromTimestamp(timeRange.end, timeZone)

  const edges: Array<{ start: Timestamp; end: Timestamp }> = []
  if (timeRange.start > startDayStart) {
    edges.push({ start: timeRange.start, end: Math.min(startDayEnd, timeRange.end) })
  }
  if (timeRange.end < endDayEnd) {
    edges.push({ start: endDayStart, end: timeRange.end })
  }

  const fullStart = timeRange.start > startDayStart ? startDayEnd + 1 : startDayStart
  const fullEnd =
    timeRange.end < endDayEnd ? startOfDayFromTimestamp(endDayStart - 1, timeZone) : endDayStart

  if (fullStart <= fullEnd) {
    return { fullDays: { start: fullStart, end: fullEnd }, edges }
  }

  return { fullDays: null, edges }
}

export function isInRange(
  timestamp: Timestamp,
  range: { start: Timestamp; end: Timestamp },
): boolean {
  return timestamp >= range.start && timestamp <= range.end
}

function minTimestamp(values: Array<Timestamp | undefined>): Timestamp | null {
  const filtered = values.filter((value): value is Timestamp => typeof value === 'number')
  if (filtered.length === 0) {
    return null
  }
  return Math.min(...filtered)
}
