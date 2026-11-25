import { describe, expect, it } from 'bun:test'
import type { PullRequest } from '../types'
import { buildPullRequestSummary } from './utils'

describe('buildPullRequestSummary', () => {
  it('includes a plain-text snippet from the first two body lines', () => {
    const pr = buildPr({
      body: '- Added **new checkout flow**\n- Fixes [payment edge case](https://example.com)\n- Extra detail',
    })

    const summary = buildPullRequestSummary(pr, Date.parse('2026-02-20T00:00:00.000Z'))

    expect(summary.body_snippet).toBe('Added new checkout flow Fixes payment edge case')
  })

  it('omits body_snippet when body is empty', () => {
    const pr = buildPr({ body: '   ' })

    const summary = buildPullRequestSummary(pr, Date.parse('2026-02-20T00:00:00.000Z'))

    expect(summary.body_snippet).toBeUndefined()
  })
})

function buildPr(overrides: Partial<PullRequest>): PullRequest {
  return {
    repo: 'acme-co/webapp',
    number: 42,
    title: 'feat: improve checkout',
    body: null,
    state: 'merged',
    draft: false,
    author: 'alice',
    created_at: Date.parse('2026-02-18T00:00:00.000Z'),
    updated_at: Date.parse('2026-02-19T00:00:00.000Z'),
    merged_at: Date.parse('2026-02-19T00:00:00.000Z'),
    closed_at: Date.parse('2026-02-19T00:00:00.000Z'),
    additions: 10,
    deletions: 2,
    commits: 1,
    requested_reviewers: [],
    labels: [],
    linked_issues: [],
    ...overrides,
  }
}
