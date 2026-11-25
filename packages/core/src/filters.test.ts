import { describe, expect, it } from 'bun:test'
import type { PullRequest } from './types'
import { isBotUsername, isDeployPr, isExcludedAuthor } from './filters'

describe('isBotUsername', () => {
  it('detects [bot] usernames', () => {
    expect(isBotUsername('dependabot[bot]')).toBe(true)
    expect(isBotUsername('renovate[bot]')).toBe(true)
  })

  it('detects common bot usernames without [bot]', () => {
    expect(isBotUsername('dependabot')).toBe(true)
    expect(isBotUsername('dependabot-preview')).toBe(true)
    expect(isBotUsername('renovate')).toBe(true)
    expect(isBotUsername('renovate-123')).toBe(true)
    expect(isBotUsername('acme-bot')).toBe(true)
    expect(isBotUsername('ops_bot')).toBe(true)
  })

  it('does not mark regular users as bots', () => {
    expect(isBotUsername('Mona-Lisa')).toBe(false)
    expect(isBotUsername('robotics')).toBe(false)
  })
})

describe('isExcludedAuthor', () => {
  it('matches explicit excluded users case-insensitively', () => {
    const exclude = new Set<string>(['mona-lisa'])
    expect(isExcludedAuthor('Mona-Lisa', exclude, false)).toBe(true)
  })

  it('applies bot exclusion when enabled', () => {
    const exclude = new Set<string>()
    expect(isExcludedAuthor('dependabot', exclude, true)).toBe(true)
    expect(isExcludedAuthor('acme-bot', exclude, true)).toBe(true)
  })

  it('does not exclude bots when bot exclusion is disabled', () => {
    const exclude = new Set<string>()
    expect(isExcludedAuthor('dependabot', exclude, false)).toBe(false)
  })
})

describe('isDeployPr', () => {
  it('returns true for bot-authored pull requests', () => {
    const pr = buildPr({ author: 'dependabot[bot]', title: 'chore: bump deps' })
    expect(isDeployPr(pr)).toBe(true)
  })

  it('returns true for deploy/release patterns', () => {
    expect(isDeployPr(buildPr({ title: 'deploy: production release' }))).toBe(true)
    expect(isDeployPr(buildPr({ title: 'deploy(testnet): update manifests to ca751d50' }))).toBe(
      true,
    )
    expect(isDeployPr(buildPr({ title: 'release: v1.2.3' }))).toBe(true)
    expect(isDeployPr(buildPr({ title: 'Version Packages across monorepo' }))).toBe(true)
    expect(isDeployPr(buildPr({ title: 'chore: update k8s manifests' }))).toBe(true)
  })

  // Gitops deploy bots title deploys "[deploy] ..." — the leading bracket
  // breaks a bare ^deploy anchor, so these manifest flips were leaking through and
  // being counted as authored engineering. The classifier must be bracket-aware.
  it('returns true for bracketed gitops deploy/release/promote titles', () => {
    expect(isDeployPr(buildPr({ title: '[deploy] update manifests to abc1234' }))).toBe(true)
    expect(isDeployPr(buildPr({ title: '[release] v1.2.3' }))).toBe(true)
    expect(isDeployPr(buildPr({ title: '[promote] testnet -> mainnet' }))).toBe(true)
  })

  it('returns true for promote PRs', () => {
    expect(isDeployPr(buildPr({ title: 'promote webapp to production' }))).toBe(true)
    expect(isDeployPr(buildPr({ title: 'promote(testnet): roll forward' }))).toBe(true)
    expect(isDeployPr(buildPr({ title: 'promote: bridge stack' }))).toBe(true)
  })

  it('returns false for non-deploy human PRs', () => {
    expect(isDeployPr(buildPr({ author: 'Mona-Lisa', title: 'feat: add shipped section' }))).toBe(
      false,
    )
    // Words that merely contain a deploy verb mid-title or as a scope are real work.
    expect(isDeployPr(buildPr({ author: 'Mona-Lisa', title: 'feat: deployment dashboard' }))).toBe(
      false,
    )
    expect(isDeployPr(buildPr({ author: 'Mona-Lisa', title: 'fix(deploy): retry backoff' }))).toBe(
      false,
    )
  })
})

function buildPr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: 'acme-co/webapp',
    number: 1,
    title: 'feat: test',
    body: null,
    state: 'merged',
    draft: false,
    author: 'Mona-Lisa',
    created_at: Date.parse('2026-02-10T00:00:00.000Z'),
    updated_at: Date.parse('2026-02-11T00:00:00.000Z'),
    merged_at: Date.parse('2026-02-12T00:00:00.000Z'),
    closed_at: null,
    additions: 1,
    deletions: 1,
    commits: 1,
    requested_reviewers: [],
    labels: [],
    linked_issues: [],
    ...overrides,
  }
}
