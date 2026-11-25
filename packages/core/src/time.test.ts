import { describe, expect, it } from 'bun:test'
import { parseRelativeDuration, periodToRange, resolveSince, resolveUntil } from './time'

const NOW = new Date('2026-01-20T12:00:00Z')

function ms(days: number): number {
  return days * 24 * 60 * 60 * 1000
}

describe('time utilities', () => {
  it('parses relative durations', () => {
    expect(parseRelativeDuration('7d')).toBe(ms(7))
    expect(parseRelativeDuration('2w')).toBe(ms(14))
  })

  it('resolves period ranges', () => {
    const range = periodToRange('week', NOW, 'UTC')
    expect(range.end).toBe(NOW.getTime())
    expect(range.start).toBe(NOW.getTime() - ms(7))
  })

  it('resolves since with relative input', () => {
    const since = resolveSince('3d', NOW, 'UTC')
    expect(since).toBe(NOW.getTime() - ms(3))
  })

  it('resolves until to end of day in timezone for date-only input', () => {
    const untilUtc = resolveUntil('2026-01-20', NOW, 'UTC')
    expect(new Date(untilUtc).toISOString()).toBe('2026-01-20T23:59:59.999Z')
  })

  it('resolves until to end of day in local timezone', () => {
    const untilPacific = resolveUntil('2026-01-20', NOW, 'America/Los_Angeles')
    expect(new Date(untilPacific).toISOString()).toBe('2026-01-21T07:59:59.999Z')
  })

  it('resolves human date keywords', () => {
    expect(new Date(resolveSince('today', NOW, 'UTC')).toISOString()).toBe(
      '2026-01-20T00:00:00.000Z',
    )
    expect(new Date(resolveUntil('today', NOW, 'UTC')).toISOString()).toBe(
      '2026-01-20T23:59:59.999Z',
    )
    expect(new Date(resolveSince('yesterday', NOW, 'UTC')).toISOString()).toBe(
      '2026-01-19T00:00:00.000Z',
    )
    expect(new Date(resolveUntil('yesterday', NOW, 'UTC')).toISOString()).toBe(
      '2026-01-19T23:59:59.999Z',
    )
    expect(resolveSince('now', NOW, 'UTC')).toBe(NOW.getTime())
    expect(resolveUntil('now', NOW, 'UTC')).toBe(NOW.getTime())
  })

  it('resolves human keywords in configured timezone', () => {
    const sincePacific = resolveSince('today', NOW, 'America/Los_Angeles')
    expect(new Date(sincePacific).toISOString()).toBe('2026-01-20T08:00:00.000Z')

    const untilPacific = resolveUntil('yesterday', NOW, 'America/Los_Angeles')
    expect(new Date(untilPacific).toISOString()).toBe('2026-01-20T07:59:59.999Z')
  })
})
