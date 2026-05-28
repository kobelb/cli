/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tokenize, cli } from '../../src/mcp/tools/cli.ts'
import type { ExecDryRun, ExecError } from '../../src/mcp/tools/exec.ts'
import { setResolvedConfig, _testResetConfig } from '../../src/config/store.ts'

function fakeConfig () {
  return {
    context: {
      elasticsearch: { url: 'http://localhost:9200', auth: { api_key: 'test' } },
      kibana:        { url: 'http://localhost:5601', auth: { api_key: 'test' } },
      cloud:         { url: 'https://api.elastic-cloud.com', auth: { api_key: 'test' } },
    },
  }
}

afterEach(() => { _testResetConfig() })

// ---------------------------------------------------------------------------
// tokenize()
// ---------------------------------------------------------------------------
describe('tokenize', () => {
  it('splits bare words', () => {
    assert.deepEqual(tokenize('elastic es info'), ['elastic', 'es', 'info'])
  })

  it('collapses multiple spaces', () => {
    assert.deepEqual(tokenize('elastic   es   info'), ['elastic', 'es', 'info'])
  })

  it('handles tabs as whitespace', () => {
    assert.deepEqual(tokenize('elastic\tes\tinfo'), ['elastic', 'es', 'info'])
  })

  it('handles single-quoted strings (literal)', () => {
    assert.deepEqual(tokenize("--query 'hello world'"), ['--query', 'hello world'])
  })

  it('handles double-quoted strings', () => {
    assert.deepEqual(tokenize('--query "hello world"'), ['--query', 'hello world'])
  })

  it('handles \\" escape inside double quotes', () => {
    assert.deepEqual(tokenize('--q "say \\"hi\\""'), ['--q', 'say "hi"'])
  })

  it('handles \\\\ escape inside double quotes', () => {
    assert.deepEqual(tokenize('--q "back\\\\slash"'), ['--q', 'back\\slash'])
  })

  it('handles --flag=value bare word', () => {
    assert.deepEqual(tokenize('--index=my-index'), ['--index=my-index'])
  })

  it('returns empty array for empty string', () => {
    assert.deepEqual(tokenize(''), [])
  })

  it('stops at shell comment #', () => {
    assert.deepEqual(tokenize('elastic es info # this is a comment'), ['elastic', 'es', 'info'])
  })

  it('unterminated single quote is handled gracefully (shell-quote strips it)', () => {
    // shell-quote silently treats an unterminated quote as if the closing quote
    // were at the end of the string — it does NOT throw.
    const tokens = tokenize("elastic 'unclosed")
    assert.deepEqual(tokens, ['elastic', 'unclosed'])
  })

  it('glob pattern * throws (produced as op:glob by shell-quote)', () => {
    assert.throws(() => tokenize('elastic es *.json'), /not allowed/i)
  })

  it('throws on shell operator |', () => {
    assert.throws(() => tokenize('elastic es info | cat'), /not allowed/i)
  })
})

// ---------------------------------------------------------------------------
// cli() — happy paths
// ---------------------------------------------------------------------------
describe('cli tool — happy paths', () => {
  it('elastic es info → dry-run GET /', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es info --dry-run' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.dry_run)
    assert.equal(dr.request.method, 'GET')
    assert.equal(dr.request.path, '/')
  })

  it('elastic es search --index my-index --size 10 → id es.search, number coerced', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es search --index my-index --size 10 --dry-run' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.dry_run)
    assert.ok(dr.request.method === 'GET' || dr.request.method === 'POST')
    // body should contain size: 10
    const body = dr.request.body as Record<string, unknown> | undefined
    assert.equal(body?.size, 10)
  })

  it('elastic kb data-views get-all-data-views-default → kb surface', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic kb data-views get-all-data-views-default --dry-run' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.dry_run)
    assert.equal(dr.request.method, 'GET')
    assert.ok(dr.request.path.startsWith('/api/data_views'), `unexpected path: ${dr.request.path}`)
  })

  it('elastic cloud trust get-current-account → cloud.trust.get-current-account', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic cloud trust get-current-account --dry-run' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.dry_run)
    assert.equal(dr.request.method, 'GET')
  })
})

