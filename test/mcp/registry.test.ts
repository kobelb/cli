/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { getRegistry, findEntry, toPolicyId } from '../../src/mcp/registry.ts'
import type { RegistryEntry } from '../../src/mcp/registry.ts'

describe('MCP registry', () => {
  let registry: RegistryEntry[]

  before(() => {
    registry = getRegistry()
  })

  it('contains at least 1000 entries', () => {
    assert.ok(registry.length >= 1000, `expected ≥1000 entries, got ${registry.length}`)
  })

  it('all IDs are unique', () => {
    const ids = registry.map(e => e.id)
    const unique = new Set(ids)
    assert.equal(unique.size, ids.length, 'duplicate IDs found')
  })

  it('all entries have required fields', () => {
    for (const e of registry) {
      assert.ok(e.id, `entry missing id: ${JSON.stringify(e)}`)
      assert.ok(e.surface, `entry ${e.id} missing surface`)
      // description may be empty string for some generated entries
      assert.equal(typeof e.description, 'string', `entry ${e.id} description must be string`)
      assert.ok(e.method, `entry ${e.id} missing method`)
      assert.ok(e.path, `entry ${e.id} missing path`)
    }
  })

  it('ES entries have es. prefix', () => {
    const esEntries = registry.filter(e => e.surface === 'es')
    assert.ok(esEntries.length > 400, `expected >400 ES entries, got ${esEntries.length}`)
    for (const e of esEntries) {
      assert.ok(e.id.startsWith('es.'), `ES entry has wrong prefix: ${e.id}`)
    }
  })

  it('Kibana entries have kb. prefix', () => {
    const kbEntries = registry.filter(e => e.surface === 'kb')
    assert.ok(kbEntries.length > 400, `expected >400 KB entries, got ${kbEntries.length}`)
    for (const e of kbEntries) {
      assert.ok(e.id.startsWith('kb.'), `KB entry has wrong prefix: ${e.id}`)
    }
  })

  it('Cloud entries have cloud. prefix', () => {
    const cloudEntries = registry.filter(e => e.surface === 'cloud')
    assert.ok(cloudEntries.length > 50, `expected >50 Cloud entries, got ${cloudEntries.length}`)
    for (const e of cloudEntries) {
      assert.ok(e.id.startsWith('cloud.'), `Cloud entry has wrong prefix: ${e.id}`)
    }
  })

  it('findEntry returns the correct entry', () => {
    const first = registry[0]!
    const found = findEntry(first.id)
    assert.deepEqual(found, first)
  })

  it('findEntry returns undefined for unknown ID', () => {
    const found = findEntry('nonexistent.command.id')
    assert.equal(found, undefined)
  })

  it('ES search is accessible', () => {
    const entry = findEntry('es.search')
    assert.ok(entry != null, 'es.search not found')
    assert.equal(entry.surface, 'es')
    assert.equal(entry.namespace, null)
    assert.ok(entry.method === 'GET' || entry.method === 'POST')
  })

  it('ES indices create is accessible', () => {
    const entry = findEntry('es.indices.create')
    assert.ok(entry != null, 'es.indices.create not found')
    assert.equal(entry.surface, 'es')
    assert.equal(entry.namespace, 'indices')
  })

  it('Cloud promoted namespace trust entries accessible', () => {
    const entry = findEntry('cloud.trust.get-current-account')
    assert.ok(entry != null, `cloud.trust.get-current-account not found`)
    assert.equal(entry.surface, 'cloud')
  })

  it('Cloud serverless project entries use short names', () => {
    // Should be cloud.serverless.projects.search.list not cloud.serverless.projects.elasticsearch-projects.list-elasticsearch-projects
    const entry = registry.find(e => e.surface === 'cloud' && e.id.includes('serverless.projects.search'))
    assert.ok(entry != null, 'no serverless search project entry found')
  })

  it('Cloud hosted entries under cloud.hosted.*', () => {
    const hosted = registry.find(e => e.id.startsWith('cloud.hosted.'))
    assert.ok(hosted != null, 'no cloud.hosted.* entries found')
  })

  it('Kibana agent-builder entries are accessible', () => {
    const entry = findEntry('kb.agent-builder.get-agent-builder-agents')
    assert.ok(entry != null, 'kb.agent-builder.get-agent-builder-agents not found')
    assert.equal(entry.surface, 'kb')
    assert.equal(entry.namespace, 'agent-builder')
  })

  it('registry is a singleton (second call returns same instance)', () => {
    const r1 = getRegistry()
    const r2 = getRegistry()
    assert.equal(r1, r2)
  })

  describe('toPolicyId', () => {
    it('maps es.* to stack.es.*', () => {
      assert.equal(toPolicyId('es.search'), 'stack.es.search')
      assert.equal(toPolicyId('es.indices.create'), 'stack.es.indices.create')
    })

    it('maps kb.* to stack.kb.*', () => {
      assert.equal(toPolicyId('kb.data-views.list'), 'stack.kb.data-views.list')
    })

    it('passes cloud.* through unchanged', () => {
      assert.equal(toPolicyId('cloud.trust.get-current-account'), 'cloud.trust.get-current-account')
    })
  })
})
