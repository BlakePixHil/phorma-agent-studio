/**
 * @phorma/practice-mcp — server assembly.
 *
 * Registers all tool groups against the framework-free MCP core. Transports:
 * - stdio.ts  — newline-delimited JSON-RPC for desktop debug (spawned by the
 *               studio's Rust MCP session host).
 * - http.ts   — streamable HTTP for deployed workflows (reached by the
 *               engine's HttpMcpClient from the Cloudflare worker).
 */

import { esignTools } from './esign-tools.js';
import { iasTools } from './ias-tools.js';
import { McpServer, type ToolContext } from './mcp.js';
import { XeroBroker } from './xero-auth.js';
import { xeroTools } from './xero-tools.js';
import { xpmTools } from './xpm-tools.js';

export { McpServer } from './mcp.js';
export type { JsonRpcRequest, JsonRpcResponse, ToolContext } from './mcp.js';

/** Builds the fully-registered practice MCP server for a host environment. */
export function createPracticeServer(ctx: ToolContext): McpServer {
  const server = new McpServer(ctx);
  const broker = new XeroBroker();

  for (const tool of xeroTools(broker)) server.register(tool);
  for (const tool of xpmTools(broker, () => ctx.env('XPM_PRACTICE_TENANT_ID'))) server.register(tool);
  for (const tool of esignTools()) server.register(tool);
  for (const tool of iasTools()) server.register(tool);

  return server;
}
