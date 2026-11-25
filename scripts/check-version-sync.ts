#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface VersionSyncTarget {
  name: string
  packageJsonPath: string
  sourcePath: string
  sourcePattern: RegExp
}

interface MarketplacePlugin {
  name: string
  version: string
}

interface MarketplaceJson {
  plugins: MarketplacePlugin[]
}

const targets: VersionSyncTarget[] = [
  {
    name: '@alleneubank/gh-pulse-core',
    packageJsonPath: 'packages/core/package.json',
    sourcePath: 'packages/core/src/index.ts',
    sourcePattern: /export const VERSION = ['"]([^'"]+)['"]/,
  },
]

async function checkSourceVersions(cwd: string): Promise<string[]> {
  const results = await Promise.all(
    targets.map(async (target) => {
      const packageJsonRaw = await readFile(resolve(cwd, target.packageJsonPath), 'utf8')
      const pkg = JSON.parse(packageJsonRaw) as { version?: string }
      const expectedVersion = pkg.version
      if (!expectedVersion) {
        throw new Error(`Missing version in ${target.packageJsonPath}`)
      }

      const source = await readFile(resolve(cwd, target.sourcePath), 'utf8')
      const match = source.match(target.sourcePattern)
      const sourceVersion = match?.[1]
      if (!sourceVersion) {
        throw new Error(`Could not find VERSION constant in ${target.sourcePath}`)
      }

      if (sourceVersion !== expectedVersion) {
        return `${target.name}: ${target.sourcePath} has VERSION=${sourceVersion}, but ${target.packageJsonPath} has version=${expectedVersion}`
      }
      return null
    }),
  )
  return results.filter((r): r is string => r !== null)
}

async function checkPluginVersion(cwd: string): Promise<string[]> {
  const cliPkgRaw = await readFile(resolve(cwd, 'apps/cli/package.json'), 'utf8')
  const cliPkg = JSON.parse(cliPkgRaw) as { version?: string }
  const cliVersion = cliPkg.version
  if (!cliVersion) {
    throw new Error('Missing version in apps/cli/package.json')
  }

  const marketplaceRaw = await readFile(resolve(cwd, '.claude-plugin/marketplace.json'), 'utf8')
  const marketplace = JSON.parse(marketplaceRaw) as MarketplaceJson
  const plugin = marketplace.plugins.find((p) => p.name === 'gh-pulse')
  if (!plugin) {
    throw new Error('gh-pulse plugin not found in .claude-plugin/marketplace.json')
  }

  if (plugin.version !== cliVersion) {
    return [
      `plugin: .claude-plugin/marketplace.json has version=${plugin.version}, but apps/cli/package.json has version=${cliVersion}. Run: bun scripts/sync-versions.ts`,
    ]
  }
  return []
}

async function run(): Promise<void> {
  const cwd = process.cwd()
  const [sourceIssues, pluginIssues] = await Promise.all([
    checkSourceVersions(cwd),
    checkPluginVersion(cwd),
  ])

  const mismatches = [...sourceIssues, ...pluginIssues]

  if (mismatches.length > 0) {
    throw new Error(`Version sync check failed:\n${mismatches.join('\n')}`)
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
