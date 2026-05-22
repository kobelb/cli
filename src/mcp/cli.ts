#!/usr/bin/env node
/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Entry point for the `elastic-mcp` binary.
 *
 * Parses minimal global flags (--config-file, --use-context, --command-profile),
 * loads the elastic config, then starts the MCP server over stdio.
 */

import { Command } from 'commander'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from '../config/loader.ts'
import { setResolvedConfig } from '../config/store.ts'
import { BUILT_IN_PROFILES } from '../config/profiles.ts'
import type { BuiltInProfile } from '../config/profiles.ts'
import { createMcpServer } from './server.ts'

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
  .allowUnknownOption(false)

program.action(async () => {
  const { configFile: configPath, useContext: contextName, commandProfile: profileName } = program.opts()
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

  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
})

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
})