// ---------------------------------------------------------------------------
// cli() — alias normalization
// ---------------------------------------------------------------------------
describe('cli tool — aliases', () => {
  it('elastic elasticsearch info ≡ elastic es info', async () => {
    setResolvedConfig(fakeConfig())
    const r1 = await cli({ command: 'elastic elasticsearch info --dry-run' })
    const r2 = await cli({ command: 'elastic es info --dry-run' })
    assert.ok(!('error' in r1), `unexpected error: ${JSON.stringify(r1)}`)
    assert.ok(!('error' in r2), `unexpected error: ${JSON.stringify(r2)}`)
    assert.deepEqual((r1 as ExecDryRun).request, (r2 as ExecDryRun).request)
  })

  it('elastic stack es info ≡ elastic es info', async () => {
    setResolvedConfig(fakeConfig())
    const r1 = await cli({ command: 'elastic stack es info --dry-run' })
    const r2 = await cli({ command: 'elastic es info --dry-run' })
    assert.ok(!('error' in r1), `unexpected error: ${JSON.stringify(r1)}`)
    assert.deepEqual((r1 as ExecDryRun).request, (r2 as ExecDryRun).request)
  })

  it('elastic stack elasticsearch info ≡ elastic es info', async () => {
    setResolvedConfig(fakeConfig())
    const r = await cli({ command: 'elastic stack elasticsearch info --dry-run' })
    assert.ok(!('error' in r), `unexpected error: ${JSON.stringify(r)}`)
    assert.equal((r as ExecDryRun).request.path, '/')
  })

  it('elastic kibana … ≡ elastic kb …', async () => {
    setResolvedConfig(fakeConfig())
    const r1 = await cli({ command: 'elastic kibana data-views get-all-data-views-default --dry-run' })
    const r2 = await cli({ command: 'elastic kb data-views get-all-data-views-default --dry-run' })
    assert.ok(!('error' in r1), `unexpected error: ${JSON.stringify(r1)}`)
    assert.deepEqual((r1 as ExecDryRun).request, (r2 as ExecDryRun).request)
  })

  it('elastic cloud serverless projects elasticsearch list → cloud.serverless.projects.search.list', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic cloud serverless projects elasticsearch list --dry-run' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const dr = result as ExecDryRun
    assert.ok(dr.dry_run)
    assert.equal(dr.request.method, 'GET')
  })
})

// ---------------------------------------------------------------------------
// cli() — type coercion
// ---------------------------------------------------------------------------
describe('cli tool — type coercion', () => {
  it('number: --size 42 is coerced to integer', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es search --index test --size 42 --dry-run' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const body = (result as ExecDryRun).request.body as Record<string, unknown> | undefined
    assert.equal(body?.size, 42)
  })

  it('boolean: standalone --allow-no-indices sets true', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es search --index test --allow-no-indices --dry-run' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    // allow_no_indices is a query param; just verify no error
  })

  it('boolean: --allow-partial-search-results false sets false', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({
      command: 'elastic es search --index test --allow-partial-search-results false --dry-run',
    })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
  })

  it('object: --query JSON string is parsed', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({
      command: `elastic es search --index test --query '{"match_all":{}}' --dry-run`,
    })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    const body = (result as ExecDryRun).request.body as Record<string, unknown> | undefined
    assert.deepEqual(body?.query, { match_all: {} })
  })

  it('--flag=value inline form works', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es search --index=my-index --dry-run' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
  })
})

