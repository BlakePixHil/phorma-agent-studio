/**
 * Streamable-HTTP transport — a single POST endpoint speaking MCP JSON-RPC,
 * compatible with the engine's HttpMcpClient (plain JSON responses; no SSE
 * needed for these short-lived tool calls).
 *
 * Local/dev: node/tsx runs a tiny HTTP server (PORT env, default 7330).
 *
 * Hardening:
 * - Binds 127.0.0.1 by default; set HOST=0.0.0.0 explicitly to expose it,
 *   which REQUIRES PRACTICE_MCP_TOKEN (refuses to start exposed without
 *   auth — this server wields the firm's Xero credentials).
 * - Bearer comparison is timing-safe; request bodies capped at 4MB (base64
 *   PDFs pass, memory floods don't).
 *
 * Run: npx -y tsx src/http.ts
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { createPracticeServer } from './index.js';
import type { JsonRpcRequest } from './mcp.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const server = createPracticeServer({ env: name => process.env[name] });
const port = Number(process.env['PORT'] ?? 7330);
const host = process.env['HOST'] ?? '127.0.0.1';
const token = process.env['PRACTICE_MCP_TOKEN'];

if (host !== '127.0.0.1' && host !== 'localhost' && !token) {
  console.error(
    'Refusing to bind a non-loopback host without PRACTICE_MCP_TOKEN — ' +
      'this server holds the firm Xero credentials.',
  );
  process.exit(1);
}

function bearerMatches(header: string | undefined): boolean {
  if (!token) return true;
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  if (!bearerMatches(req.headers.authorization)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized.' }));
    return;
  }
  let body = '';
  let overflow = false;
  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES && !overflow) {
      overflow = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large.' }));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (overflow) return;
    void (async () => {
      try {
        const request = JSON.parse(body) as JsonRpcRequest;
        const response = await server.handle(request);
        res.writeHead(response ? 200 : 202, { 'Content-Type': 'application/json' });
        res.end(response ? JSON.stringify(response) : '');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON-RPC request.' }));
      }
    })();
  });
}).listen(port, host, () => {
  console.log(
    `phorma-practice-mcp listening on http://${host}:${port}${token ? ' (bearer auth on)' : ''}`,
  );
});
