/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { man } from '../../src/mcp/tools/man.ts'
import type { ManResponse } from '../../src/mcp/tools/man.ts'

describe('man tool', () => {
  it('returns error for unknown command ID', async () => {
    const result = await man({ id: 'nonexistent.command.id' })
    assert.ok('error' in result)
    assert.equal(result.error.code, 'unknown_command')
  })

  it('returns schema for ES search', async () => {
    const result = await man({ id: 'stack.es.search' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const r = result as ManResponse
    assert.equal(r.id, 'stack.es.search')
    assert.equal(r.surface, 'es')
    assert.ok(r.method === 'GET' || r.method === 'POST')
    assert.ok(r.input_schema != null)
    // JSON schema should be an object
    assert.equal(typeof r.input_schema, 'object')
    assert.ok(r.input_schema !== null)
  })

  it('does not contain found_in in schema', async () => {
    const result = await man({ id: 'stack.es.search' })
    assert.ok(!('error' in result))
    const schemaStr = JSON.stringify((result as ManResponse).input_schema)
    assert.ok(!schemaStr.includes('"found_in"'), 'schema should not contain found_in')
  })

  it('returns schema for ES indices create', async () => {
    const result = await man({ id: 'stack.es.indices.create' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const r = result as ManResponse
    assert.equal(r.surface, 'es')
    assert.equal(r.id, 'stack.es.indices.create')
  })

  it('returns schema for KB command', async () => {
    const result = await man({ id: 'stack.kb.agent-builder.get-agent-builder-agents' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const r = result as ManResponse
    assert.equal(r.surface, 'kb')
    assert.equal(r.method, 'GET')
    assert.ok(r.input_schema != null)
  })

  it('returns schema for Cloud promoted namespace command', async () => {
    const result = await man({ id: 'cloud.trust.get-current-account' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const r = result as ManResponse
    assert.equal(r.surface, 'cloud')
    assert.equal(r.method, 'GET')
  })

  it('returns response_type=text for ES cat command', async () => {
    // cat health is a text-response command
    const result = await man({ id: 'stack.es.cat.health' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const r = result as ManResponse
    assert.equal(r.response_type, 'text')
  })

  it('returns body_format=ndjson for bulk command', async () => {
    const result = await man({ id: 'stack.es.bulk' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const r = result as ManResponse
    assert.equal(r.body_format, 'ndjson')
  })

  it('schema has type=object at top level', async () => {
    const result = await man({ id: 'stack.es.indices.create' })
    assert.ok(!('error' in result))
    const schema = (result as ManResponse).input_schema as Record<string, unknown>
    assert.equal(schema.type, 'object')
  })

  it('Cloud serverless project command has schema', async () => {
    const { getRegistry } = await import('../../src/mcp/registry.ts')
    const registry = getRegistry()
    const entry = registry.find(e => e.surface === 'cloud' && e.id.includes('serverless.projects.search'))
    assert.ok(entry != null, 'no serverless search project entry found')
    const result = await man({ id: entry.id })
    assert.ok(!('error' in result), `unexpected error for ${entry.id}: ${JSON.stringify(result)}`)
  })
})
