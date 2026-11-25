export type ConventionalType =
  | 'feat'
  | 'fix'
  | 'chore'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'ci'
  | 'style'
  | 'perf'
  | 'build'
  | 'other'

export interface ConventionalPrefix {
  type: ConventionalType
  scope: string | null
}

const CONVENTIONAL_PREFIX_RE = /^(\w+)(?:\(([^)]*)\))?!?\s*:\s*/
const KNOWN_TYPES = new Set<ConventionalType>([
  'feat',
  'fix',
  'chore',
  'refactor',
  'docs',
  'test',
  'ci',
  'style',
  'perf',
  'build',
  'other',
])

export function parseConventionalPrefix(title: string): ConventionalPrefix {
  const match = title.match(CONVENTIONAL_PREFIX_RE)
  if (!match) {
    return { type: 'other', scope: null }
  }

  const rawType = (match[1] ?? '').toLowerCase()
  const normalizedType = KNOWN_TYPES.has(rawType as ConventionalType)
    ? (rawType as ConventionalType)
    : 'other'
  const rawScope = match[2]?.trim()

  return {
    type: normalizedType,
    scope: rawScope && rawScope.length > 0 ? rawScope : null,
  }
}

export function conventionalLabel(type: ConventionalType): string {
  switch (type) {
    case 'feat':
      return 'Features'
    case 'fix':
      return 'Bug Fixes'
    case 'chore':
      return 'Chores'
    case 'refactor':
      return 'Refactors'
    case 'docs':
      return 'Documentation'
    case 'test':
      return 'Tests'
    case 'ci':
      return 'CI'
    case 'style':
      return 'Style'
    case 'perf':
      return 'Performance'
    case 'build':
      return 'Build'
    case 'other':
      return 'Other'
    default: {
      const _exhaustive: never = type
      throw new Error(`Unhandled conventional type: ${_exhaustive}`)
    }
  }
}
