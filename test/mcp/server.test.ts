/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Protocol smoke test for the MCP server.
 *
 * Spawns the compiled `dist/mcp/cli.js` binary, exchanges JSON-RPC messages
 * over stdio, and asserts the structure of the responses. No Elastic services
 * are needed — only the binary must be compiled before this test runs.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BINARY = path.join(__dirname, '../../dist/mcp/cli.js')

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: string
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * Spawns the MCP server and returns a helper for sending/receiving JSON-RPC messages.
 */
function spawnServer () {
  const child = spawn('node', [BINARY], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const rl = createInterface({ input: child.stdout! })
  const pending = new Map<number, (msg: JsonRpcResponse) => void>()

  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line) as JsonRpcResponse
      const resolve = pending.get(msg.id)
      if (resolve != null) {
        pending.delete(msg.id)
        resolve(msg)
      }
    } catch {
      // ignore non-JSON lines (e.g. warnings)
    }
  })

  const send = (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    return new Promise((resolve) => {
      pending.set(req.id, resolve)
      child.stdin!.write(JSON.stringify(req) + '\n')
    })
  }

  const close = () => {
    child.stdin!.end()
    child.kill()
  }

  return { send, close, child }
}

describe('MCP server protocol smoke test', () => {
  let server: ReturnType<typeof spawnServer>

  before(() => {
    server = spawnServer()
  })

  after(() => {
    server.close()
  })

  it('responds to initialize', async () => {
    const response = await server.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      },
    })
    assert.ok(response.result != null, 'expected result')
    const result = response.result as Record<string, unknown>
    assert.ok(result.protocolVersion, 'missing protocolVersion')
    assert.ok(result.serverInfo, 'missing serverInfo')
    const serverInfo = result.serverInfo as Record<string, unknown>
    assert.equal(serverInfo.name, 'elastic-cli')
  })

  it('responds to tools/list with three tools', async () => {
    const response = await server.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })
    assert.ok(response.result != null, `expected result, got: ${JSON.stringify(response)}`)
    const result = response.result as Record<string, unknown>
    const tools = result.tools as Array<{ name: string; description: string }>
    assert.ok(Array.isArray(tools), 'tools must be an array')
    assert.equal(tools.length, 3, `expected 3 tools, got ${tools.length}`)
    const names = tools.map(t => t.name).sort()
    assert.deepEqual(names, ['discover', 'exec', 'man'])
  })

  it('tools/call discover returns results', async () => {
    const response = await server.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'discover',
        arguments: { surface: 'es', query: 'search', limit: 5 },
      },
    })
    assert.ok(response.result != null, `expected result, got: ${JSON.stringify(response)}`)
    const result = response.result as Record<string, unknown>
    const content = result.content as Array<{ type: string; text: string }>
    assert.ok(Array.isArray(content), 'content must be array')
    assert.equal(content[0]!.type, 'text')
    const data = JSON.parse(content[0]!.text) as { total: number; results: unknown[] }
    assert.ok(typeof data.total === 'number' && data.total > 0, 'expected non-zero total')
    assert.ok(Array.isArray(data.results) && data.results.length <= 5, 'expected ≤5 results')
  })

  it('tools/call man returns schema for es.search', async () => {
    const response = await server.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'man',
        arguments: { id: 'es.search' },
      },
    })
    assert.ok(response.result != null, `expected result, got: ${JSON.stringify(response)}`)
    const result = response.result as Record<string, unknown>
    const content = result.content as Array<{ type: string; text: string }>
    assert.equal(content[0]!.type, 'text')
    const data = JSON.parse(content[0]!.text) as Record<string, unknown>
    assert.equal(data.id, 'es.search')
    assert.equal(data.surface, 'es')
    assert.ok(data.input_schema != null, 'expected input_schema')
    // found_in must not appear in schema
    assert.ok(!JSON.stringify(data.input_schema).includes('"found_in"'), 'found_in leaked into schema')
  })

  it('tools/call man returns error for unknown id', async () => {
    const response = await server.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'man',
        arguments: { id: 'nonexistent.command' },
      },
    })
    assert.ok(response.result != null, `expected result, got: ${JSON.stringify(response)}`)
    const result = response.result as Record<string, unknown>
    const content = result.content as Array<{ type: string; text: string }>
    const data = JSON.parse(content[0]!.text) as Record<string, unknown>
    assert.ok('error' in data, 'expected error object')
    const err = data.error as Record<string, unknown>
    assert.equal(err.code, 'unknown_command')
  })

  it('tools/call exec dry_run returns resolved request', async () => {
    const response = await server.send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'exec',
        arguments: {
          id: 'es.search',
          input: { index: 'test-index' },
          dry_run: true,
        },
      },
    })
    assert.ok(response.result != null, `expected result, got: ${JSON.stringify(response)}`)
    const result = response.result as Record<string, unknown>
    const content = result.content as Array<{ type: string; text: string }>
    const data = JSON.parse(content[0]!.text) as Record<string, unknown>
    // Missing config means missing_config error or dry_run success
    // Either is acceptable — the important thing is no crash
    assert.ok('dry_run' in data || 'error' in data, `unexpected response shape: ${JSON.stringify(data)}`)
  })
})
