import { describe, expect, it } from 'bun:test'
import { resolveOutputFormat } from './index'

describe('output format resolution', () => {
  it('defaults to tui on tty when format is not explicit', () => {
    expect(
      resolveOutputFormat(
        {
          format: 'table',
          formatExplicit: false,
          compare: false,
        },
        true,
      ),
    ).toBe('tui')
  })

  it('defaults to table on non-tty when format is not explicit', () => {
    expect(
      resolveOutputFormat(
        {
          format: 'table',
          formatExplicit: false,
          compare: false,
        },
        false,
      ),
    ).toBe('table')
  })

  it('respects explicit format selection', () => {
    expect(
      resolveOutputFormat(
        {
          format: 'markdown',
          formatExplicit: true,
          compare: false,
        },
        true,
      ),
    ).toBe('markdown')
  })

  it('passes through explicit slack format selection', () => {
    expect(
      resolveOutputFormat(
        {
          format: 'slack',
          formatExplicit: true,
          compare: false,
        },
        true,
      ),
    ).toBe('slack')
  })

  it('supports audience preset formats', () => {
    expect(
      resolveOutputFormat(
        {
          format: 'internal',
          formatExplicit: true,
          compare: false,
        },
        true,
      ),
    ).toBe('internal')

    expect(
      resolveOutputFormat(
        {
          format: 'customer',
          formatExplicit: true,
          compare: false,
        },
        false,
      ),
    ).toBe('customer')
  })

  it('falls back to table in compare mode when resolved format is tui', () => {
    expect(
      resolveOutputFormat(
        {
          format: 'table',
          formatExplicit: false,
          compare: true,
        },
        true,
      ),
    ).toBe('table')

    expect(
      resolveOutputFormat(
        {
          format: 'tui',
          formatExplicit: true,
          compare: true,
        },
        true,
      ),
    ).toBe('table')
  })
})
