import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_BRANCH_ROLES,
  type Exposure,
  type LimitedSurface,
  type RolloutEntry,
  buildRolloutSection,
  judgeCitation,
  rolloutRef,
  parseExposure,
  productionReach,
  promotedPullRequestNumbers,
} from './rollout'
import type { PullRequest } from './types'

const DAY_MS = 86_400_000
const WEEK_START = Date.parse('2026-11-16T06:00:00Z')
const WEEK_END = Date.parse('2026-11-23T05:59:59.999Z')

function pr(overrides: Partial<PullRequest> & Pick<PullRequest, 'number'>): PullRequest {
  return {
    repo: 'acme-co/webapp',
    title: `PR ${overrides.number}`,
    body: null,
    state: 'merged',
    draft: false,
    author: 'bob',
    created_at: WEEK_START,
    updated_at: WEEK_START + DAY_MS,
    merged_at: WEEK_START + DAY_MS,
    closed_at: WEEK_START + DAY_MS,
    additions: 1,
    deletions: 0,
    commits: 1,
    requested_reviewers: [],
    labels: [],
    linked_issues: [],
    base_ref: 'dev',
    head_ref: 'feature',
    ...overrides,
  }
}

describe('parseExposure', () => {
  // Ships lines in the forms real pull request bodies use.
  it.each([
    ['- **Ships:** live on merge.', 'live'],
    ['- **Ships:** web on deploy; native with the next OTA.', 'live'],
    [
      "- **Ships:** dark, with no flag by owner decision. The switch is the settings row's rate.",
      'dark',
    ],
    [
      '- **Ships:** live on merge, with no effect until a settings row has a rate above zero (none exists in production).',
      'dark',
    ],
    [
      '- **Ships:** live on merge. Both alerts key on a bonus wallet existing, so staging stays silent and production stays silent until the wallet is configured.',
      'dark',
    ],
    [
      '- **Ships:** live on merge, with no flag, for whoever already has the v2 app (closed beta). Nobody else sees a change.',
      'beta',
    ],
    [
      '- **Ships:** live on merge, with no flag, for whoever already has the v2 app (closed beta). The rest of the round-up bonus stack ships dark; this layer and 1/11 are the visible part.',
      'beta',
    ],
    ['- **Ships:** tests only, no runtime effect.', 'internal'],
    ['- **Ships:** live on merge; log output only.', 'internal'],
    ['- **Ships:** observability and wiring; nothing a user sees.', 'internal'],
    ['- **Ships:** something unusual happens.', 'unknown'],
  ] as const)('classifies %s as %s', (line, kind) => {
    expect(parseExposure(`## Rollout\n\n${line}\n`, []).kind).toBe(kind)
  })

  it('names the flag that confines a live change', () => {
    const exposure = parseExposure(
      '- **Ships:** live on merge, inside round-ups, which stay behind `rewards_roundups_enabled`.',
      [],
    )
    expect(exposure).toMatchObject({ kind: 'flag', flag: 'rewards_roundups_enabled' })
  })

  it('reads a flag-only line as flag-gated', () => {
    const exposure = parseExposure('- **Ships:** behind `new_app_ui_enabled`; v2 only.', [])
    expect(exposure).toMatchObject({ kind: 'flag', flag: 'new_app_ui_enabled' })
  })

  it('is unknown without a Ships line', () => {
    expect(parseExposure('## Summary\n\nFixes a bug.', [])).toEqual({
      kind: 'unknown',
      evidence: null,
      gates: [],
    })
    expect(parseExposure(null, [])).toEqual({ kind: 'unknown', evidence: null, gates: [] })
  })
})

describe('exposure gates', () => {
  const V2: LimitedSurface = { name: 'v2', label: 'Closed beta' }

  // Live Ships lines on a closed-beta surface, with the audience restriction stated outside the Ships line.
  it('gates live work on a configured limited surface named anywhere in the body', () => {
    const body =
      'On the v2 Save sheet, moving goal money to cash now says why.\n\n- **Ships:** live on merge (no flag).'
    expect(parseExposure(body, [V2])).toMatchObject({
      kind: 'live',
      gates: [{ kind: 'surface', name: 'v2', label: 'Closed beta' }],
    })
    expect(parseExposure(body, []).gates).toEqual([])
  })

  it('matches a surface as a whole word, case-insensitively', () => {
    expect(parseExposure('The V2 Card page re-reads.', [V2]).gates).toHaveLength(1)
    expect(parseExposure('Bumps v20 of the SDK.', [V2]).gates).toEqual([])
  })

  it('collects every flag the body names, not only the one in the Ships line', () => {
    const body =
      'Drawn only behind `rewards_roundups_enabled`.\n- **Ships:** behind `new_app_ui_enabled`.'
    expect(parseExposure(body, []).gates).toEqual([
      { kind: 'flag', flag: 'new_app_ui_enabled' },
      { kind: 'flag', flag: 'rewards_roundups_enabled' },
    ])
  })

  it('records a closed-beta Ships line as a gate', () => {
    expect(parseExposure('- **Ships:** live for the closed beta.', []).gates).toEqual([
      { kind: 'beta' },
    ])
  })
})

