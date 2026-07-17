/**
 * stdio transport — newline-delimited JSON-RPC over stdin/stdout, matching
 * the studio's Rust MCP session host (mcp.rs) and the MCP stdio spec.
 *
 * Run: npx -y tsx src/stdio.ts   (or the built dist/stdio.js)
 */

import { createInterface } from 'node:readline';

import { createPracticeServer } from './index.js';
import type { JsonRpcRequest } from './mcp.js';

const server = createPracticeServer({ env: name => process.env[name] });

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    return; // Ignore malformed lines per stdio transport convention.
  }
  void server.handle(request).then(response => {
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
});
