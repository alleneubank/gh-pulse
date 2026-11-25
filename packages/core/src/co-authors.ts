import type { CoAuthor, Commit, GitHubUsername } from './types'

const CO_AUTHORED_BY_TRAILER_REGEX = /^\s*co-authored-by:\s*(.+?)\s*<([^<>@\s]+@[^<>@\s]+)>\s*$/i

export interface CoAuthorTrailer {
  name: string
  email: string
}

export function parseCoAuthorTrailers(message: string): CoAuthorTrailer[] {
  return message
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(CO_AUTHORED_BY_TRAILER_REGEX)
      if (!match) {
        return []
      }
      const name = match[1]?.trim() ?? ''
      const email = normalizeEmail(match[2] ?? '')
      if (name.length === 0 || email.length === 0) {
        return []
      }
      return [{ name, email }]
    })
}

export function resolveCoAuthors(
  message: string,
  primaryAuthor: GitHubUsername,
  emailToUsername: ReadonlyMap<string, GitHubUsername>,
): CoAuthor[] {
  const primaryKey = normalizeUsername(primaryAuthor)
  const resolved = new Map<string, CoAuthor>()

  for (const trailer of parseCoAuthorTrailers(message)) {
    const username = emailToUsername.get(trailer.email)
    if (!username) {
      continue
    }

    const key = normalizeUsername(username)
    if (key.length === 0 || key === primaryKey || resolved.has(key)) {
      continue
    }

    resolved.set(key, { username, email: trailer.email })
  }

  return Array.from(resolved.entries())
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([, coAuthor]) => coAuthor)
}

export function commitMatchesContributor(
  commit: Pick<Commit, 'author' | 'co_authors'>,
  username: GitHubUsername,
): boolean {
  const candidate = normalizeUsername(username)
  if (candidate.length === 0) {
    return false
  }

  if (normalizeUsername(commit.author) === candidate) {
    return true
  }

  return (commit.co_authors ?? []).some(
    (coAuthor) => normalizeUsername(coAuthor.username) === candidate,
  )
}

export function dedupeAndSortUsernamesCaseInsensitive(
  usernames: GitHubUsername[],
): GitHubUsername[] {
  const deduped = new Map<string, GitHubUsername>()

  for (const username of usernames) {
    const normalized = normalizeUsername(username)
    if (normalized.length === 0 || deduped.has(normalized)) {
      continue
    }
    deduped.set(normalized, username)
  }

  return Array.from(deduped.entries())
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([, username]) => username)
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}
