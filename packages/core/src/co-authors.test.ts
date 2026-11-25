import { describe, expect, it } from 'bun:test'
import type { Commit } from './types'
import {
  commitMatchesContributor,
  dedupeAndSortUsernamesCaseInsensitive,
  parseCoAuthorTrailers,
  resolveCoAuthors,
} from './co-authors'

describe('co-authors', () => {
  it('parses co-author trailers and ignores malformed lines', () => {
    const trailers = parseCoAuthorTrailers(`
feat: add attribution

Co-authored-by: Bob Builder <bob@example.com>
Co-authored-by: invalid trailer
co-authored-by: Carol Smith <carol@example.com>
Co-authored-by: Bob Duplicate <BOB@example.com>
`)

    expect(trailers).toEqual([
      { name: 'Bob Builder', email: 'bob@example.com' },
      { name: 'Carol Smith', email: 'carol@example.com' },
      { name: 'Bob Duplicate', email: 'bob@example.com' },
    ])
  })

  it('resolves co-authors from known emails with stable case-insensitive dedupe', () => {
    const emailToUsername = new Map<string, string>([
      ['bob@example.com', 'Bob'],
      ['carol@example.com', 'Carol'],
      ['alice@example.com', 'Alice'],
    ])

    const coAuthors = resolveCoAuthors(
      `
feat: with collaborators

Co-authored-by: Bob One <bob@example.com>
Co-authored-by: Bob Two <BOB@example.com>
Co-authored-by: Carol <carol@example.com>
Co-authored-by: Unknown <unknown@example.com>
Co-authored-by: Alice <alice@example.com>
`,
      'alice',
      emailToUsername,
    )

    expect(coAuthors).toEqual([
      { username: 'Bob', email: 'bob@example.com' },
      { username: 'Carol', email: 'carol@example.com' },
    ])
  })

  it('matches commits by primary author or resolved co-author', () => {
    const commit: Commit = {
      repo: 'org/repo',
      sha: 'abc123',
      author: 'alice',
      committed_at: Date.parse('2026-02-20T00:00:00.000Z'),
      message: 'feat: commit',
      additions: 5,
      deletions: 2,
      files_changed: 1,
      co_authors: [{ username: 'Bob', email: 'bob@example.com' }],
    }

    expect(commitMatchesContributor(commit, 'alice')).toBe(true)
    expect(commitMatchesContributor(commit, 'bob')).toBe(true)
    expect(commitMatchesContributor(commit, 'carol')).toBe(false)
  })

  it('dedupes and stable-sorts usernames case-insensitively', () => {
    expect(
      dedupeAndSortUsernamesCaseInsensitive(['bob', 'ALICE', 'alice', 'Bob', 'carol', 'Carol']),
    ).toEqual(['ALICE', 'bob', 'carol'])
  })
})
