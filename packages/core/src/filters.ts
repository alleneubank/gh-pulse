import type { GitHubUsername, PullRequest } from './types'

// Anchors allow an optional leading bracket because gitops deploy bots title releases
// "[deploy] ..." / "[release] ..." / "[promote] ...". A bare ^deploy anchor misses the
// bracketed form and would count those manifest flips as authored engineering. \b keeps
// "deployment"/"fix(deploy):" (real work) out.
const DEPLOY_PR_PATTERNS: RegExp[] = [
  /^\[?\s*deploy\b/i,
  /^\[?\s*release\b/i,
  /^\[?\s*promote\b/i,
  /version packages/i,
  /update.*manifests/i,
]

export function isBotUsername(username: GitHubUsername): boolean {
  const normalized = username.trim().toLowerCase()
  if (normalized.length === 0) {
    return false
  }

  // GitHub app/bot convention: dependabot[bot], renovate[bot], etc.
  if (normalized.endsWith('[bot]')) {
    return true
  }

  // Common bot accounts without [bot] suffix.
  if (normalized === 'dependabot' || normalized.startsWith('dependabot-')) {
    return true
  }
  if (normalized === 'renovate' || normalized.startsWith('renovate-')) {
    return true
  }

  // Common service account naming in orgs.
  if (normalized.endsWith('-bot') || normalized.endsWith('_bot')) {
    return true
  }

  return false
}

export function isExcludedAuthor(
  username: GitHubUsername,
  exclude: Set<GitHubUsername>,
  excludeBots: boolean,
): boolean {
  if (hasCaseInsensitive(exclude, username)) {
    return true
  }
  if (excludeBots && isBotUsername(username)) {
    return true
  }
  return false
}

export function isDeployPr(pr: PullRequest): boolean {
  if (isBotUsername(pr.author)) {
    return true
  }

  return DEPLOY_PR_PATTERNS.some((pattern) => pattern.test(pr.title))
}

function hasCaseInsensitive(exclude: Set<GitHubUsername>, username: GitHubUsername): boolean {
  if (exclude.has(username)) {
    return true
  }
  const normalized = username.toLowerCase()
  for (const entry of exclude) {
    if (entry.toLowerCase() === normalized) {
      return true
    }
  }
  return false
}
