/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP `man` tool — returns the full JSON Schema and transport metadata for one command.
 *
 * The `input_schema` returned here is exactly what `elastic <cmd> --help --json` emits:
 * a JSON Schema derived from the command's Zod input schema, with `found_in` routing
 * metadata stripped so agents only see user-facing field descriptions.
 */

import { z } from 'zod'
import { findEntry } from '../registry.ts'
import type { RegistryEntry, Surface } from '../registry.ts'
import { loadEsApi } from '../../es/apis.ts'
import { loadKbApi } from '../../kb/apis.ts'
import { allCloudApis } from '../../cloud/apis.ts'
import { allServerlessApis } from '../../cloud/serverless-apis.ts'
import type { EsApiDefinition } from '../../es/types.ts'
import type { KbApiDefinition } from '../../kb/types.ts'
import type { CloudApiDefinition } from '../../cloud/types.ts'
import { resolveInput } from '../../es/types.ts'
import { buildCommandSchema as buildKbSchema } from '../../kb/register.ts'
import { buildCommandSchema as buildCloudSchema } from '../../cloud/register.ts'
import { extractSchemaArgs } from '../../lib/schema-args.ts'
import { stripTransportMeta } from '../../factory.ts'
import type { JsonValue } from '../../factory.ts'

/** Input for the `man` tool. */
export interface ManInput {
  /** Dot-path ID as returned by `discover` (e.g. `es.indices.create`). */
  id: string
}

/** Response from the `man` tool. */
export interface ManResponse {
  id: string
  surface: Surface
  description: string
  method: string
  /** HTTP path template (e.g. `/{index}/_search`). */
  path: string
  /**
   * JSON Schema for the command's input. Fields use snake_case (same as the
   * CLI's stdin/`--input-file` format, NOT kebab-case CLI flags).
   * `found_in` transport routing metadata is stripped.
   */
  input_schema: JsonValue
  /** Present when the response is plain text (ES cat APIs). */
  response_type?: 'text'
  /** Present when the request body uses NDJSON format (ES bulk/msearch). */
  body_format?: 'ndjson'
}

/** Error response when the command ID is unknown. */
export interface ManError {
  error: { code: 'unknown_command'; message: string }
}

/**
 * Finds and loads the full API definition for a registry entry, then
 * builds and returns the ManResponse.
 */
export async function man (input: ManInput): Promise<ManResponse | ManError> {
  const entry = findEntry(input.id)
  if (entry == null) {
    return {
      error: {
        code: 'unknown_command',
        message: `Unknown command: "${input.id}". Use the discover tool to list available commands.`,
      },
    }
  }

  try {
    const schema = await buildSchemaForEntry(entry)
    const jsonSchema = stripTransportMeta(
      z.toJSONSchema(schema, { reused: 'ref', target: 'draft-7' }) as JsonValue
    )

    const response: ManResponse = {
      id: entry.id,
      surface: entry.surface,
      description: entry.description,
      method: entry.method,
      path: entry.path,
      input_schema: jsonSchema,
    }
    if (entry.responseType === 'text') response.response_type = 'text'
    if (entry.bodyFormat === 'ndjson') response.body_format = 'ndjson'
    return response
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: { code: 'unknown_command' as const, message } }
  }
}

/**
 * Builds the Zod input schema for a registry entry by surface:
 * - ES: lazy-load the definition and resolve `def.input`
 * - KB: lazy-load the definition and call `buildCommandSchema(def)`
 * - Cloud: find the definition in the in-memory registry and call `buildCommandSchema(def)`
 */
async function buildSchemaForEntry (entry: RegistryEntry): Promise<z.ZodObject<z.ZodRawShape>> {
  if (entry.surface === 'es') {
    return buildEsSchema(entry)
  }
  if (entry.surface === 'kb') {
    return buildKbSchemaForEntry(entry)
  }
  return buildCloudSchemaForEntry(entry)
}

async function buildEsSchema (entry: RegistryEntry): Promise<z.ZodObject<z.ZodRawShape>> {
  // Construct the meta-like object needed by loadEsApi
  const meta = {
    name: entry.esName!,
    namespace: entry.namespace,
    namespaceFile: entry.namespaceFile!,
    description: entry.description,
    method: entry.method as EsApiDefinition['method'],
    path: entry.path,
  }
  const def = await loadEsApi(meta)
  if (def.input == null) return z.looseObject({})
  return resolveInput(def.input)
}

async function buildKbSchemaForEntry (entry: RegistryEntry): Promise<z.ZodObject<z.ZodRawShape>> {
  const meta = {
    name: entry.esName!,
    namespace: entry.namespace!,
    namespaceFile: entry.namespaceFile!,
    description: entry.description,
    method: entry.method as KbApiDefinition['method'],
    path: entry.path,
  }
  const def = await loadKbApi(meta)
  return buildKbSchema(def)
}

function buildCloudSchemaForEntry (entry: RegistryEntry): z.ZodObject<z.ZodRawShape> {
  const allDefs: CloudApiDefinition[] = [...allCloudApis, ...allServerlessApis]
  const def = allDefs.find(
    (d) => d.namespace === entry.cloudNamespace && d.name === entry.cloudName
  )
  if (def == null) {
    throw new Error(`Cloud definition not found: ${entry.cloudNamespace}/${entry.cloudName}`)
  }
  return buildCloudSchema(def)
}

/**
 * Returns the pre-computed schema args for a definition.
 * Used by the `exec` tool to route input fields.
 */
export async function getSchemaArgsForEntry (entry: RegistryEntry) {
  const schema = await buildSchemaForEntry(entry)
  return extractSchemaArgs(schema)
}

/**
 * Returns the full API definition for the given registry entry.
 * The definition object shape varies by surface — callers must narrow by `entry.surface`.
 */
export async function loadDefinitionForEntry (
  entry: RegistryEntry
): Promise<EsApiDefinition | KbApiDefinition | CloudApiDefinition> {
  if (entry.surface === 'es') {
    const meta = {
      name: entry.esName!,
      namespace: entry.namespace,
      namespaceFile: entry.namespaceFile!,
      description: entry.description,
      method: entry.method as EsApiDefinition['method'],
      path: entry.path,
    }
    return loadEsApi(meta)
  }
  if (entry.surface === 'kb') {
    const meta = {
      name: entry.esName!,
      namespace: entry.namespace!,
      namespaceFile: entry.namespaceFile!,
      description: entry.description,
      method: entry.method as KbApiDefinition['method'],
      path: entry.path,
    }
    return loadKbApi(meta)
  }
  // cloud
  const allDefs: CloudApiDefinition[] = [...allCloudApis, ...allServerlessApis]
  const def = allDefs.find(
    (d) => d.namespace === entry.cloudNamespace && d.name === entry.cloudName
  )
  if (def == null) {
    throw new Error(`Cloud definition not found: ${entry.cloudNamespace}/${entry.cloudName}`)
  }
  return def
}
