/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP `exec` tool — validates input and executes an API command.
 *
 * Input uses the same schema keys as `man` returns (snake_case), NOT kebab-case CLI flags.
 * Input validation uses the same rules as the CLI factory:
 *   - passthrough for unknown fields (newer ES params)
 *   - relaxed validation for object/array body fields (ES DSL is too rich to validate client-side)
 *
 * When `dry_run` is true, the tool returns the resolved HTTP request payload instead
 * of executing it — useful for agents to inspect what would be sent.
 */

import { findEntry, toPolicyId } from '../registry.ts'
import type { RegistryEntry } from '../registry.ts'
import { loadDefinitionForEntry, getSchemaArgsForEntry } from './man.ts'
import { validateInput } from '../../lib/validate-input.ts'
import { loadConfig } from '../../config/loader.ts'
import { setResolvedConfig, getResolvedConfig } from '../../config/store.ts'
import { isCommandAllowed } from '../../factory.ts'
import type { JsonValue, ParsedResult } from '../../factory.ts'
import type { SchemaArgDefinition } from '../../lib/schema-args.ts'
import { buildRequestParams } from '../../es/request-builder.ts'
import { buildKibanaRequestParams } from '../../kb/request-builder.ts'
import { buildCloudRequestParams } from '../../cloud/request-builder.ts'
import { createEsHandler } from '../../es/handler.ts'
import { createKbHandler } from '../../kb/handler.ts'
import { createCloudHandler } from '../../cloud/handler.ts'
import type { EsApiDefinition } from '../../es/types.ts'
import type { KbApiDefinition } from '../../kb/types.ts'
import type { CloudApiDefinition } from '../../cloud/types.ts'
import { formatIssuesText } from '../../lib/zod-error.ts'
import { getSchemaForEntry } from './exec-schema.ts'

/** Input for the `exec` tool. */
export interface ExecInput {
  /** Dot-path ID as returned by `discover` (e.g. `es.indices.create`). */
  id: string
  /** Command input using the schema keys returned by `man` (snake_case). */
  input?: Record<string, unknown>
  /**
   * When true, validate all inputs and return the resolved HTTP request payload
   * without executing any network call.
   */
  dry_run?: boolean
  /**
   * Override the active context for this call (mirrors `--use-context`).
   * Uses the default context when omitted.
   */
  context?: string
}

/** Response from a successful `exec` call (non-dry-run). */
export interface ExecSuccess {
  result: JsonValue
}

/** Dry-run response showing the resolved HTTP request. */
export interface ExecDryRun {
  dry_run: true
  request: {
    method: string
    path: string
    querystring?: Record<string, unknown>
    body?: unknown
  }
}

/** Error response envelope. */
export interface ExecError {
  error: { code: string; message: string; issues?: unknown[] }
}

export type ExecResponse = ExecSuccess | ExecDryRun | ExecError

/**
 * Executes a command identified by its dot-path ID.
 *
 * Steps:
 * 1. Look up the registry entry and reject unknown commands.
 * 2. Enforce command policy from the resolved config.
 * 3. Load the full definition and build the Zod input schema.
 * 4. Validate `input` against the schema.
 * 5. If `dry_run`, build and return the request params without sending.
 * 6. Otherwise, dispatch to the surface-specific handler and return the result.
 */
