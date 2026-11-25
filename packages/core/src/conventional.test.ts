import { describe, expect, it } from 'bun:test'
import { conventionalLabel, parseConventionalPrefix } from './conventional'

describe('parseConventionalPrefix', () => {
  it('parses feat prefix', () => {
    expect(parseConventionalPrefix('feat: add shipped report')).toEqual({
      type: 'feat',
      scope: null,
    })
  })

  it('parses fix scope prefix', () => {
    expect(parseConventionalPrefix('fix(cli): markdown output')).toEqual({
      type: 'fix',
      scope: 'cli',
    })
  })

  it('parses breaking change marker', () => {
    expect(parseConventionalPrefix('chore!: update release workflow')).toEqual({
      type: 'chore',
      scope: null,
    })
  })

  it('normalizes uppercase prefix', () => {
    expect(parseConventionalPrefix('FEAT(api): add endpoint')).toEqual({
      type: 'feat',
      scope: 'api',
    })
  })

  it('maps unknown prefix to other', () => {
    expect(parseConventionalPrefix('deploy: release to prod')).toEqual({
      type: 'other',
      scope: null,
    })
    expect(parseConventionalPrefix('release: publish packages')).toEqual({
      type: 'other',
      scope: null,
    })
  })

  it('maps non-conventional title to other', () => {
    expect(parseConventionalPrefix('Ship weekly summary')).toEqual({
      type: 'other',
      scope: null,
    })
  })
})

describe('conventionalLabel', () => {
  it('returns human-readable labels', () => {
    expect(conventionalLabel('feat')).toBe('Features')
    expect(conventionalLabel('fix')).toBe('Bug Fixes')
    expect(conventionalLabel('chore')).toBe('Chores')
    expect(conventionalLabel('other')).toBe('Other')
  })
})
