/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { discover } from '../../src/mcp/tools/discover.ts'

describe('discover tool', () => {
  it('returns all entries with no filters (default limit 50)', () => {
    const result = discover({})
    assert.equal(result.results.length, 50)
    assert.ok(result.total >= 1000)
  })

  it('respects limit parameter', () => {
    const result = discover({ limit: 10 })
    assert.equal(result.results.length, 10)
  })

  it('caps limit at 200', () => {
    const result = discover({ limit: 9999 })
    assert.ok(result.results.length <= 200)
  })

  it('respects offset for pagination', () => {
    const first = discover({ limit: 5, offset: 0 })
    const second = discover({ limit: 5, offset: 5 })
    assert.notDeepEqual(first.results, second.results)
    // total should be same regardless of offset
    assert.equal(first.total, second.total)
  })

  it('filters by surface: es', () => {
    const result = discover({ surface: 'es', limit: 200 })
    assert.ok(result.results.length > 0)
    for (const r of result.results) {
      assert.equal(r.surface, 'es')
      assert.ok(r.id.startsWith('stack.es.'))
    }
  })

  it('filters by surface: kb', () => {
    const result = discover({ surface: 'kb', limit: 200 })
    assert.ok(result.results.length > 0)
    for (const r of result.results) {
      assert.equal(r.surface, 'kb')
      assert.ok(r.id.startsWith('stack.kb.'))
    }
  })

  it('filters by surface: cloud', () => {
    const result = discover({ surface: 'cloud', limit: 200 })
    assert.ok(result.results.length > 0)
    for (const r of result.results) {
      assert.equal(r.surface, 'cloud')
      assert.ok(r.id.startsWith('cloud.'))
    }
  })

  it('filters by namespace', () => {
    const result = discover({ surface: 'es', namespace: 'indices', limit: 200 })
    assert.ok(result.results.length > 0)
    for (const r of result.results) {
      assert.equal(r.namespace, 'indices')
    }
  })

  it('free-text query filters by ID and description', () => {
    const result = discover({ query: 'search', limit: 200 })
    assert.ok(result.results.length > 0)
    for (const r of result.results) {
      const haystack = `${r.id} ${r.description}`.toLowerCase()
      assert.ok(haystack.includes('search'), `result ${r.id} does not match 'search'`)
    }
  })

  it('returns empty results for non-matching query', () => {
    const result = discover({ query: 'zzzznonexistentqueryzzzz' })
    assert.equal(result.total, 0)
    assert.equal(result.results.length, 0)
  })

  it('result entries have all required fields', () => {
    const result = discover({ limit: 20 })
    for (const r of result.results) {
      assert.ok(r.id, `missing id`)
      assert.ok(r.surface, `missing surface on ${r.id}`)
      assert.ok(r.method, `missing method on ${r.id}`)
      assert.ok(r.path, `missing path on ${r.id}`)
    }
  })

  it('applies command policy: blocked commands are excluded', () => {
    const allResult = discover({ surface: 'cloud', limit: 200 })
    const totalBeforeBlock = allResult.total

    // Block all cloud commands
    const blockedResult = discover(
      { surface: 'cloud', limit: 200 },
      { blocked: ['cloud.*'] }
    )
    assert.equal(blockedResult.total, 0)
    assert.ok(totalBeforeBlock > 0)
  })

  it('applies command policy: allowed list restricts to subset', () => {
    const result = discover(
      { surface: 'es', limit: 200 },
      { allowed: ['stack.es.search'] }
    )
    assert.equal(result.total, 1)
    assert.equal(result.results[0]!.id, 'stack.es.search')
  })

  it('combined surface + query filters', () => {
    const result = discover({ surface: 'kb', query: 'data-view', limit: 200 })
    assert.ok(result.results.length > 0)
    for (const r of result.results) {
      assert.equal(r.surface, 'kb')
    }
  })
})
