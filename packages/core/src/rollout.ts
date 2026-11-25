import type { PullRequest, PullRequestId, Timestamp } from './types'

/**
 * Rollout: when a merged pull request reached production, and how its change is exposed there.
 *
 * Production reach is structural. A pull request merged straight into a production branch is in
 * production at merge. One merged into an integration branch gets there through a promotion pull
 * request (integration -> production), whose commits name the pull requests they carry.
 *
 * Exposure is read from the author's `Ships:` line. The keyword rules below are deliberately
 * conservative: wording they cannot place is `unknown`, and only `live`, `beta`, and `flag` may be
 * presented as reaching customers.
 */

export interface BranchRoles {
  /** Branches whose merges are production (`main`). */
  production: readonly string[]
  /** Long-lived branches promoted into production (`dev`). */
  integration: readonly string[]
}

export const DEFAULT_BRANCH_ROLES: BranchRoles = {
  production: ['main', 'master'],
  integration: ['dev'],
}

export type ExposureKind = 'live' | 'beta' | 'flag' | 'dark' | 'internal' | 'unknown'

/**
 * A product surface only part of the audience can reach (for example a v2 app in closed beta).
 * A pull request body that names the surface as a whole word is gated by it.
 */
export interface LimitedSurface {
  name: string
  /** Visible label for work on this surface, such as `Closed beta`. */
  label: string
}

/** One restriction on who sees a change. A change behind several gates reaches their overlap. */
export type Gate =
  | { kind: 'beta' }
  | { kind: 'surface'; name: string; label: string }
  | { kind: 'flag'; flag: string }

/** What the `Ships:` line says on its own. */
type ShipsReading =
  | { kind: 'live' | 'beta' | 'dark' | 'internal'; evidence: string }
  | { kind: 'flag'; flag: string; evidence: string }
  | { kind: 'unknown'; evidence: string | null }

export type Exposure = ShipsReading & { gates: Gate[] }

export function gateLabel(gate: Gate): string {
  switch (gate.kind) {
    case 'beta':
      return 'Closed beta'
    case 'surface':
      return gate.label
    case 'flag':
      return `Behind ${gate.flag}`
    default: {
      const unhandled: never = gate
      throw new Error(`unhandled gate ${JSON.stringify(unhandled)}`)
    }
  }
}

/** A promotion carries at most this many commits through the REST commit listing. */
export const PROMOTION_COMMITS_MAX = 250

const SHIPS_LINE_RE = /^\s*(?:[-*]\s*)?\**\s*ships\s*:?\s*\**\s*:?\s*(?<text>.+)$/im
const FLAG_RE = /`(?<flag>[a-z0-9_]+_enabled)`/i
const FLAG_RE_GLOBAL = /`(?<flag>[a-z0-9_]+_enabled)`/gi

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every gate the body states: a closed-beta Ships line, every flag named anywhere in the body,
 * and every configured limited surface the body names. Surfaces and flags are read from the whole
 * body because authors describe audience restrictions outside the Ships line.
 */
function gatesOf(body: string, kind: ExposureKind, surfaces: readonly LimitedSurface[]): Gate[] {
  const gates: Gate[] = kind === 'beta' ? [{ kind: 'beta' }] : []
  for (const surface of surfaces) {
    if (new RegExp(`\\b${escapeRegExp(surface.name)}\\b`, 'i').test(body)) {
      gates.push({ kind: 'surface', name: surface.name, label: surface.label })
    }
  }
  const flags = new Set(
    [...body.matchAll(FLAG_RE_GLOBAL)].map((match) => match.groups!.flag!.toLowerCase()),
  )
  for (const flag of [...flags].toSorted()) gates.push({ kind: 'flag', flag })
  return gates
}

/**
 * Ordered rules; the first match wins. Statements that the change has no user-visible effect, or
 * is switched off, outrank the generic "live on merge", because authors routinely write
 * "live on merge, with no effect until ...". A beta audience outranks "dark" because beta layers
 * describe the rest of their stack ("the rest of the stack ships dark").
 */
