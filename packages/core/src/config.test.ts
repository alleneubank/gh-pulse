import { describe, expect, it } from 'bun:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadConfig, resolveConfigPath, resolveCachePath } from './config'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-pulse-'))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('config', () => {
  it('resolves config path with env override', () => {
    const env = { GH_PULSE_CONFIG: '/tmp/config.yaml' }
    expect(resolveConfigPath(undefined, env)).toBe('/tmp/config.yaml')
  })

  it('resolves cache path from XDG cache home', () => {
    const env = { XDG_CACHE_HOME: '/tmp/cache' }
    expect(resolveCachePath('', env)).toBe('/tmp/cache/gh-pulse/cache.db')
  })

  it('loads config with env substitution', async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, 'config.yaml')
      const configContents = `
        github_token: \${GITHUB_TOKEN}
        orgs: [example]
        repos: [example/repo]
        repo_descriptions:
          example/repo: Example repository
        team:
          strategy: config_list
          members: [alice]
        exclude:
          bots: true
          forks: true
          archived: true
          authors: []
        thresholds:
          stale_days: 2
          stuck_days: 4
        cache:
          path: \${XDG_CACHE_HOME}/gh-pulse/cache.db
          ttl_hours: 1
      `
      await fs.writeFile(configPath, configContents, 'utf8')

      const config = await loadConfig({
        path: configPath,
        env: { GITHUB_TOKEN: 'token', XDG_CACHE_HOME: dir },
      })

      expect(config.github_token).toBe('token')
      expect(config.cache.path).toBe(path.join(dir, 'gh-pulse', 'cache.db'))
      expect(config.team.members).toEqual(['alice'])
      expect(config.repo_descriptions).toEqual({ 'example/repo': 'Example repository' })
    })
  })

  it('loads default AI identities and allows YAML override', async () => {
    await withTempDir(async (dir) => {
      const defaultConfigPath = path.join(dir, 'default.yaml')
      const overrideConfigPath = path.join(dir, 'override.yaml')

      await fs.writeFile(defaultConfigPath, 'github_token: ${GITHUB_TOKEN}\n', 'utf8')
      await fs.writeFile(
        overrideConfigPath,
        `
          github_token: \${GITHUB_TOKEN}
          exclude:
            ai_identities:
              - custom-ai
        `,
        'utf8',
      )

      const env = { GITHUB_TOKEN: 'token', XDG_CACHE_HOME: dir }
      const defaultConfig = await loadConfig({ path: defaultConfigPath, env })
      const overrideConfig = await loadConfig({ path: overrideConfigPath, env })

      expect(defaultConfig.exclude.ai_identities).toEqual([
        'claude',
        'cursor',
        'github-copilot[bot]',
        'aider',
        'devin-ai-integration[bot]',
      ])
      expect(overrideConfig.exclude.ai_identities).toEqual(['custom-ai'])
    })
  })
})
