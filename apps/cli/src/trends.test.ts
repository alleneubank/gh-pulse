import { describe, expect, it } from 'bun:test'
import { computeMemberTrendDeltaPct, trendFromDeltaPct } from './trends'

interface HistoryPoint {
  bucket_start: number
  bucket_end: number
  activity: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function point(startDay: number, days: number, activity: number): HistoryPoint {
  const start = startDay * DAY_MS
  const end = start + days * DAY_MS - 1
  return {
    bucket_start: start,
    bucket_end: end,
    activity,
  }
}

describe('member trend calculations', () => {
  it('skips partial latest bucket when two complete buckets exist', () => {
    const history = [
      point(0, 7, 700), // 100/day
      point(7, 7, 560), // 80/day
      point(14, 3, 210), // 70/day partial - should be skipped
    ]

    const delta = computeMemberTrendDeltaPct(history)
    expect(Math.round(delta)).toBe(-20)
    expect(trendFromDeltaPct(delta)).toBe('down')
  })

  it('uses rate normalization when only two buckets exist and latest is partial', () => {
    const history = [
      point(0, 7, 700), // 100/day
      point(7, 3, 300), // 100/day partial
    ]

    const delta = computeMemberTrendDeltaPct(history)
    expect(Math.round(delta)).toBe(0)
    expect(trendFromDeltaPct(delta)).toBe('flat')
  })

  it('handles zero previous rate', () => {
    const history = [
      point(0, 7, 0),
      point(7, 7, 350), // 50/day
    ]

    const delta = computeMemberTrendDeltaPct(history)
    expect(delta).toBe(100)
    expect(trendFromDeltaPct(delta)).toBe('up')
  })
})

describe('period-over-period trend with 2 buckets', () => {
  it('shows upward trend when current period has more activity than prior', () => {
    // Simulates buildTrendBuckets output: prior week vs current week
    // Prior week: 30 total activity, Current week: 49 total activity
    // Even if daily breakdown within current week is high Mon-Thu / low Fri-Sun,
    // the period-level comparison should show improvement
    const history = [
      point(0, 7, 30), // prior week: 30 activity
      point(7, 7, 49), // current week: 49 activity
    ]

    const delta = computeMemberTrendDeltaPct(history)
    expect(delta).toBeGreaterThan(10)
    expect(trendFromDeltaPct(delta)).toBe('up')
  })

  it('shows +100% when no prior data exists', () => {
    const history = [
      point(0, 7, 0), // prior week: no activity
      point(7, 7, 25), // current week: some activity
    ]

    const delta = computeMemberTrendDeltaPct(history)
    expect(delta).toBe(100)
    expect(trendFromDeltaPct(delta)).toBe('up')
  })

  it('shows flat when half-day buckets have proportional activity', () => {
    // Simulates --period today at noon: 12h buckets, not 24h.
    // Prior has 12 in 24h (rate: 12/day), current has 6 in 12h (rate: 12/day).
    // With actual period boundaries, rate normalization produces flat trend.
    const HALF_DAY = 0.5
    const history = [
      point(0, HALF_DAY, 6), // prior: 6 activity in 12h → 12/day
      point(1, HALF_DAY, 6), // current: 6 activity in 12h → 12/day
    ]

    const delta = computeMemberTrendDeltaPct(history)
    expect(Math.round(delta)).toBe(0)
    expect(trendFromDeltaPct(delta)).toBe('flat')
  })

  it('shows flat 0% when both periods are empty', () => {
    const history = [
      point(0, 7, 0), // prior week: no activity
      point(7, 7, 0), // current week: no activity
    ]

    const delta = computeMemberTrendDeltaPct(history)
    expect(delta).toBe(0)
    expect(trendFromDeltaPct(delta)).toBe('flat')
  })
})
