import type { Timestamp } from './types'

export type Period = 'today' | 'week' | 'sprint' | 'month' | 'quarter'

export interface TimeRange {
  start: Timestamp
  end: Timestamp
  label: string
}

const DAY_MS = 24 * 60 * 60 * 1000

export function periodToRange(period: Period, now: Date, timeZone: string): TimeRange {
  const end = now.getTime()
  switch (period) {
    case 'today': {
      const start = startOfDay(now, timeZone)
      return { start, end, label: 'today' }
    }
    case 'week': {
      const start = end - 7 * DAY_MS
      return { start, end, label: 'last 7 days' }
    }
    case 'sprint': {
      const start = end - 14 * DAY_MS
      return { start, end, label: 'last 14 days' }
    }
    case 'month': {
      const start = end - 30 * DAY_MS
      return { start, end, label: 'last 30 days' }
    }
    case 'quarter': {
      const start = end - 90 * DAY_MS
      return { start, end, label: 'last 90 days' }
    }
    default: {
      const _exhaustive: never = period
      throw new Error(`Unhandled period: ${_exhaustive}`)
    }
  }
}

export function resolveSince(input: string, now: Date, timeZone = 'UTC'): Timestamp {
  const human = parseHumanDateInput(input, now, timeZone, 'since')
  if (human !== null) {
    return human
  }

  if (isRelative(input)) {
    return now.getTime() - parseRelativeDuration(input)
  }
  return parseAbsoluteDate(input)
}

export function resolveUntil(input: string, now: Date, timeZone: string): Timestamp {
  const human = parseHumanDateInput(input, now, timeZone, 'until')
  if (human !== null) {
    return human
  }

  if (isRelative(input)) {
    return now.getTime() - parseRelativeDuration(input)
  }
  return parseAbsoluteUntil(input, timeZone)
}

export function formatTimestamp(timestamp: Timestamp, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  return formatter.format(new Date(timestamp))
}

export function diffInDays(start: Timestamp, end: Timestamp): number {
  return Math.floor((end - start) / DAY_MS)
}

export function parseRelativeDuration(input: string): number {
  const match = input.trim().match(/^(\d+)([dwmy])$/i)
  if (!match) {
    throw new Error(`Invalid relative duration: ${input}`)
  }

  const value = Number(match[1])
  const unitRaw = match[2]
  if (!unitRaw) {
    throw new Error(`Invalid relative duration unit: ${input}`)
  }
  const unit = unitRaw.toLowerCase() as 'd' | 'w' | 'm' | 'y'

  switch (unit) {
    case 'd':
      return value * DAY_MS
    case 'w':
      return value * 7 * DAY_MS
    case 'm':
      return value * 30 * DAY_MS
    case 'y':
      return value * 365 * DAY_MS
    default: {
      const _exhaustive: never = unit
      throw new Error(`Unhandled duration unit: ${_exhaustive}`)
    }
  }
}

function isRelative(input: string): boolean {
  return /^(\d+)([dwmy])$/i.test(input.trim())
}

function parseAbsoluteDate(input: string): Timestamp {
  const parsed = Date.parse(input)
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date: ${input}`)
  }
  return parsed
}

function parseHumanDateInput(
  input: string,
  now: Date,
  timeZone: string,
  boundary: 'since' | 'until',
): Timestamp | null {
  const normalized = input.trim().toLowerCase()
  switch (normalized) {
    case 'now':
      return now.getTime()
    case 'today': {
      const dayStart = localDayStartWithOffset(now, timeZone, 0)
      return boundary === 'since' ? dayStart : endOfDayFromTimestamp(dayStart, timeZone)
    }
    case 'yesterday': {
      const dayStart = localDayStartWithOffset(now, timeZone, -1)
      return boundary === 'since' ? dayStart : endOfDayFromTimestamp(dayStart, timeZone)
    }
    default:
      return null
  }
}

function startOfDay(now: Date, timeZone: string): Timestamp {
  return localDayStartWithOffset(now, timeZone, 0)
}

export function startOfDayFromTimestamp(timestamp: Timestamp, timeZone: string): Timestamp {
  return startOfDay(new Date(timestamp), timeZone)
}

export function endOfDayFromTimestamp(timestamp: Timestamp, timeZone: string): Timestamp {
  const parts = getZonedParts(new Date(timestamp), timeZone)
  const next = addDaysToParts(parts, 1)
  const nextStart = zonedTimeToUtcMs(
    {
      ...next,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  )
  return nextStart - 1
}

export function getLocalDayStart(timestamp: Timestamp, timeZone: string): Timestamp {
  return startOfDayFromTimestamp(timestamp, timeZone)
}

export function formatLocalDay(timestamp: Timestamp, timeZone: string): string {
  const parts = getZonedParts(new Date(timestamp), timeZone)
  const month = String(parts.month).padStart(2, '0')
  const day = String(parts.day).padStart(2, '0')
  return `${parts.year}-${month}-${day}`
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = formatter.formatToParts(date)
  const lookup = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  )

  const year = lookup.year
  const month = lookup.month
  const day = lookup.day
  const hour = lookup.hour
  const minute = lookup.minute
  const second = lookup.second

  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error(`Failed to resolve timezone parts for ${timeZone}`)
  }

  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  }
}

function zonedTimeToUtcMs(parts: ZonedParts, timeZone: string): number {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone)
  return utcGuess - offset
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone)
  const utcFromParts = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  return utcFromParts - date.getTime()
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function addDaysToParts(parts: ZonedParts, days: number): ZonedParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

function localDayStartWithOffset(now: Date, timeZone: string, daysOffset: number): Timestamp {
  const localNow = getZonedParts(now, timeZone)
  const localDayStart = addDaysToParts({ ...localNow, hour: 0, minute: 0, second: 0 }, daysOffset)
  return zonedTimeToUtcMs(localDayStart, timeZone)
}

function parseAbsoluteUntil(input: string, timeZone: string): Timestamp {
  const trimmed = input.trim()
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnly) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      throw new Error(`Invalid date: ${input}`)
    }
    const endOfDay = endOfDayFromTimestamp(
      zonedTimeToUtcMs({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone),
      timeZone,
    )
    return endOfDay
  }

  return parseAbsoluteDate(trimmed)
}