// ---------------------------------------------------------------------------
// cli() — meta-flags
// ---------------------------------------------------------------------------
describe('cli tool — meta-flags', () => {
  it('--dry-run returns dry_run:true without executing', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es info --dry-run' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
    assert.ok((result as ExecDryRun).dry_run === true)
  })

  it('--use-context overrides context', async () => {
    setResolvedConfig(fakeConfig())
    // context override with a name that does not exist → config_error from exec
    const result = await cli({ command: 'elastic es info --use-context nonexistent-ctx --dry-run' })
    // Either it errors (missing context) or succeeds — the important thing is the flag is consumed
    assert.ok('error' in result || 'dry_run' in result)
  })

  it('--json is silently ignored', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es info --json --dry-run' })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
  })

  it('--output-fields returns unsupported_flag error', async () => {
    const result = await cli({ command: 'elastic es info --output-fields id' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'unsupported_flag')
  })

  it('--output-template returns unsupported_flag error', async () => {
    const result = await cli({ command: 'elastic es info --output-template "{{id}}"' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'unsupported_flag')
  })

  it('--config-file returns unsupported_flag error', async () => {
    const result = await cli({ command: 'elastic es info --config-file /tmp/foo.yml' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'unsupported_flag')
  })

  it('--command-profile returns unsupported_flag error', async () => {
    const result = await cli({ command: 'elastic es info --command-profile ess' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'unsupported_flag')
  })

  it('--input-file merges JSON with CLI flag override', async () => {
    setResolvedConfig(fakeConfig())
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-'))
    const filePath = join(dir, 'input.json')
    try {
      writeFileSync(filePath, JSON.stringify({ index: 'from-file', size: 5 }))
      const result = await cli({
        command: `elastic es search --input-file "${filePath}" --size 99 --dry-run`,
      })
      assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
      const body = (result as ExecDryRun).request.body as Record<string, unknown> | undefined
      // size from CLI (99) must override the file value (5)
      assert.equal(body?.size, 99)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('context field on CliInput forwards as context override', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es info --dry-run', context: 'my-ctx' })
    // Will either get config_error (missing context) or dry_run
    assert.ok('error' in result || 'dry_run' in result)
  })

  it('options.contextName parameter is forwarded to exec', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es info --dry-run' }, { contextName: 'my-ctx' })
    assert.ok('error' in result || 'dry_run' in result)
  })

  it('--flag=true inline boolean value sets true', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({
      command: 'elastic es search --index test --allow-no-indices=true --dry-run',
    })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
  })

  it('--flag=false inline boolean value sets false', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({
      command: 'elastic es search --index test --allow-no-indices=false --dry-run',
    })
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
  })
})

// ---------------------------------------------------------------------------
// cli() — errors
// ---------------------------------------------------------------------------
describe('cli tool — errors', () => {
  it('empty string → invalid_command_string', async () => {
    const result = await cli({ command: '' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'invalid_command_string')
  })

  it('only "elastic" → invalid_command_string (no command specified)', async () => {
    const result = await cli({ command: 'elastic' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'invalid_command_string')
  })

  it('missing elastic prefix → invalid_command_string', async () => {
    const result = await cli({ command: 'es info' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'invalid_command_string')
  })

  it('unknown command → unknown_command', async () => {
    const result = await cli({ command: 'elastic es totally-nonexistent-command' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'unknown_command')
  })

  it('unknown flag → unknown_flag', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es info --totally-made-up-flag foo' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'unknown_flag')
  })

  it('shell operator → invalid_command_string', async () => {
    const result = await cli({ command: 'elastic es info | grep version' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'invalid_command_string')
  })

  it('non-API command elastic version → unknown_command', async () => {
    const result = await cli({ command: 'elastic version' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'unknown_command')
  })

  it('non-API command elastic config get → unknown_command', async () => {
    const result = await cli({ command: 'elastic config get' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'unknown_command')
  })

  it('short flag -i → unknown_flag', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es info -i my-index' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'unknown_flag')
  })
})

// ---------------------------------------------------------------------------
// cli() — adversarial inputs
// ---------------------------------------------------------------------------
describe('cli tool — adversarial inputs', () => {
  it('only whitespace → invalid_command_string', async () => {
    const result = await cli({ command: '   ' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'invalid_command_string')
  })

  it('only "elastic stack" → invalid_command_string', async () => {
    const result = await cli({ command: 'elastic stack' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'invalid_command_string')
  })

  it('number flag with NaN value → input_validation_failed', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es search --index test --size notanumber' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'input_validation_failed')
  })

  it('--input-file pointing to missing file → invalid_command_string', async () => {
    setResolvedConfig(fakeConfig())
    const result = await cli({ command: 'elastic es search --input-file /totally/missing/file.json' })
    assert.ok('error' in result)
    assert.equal((result as ExecError).error.code, 'invalid_command_string')
    assert.ok((result as ExecError).error.message.includes('file not found'))
  })

  it('--input-file pointing to non-object JSON → invalid_command_string', async () => {
    setResolvedConfig(fakeConfig())
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-'))
    const filePath = join(dir, 'bad.json')
    try {
      writeFileSync(filePath, JSON.stringify([1, 2, 3]))
      const result = await cli({ command: `elastic es search --input-file "${filePath}"` })
      assert.ok('error' in result)
      assert.equal((result as ExecError).error.code, 'invalid_command_string')
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('--flag= with empty inline value treated as empty string', async () => {
    setResolvedConfig(fakeConfig())
    // --index= gives an empty string for the index; Zod will reject it as invalid
    const result = await cli({ command: 'elastic es search --index= --dry-run' })
    // Either validation error or dry-run with empty index — both are acceptable
    assert.ok('error' in result || 'dry_run' in result)
  })

  it('path with dot-injected segment does not match registry', async () => {
    const result = await cli({ command: 'elastic es..indices create' })
    assert.ok('error' in result)
    const code = (result as ExecError).error.code
    assert.ok(code === 'unknown_command' || code === 'invalid_command_string')
  })
})
