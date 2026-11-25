import { promises as fs } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import YAML from 'yaml'

const TeamStrategySchema = z.enum(['org_members', 'config_list', 'repo_contributors'])

const DEFAULT_AI_IDENTITIES = [
  'claude',
  'cursor',
  'github-copilot[bot]',
  'aider',
  'devin-ai-integration[bot]',
]

const ExcludeSchema = z
  .object({
    bots: z.boolean().default(true),
    forks: z.boolean().default(true),
    archived: z.boolean().default(true),
    authors: z.array(z.string().min(1)).default([]),
    ai_identities: z.array(z.string().min(1)).default(DEFAULT_AI_IDENTITIES),
  })
  .default({
    bots: true,
    forks: true,
    archived: true,
    authors: [],
    ai_identities: DEFAULT_AI_IDENTITIES,
  })

const ThresholdsSchema = z
  .object({
    stale_days: z.number().int().positive().default(2),
    stuck_days: z.number().int().positive().default(4),
    large_pr_lines: z.number().int().positive().default(500),
    // Max age for blockers - PRs older than this are excluded from blocker list
    // Set to 0 to disable (show all blockers regardless of age)
    blocker_max_age_days: z.number().int().nonnegative().default(90),
  })
  .default({
    stale_days: 2,
    stuck_days: 4,
    large_pr_lines: 500,
    blocker_max_age_days: 90,
  })

const CacheSchema = z
  .object({
    path: z.string().default(''),
    ttl_hours: z.number().int().positive().default(1),
    sync_ttl_hours: z.number().int().nonnegative().default(24),
    concurrency: z.number().int().positive().default(5),
    use_etags: z.boolean().default(true),
    use_timeline: z.boolean().default(true),
    use_graphql: z.boolean().default(true),
  })
  .default({
    path: '',
    ttl_hours: 1,
    sync_ttl_hours: 24,
    concurrency: 5,
    use_etags: true,
    use_timeline: true,
    use_graphql: true,
  })

const TeamSchema = z
  .object({
    strategy: TeamStrategySchema.default('org_members'),
    members: z.array(z.string().min(1)).default([]),
  })
  .default({
    strategy: 'org_members',
    members: [],
  })

const RolloutSchema = z
  .object({
    production_branches: z.array(z.string().min(1)).min(1).default(['main', 'master']),
    integration_branches: z.array(z.string().min(1)).default(['dev']),
    limited_surfaces: z
      .array(z.object({ name: z.string().min(1), label: z.string().min(1) }))
      .default([]),
  })
  .default({
    production_branches: ['main', 'master'],
    integration_branches: ['dev'],
    limited_surfaces: [],
  })

const ConfigSchema = z.object({
  github_token: z.string().optional(),
  linear_api_key: z.string().min(1).optional(),
  orgs: z.array(z.string().min(1)).default([]),
  repos: z.array(z.string().min(1)).default([]),
  repo_descriptions: z.record(z.string().min(1)).default({}),
  team: TeamSchema,
  exclude: ExcludeSchema,
  thresholds: ThresholdsSchema,
  timezone: z.string().default(''),
  cache: CacheSchema,
  rollout: RolloutSchema,
})

// Internal schema with required token (after resolution)
const ResolvedConfigSchema = ConfigSchema.extend({
  github_token: z.string().min(1),
})

export type Config = z.infer<typeof ResolvedConfigSchema>

export const DEFAULT_CONFIG_ENV = 'GH_PULSE_CONFIG'

/**
 * Try to get GitHub token from `gh` CLI.
 * Returns undefined if gh is not available or not authenticated.
 */
export function getGhCliToken(): string | undefined {
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim()
    return token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

export function resolveConfigPath(
  providedPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (providedPath) {
    return expandHome(providedPath)
  }

  const envPath = env[DEFAULT_CONFIG_ENV]
  if (envPath && envPath.trim().length > 0) {
    return expandHome(envPath.trim())
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME
  const base =
    xdgConfigHome && xdgConfigHome.trim().length > 0
      ? xdgConfigHome.trim()
      : path.join(os.homedir(), '.config')
  return path.join(base, 'gh-pulse', 'config.yaml')
}

export function resolveCachePath(
  configuredPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (configuredPath && configuredPath.trim().length > 0) {
    return expandHome(configuredPath.trim())
  }

  const xdgCacheHome = env.XDG_CACHE_HOME
  const base =
    xdgCacheHome && xdgCacheHome.trim().length > 0
      ? xdgCacheHome.trim()
      : path.join(os.homedir(), '.cache')
  return path.join(base, 'gh-pulse', 'cache.db')
}

export async function loadConfig(
  options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Config> {
  const env = options.env ?? process.env
  const configPath = resolveConfigPath(options.path, env)
  const rawText = await fs.readFile(configPath, 'utf8')
  const parsed = YAML.parse(rawText) ?? {}

  // Resolve env placeholders, allowing GITHUB_TOKEN to be missing
  const resolved = resolveEnvPlaceholders(parsed, env, ['GITHUB_TOKEN'])

  const parsedConfig = ConfigSchema.parse(resolved)

  // Resolve GitHub token: config > env > gh CLI
  let githubToken = parsedConfig.github_token
  if (!githubToken || githubToken.trim().length === 0) {
    // Try gh CLI as fallback
    githubToken = getGhCliToken()
  }

  if (!githubToken || githubToken.trim().length === 0) {
    throw new Error(
      'GitHub token not found. Provide github_token in config, set GITHUB_TOKEN env var, or authenticate with `gh auth login`',
    )
  }

  const timezone =
    parsedConfig.timezone.trim().length > 0
      ? parsedConfig.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  return ResolvedConfigSchema.parse({
    ...parsedConfig,
    github_token: githubToken,
    timezone,
    cache: {
      ...parsedConfig.cache,
      path: resolveCachePath(parsedConfig.cache.path, env),
    },
  })
}

function resolveEnvPlaceholders(
  value: unknown,
  env: NodeJS.ProcessEnv,
  allowMissing: string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvPlaceholders(item, env, allowMissing))
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return Object.fromEntries(
      entries.map(([key, val]) => [key, resolveEnvPlaceholders(val, env, allowMissing)]),
    )
  }

  if (typeof value === 'string') {
    return substituteEnv(value, env, allowMissing)
  }

  return value
}

function substituteEnv(value: string, env: NodeJS.ProcessEnv, allowMissing: string[] = []): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
    const replacement = env[name]
    if (!replacement || replacement.trim().length === 0) {
      if (allowMissing.includes(name)) {
        return '' // Return empty string, will be handled by fallback logic
      }
      throw new Error(`Missing environment variable for ${name}`)
    }
    return replacement
  })
}

function expandHome(value: string): string {
  if (!value.startsWith('~')) {
    return value
  }
  return path.join(os.homedir(), value.slice(1))
}

export const CONFIG_SCHEMA = ConfigSchema
