#!/usr/bin/env node
/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Entry point for the `elastic-mcp` binary.
 *
 * Parses minimal global flags (--config-file, --use-context, --command-profile,
 * --transport, --port, --host), loads the elastic config, then starts the MCP
 * server over the chosen transport (stdio or Streamable HTTP).
 */

import { Command } from 'commander'
import { z } from 'zod'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from '../config/loader.ts'
import { setResolvedConfig } from '../config/store.ts'
import { BUILT_IN_PROFILES } from '../config/profiles.ts'
import type { BuiltInProfile } from '../config/profiles.ts'
import { createMcpServer, TOOL_NAMES } from './server.ts'
import type { ToolName } from './server.ts'
import { startMcpHttpServer } from './http.ts'

const TransportSchema = z.enum(['stdio', 'http'])
const PortSchema = z.coerce.number().int().min(0).max(65535)
const ToolNameSchema = z.enum(TOOL_NAMES)

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * Parses the `--tools` argument value. Returns the deduplicated list of tools,
 * or an Error explaining what was wrong with the input.
 *
 * Exported only for unit tests; not part of the stable public API.
 */
export function parseToolsArg (raw: string): readonly ToolName[] | Error {
  const names = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  if (names.length === 0) {
    return new Error(`--tools must specify at least one tool name (valid: ${TOOL_NAMES.join(', ')})`)
  }
  const result = new Set<ToolName>()
  for (const name of names) {
    const parsed = ToolNameSchema.safeParse(name)
    if (!parsed.success) {
      return new Error(`--tools contains unknown tool "${name}" (valid: ${TOOL_NAMES.join(', ')})`)
    }
    result.add(parsed.data)
  }
  return [...result]
}

const program = new Command()
program
  .name('elastic-mcp')
  .description('MCP server exposing Elastic Cloud, Elasticsearch, and Kibana HTTP APIs.')
  .option('--config-file <path>', 'path to a config file (default: ~/.elasticrc.yml)')
  .option('--use-context <name>', 'override the active context from the config file')
  .option(
    '--command-profile <name>',
    `restrict available commands to a deployment profile (${BUILT_IN_PROFILES.join(', ')})`
  )
  .option('--transport <stdio|http>', 'transport to use: "stdio" (default) or "http" (Streamable HTTP)', 'stdio')
  .option('--port <number>', 'port for the HTTP transport (default: 4319; 0 = OS-assigned)', '4319')
  .option('--host <address>', 'bind address for the HTTP transport (default: 127.0.0.1)', '127.0.0.1')
  .option(
    '--tools <list>',
    `comma-separated tools to expose (default: all). Valid: ${TOOL_NAMES.join(', ')}`
  )
  .allowUnknownOption(false)

program.action(async () => {
  const {
    configFile: configPath,
    useContext: contextName,
    commandProfile: profileName,
    transport: rawTransport,
    port: rawPort,
    host,
    tools: rawTools,
  } = program.opts<{
    configFile?: string
    useContext?: string
    commandProfile?: string
    transport: string
    port: string
    host: string
    tools?: string
  }>()

  // Validate transport
  const transportResult = TransportSchema.safeParse(rawTransport)
  if (!transportResult.success) {
    process.stderr.write(`Error: --transport must be "stdio" or "http", got "${rawTransport}"\n`)
    process.exit(1)
  }
  const transport = transportResult.data

  // Validate port (only meaningful for http, but validate early)
  const portResult = PortSchema.safeParse(rawPort)
  if (!portResult.success) {
    process.stderr.write(`Error: --port must be an integer between 0 and 65535, got "${rawPort}"\n`)
    process.exit(1)
  }
  const port = portResult.data

  // Validate --tools (if provided). Fail-loud on unknown tools so users
  // notice typos instead of silently getting a partial server.
  let tools: readonly ToolName[] | undefined
  if (rawTools != null) {
    const parsed = parseToolsArg(rawTools)
    if (parsed instanceof Error) {
      process.stderr.write(`Error: ${parsed.message}\n`)
      process.exit(1)
    }
    tools = parsed
  }

  const typedProfileName = profileName as BuiltInProfile | undefined

  const result = await loadConfig({
    ...(configPath != null ? { configPath } : {}),
    ...(contextName != null ? { contextName } : {}),
    ...(typedProfileName != null ? { profileName: typedProfileName } : {}),
  })

  if (result.ok) {
    setResolvedConfig(result.value)
  } else {
    // Config errors are non-fatal: the server still starts; tool calls that
    // require auth will return missing_config errors at runtime.
    process.stderr.write(`Warning: ${result.error.message}\n`)
  }

  if (transport === 'stdio') {
    const server = createMcpServer(tools != null ? { tools } : {})
    await server.connect(new StdioServerTransport())
  } else {
    if (!LOOPBACK_HOSTS.has(host)) {
      process.stderr.write(
        `Warning: binding to ${host} without authentication. ` +
        'Restrict access via firewall or use --host 127.0.0.1.\n'
      )
    }
    const running = await startMcpHttpServer({ host, port, ...(tools != null ? { tools } : {}) })
    process.stderr.write(`elastic-mcp listening on http://${host}:${running.port}/mcp\n`)

    const shutdown = (): void => {
      running.close().catch((err: unknown) => {
        process.stderr.write(`Error during shutdown: ${String(err)}\n`)
      }).finally(() => process.exit(0))
    }
    if (process.platform !== 'win32') {
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    }
  }
})

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
})