describe('judgeCitation', () => {
  const entry = (number: number, exposure: Exposure): RolloutEntry => ({
    repo: 'acme-co/webapp',
    number,
    title: `PR ${number}`,
    author: 'bob',
    merged_at: WEEK_START,
    production_at: WEEK_START,
    via: null,
    exposure,
  })
  const reached = new Map(
    [
      entry(1, { kind: 'live', evidence: 'live on merge.', gates: [] }),
      entry(2, {
        kind: 'beta',
        evidence: 'closed beta',
        gates: [{ kind: 'beta' }, { kind: 'surface', name: 'v2', label: 'Closed beta' }],
      }),
      entry(3, {
        kind: 'live',
        evidence: 'live on merge.',
        gates: [{ kind: 'flag', flag: 'rewards_roundups_enabled' }],
      }),
      entry(4, { kind: 'dark', evidence: 'dark, with no flag.', gates: [] }),
    ].map((value) => [rolloutRef(value), value]),
  )

  it('requires one label per distinct gate across the cited PRs', () => {
    expect(judgeCitation(['acme-co/webapp#1'], reached)).toEqual({ ok: true, labels: [] })
    expect(judgeCitation(['acme-co/webapp#2', 'acme-co/webapp#3'], reached)).toEqual({
      ok: true,
      labels: ['Behind rewards_roundups_enabled', 'Closed beta'],
    })
  })

  it('refuses dark, unreached, and empty citations', () => {
    expect(judgeCitation(['acme-co/webapp#4'], reached)).toMatchObject({ ok: false })
    expect(judgeCitation(['acme-co/webapp#9'], reached)).toMatchObject({ ok: false })
    expect(judgeCitation([], reached)).toMatchObject({ ok: false })
  })
})

describe('promotedPullRequestNumbers', () => {
  it('reads squash and merge-commit headlines and ignores the rest', () => {
    expect(
      promotedPullRequestNumbers([
        'feat(app): v2 page menu with profile row and labelled pages (#10853)\n\nbody (#1)',
        'fix(localnet): turn off the flashblocks loop (#10838)',
        'Merge pull request #10790 from acme-co/feature',
        'chore: manual commit without a reference',
        'fix(localnet): duplicate headline (#10838)',
      ]),
    ).toEqual([10790, 10838, 10853])
  })
})

describe('productionReach', () => {
  const promotion = pr({
    number: 10928,
    base_ref: 'main',
    head_ref: 'dev',
    merged_at: WEEK_START + 3 * DAY_MS,
    promotion: { included: [10865, 10866], complete: true },
  })

  it('reaches production through the promotion that carried it', () => {
    expect(productionReach(pr({ number: 10865 }), [promotion], DEFAULT_BRANCH_ROLES)).toEqual({
      status: 'reached',
      at: WEEK_START + 3 * DAY_MS,
      via: 10928,
    })
  })

  it('stays pending on the integration branch until promoted', () => {
    expect(productionReach(pr({ number: 10900 }), [promotion], DEFAULT_BRANCH_ROLES)).toEqual({
      status: 'pending',
    })
  })

  it('is unknown, not pending, when a later promotion listing was truncated', () => {
    const truncated = { ...promotion, promotion: { included: [], complete: false } }
    expect(productionReach(pr({ number: 10900 }), [truncated], DEFAULT_BRANCH_ROLES)).toEqual({
      status: 'unknown',
      reason: 'promotion-incomplete',
    })
  })

  it('reaches production at merge on a production branch', () => {
    const direct = pr({ number: 2084, repo: 'acme-co/api', base_ref: 'main' })
    expect(productionReach(direct, [], DEFAULT_BRANCH_ROLES)).toEqual({
      status: 'reached',
      at: direct.merged_at!,
      via: null,
    })
  })

  it('does not guess for stacked or unrecorded branches', () => {
    expect(
      productionReach(pr({ number: 1, base_ref: 'feature/base' }), [], DEFAULT_BRANCH_ROLES),
    ).toEqual({ status: 'unknown', reason: 'feature-branch' })
    const { base_ref: _base, ...unrecorded } = pr({ number: 2 })
    expect(productionReach(unrecorded, [], DEFAULT_BRANCH_ROLES)).toEqual({
      status: 'unknown',
      reason: 'branch-not-recorded',
    })
  })
})

describe('buildRolloutSection', () => {
  it('lists only work whose production arrival falls in the window, with its exposure', () => {
    const promotion = pr({
      number: 10928,
      base_ref: 'main',
      head_ref: 'dev',
      merged_at: WEEK_START + 5 * DAY_MS,
      promotion: { included: [10700, 10865, 10870], complete: true },
    })
    const section = buildRolloutSection({
      roles: DEFAULT_BRANCH_ROLES,
      surfaces: [],
      window: { start: WEEK_START, end: WEEK_END },
      candidates: [
        // Merged the week before, carried to production this week.
        pr({
          number: 10700,
          merged_at: WEEK_START - 2 * DAY_MS,
          body: '**Ships:** live on merge.',
        }),
        pr({ number: 10865, body: '**Ships:** live on merge for the v2 app (closed beta).' }),
        pr({ number: 10870, body: '**Ships:** dark, with no flag by owner decision.' }),
        // Merged to dev this week, not yet promoted.
        pr({ number: 10950, merged_at: WEEK_END - DAY_MS, body: '**Ships:** live on merge.' }),
      ],
      promotions: [promotion],
    })

    expect(section.promotions).toEqual([
      {
        repo: 'acme-co/webapp',
        number: 10928,
        merged_at: WEEK_START + 5 * DAY_MS,
        included: [10700, 10865, 10870],
        complete: true,
      },
    ])
    expect(
      section.reached_production.map((entry) => [entry.number, entry.via, entry.exposure.kind]),
    ).toEqual([
      [10700, 10928, 'live'],
      [10865, 10928, 'beta'],
      [10870, 10928, 'dark'],
    ])
  })
})
