import { describe, expect, it } from 'bun:test'
import type { PullRequest } from '../types'
import { buildRepoBreakdown, buildShippedSection } from './sections'

describe('buildRepoBreakdown', () => {
  it('attaches configured repo descriptions to entries', () => {
    const pr = buildPr({
      repo: 'acme-co/webapp',
      number: 10,
      title: 'feat: checkout improvements',
      merged_at: Date.parse('2026-02-19T12:00:00.000Z'),
    })

    const repoBreakdown = buildRepoBreakdown(
      [pr],
      [pr],
      {
        start: Date.parse('2026-02-01T00:00:00.000Z'),
        end: Date.parse('2026-02-28T23:59:59.999Z'),
      },
      {
        'acme-co/webapp': 'Web app',
      },
      Date.parse('2026-02-20T00:00:00.000Z'),
    )

    expect(repoBreakdown.entries[0]?.repo_description).toBe('Web app')
  })
})

describe('buildShippedSection', () => {
  it('attributes merged PRs to each contributor with case-insensitive dedupe', () => {
    const mergedPr = buildPr({
      number: 22,
      author: 'opener',
      contributors: ['ALICE', 'alice', 'bob'],
      merged_at: Date.parse('2026-02-19T12:00:00.000Z'),
    })

    const shipped = buildShippedSection([mergedPr], Date.parse('2026-02-20T00:00:00.000Z'))

    expect(shipped.total_merged).toBe(1)
    expect(shipped.entries.map((entry) => entry.author)).toEqual(['ALICE', 'bob'])
    expect(shipped.entries[0]?.prs.map((pr) => pr.number)).toEqual([22])
    expect(shipped.entries[1]?.prs.map((pr) => pr.number)).toEqual([22])
  })

  it('falls back to pr.author when contributors is undefined', () => {
    const mergedPr = buildPr({
      number: 33,
      author: 'solo-dev',
      merged_at: Date.parse('2026-02-19T12:00:00.000Z'),
    })

    const shipped = buildShippedSection([mergedPr], Date.parse('2026-02-20T00:00:00.000Z'))

    expect(shipped.total_merged).toBe(1)
    expect(shipped.entries).toHaveLength(1)
    expect(shipped.entries[0]?.author).toBe('solo-dev')
    expect(shipped.entries[0]?.prs.map((pr) => pr.number)).toEqual([33])
  })
})

function buildPr(overrides: Partial<PullRequest>): PullRequest {
  return {
    repo: 'acme-co/webapp',
    number: 1,
    title: 'feat: example',
    body: null,
    state: 'merged',
    draft: false,
    author: 'alice',
    created_at: Date.parse('2026-02-10T00:00:00.000Z'),
    updated_at: Date.parse('2026-02-11T00:00:00.000Z'),
    merged_at: Date.parse('2026-02-11T12:00:00.000Z'),
    closed_at: Date.parse('2026-02-11T12:00:00.000Z'),
    additions: 20,
    deletions: 5,
    commits: 1,
    requested_reviewers: [],
    labels: [],
    linked_issues: [],
    ...overrides,
  }
}
