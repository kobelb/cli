/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP `discover` tool — filtered listing of available API commands.
 *
 * Agents use `discover` to enumerate available commands before calling `man`
 * (to read the schema) and `exec` (to invoke a command).
 */

import { getRegistry, toPolicyId } from '../registry.ts'
import type { RegistryEntry, Surface } from '../registry.ts'
import { isCommandAllowed } from '../../factory.ts'
import type { CommandPolicy } from '../../config/types.ts'

/** Input parameters for the `discover` tool. */
export interface DiscoverInput {
  /** Filter to a specific surface. */
  surface?: Surface
  /** Filter to a specific namespace within a surface (exact or prefix match). */
  namespace?: string
  /** Free-text substring search across command IDs and descriptions. */
  query?: string
  /** Maximum number of results to return (default 50, max 200). */
  limit?: number
  /** Number of results to skip for pagination (default 0). */
  offset?: number
}

/** A single result entry returned by the `discover` tool. */
export interface DiscoverResult {
  /** Dot-path identifier used in `man` and `exec` calls. */
  id: string
  /** API surface (`es`, `kb`, or `cloud`). */
  surface: Surface
  /** Namespace group within the surface. */
  namespace: string | null
  /** One-line description. */
  description: string
  /** HTTP method. */
  method: string
  /** URL path template. */
  path: string
}

/** Response envelope for the `discover` tool. */
export interface DiscoverResponse {
  /** Total number of matching commands (before pagination). */
  total: number
  /** Commands matching the filters (paginated). */
  results: DiscoverResult[]
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * Runs the discover query and returns a structured response.
 *
 * @param input - filter/pagination parameters
 * @param policy - optional command policy from the resolved config
 */
export function discover (input: DiscoverInput, policy?: CommandPolicy): DiscoverResponse {
  const { surface, namespace, query, limit: rawLimit, offset: rawOffset } = input
  const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const offset = rawOffset ?? 0

  const queryLower = query != null ? query.toLowerCase() : undefined
  const namespaceLower = namespace != null ? namespace.toLowerCase() : undefined

  const all = getRegistry()
  const matched: RegistryEntry[] = []

  for (const entry of all) {
    if (surface != null && entry.surface !== surface) continue
    if (namespaceLower != null) {
      const ns = entry.namespace?.toLowerCase() ?? ''
      if (!ns.startsWith(namespaceLower) && !entry.id.toLowerCase().includes(`.${namespaceLower}.`)) {
        continue
      }
    }
    if (queryLower != null) {
      const haystack = `${entry.id} ${entry.description}`.toLowerCase()
      if (!haystack.includes(queryLower)) continue
    }
    if (!isCommandAllowed(toPolicyId(entry.id), policy)) continue
    matched.push(entry)
  }

  const page = matched.slice(offset, offset + limit)

  return {
    total: matched.length,
    results: page.map((e) => ({
      id: e.id,
      surface: e.surface,
      namespace: e.namespace,
      description: e.description,
      method: e.method,
      path: e.path,
    })),
  }
}
