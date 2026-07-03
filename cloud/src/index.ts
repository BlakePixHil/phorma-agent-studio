/**
 * Phorma Agent Studio — cloud runtime entry point.
 *
 * Routes requests to WorkflowAgent Durable Objects. Instances are addressed
 * as /agents/workflow-agent/{instance-name}; the studio uses one instance
 * per deployed workflow (the workflow id).
 */

import { routeAgentRequest } from 'agents';

import { WorkflowAgent, type Env } from './workflow-agent';

export { WorkflowAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight for the studio (Tauri webview / localhost dev).
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
      });
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response('Phorma Agent Studio cloud runtime. POST /agents/workflow-agent/{id}/trigger', {
        status: 404,
      })
    );
  },
};
