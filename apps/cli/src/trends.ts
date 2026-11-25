export type TrendDirection = 'up' | 'down' | 'flat'

export interface ActivityHistoryPoint {
  bucket_start: number
  bucket_end: number
  activity: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function activityRatePerDay(point: ActivityHistoryPoint): number {
  const durationMs = bucketDurationMs(point)
  if (durationMs <= 0) {
    return 0
  }
  return point.activity / (durationMs / DAY_MS)
}

export function trendFromDeltaPct(deltaPct: number): TrendDirection {
  if (deltaPct > 10) {
    return 'up'
  }
  if (deltaPct < -10) {
    return 'down'
  }
  return 'flat'
}

export function computeMemberTrendDeltaPct(history: ActivityHistoryPoint[]): number {
  if (history.length < 2) {
    return 0
  }

  const nominalBucketMs = inferNominalBucketMs(history)
  let currentIndex = history.length - 1
  let previousIndex = history.length - 2

  // Avoid misleading "down" trends caused by a trailing partial bucket.
  const latest = history[currentIndex]
  if (history.length >= 3 && latest && isPartialBucket(latest, nominalBucketMs)) {
    currentIndex -= 1
    previousIndex -= 1
  }

  const current = history[currentIndex]
  const previous = history[previousIndex]
  if (!current || !previous) {
    return 0
  }

  const currentRate = activityRatePerDay(current)
  const previousRate = activityRatePerDay(previous)

  if (previousRate === 0) {
    return currentRate > 0 ? 100 : 0
  }

  return ((currentRate - previousRate) / previousRate) * 100
}

export function applyHistoryTrends<T extends ActivityHistoryPoint>(
  history: T[],
): Array<
  T & {
    trend: TrendDirection
  }
> {
  return history.map((point, index) => {
    if (index === 0) {
      return { ...point, trend: 'flat' as const }
    }
    const previous = history[index - 1]
    if (!previous) {
      return { ...point, trend: 'flat' as const }
    }
    const currentRate = activityRatePerDay(point)
    const previousRate = activityRatePerDay(previous)
    const deltaPct =
      previousRate === 0
        ? currentRate > 0
          ? 100
          : 0
        : ((currentRate - previousRate) / previousRate) * 100
    return { ...point, trend: trendFromDeltaPct(deltaPct) }
  })
}

function inferNominalBucketMs(history: ActivityHistoryPoint[]): number {
  if (history.length < 2) {
    const first = history[0]
    return first ? bucketDurationMs(first) : 0
  }

  const gaps: number[] = []
  for (let index = 1; index < history.length; index += 1) {
    const current = history[index]
    const previous = history[index - 1]
    if (!current || !previous) {
      continue
    }
    const gap = current.bucket_start - previous.bucket_start
    if (gap > 0) {
      gaps.push(gap)
    }
  }

  if (gaps.length > 0) {
    return gaps[0] ?? 0
  }

  const first = history[0]
  return first ? bucketDurationMs(first) : 0
}

function isPartialBucket(point: ActivityHistoryPoint, nominalBucketMs: number): boolean {
  if (nominalBucketMs <= 0) {
    return false
  }
  return bucketDurationMs(point) < nominalBucketMs
}

function bucketDurationMs(point: ActivityHistoryPoint): number {
  return Math.max(0, point.bucket_end - point.bucket_start + 1)
}
