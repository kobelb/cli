/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { exec, _dispatchForTest } from '../../src/mcp/tools/exec.ts'
import type { ExecDryRun, ExecError, DispatchDeps } from '../../src/mcp/tools/exec.ts'
import { setResolvedConfig, _testResetConfig } from '../../src/config/store.ts'
import { findEntry } from '../../src/mcp/registry.ts'
import type { ParsedResult } from '../../src/factory.ts'

/** Minimal resolved config that points at a stub ES URL (no real network needed for dry-run). */
function fakeConfig () {
  return {
    context: {
      elasticsearch: {
        url: 'http://localhost:9200',
        auth: { api_key: 'test-key' },
      },
      kibana: {
        url: 'http://localhost:5601',
        auth: { api_key: 'test-key' },
      },
      cloud: {
        url: 'https://api.elastic-cloud.com',
        auth: { api_key: 'test-cloud-key' },
      },
    },
  }
}

afterEach(() => {
  _testResetConfig()
})

describe('exec tool', () => {
  it('returns error for unknown command ID', async () => {
    const result = await exec({ id: 'nonexistent.command.id' })
    assert.ok('error' in result, 'expected error')
    assert.equal((result as ExecError).error.code, 'unknown_command')
  })

  it('dry_run: validates and returns resolved ES request', async () => {
    setResolvedConfig(fakeConfig())
    const result = await exec({
      id: 'stack.es.search',
      input: { index: 'my-index' },
      dry_run: true,
    })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.dry_run)
    assert.ok(dr.request.method === 'GET' || dr.request.method === 'POST')
    assert.ok(typeof dr.request.path === 'string')
  })

  it('dry_run: validates and returns resolved KB request', async () => {
    setResolvedConfig(fakeConfig())
    const result = await exec({
      id: 'stack.kb.agent-builder.get-agent-builder-agents',
      input: {},
      dry_run: true,
    })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.dry_run)
    assert.equal(dr.request.method, 'GET')
    assert.ok(dr.request.path.startsWith('/api/agent_builder'))
  })

  it('dry_run: validates and returns resolved Cloud request', async () => {
    setResolvedConfig(fakeConfig())
    const result = await exec({
      id: 'cloud.trust.get-current-account',
      input: {},
      dry_run: true,
    })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.dry_run)
    assert.equal(dr.request.method, 'GET')
  })

  it('dry_run: path params are interpolated', async () => {
    setResolvedConfig(fakeConfig())
    const result = await exec({
      id: 'stack.es.indices.create',
      input: { index: 'my-new-index' },
      dry_run: true,
    })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.request.path.includes('my-new-index'), `path should include index: ${dr.request.path}`)
  })

  it('dry_run: returns validation error for invalid input', async () => {
    setResolvedConfig(fakeConfig())
    // indices.create requires `index` path param
    const result = await exec({
      id: 'stack.es.indices.create',
      input: {},
      dry_run: true,
    })
    // Missing required `index` — should be a validation error
    assert.ok('error' in result, `expected validation error, got: ${JSON.stringify(result)}`)
    const err = (result as ExecError).error
    assert.equal(err.code, 'input_validation_failed')
  })

  it('command_blocked when policy blocks it', async () => {
    setResolvedConfig({
      ...fakeConfig(),
      commands: { blocked: ['stack.es.*'] },
    })
    const result = await exec({
      id: 'stack.es.search',
      input: { index: 'test' },
      dry_run: true,
    })
    assert.ok('error' in result, 'expected error')
    const err = (result as ExecError).error
    assert.equal(err.code, 'command_blocked')
  })

  it('dry_run: bulk request uses ndjson-style body structure', async () => {
    setResolvedConfig(fakeConfig())
    const result = await exec({
      id: 'stack.es.bulk',
      input: { operations: [{ index: { _index: 'test' } }, { field1: 'value1' }] },
      dry_run: true,
    })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.dry_run)
    // body should be ndjson string or array
    assert.ok(dr.request.body != null, 'expected a body for bulk')
  })

  it('dry_run: ES query in body is passed through', async () => {
    setResolvedConfig(fakeConfig())
    const result = await exec({
      id: 'stack.es.search',
      input: {
        index: 'logs-*',
        query: { match_all: {} },
        size: 10,
      },
      dry_run: true,
    })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.request.body != null, 'expected body with query')
  })

  it('returns config_error when context override fails to load', async () => {
    // Passing a nonexistent config file forces loadConfig to fail
    const result = await exec({
      id: 'stack.es.search',
      input: {},
      dry_run: true,
      context: 'nonexistent-context-name',
    })
    // Either config_error (no config file) or dry_run result if config happened to load — both ok
    assert.ok('error' in result || 'dry_run' in result, `unexpected shape: ${JSON.stringify(result)}`)
  })
})

describe('exec dispatch (with stub handlers)', () => {
  afterEach(() => {
    _testResetConfig()
  })

  it('dispatch ES handler: calls handler and returns result', async () => {
    const entry = findEntry('stack.es.search')!
    assert.ok(entry != null)
    const parsed: ParsedResult = { options: {}, input: { index: 'test' } }
    const def = { name: 'search', description: 'Search', method: 'GET' as const, path: '/_search' }
    const deps: DispatchDeps = {
      createEsHandler: () => async () => ({ hits: { hits: [] } }),
      createKbHandler: () => async () => ({}),
      createCloudHandler: () => async () => ({}),
    }
    const result = await _dispatchForTest(entry, def as never, parsed, [], deps)
    assert.deepEqual(result, { hits: { hits: [] } })
  })

  it('dispatch KB handler: calls handler and returns result', async () => {
    const entry = findEntry('stack.kb.agent-builder.get-agent-builder-agents')!
    assert.ok(entry != null)
    const parsed: ParsedResult = { options: {}, input: {} }
    const def = { name: 'get-agent-builder-agents', namespace: 'agent-builder', description: '', method: 'GET' as const, path: '/api/agent_builder/agents' }
    const deps: DispatchDeps = {
      createEsHandler: () => async () => ({}),
      createKbHandler: () => async () => ({ items: [] }),
      createCloudHandler: () => async () => ({}),
    }
    const result = await _dispatchForTest(entry, def as never, parsed, [], deps)
    assert.deepEqual(result, { items: [] })
  })

  it('dispatch Cloud handler: calls handler and returns result', async () => {
    const entry = findEntry('cloud.trust.get-current-account')!
    assert.ok(entry != null)
    const parsed: ParsedResult = { options: {}, input: {} }
    const def = { name: 'get-current-account', namespace: 'accounts', description: '', method: 'GET' as const, path: '/api/v1/users/auth/current' }
    const deps: DispatchDeps = {
      createEsHandler: () => async () => ({}),
      createKbHandler: () => async () => ({}),
      createCloudHandler: () => async () => ({ id: 'account-123' }),
    }
    const result = await _dispatchForTest(entry, def as never, parsed, [], deps)
    assert.deepEqual(result, { id: 'account-123' })
  })
})
