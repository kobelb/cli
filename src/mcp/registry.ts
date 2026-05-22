/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified dot-path inventory for all Cloud, Elasticsearch, and Kibana HTTP APIs.
 *
 * The registry is built from the same lightweight manifests and definition arrays
 * the CLI uses, so MCP tool IDs exactly match CLI dot-paths (e.g. the CLI command
 * `elastic stack es indices create` has MCP ID `stack.es.indices.create`).
 *
 * Three surfaces:
 * - `es`    — Elasticsearch (from `apiManifest`, 560+ commands)
 * - `kb`    — Kibana (from `kbApiManifest`, 500+ commands)
 * - `cloud` — Elastic Cloud hosted + serverless (from `allCloudApis` + `allServerlessApis`, 151 commands)
 *
 * Registry entries are built once lazily and reused across all tool calls.
 */

import { apiManifest } from '../es/apis.ts'
import type { EsApiMeta } from '../es/api-manifest.ts'
import { kbApiManifest } from '../kb/apis.ts'
import type { KbApiMeta } from '../kb/api-manifest.ts'
import { allCloudApis } from '../cloud/apis.ts'
import { allServerlessApis } from '../cloud/serverless-apis.ts'
import type { CloudApiDefinition } from '../cloud/types.ts'
import { cloudDotPath } from '../cloud/dot-path.ts'

/** Which API surface a registry entry belongs to. */
export type Surface = 'es' | 'kb' | 'cloud'

/**
 * A single entry in the MCP command registry.
 * Carries enough information to serve `discover` without loading full definitions.
 */
export interface RegistryEntry {
  /** Stable dot-path identifier matching the CLI command path (e.g. `stack.es.indices.create`). */
  id: string
  /** API surface. */
  surface: Surface
  /** Namespace group within the surface (e.g. `indices`, `data-views`, `hosted.deployments`). */
  namespace: string | null
  /** One-line description of the command. */
  description: string
  /** HTTP method. */
  method: string
  /** URL path template (e.g. `/{index}/_search`). */
  path: string
  /** When `text`, the response body is plain text (ES cat APIs). */
  responseType?: 'text'
  /** When `ndjson`, the request body uses NDJSON format (ES bulk/msearch). */
  bodyFormat?: 'ndjson'
  /**
   * The namespace file (for ES) or namespace (for KB) used to lazy-load the full definition.
   * For cloud, the full definition is already in memory.
   */
  namespaceFile?: string
  /** ES-only: the `name` key in the manifest (for locating the definition inside the namespace file). */
  esName?: string
  /** Cloud-only: the raw codegen `namespace` before renaming (needed to load the definition). */
  cloudNamespace?: string
  /** Cloud-only: the raw codegen `name` before command renaming (needed to load the definition). */
  cloudName?: string
}

/**
 * Build the full registry from the manifests and Cloud definition arrays.
 * Called once and cached — does not load any Zod schemas.
 */
function buildRegistry (): RegistryEntry[] {
  const entries: RegistryEntry[] = []

  // --- Elasticsearch ---
  for (const meta of apiManifest) {
    const ns = meta.namespace ?? null
    const id = ns != null ? `stack.es.${ns}.${meta.name}` : `stack.es.${meta.name}`
    const entry: RegistryEntry = {
      id,
      surface: 'es',
      namespace: ns,
      description: meta.description,
      method: meta.method,
      path: meta.path,
      namespaceFile: meta.namespaceFile,
      esName: meta.name,
    }
    if (meta.responseType === 'text') entry.responseType = 'text'
    if (meta.bodyFormat === 'ndjson') entry.bodyFormat = 'ndjson'
    entries.push(entry)
  }

  // --- Kibana ---
  for (const meta of kbApiManifest) {
    const id = `stack.kb.${meta.namespace}.${meta.name}`
    entries.push({
      id,
      surface: 'kb',
      namespace: meta.namespace,
      description: meta.description,
      method: meta.method,
      path: meta.path,
      namespaceFile: meta.namespaceFile,
      esName: meta.name,
    })
  }

  // --- Cloud ---
  const allCloudDefs: CloudApiDefinition[] = [...allCloudApis, ...allServerlessApis]
  for (const def of allCloudDefs) {
    const id = cloudDotPath(def.namespace, def.name)
    // Extract the namespace portion of the dot-path for filtering
    // e.g. `cloud.trust.get-current-account` → `trust`
    const dotParts = id.split('.')
    // id starts with `cloud.`, remove first element then all but last
    const nsDisplay = dotParts.length > 2
      ? dotParts.slice(1, -1).join('.')
      : null
    entries.push({
      id,
      surface: 'cloud',
      namespace: nsDisplay,
      description: def.description,
      method: def.method,
      path: def.path,
      cloudNamespace: def.namespace,
      cloudName: def.name,
    })
  }

  return entries
}

let _registry: RegistryEntry[] | undefined

/**
 * Returns the singleton registry, building it on first call.
 * Subsequent calls return the cached instance (no schema loading involved).
 */
export function getRegistry (): RegistryEntry[] {
  if (_registry == null) _registry = buildRegistry()
  return _registry
}

/**
 * Look up a single registry entry by its dot-path ID.
 * Returns `undefined` if the ID is unknown.
 */
export function findEntry (id: string): RegistryEntry | undefined {
  return getRegistry().find((e) => e.id === id)
}

// Re-export manifest meta types for use by tools
export type { EsApiMeta, KbApiMeta, CloudApiDefinition }