const EXPOSURE_RULES: ReadonlyArray<{ kind: 'internal' | 'dark' | 'beta' | 'live'; re: RegExp }> = [
  {
    kind: 'internal',
    re: /\b(?:tests only|no runtime effect|nothing a user sees|logging only|log output only|observability)\b/i,
  },
  { kind: 'beta', re: /\bbeta\b/i },
  {
    kind: 'dark',
    re: /\bdark\b|\bno effect until\b|\bstays? (?:silent|off)\b|\bnothing is drawn\b|\bnowhere yet\b|\bnothing calls it\b|\bswitched off\b|\bdefault off\b/i,
  },
  { kind: 'live', re: /\blive on merge\b|\bon deploy\b|\bwith the worker deploy\b|\bOTA\b/i },
]

/** Classify a pull request body's `Ships:` line and collect the gates its body states. */
export function parseExposure(body: string | null, surfaces: readonly LimitedSurface[]): Exposure {
  const text = body?.match(SHIPS_LINE_RE)?.groups?.text?.trim()
  const shipsOnly = ((): ShipsReading => {
    if (text === undefined || text.length === 0) {
      return { kind: 'unknown', evidence: null }
    }
    const rule = EXPOSURE_RULES.find(({ re }) => re.test(text))
    if (rule !== undefined && rule.kind !== 'live') {
      return { kind: rule.kind, evidence: text }
    }
    // A live change confined to a flag is flag-gated, not live for everyone.
    const flag = text.match(FLAG_RE)?.groups?.flag
    if (flag !== undefined) {
      return { kind: 'flag', flag, evidence: text }
    }
    if (rule !== undefined) {
      return { kind: 'live', evidence: text }
    }
    return { kind: 'unknown', evidence: text }
  })()
  return { ...shipsOnly, gates: gatesOf(body ?? '', shipsOnly.kind, surfaces) }
}

