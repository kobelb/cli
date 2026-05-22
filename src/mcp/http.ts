/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streamable HTTP transport for the MCP server.
 *
 * Exposes a single `/mcp` endpoint (POST, GET, DELETE) per the MCP Streamable
 * HTTP spec. Each session gets its own McpServer and StreamableHTTPServerTransport.
 * The session map is in-memory; suitable for single-process local use.
 *
 * DNS rebinding protection is applied automatically when `host` is a loopback
 * address (127.0.0.1, localhost, ::1), via the SDK's localhostHostValidation.
 *
 * CORS is permissively enabled because the primary browser-based consumers
 * (MCP Inspector, web playgrounds) load from origins we cannot enumerate
 * ahead of time. Cross-origin abuse is mitigated separately by DNS rebinding
 * protection (Host header validation) when bound to a loopback address.
 *
 * The OAuth discovery well-known endpoints respond with a JSON 404 rather
 * than Express's default HTML 404, so MCP clients can cleanly determine that
 * this server does not require authentication.
 */

import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import cors from 'cors'
import type { Application, Request, Response } from 'express'
import { createMcpServer } from './server.ts'

export interface HttpServerOptions { host: string; port: number }
export interface RunningHttpServer { server: Server; port: number; close: () => Promise<void> }

function sendError (res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null })
}

function sessionHeader (req: Request): string | undefined {
  const v = req.headers['mcp-session-id']
  return typeof v === 'string' ? v : undefined
}

async function handlePost (req: Request, res: Response, sessions: Map<string, StreamableHTTPServerTransport>): Promise<void> {
  try {
    const sessionId = sessionHeader(req)
    if (sessionId != null) {
      const transport = sessions.get(sessionId)
      if (transport == null) { sendError(res, 404, -32001, `Session not found: ${sessionId}`); return }
      await transport.handleRequest(req, res, req.body as unknown)
      return
    }
    if (!isInitializeRequest(req.body)) {
      sendError(res, 400, -32000, 'Bad Request: missing mcp-session-id for non-initialize request')
      return
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, transport) },
    })
    transport.onclose = () => { if (transport.sessionId != null) sessions.delete(transport.sessionId) }
    const mcpServer = createMcpServer()
    // Cast needed: SDK's optional callback properties lack `| undefined`, conflicting with exactOptionalPropertyTypes.
    await mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0])
    await transport.handleRequest(req, res, req.body as unknown)
  /* node:coverage disable */
  } catch (err) {
    if (!res.headersSent) sendError(res, 500, -32603, 'Internal server error')
    process.stderr.write(`[elastic-mcp] HTTP error: ${String(err)}\n`)
  }
  /* node:coverage enable */
}

async function handleGetOrDelete (req: Request, res: Response, sessions: Map<string, StreamableHTTPServerTransport>): Promise<void> {
  try {
    const sessionId = sessionHeader(req)
    const transport = sessionId != null ? sessions.get(sessionId) : undefined
    if (transport == null) { sendError(res, 400, -32000, 'Bad Request: missing or invalid mcp-session-id'); return }
    await transport.handleRequest(req, res)
  /* node:coverage disable */
  } catch (err) {
    if (!res.headersSent) res.status(500).end()
    process.stderr.write(`[elastic-mcp] HTTP error: ${String(err)}\n`)
  }
  /* node:coverage enable */
}

export function createMcpHttpApp (host: string): Application {
  const app = createMcpExpressApp({ host })
  // Browser-based MCP clients (Inspector, playgrounds) send a CORS preflight
  // before every request and need `mcp-session-id` exposed to JS. Without
  // these headers the browser blocks the fetch ("TypeError: Failed to fetch").
  // Origin is reflected ('*' is incompatible with credentials, and we don't
  // know client origins ahead of time). DNS rebinding protection (already
  // applied by createMcpExpressApp for loopback hosts) is the real boundary.
  app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
    exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
    maxAge: 86400,
  }))
  // MCP clients probe these endpoints to discover OAuth metadata. We don't
  // require auth, so a 404 is the correct signal per the MCP authorization
  // spec — clients then know not to attempt an OAuth flow. Express's default
  // 404 returns HTML, which strict clients may fail to parse as JSON and
  // misinterpret. Respond with a small JSON body so the signal is clean.
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource']) {
    app.get(path, (_req, res) => {
      res.status(404).json({ error: 'OAuth metadata not available; this server does not require authentication' })
    })
  }
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  app.post('/mcp', (req, res) => { void handlePost(req, res, sessions) })
  app.get('/mcp', (req, res) => { void handleGetOrDelete(req, res, sessions) })
  app.delete('/mcp', (req, res) => { void handleGetOrDelete(req, res, sessions) })
  return app
}

export function startMcpHttpServer (opts: HttpServerOptions): Promise<RunningHttpServer> {
  return new Promise((resolve, reject) => {
    const app = createMcpHttpApp(opts.host)
    const server = app.listen(opts.port, opts.host, () => {
      const addr = server.address()
      if (addr == null || typeof addr === 'string') { reject(new Error('Unexpected server address')); return }
      const port = addr.port
      resolve({ server, port, close: () => new Promise<void>((res, rej) => server.close((e) => (e != null ? rej(e) : res()))) })
    })
    server.on('error', reject)
  })
}