export async function exec (
  input: ExecInput,
  options: { contextName?: string } = {}
): Promise<ExecResponse> {
  const { id, input: cmdInput = {}, dry_run = false, context: contextOverride } = input
  const contextName = contextOverride ?? options.contextName

  const entry = findEntry(id)
  if (entry == null) {
    return {
      error: {
        code: 'unknown_command',
        message: `Unknown command: "${id}". Use the discover tool to list available commands.`,
      },
    }
  }

  // Ensure config is loaded (may already be set by the server entrypoint).
  // If a context override is requested, reload with it.
  if (contextName != null) {
    const loadResult = await loadConfig({ contextName })
    if (loadResult.ok) {
      setResolvedConfig(loadResult.value)
    } else {
      return {
        error: {
          code: 'config_error',
          message: loadResult.error.message,
        },
      }
    }
  }

  const resolvedConfig = getResolvedConfig()

  // Enforce command policy
  if (resolvedConfig?.commands != null && !isCommandAllowed(toPolicyId(id), resolvedConfig.commands)) {
    return {
      error: {
        code: 'command_blocked',
        message: `Command "${id}" is not allowed by the current policy.`,
      },
    }
  }

  // Load full definition and schema
  let def: EsApiDefinition | KbApiDefinition | CloudApiDefinition
  let schemaArgs: SchemaArgDefinition[]
  try {
    def = await loadDefinitionForEntry(entry)
    schemaArgs = await getSchemaArgsForEntry(entry)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: { code: 'internal_error', message } }
  }

  // Build schema and validate input
  const schema = await getSchemaForEntry(entry)

  const validationResult = validateInput(schema, cmdInput, schemaArgs)
  if (!validationResult.ok) {
    return {
      error: {
        code: 'input_validation_failed',
        message: `Input validation failed with ${validationResult.issues.length} issue(s)`,
        issues: validationResult.issues,
      },
    }
  }

  const validatedInput = validationResult.data as Record<string, unknown>

  // Build ParsedResult for the request builders
  const parsed: ParsedResult = {
    options: {},
    ...(resolvedConfig != null ? { config: resolvedConfig } : {}),
    input: validatedInput,
  }

  // Dry-run: return resolved request without sending
  if (dry_run) {
    try {
      const request = buildDryRunRequest(entry, def, parsed, schemaArgs)
      return { dry_run: true, request }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { error: { code: 'internal_error', message } }
    }
  }

  // Execute the command through the surface-specific handler
  try {
    const result = await _dispatchForTest(entry, def, parsed, schemaArgs)
    return { result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: { code: 'internal_error', message } }
  }
}

/**
 * Builds the resolved request params for dry-run mode without executing.
 */
function buildDryRunRequest (
  entry: RegistryEntry,
  def: EsApiDefinition | KbApiDefinition | CloudApiDefinition,
  parsed: ParsedResult,
  schemaArgs: SchemaArgDefinition[],
): ExecDryRun['request'] {
  if (entry.surface === 'es') {
    const params = buildRequestParams(def as EsApiDefinition, parsed, schemaArgs)
    return {
      method: params.method as string,
      path: params.path as string,
      ...(params.querystring != null ? { querystring: params.querystring as Record<string, unknown> } : {}),
      ...(params.body != null ? { body: params.body } :
         params.bulkBody != null ? { body: params.bulkBody } : {}),
    }
  }
  if (entry.surface === 'kb') {
    const params = buildKibanaRequestParams(def as KbApiDefinition, parsed)
    return {
      method: params.method,
      path: params.path,
      ...(params.querystring != null ? { querystring: params.querystring as Record<string, unknown> } : {}),
      ...(params.body != null ? { body: params.body } : {}),
    }
  }
  // cloud
  const params = buildCloudRequestParams(def as CloudApiDefinition, parsed)
  return {
    method: params.method,
    path: params.path,
    ...(params.querystring != null ? { querystring: params.querystring as Record<string, unknown> } : {}),
    ...(params.body != null ? { body: params.body } : {}),
  }
}

/**
 * Dispatches to the correct surface handler and returns the result.
 *
 * Exported for unit testing with stub handlers.
 */
export async function _dispatchForTest (
  entry: RegistryEntry,
  def: EsApiDefinition | KbApiDefinition | CloudApiDefinition,
  parsed: ParsedResult,
  schemaArgs: SchemaArgDefinition[],
  deps: DispatchDeps = defaultDispatchDeps,
): Promise<JsonValue> {
  if (entry.surface === 'es') {
    const handler = deps.createEsHandler(def as EsApiDefinition, schemaArgs)
    return handler(parsed)
  }
  if (entry.surface === 'kb') {
    const handler = deps.createKbHandler(def as KbApiDefinition)
    return handler(parsed)
  }
  // cloud
  const handler = deps.createCloudHandler(def as CloudApiDefinition)
  return handler(parsed)
}

/**
 * Injectable deps for dispatch — overridable in tests to avoid real network calls.
 */
export interface DispatchDeps {
  createEsHandler: typeof createEsHandler
  createKbHandler: typeof createKbHandler
  createCloudHandler: typeof createCloudHandler
}

const defaultDispatchDeps: DispatchDeps = { createEsHandler, createKbHandler, createCloudHandler }

// Export for use in tests
export { formatIssuesText }
