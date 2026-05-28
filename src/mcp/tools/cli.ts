/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP `cli` tool — accepts a raw `elastic …` CLI string and dispatches the
 * matching Elasticsearch / Kibana / Cloud HTTP request in-process.
 *
 * Parsing steps:
 *  1. Shell-quote tokenization via `shell-quote` (handles single/double quotes,
 *     backslash escapes, env-var interpolation is disabled).
 *  2. Require the leading `elastic` token.
 *  3. Walk non-flag tokens to derive the registry dot-path (alias normalization).
 *  4. Meta-flag extraction (--dry-run, --input-file, --use-context, --json, etc.).
 *  5. Schema-arg flag dispatch → typed input object.
 *  6. Delegate to exec().
 */

import { readFileSync } from 'node:fs'
import { parse as shellParse } from 'shell-quote'
import type { ParseEntry } from 'shell-quote'
import { findEntry } from '../registry.ts'
import { getSchemaArgsForEntry } from './man.ts'
import { exec } from './exec.ts'
import type { ExecResponse } from './exec.ts'
import type { SchemaArgDefinition } from '../../lib/schema-args.ts'

/** Input for the `cli` tool. */
export interface CliInput {
  /**
   * Raw CLI invocation string exactly as a user would type it.
   * MUST start with `elastic` (e.g. `elastic es info`,
   * `elastic es indices create --index foo --number-of-shards 3`).
   */
  command: string
  /**
   * Override the active context for this call (mirrors `--use-context`).
   * Uses the default context when omitted.
   */
  context?: string
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Splits a shell-like command string into string tokens using `shell-quote`.
 *
 * Shell operators (`|`, `&&`, `>`, etc.) and glob patterns (`*`, `?`) are not
 * meaningful here and are rejected so agents get a clear message instead of
 * silently wrong behaviour.
 *
 * Shell comments (`#...`) stop token collection, matching real-shell behaviour.
 * Unterminated quotes are handled gracefully by shell-quote (the content is
 * included without the unclosed quote character).
 */
export function tokenize (input: string): string[] {
  const entries: ParseEntry[] = shellParse(input)
  const tokens: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      tokens.push(entry)
      continue
    }
    if (typeof entry === 'object' && entry !== null) {
      if ('comment' in entry) break
      // op covers both shell operators (||, |, >, &&, …) and glob patterns
      // (shell-quote emits { op: 'glob', pattern } for * and ?)
      const op = (entry as { op: string }).op
      throw new Error(`shell operator "${op}" is not allowed in a cli command string`)
    }
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Top-level aliases: normalises the first surface token so the registry lookup
 * always sees the canonical surface prefix.
 */
const TOP_LEVEL_ALIASES: Readonly<Record<string, string>> = {
  elasticsearch: 'es',
  kibana: 'kb',
}

/**
 * Meta-flags consumed by the cli tool itself (not forwarded as schema input).
 * `'boolean'` = no value consumed; `'value'` = next token is the value.
 */
const META_FLAGS: Readonly<Record<string, 'boolean' | 'value'>> = {
  'dry-run': 'boolean',
  'input-file': 'value',
  'use-context': 'value',
  json: 'boolean',
}

/**
 * Meta-flags explicitly unsupported in the MCP cli context.
 * Agents may expect these to have an effect; returning an error is clearer
 * than silently ignoring them.
 */
const UNSUPPORTED_FLAGS = new Set(['output-fields', 'output-template', 'config-file', 'command-profile'])

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parses a raw `elastic …` CLI string and dispatches the corresponding API
 * call in-process, returning the same response envelope as the `exec` tool.
 */
export async function cli (
  input: CliInput,
  options: { contextName?: string } = {},
): Promise<ExecResponse> {
  // 1. Tokenize — tokenize() only throws for shell operators (|, &&, etc.)
  let tokens: string[]
  try {
    tokens = tokenize(input.command)
  } catch (err) {
    return { error: { code: 'invalid_command_string', message: err instanceof Error ? err.message : String(err) } }
  }

  if (tokens.length === 0) {
    return { error: { code: 'invalid_command_string', message: 'command string is empty' } }
  }

  // 2. Require leading 'elastic'
  if (tokens[0] !== 'elastic') {
    return {
      error: {
        code: 'invalid_command_string',
        message: `command must start with "elastic", got "${tokens[0]}"`,
      },
    }
  }

  // 3. Separate path tokens (non-flag) from flag tokens.
  //    Collect non-flag tokens from index 1 until the first token starting with '-'.
  const pathTokens: string[] = []
  let flagStart = tokens.length

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.startsWith('-')) {
      flagStart = i
      break
    }
    pathTokens.push(t)
  }

  const flagTokens = tokens.slice(flagStart)

  // 4. Normalise the path tokens into a registry dot-path.
  const idResult = resolveId(pathTokens)
  if ('error' in idResult) return idResult

  const { id, remainingPathTokens } = idResult

  // Positional arguments are not supported for API commands.
  if (remainingPathTokens.length > 0) {
    return {
      error: {
        code: 'unexpected_positional_argument',
        message: `unexpected positional argument: "${remainingPathTokens[0]}"`,
      },
    }
  }

  // 5. Look up the registry entry.
  const entry = findEntry(id)
  if (entry == null) {
    return {
      error: {
        code: 'unknown_command',
        message: `Unknown command: "${id}". Use the discover tool to list available commands.`,
      },
    }
  }

  // 6. Load schema args for flag → input mapping.
  let schemaArgs: SchemaArgDefinition[]
  try {
    schemaArgs = await getSchemaArgsForEntry(entry)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: { code: 'internal_error', message } }
  }

  // Build a fast lookup from cliFlag → SchemaArgDefinition
  const argByFlag = new Map(schemaArgs.map((a) => [a.cliFlag, a]))

  // 7. Parse flag tokens: extract meta-flags and schema-arg flags.
  //    We work on an index so we can look ahead for values without losing position.
  let dryRun = false
  let contextOverride = input.context
  let fileInput: Record<string, unknown> | undefined
  const cliInput: Record<string, unknown> = {}

  let fi = 0
  while (fi < flagTokens.length) {
    const rawFlag = flagTokens[fi++]!

    // Split --flag=value
    let flagName: string
    let inlineValue: string | undefined

    if (rawFlag.startsWith('--')) {
      const eqIdx = rawFlag.indexOf('=')
      if (eqIdx !== -1) {
        flagName = rawFlag.slice(2, eqIdx)
        inlineValue = rawFlag.slice(eqIdx + 1)
      } else {
        flagName = rawFlag.slice(2)
      }
    } else if (rawFlag.startsWith('-')) {
      // Short flags are not supported in the MCP cli tool
      return {
        error: {
          code: 'unknown_flag',
          message: `short flags are not supported in the cli tool: "${rawFlag}"`,
        },
      }
    } else {
      return {
        error: {
          code: 'unexpected_positional_argument',
          message: `unexpected positional argument after flags: "${rawFlag}"`,
        },
      }
    }

    // Unsupported meta-flags
    if (UNSUPPORTED_FLAGS.has(flagName)) {
      return {
        error: {
          code: 'unsupported_flag',
          message: `--${flagName} is not supported in the cli MCP tool`,
        },
      }
    }

    // Known meta-flags
    const metaKind = META_FLAGS[flagName]
    if (metaKind != null) {
      if (flagName === 'dry-run') {
        dryRun = true
        continue
      }
      if (flagName === 'json') {
        // Silently ignored — MCP always returns JSON
        continue
      }

      // Meta-flags that need a value
      let value: string | undefined = inlineValue
      if (value == null) {
        if (fi >= flagTokens.length) {
          return { error: { code: 'invalid_command_string', message: `--${flagName} requires a value` } }
        }
        value = flagTokens[fi++]
      }

      if (flagName === 'use-context') {
        contextOverride = value
        continue
      }
      if (flagName === 'input-file') {
        let raw: string
        try {
          raw = readFileSync(value!, 'utf-8')
        } catch {
          return { error: { code: 'invalid_command_string', message: `--input-file: file not found: ${value}` } }
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return { error: { code: 'invalid_command_string', message: `--input-file: invalid JSON in "${value}"` } }
        }
        if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { error: { code: 'invalid_command_string', message: '--input-file: JSON must be an object' } }
        }
        fileInput = parsed as Record<string, unknown>
        continue
      }
      continue
    }

    // Schema-arg flags
    const arg = argByFlag.get(flagName)
    if (arg == null) {
      return { error: { code: 'unknown_flag', message: `unknown flag: --${flagName}` } }
    }

    if (arg.type === 'boolean') {
      if (inlineValue != null) {
        cliInput[arg.schemaKey] = inlineValue !== 'false'
      } else {
        // Peek: consume next token only if it is literally 'true' or 'false'
        const next = flagTokens[fi]
        if (next === 'true' || next === 'false') {
          fi++
          cliInput[arg.schemaKey] = next !== 'false'
        } else {
          // Standalone --flag → true (next token, if any, is a separate flag or value)
          cliInput[arg.schemaKey] = true
        }
      }
      continue
    }

    // All other types require a value
    let strValue: string | undefined = inlineValue
    if (strValue == null) {
      if (fi >= flagTokens.length) {
        return { error: { code: 'invalid_command_string', message: `--${flagName} requires a value` } }
      }
      strValue = flagTokens[fi++]!
    }

    if (arg.type === 'number') {
      const n = Number(strValue)
      if (Number.isNaN(n)) {
        return {
          error: {
            code: 'input_validation_failed',
            message: `--${flagName}: expected a number, got "${strValue}"`,
          },
        }
      }
      cliInput[arg.schemaKey] = n
    } else if (arg.type === 'object' || arg.type === 'array') {
      try {
        cliInput[arg.schemaKey] = JSON.parse(strValue)
      } catch {
        // z.any() fields accept raw strings as well
        cliInput[arg.schemaKey] = strValue
      }
    } else {
      // string | enum
      cliInput[arg.schemaKey] = strValue
    }
  }

  // 8. Merge file input (base) with CLI flags (override, per constitution)
  const mergedInput: Record<string, unknown> =
    fileInput != null ? { ...fileInput, ...cliInput } : cliInput

  // 9. Delegate to exec()
  return exec(
    {
      id,
      input: mergedInput,
      dry_run: dryRun,
      ...(contextOverride != null ? { context: contextOverride } : {}),
    },
    options,
  )
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ResolveIdSuccess {
  id: string
  /** Non-flag tokens not consumed as part of the command path (should be empty for API commands). */
  remainingPathTokens: string[]
}

