/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Creates and returns a configured McpServer exposing three tools:
 * - `discover` — filtered listing of available Cloud / ES / Kibana API commands
 * - `man`      — full JSON Schema + metadata for a single command
 * - `exec`     — execute a command with a validated input object (or dry-run)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { discover } from './tools/discover.ts'
import { man } from './tools/man.ts'
import { exec } from './tools/exec.ts'
import type { CommandPolicy } from '../config/types.ts'
import { getResolvedConfig } from '../config/store.ts'

// x-release-please-start-version
const SERVER_VERSION = '0.1.0-alpha.1'
// x-release-please-end

/**
 * Converts any tool result to the MCP text-content envelope.
 * Tool callbacks must return `{ content: [{ type: 'text', text: string }] }`.
 */
function textResult (value: unknown): { content: [{ type: 'text'; text: string }] } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }
}

/** Returns the active command policy from the resolved config, if any. */
function getPolicy (): CommandPolicy | undefined {
  return getResolvedConfig()?.commands
}

/**
 * Creates and wires the McpServer.
 * Call `server.connect(transport)` after creating to start serving.
 */
export function createMcpServer (): McpServer {
  const server = new McpServer(
    { name: 'elastic-cli', version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        'This server exposes Elastic Cloud, Elasticsearch, and Kibana HTTP APIs through three tools.',
        'Workflow: 1) discover — search for commands by surface/namespace/keyword.',
        '2) man — fetch the JSON Schema for a specific command ID.',
        '3) exec — invoke the command with validated input.',
        'All API inputs use snake_case keys (as returned by man), not CLI kebab-case flags.',
        'Use dry_run=true in exec to inspect the resolved HTTP request without executing it.',
      ].join(' '),
    },
  )

  // --- discover ---
  server.registerTool(
    'discover',
    {
      description:
        'Search the registry of available Elastic API commands. ' +
        'Filter by surface (es, kb, cloud), namespace, or free-text query. ' +
        'Returns command IDs to use with the man and exec tools.',
      inputSchema: z.object({
        surface: z.enum(['es', 'kb', 'cloud']).optional().describe(
          'API surface: "es" (Elasticsearch), "kb" (Kibana), or "cloud" (Elastic Cloud).'
        ),
        namespace: z.string().optional().describe(
          'Namespace group to filter by (e.g. "indices", "data-views", "hosted.deployments").'
        ),
        query: z.string().optional().describe(
          'Free-text substring search across command IDs and descriptions.'
        ),
        limit: z.number().int().min(1).max(200).optional().describe(
          'Maximum number of results to return (default 50, max 200).'
        ),
        offset: z.number().int().min(0).optional().describe(
          'Number of results to skip for pagination (default 0).'
        ),
      }),
    },
    async (args) => {
      const discoverInput = {
        ...(args.surface != null ? { surface: args.surface } : {}),
        ...(args.namespace != null ? { namespace: args.namespace } : {}),
        ...(args.query != null ? { query: args.query } : {}),
        ...(args.limit != null ? { limit: args.limit } : {}),
        ...(args.offset != null ? { offset: args.offset } : {}),
      }
      const result = discover(discoverInput, getPolicy())
      return textResult(result)
    },
  )

  // --- man ---
  server.registerTool(
    'man',
    {
      description:
        'Return the JSON Schema and HTTP metadata for a specific API command. ' +
        'Use the id from discover. The input_schema shows all accepted fields in ' +
        'snake_case (path params, query params, body params combined).',
      inputSchema: z.object({
        id: z.string().describe('Dot-path command ID as returned by discover (e.g. "stack.es.search").'),
      }),
    },
    async (args) => {
      const result = await man(args)
      return textResult(result)
    },
  )

  // --- exec ---
  server.registerTool(
    'exec',
    {
      description:
        'Execute an Elastic API command. ' +
        'Provide the dot-path id from discover and an input object matching the schema from man. ' +
        'Use dry_run=true to validate inputs and inspect the resolved HTTP request without executing. ' +
        'Credentials are read from the configured elastic context — never pass credentials in input.',
      inputSchema: z.object({
        id: z.string().describe('Dot-path command ID (e.g. "stack.es.search").'),
        input: z.record(z.string(), z.unknown()).optional().describe(
          'Command input using snake_case keys from the man schema.'
        ),
        dry_run: z.boolean().optional().describe(
          'When true, validate inputs and return the resolved HTTP request without executing.'
        ),
        context: z.string().optional().describe(
          'Override the active context for this call (mirrors --use-context).'
        ),
      }),
    },
    async (args) => {
      const execInput = {
        id: args.id,
        ...(args.input != null ? { input: args.input as Record<string, unknown> } : {}),
        ...(args.dry_run != null ? { dry_run: args.dry_run } : {}),
        ...(args.context != null ? { context: args.context } : {}),
      }
      const result = await exec(execInput)
      return textResult(result)
    },
  )

  return server
}
