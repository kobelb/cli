/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Cloud CLI tree namespace/command renaming logic.
 *
 * Used by both `register.ts` (Commander tree construction) and `src/mcp/registry.ts`
 * (dot-path inventory) so that MCP IDs stay in sync with CLI dot-paths.
 */

/**
 * Maps project-type namespaces from codegen to short CLI group names.
 * E.g. `elasticsearch-projects` → `search`.
 */
export const PROJECT_NAMESPACES: Readonly<Record<string, string>> = {
  'elasticsearch-projects': 'search',
  'observability-projects': 'observability',
  'security-projects': 'security',
}

/**
 * Cross-cutting namespaces promoted to direct children of `cloud`.
 * Values are the display names shown in the CLI tree.
 */
export const PROMOTED_NAMESPACES: ReadonlyMap<string, string> = new Map([
  ['accounts',              'trust'],
  ['authentication',        'auth'],
  ['organizations',         'orgs'],
  ['user-role-assignments', 'users'],
  ['billing-costs-analysis','billing'],
])

/**
 * Serverless namespaces merged into a single `cross-project` group.
 */
export const CROSS_PROJECT_NAMESPACES: ReadonlySet<string> = new Set([
  'linked-projects',
  'linked-candidate-projects',
])

/**
 * Display name overrides for hosted namespaces.
 */
export const HOSTED_NAMESPACE_RENAMES: ReadonlyMap<string, string> = new Map([
  ['deployments-traffic-filter', 'traffic-filters'],
])

/**
 * Namespaces that belong under `cloud serverless`.
 */
export const SERVERLESS_NAMESPACES: ReadonlySet<string> = new Set([
  'elasticsearch-projects',
  'observability-projects',
  'security-projects',
  'regions',
  'traffic-filters',
  'linked-projects',
  'linked-candidate-projects',
])

/**
 * Strips the project-type identifier from a codegen command name to produce
 * a short action name for the restructured tree.
 *
 * @example
 * simplifyProjectCommandName('list-elasticsearch-projects', 'elasticsearch-projects') // 'list'
 * simplifyProjectCommandName('reset-elasticsearch-project-credentials', 'elasticsearch-projects') // 'reset-credentials'
 */
export function simplifyProjectCommandName (name: string, namespace: string): string {
  const singular = namespace.endsWith('s') ? namespace.slice(0, -1) : namespace
  let simplified = name.replace(`-${namespace}`, '')
  if (simplified === name) {
    simplified = name.replace(`-${singular}`, '')
  }
  return simplified || name
}

/** Classifies a Cloud API definition's namespace into tree partition. */
export type CloudPartition = 'promoted' | 'hosted' | 'serverless'

/** Returns the partition that a Cloud API namespace belongs to. */
export function getCloudPartition (namespace: string): CloudPartition {
  if (PROMOTED_NAMESPACES.has(namespace)) return 'promoted'
  if (SERVERLESS_NAMESPACES.has(namespace)) return 'serverless'
  return 'hosted'
}

/**
 * Computes the dot-path CLI ID for a Cloud API definition.
 *
 * Examples:
 * - promoted:     `accounts` / `get-current-account`   → `cloud.trust.get-current-account`
 * - hosted:       `deployments` / `list-deployments`    → `cloud.hosted.deployments.list-deployments`
 * - serverless project: `elasticsearch-projects` / `list-elasticsearch-projects` → `cloud.serverless.projects.search.list`
 * - serverless cross: `linked-projects` / `get-link`   → `cloud.serverless.cross-project.get-link`
 * - serverless other: `regions` / `list-regions`       → `cloud.serverless.regions.list-regions`
 */
export function cloudDotPath (namespace: string, commandName: string): string {
  const partition = getCloudPartition(namespace)

  if (partition === 'promoted') {
    const displayNs = PROMOTED_NAMESPACES.get(namespace)!
    return `cloud.${displayNs}.${commandName}`
  }

  if (partition === 'hosted') {
    const displayNs = HOSTED_NAMESPACE_RENAMES.get(namespace) ?? namespace
    return `cloud.hosted.${displayNs}.${commandName}`
  }

  // serverless
  if (PROJECT_NAMESPACES[namespace] != null) {
    const typeShort = PROJECT_NAMESPACES[namespace]!
    const shortCmd = simplifyProjectCommandName(commandName, namespace)
    return `cloud.serverless.projects.${typeShort}.${shortCmd}`
  }

  if (CROSS_PROJECT_NAMESPACES.has(namespace)) {
    return `cloud.serverless.cross-project.${commandName}`
  }

  return `cloud.serverless.${namespace}.${commandName}`
}