interface ResolveIdError {
  error: { code: string; message: string }
}

/**
 * Converts a slice of non-flag path tokens into a registry dot-path id.
 *
 * Normalisation applied (in order):
 * - Optional leading `stack` segment stripped.
 * - Top-level surface aliases: `elasticsearch` → `es`, `kibana` → `kb`.
 * - Cloud serverless projects sub-alias: `elasticsearch` → `search` when the
 *   path is `cloud serverless projects elasticsearch …`.
 *
 * Tries the longest possible match first, then progressively shorter, so any
 * trailing tokens (positional args) can be detected by the caller.
 */
function resolveId (pathTokens: string[]): ResolveIdSuccess | ResolveIdError {
  if (pathTokens.length === 0) {
    return {
      error: {
        code: 'invalid_command_string',
        message: 'no command specified after "elastic"',
      },
    }
  }

  const normalized = [...pathTokens]

  // Strip optional 'stack' segment (elastic stack es …)
  if (normalized[0] === 'stack') normalized.shift()

  if (normalized.length === 0) {
    return {
      error: {
        code: 'invalid_command_string',
        message: 'no command specified after "elastic stack"',
      },
    }
  }

  // Top-level surface aliases
  const surface = normalized[0]
  if (surface != null && surface in TOP_LEVEL_ALIASES) {
    normalized[0] = TOP_LEVEL_ALIASES[surface]!
  }

  // Cloud serverless projects elasticsearch → search
  if (
    normalized[0] === 'cloud' &&
    normalized[1] === 'serverless' &&
    normalized[2] === 'projects' &&
    normalized[3] === 'elasticsearch'
  ) {
    normalized[3] = 'search'
  }

  // Try longest-match first; any remaining tokens are positional candidates.
  for (let take = normalized.length; take >= 1; take--) {
    const candidate = normalized.slice(0, take).join('.')
    if (findEntry(candidate) != null) {
      return {
        id: candidate,
        remainingPathTokens: normalized.slice(take),
      }
    }
  }

  const attempted = normalized.join('.')
  return {
    error: {
      code: 'unknown_command',
      message: `Unknown command: "${attempted}". Use the discover tool to list available commands.`,
    },
  }
}