const SQUASH_REF_RE = /\(#(?<number>\d+)\)\s*$/
const MERGE_REF_RE = /^Merge pull request #(?<number>\d+)\b/

/** Pull request numbers named by commit headlines (squash `(#N)` or `Merge pull request #N`). */
export function promotedPullRequestNumbers(commitMessages: readonly string[]): PullRequestId[] {
  const numbers = new Set<PullRequestId>()
  for (const message of commitMessages) {
    const headline = message.split('\n', 1)[0] ?? ''
    const match = headline.match(SQUASH_REF_RE) ?? headline.match(MERGE_REF_RE)
    if (match?.groups?.number !== undefined) {
      numbers.add(Number(match.groups.number))
    }
  }
  return [...numbers].toSorted((a, b) => a - b)
}

export function isPromotion(pr: PullRequest, roles: BranchRoles): boolean {
  return (
    pr.state === 'merged' &&
    pr.base_ref !== undefined &&
    pr.head_ref !== undefined &&
    roles.production.includes(pr.base_ref) &&
    roles.integration.includes(pr.head_ref)
  )
}

export type ProductionReach =
  | { status: 'reached'; at: Timestamp; via: PullRequestId | null }
  | { status: 'pending' }
  | { status: 'unknown'; reason: 'branch-not-recorded' | 'feature-branch' | 'promotion-incomplete' }

/**
 * Where a merged pull request stands relative to production, given the repository's merged
 * promotions. The earliest promotion that names the pull request wins.
 */
export function productionReach(
  pr: PullRequest,
  promotions: readonly PullRequest[],
  roles: BranchRoles,
): ProductionReach {
  const mergedAt = pr.merged_at
  if (pr.state !== 'merged' || mergedAt === null) {
    return { status: 'pending' }
  }
  // A promotion naming the pull request is direct evidence, whatever branch it targeted.
  const carrying = promotions
    .filter((promotion) => promotion.promotion?.included.includes(pr.number) === true)
    .toSorted((a, b) => (a.merged_at ?? 0) - (b.merged_at ?? 0))[0]
  if (carrying !== undefined && carrying.merged_at !== null) {
    return { status: 'reached', at: carrying.merged_at, via: carrying.number }
  }
  if (pr.base_ref === undefined) {
    return { status: 'unknown', reason: 'branch-not-recorded' }
  }
  if (roles.production.includes(pr.base_ref)) {
    return { status: 'reached', at: mergedAt, via: null }
  }
  if (!roles.integration.includes(pr.base_ref)) {
    return { status: 'unknown', reason: 'feature-branch' }
  }
  const later = promotions.some(
    (promotion) =>
      promotion.promotion?.complete === false && (promotion.merged_at ?? 0) >= mergedAt,
  )
  return later ? { status: 'unknown', reason: 'promotion-incomplete' } : { status: 'pending' }
}

export interface RolloutPromotion {
  repo: string
  number: PullRequestId
  merged_at: Timestamp
  included: PullRequestId[]
  complete: boolean
}

export interface RolloutEntry {
  repo: string
  number: PullRequestId
  title: string
  author: string
  merged_at: Timestamp
  production_at: Timestamp
  /** Promotion that carried it; null when merged straight into a production branch. */
  via: PullRequestId | null
  exposure: Exposure
}

export interface RolloutSection {
  branches: { production: string[]; integration: string[] }
  promotions: RolloutPromotion[]
  /** Pull requests whose production arrival falls inside the report window. */
  reached_production: RolloutEntry[]
}

export interface RolloutInputs {
  roles: BranchRoles
  surfaces: readonly LimitedSurface[]
  window: { start: Timestamp; end: Timestamp }
  /** Merged pull requests that count as engineering (team-authored, not deploy or bot). */
  candidates: readonly PullRequest[]
  /** Merged promotions in the covered repositories. */
  promotions: readonly PullRequest[]
}

export function buildRolloutSection(inputs: RolloutInputs): RolloutSection {
  const { roles, window } = inputs
  const promotionsByRepo = new Map<string, PullRequest[]>()
  for (const promotion of inputs.promotions) {
    const list = promotionsByRepo.get(promotion.repo) ?? []
    list.push(promotion)
    promotionsByRepo.set(promotion.repo, list)
  }

  const reached: RolloutEntry[] = []
  for (const pr of inputs.candidates) {
    const reach = productionReach(pr, promotionsByRepo.get(pr.repo) ?? [], roles)
    if (reach.status !== 'reached' || reach.at < window.start || reach.at > window.end) {
      continue
    }
    reached.push({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      author: pr.author,
      merged_at: pr.merged_at ?? reach.at,
      production_at: reach.at,
      via: reach.via,
      exposure: parseExposure(pr.body, inputs.surfaces),
    })
  }

  return {
    branches: { production: [...roles.production], integration: [...roles.integration] },
    promotions: inputs.promotions
      .filter(
        (pr) => pr.merged_at !== null && pr.merged_at >= window.start && pr.merged_at <= window.end,
      )
      .map((pr) => ({
        repo: pr.repo,
        number: pr.number,
        merged_at: pr.merged_at ?? 0,
        included: pr.promotion?.included ?? [],
        complete: pr.promotion?.complete ?? false,
      }))
      .toSorted((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number),
    reached_production: reached.toSorted(
      (a, b) => a.repo.localeCompare(b.repo) || a.number - b.number,
    ),
  }
}

export type CitationVerdict = { ok: true; labels: string[] } | { ok: false; reason: string }

/**
 * Whether a set of pull requests may be presented as reaching customers in this window, and the
 * labels the claim must show: one per distinct gate across the cited pull requests, sorted.
 * Unknown exposure is allowed: it reached production and nothing says it is switched off.
 */
// WAIVER(claim audience matches the code's audience): gates hold only restrictions a PR body names
// (flags, configured surfaces, a closed-beta Ships line). An audience narrowed in code, such as a
// section drawn only for accounts offered round-ups, is invisible here; holding it would need
// per-PR audience data from the product's own flag and eligibility code. Permanent — the
// independent recap verifier reads PR bodies and code for these claims.
export function judgeCitation(
  refs: readonly string[],
  reached: ReadonlyMap<string, RolloutEntry>,
): CitationVerdict {
  if (refs.length === 0) {
    return { ok: false, reason: 'cites no pull requests' }
  }
  const labels = new Set<string>()
  for (const ref of refs) {
    const entry = reached.get(ref)
    if (entry === undefined) {
      return { ok: false, reason: `${ref} did not reach production in this window` }
    }
    const kind = entry.exposure.kind
    if (kind === 'dark' || kind === 'internal') {
      return { ok: false, reason: `${ref} ships ${kind}: ${entry.exposure.evidence}` }
    }
    for (const gate of entry.exposure.gates) labels.add(gateLabel(gate))
  }
  return { ok: true, labels: [...labels].toSorted() }
}

export function rolloutRef(entry: Pick<RolloutEntry, 'repo' | 'number'>): string {
  return `${entry.repo}#${entry.number}`
}

const EXPOSURE_KINDS: ReadonlySet<string> = new Set([
  'live',
  'beta',
  'flag',
  'dark',
  'internal',
  'unknown',
])

function parseGate(value: unknown, label: string): Gate {
  const record = recordAt(value, label)
  switch (record.kind) {
    case 'beta':
      return { kind: 'beta' }
    case 'surface':
      return {
        kind: 'surface',
        name: stringField(record, 'name', label),
        label: stringField(record, 'label', label),
      }
    case 'flag':
      return { kind: 'flag', flag: stringField(record, 'flag', label) }
    default:
      throw new Error(`${label}.kind is not a known gate`)
  }
}

function parseExposureValue(value: unknown, label: string): Exposure {
  const record = recordAt(value, label)
  const kind = record.kind
  const evidence = record.evidence
  if (typeof kind !== 'string' || !EXPOSURE_KINDS.has(kind)) {
    throw new Error(`${label}.kind is not a known exposure`)
  }
  if (!Array.isArray(record.gates)) throw new Error(`${label}.gates must be a list`)
  const gates = record.gates.map((gate, index) => parseGate(gate, `${label}.gates[${index}]`))
  if (kind === 'unknown') {
    if (evidence !== null && typeof evidence !== 'string') {
      throw new Error(`${label}.evidence must be a string or null`)
    }
    return { kind, evidence, gates }
  }
  if (typeof evidence !== 'string') throw new Error(`${label}.evidence must be a string`)
  if (kind === 'flag') {
    if (typeof record.flag !== 'string' || record.flag.length === 0) {
      throw new Error(`${label}.flag must name the flag`)
    }
    return { kind, flag: record.flag, evidence, gates }
  }
  return { kind: kind as 'live' | 'beta' | 'dark' | 'internal', evidence, gates }
}

function integerField(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key]
  if (!Number.isInteger(value)) throw new Error(`${label}.${key} must be an integer`)
  return value as number
}

function nullableIntegerField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | null {
  return record[key] === null ? null : integerField(record, key, label)
}

function stringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`${label}.${key} must be a string`)
  return value
}

