#!/usr/bin/env bun

/**
 * Propagates versions that changesets bumps in package.json out to the places that restate them.
 * Run after `changeset version`, via `bun run version`.
 *
 * Two targets, both enforced by `scripts/check-version-sync.ts`:
 *   - source `VERSION` constants, against their own package's version
 *   - the Claude Code plugin marketplace entry, against the CLI package version
 *
 * The source-constant half exists because the checker enforced that invariant while nothing
 * maintained it, so every core bump left the tree failing until someone hand-edited the constant.
 * Anything the checker asserts belongs here too.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const cwd = process.cwd()

const CLI_PACKAGE_JSON = resolve(cwd, 'apps/cli/package.json')
const MARKETPLACE_JSON = resolve(cwd, '.claude-plugin/marketplace.json')

interface SourceVersionTarget {
  name: string
  packageJsonPath: string
  sourcePath: string
  /** Must capture the version in group 1; kept identical to the checker's pattern. */
  sourcePattern: RegExp
}

/** Keep in step with `targets` in scripts/check-version-sync.ts. */
const SOURCE_TARGETS: SourceVersionTarget[] = [
  {
    name: '@alleneubank/gh-pulse-core',
    packageJsonPath: 'packages/core/package.json',
    sourcePath: 'packages/core/src/index.ts',
    sourcePattern: /export const VERSION = ['"]([^'"]+)['"]/,
  },
]

interface PackageJson {
  version: string
}

interface MarketplacePlugin {
  name: string
  description: string
  version: string
  author: { name: string }
  source: string
  category: string
  homepage: string
}

interface MarketplaceJson {
  $schema: string
  name: string
  owner: { name: string }
  metadata: { description: string }
  plugins: MarketplacePlugin[]
}

async function readVersion(path: string): Promise<string> {
  const pkg = JSON.parse(await readFile(path, 'utf8')) as Partial<PackageJson>
  if (!pkg.version) throw new Error(`Missing version in ${path}`)
  return pkg.version
}

async function syncSourceVersions(): Promise<void> {
  for (const target of SOURCE_TARGETS) {
    const expected = await readVersion(resolve(cwd, target.packageJsonPath))
    const sourceFile = resolve(cwd, target.sourcePath)
    const source = await readFile(sourceFile, 'utf8')

    const match = target.sourcePattern.exec(source)
    const current = match?.[1]
    if (match === null || current === undefined) {
      throw new Error(`Could not find VERSION constant in ${target.sourcePath}`)
    }

    if (current === expected) {
      console.log(`${target.name} VERSION already in sync: ${expected}`)
      continue
    }

    console.log(`syncing ${target.name} VERSION: ${current} -> ${expected}`)
    // Replace only inside the matched declaration so an unrelated occurrence of the same
    // version string elsewhere in the file is left alone.
    const updated =
      source.slice(0, match.index) +
      match[0].replace(current, expected) +
      source.slice(match.index + match[0].length)
    await writeFile(sourceFile, updated, 'utf8')
    console.log(`${target.sourcePath} updated`)
  }
}

async function syncPluginVersion(): Promise<void> {
  const cliVersion = await readVersion(CLI_PACKAGE_JSON)

  const marketplaceRaw = await readFile(MARKETPLACE_JSON, 'utf8')
  const marketplace = JSON.parse(marketplaceRaw) as MarketplaceJson

  const plugin = marketplace.plugins.find((p) => p.name === 'gh-pulse')
  if (!plugin) {
    throw new Error('gh-pulse plugin not found in marketplace.json')
  }

  if (plugin.version === cliVersion) {
    console.log(`plugin version already in sync: ${cliVersion}`)
    return
  }

  console.log(`syncing plugin version: ${plugin.version} -> ${cliVersion}`)
  plugin.version = cliVersion

  await writeFile(MARKETPLACE_JSON, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
  console.log('marketplace.json updated')
}

async function run(): Promise<void> {
  await syncSourceVersions()
  await syncPluginVersion()
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