function recordAt(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a list of strings`)
  }
  return value as string[]
}

/** Parse the `rollout` section of a serialized team report. Throws on any shape violation. */
export function parseRolloutSection(value: unknown): RolloutSection {
  const section = recordAt(value, 'rollout')
  const branches = recordAt(section.branches, 'rollout.branches')
  if (!Array.isArray(section.promotions) || !Array.isArray(section.reached_production)) {
    throw new Error('rollout.promotions and rollout.reached_production must be lists')
  }
  return {
    branches: {
      production: stringList(branches.production, 'rollout.branches.production'),
      integration: stringList(branches.integration, 'rollout.branches.integration'),
    },
    promotions: section.promotions.map((item, index) => {
      const label = `rollout.promotions[${index}]`
      const record = recordAt(item, label)
      const included = record.included
      if (!Array.isArray(included) || !included.every((number) => Number.isInteger(number))) {
        throw new Error(`${label}.included must be a list of pull request numbers`)
      }
      if (typeof record.complete !== 'boolean') throw new Error(`${label}.complete must be boolean`)
      return {
        repo: stringField(record, 'repo', label),
        number: integerField(record, 'number', label),
        merged_at: integerField(record, 'merged_at', label),
        included: included as number[],
        complete: record.complete,
      }
    }),
    reached_production: section.reached_production.map((item, index) => {
      const label = `rollout.reached_production[${index}]`
      const record = recordAt(item, label)
      return {
        repo: stringField(record, 'repo', label),
        number: integerField(record, 'number', label),
        title: stringField(record, 'title', label),
        author: stringField(record, 'author', label),
        merged_at: integerField(record, 'merged_at', label),
        production_at: integerField(record, 'production_at', label),
        via: nullableIntegerField(record, 'via', label),
        exposure: parseExposureValue(record.exposure, `${label}.exposure`),
      }
    }),
  }
}
