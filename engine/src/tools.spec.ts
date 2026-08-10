import { describe, expect, it } from 'vitest';
import { buildHttpToolRequest, httpToolDefinition, withConnectionBaseUrl } from './tools.js';
import type { ResolvedConnection } from './connections.js';
import type { WorkflowNode } from './types.js';

/**
 * `http-tool` schema + request construction (Requirement: an agent-callable
 * HTTP tool that can carry more than one dynamic value per call).
 *
 * Every node created before `params` existed has none, so the single-`input`
 * behaviour MUST stay byte-identical - these are the backward-compatibility
 * cases. `params` is the opt-in generalisation: named tokens spliced into
 * BOTH the url and the body template independently, which one shared
 * `{{input}}` token cannot do.
 */

/**
 * `ToolDefinition.parameters` is deliberately the cross-package `object`
 * boundary type (see the conventions steering), so a test that asserts on the
 * JSON schema inside it has to narrow first.
 */
function schema(definition: { parameters: object }): {
  properties?: Record<string, unknown>;
  required?: string[];
} {
  return definition.parameters as { properties?: Record<string, unknown>; required?: string[] };
}

function node(data: object, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'n-http',
    name: overrides.name ?? 'HTTP Tool',
    kind: 'http-tool',
    category: 'tool',
    icon: 'ti ti-world',
    position: { x: 0, y: 0 },
    ports: [{ id: 'n-http-tool', name: 'Tool', role: 'tools' }],
    data,
    ...overrides,
  };
}

describe('httpToolDefinition', () => {
  it('falls back to a single free-form input property with no params', () => {
    const definition = httpToolDefinition(node({ method: 'GET', url: 'https://api.example.com' }));
    expect(schema(definition).properties).toEqual({
      input: {
        type: 'string',
        description: 'Interpolated into the {{input}} placeholder of the URL and body template.',
      },
    });
    expect(schema(definition).required).toEqual(['input']);
  });

  it('builds one named string property per declared param', () => {
    const definition = httpToolDefinition(
      node({
        method: 'POST',
        url: 'https://api.example.com/issue/{{issueKey}}/worklog',
        params: [
          { name: 'issueKey', description: 'Jira issue key', required: true },
          { name: 'body', description: 'JSON request body' },
        ],
      }),
    );
    expect(schema(definition).properties).toEqual({
      issueKey: { type: 'string', description: 'Jira issue key' },
      body: { type: 'string', description: 'JSON request body' },
    });
    expect(schema(definition).required).toEqual(['issueKey', 'body']);
  });

  it('excludes a param from required when explicitly marked optional', () => {
    const definition = httpToolDefinition(
      node({ url: 'https://x.test', params: [{ name: 'q', required: false }] }),
    );
    expect(schema(definition).required).toEqual([]);
  });

  it('ignores params with a blank name', () => {
    const definition = httpToolDefinition(
      node({ url: 'https://x.test', params: [{ name: '  ' }] }),
    );
    expect(schema(definition).properties).toEqual({
      input: {
        type: 'string',
        description: 'Interpolated into the {{input}} placeholder of the URL and body template.',
      },
    });
  });
});

describe('buildHttpToolRequest', () => {
  it('splices the single input value into both url and body (no params)', () => {
    const request = buildHttpToolRequest(
      node({ method: 'POST', url: 'https://api.example.com/{{input}}', bodyTemplate: '{"q":"{{input}}"}' }),
      JSON.stringify({ input: 'abc' }),
    );
    expect(request.url).toBe('https://api.example.com/abc');
    expect(request.body).toBe('{"q":"abc"}');
    expect(request.method).toBe('POST');
  });

  it('splices each named param into its own token, independently, in url and body', () => {
    const request = buildHttpToolRequest(
      node({
        method: 'POST',
        url: 'https://api.example.com/issue/{{issueKey}}/worklog',
        bodyTemplate: '{{body}}',
        params: [{ name: 'issueKey' }, { name: 'body' }],
      }),
      JSON.stringify({ issueKey: 'PROJ-123', body: '{"timeSpent":"1d"}' }),
    );
    expect(request.url).toBe('https://api.example.com/issue/PROJ-123/worklog');
    expect(request.body).toBe('{"timeSpent":"1d"}');
  });

  it('never sends a body for GET, even with a bodyTemplate configured', () => {
    const request = buildHttpToolRequest(
      node({ method: 'GET', url: 'https://api.example.com/{{input}}', bodyTemplate: '{{input}}' }),
      JSON.stringify({ input: 'x' }),
    );
    expect(request.body).toBeUndefined();
  });

  it('stringifies a non-string argument value before splicing', () => {
    const request = buildHttpToolRequest(
      node({ url: 'https://x.test', params: [{ name: 'q' }] }),
      JSON.stringify({ q: { nested: true } }),
    );
    expect(request.url).toBe('https://x.test');
    // The literal token only appears in the body here.
    const withBody = buildHttpToolRequest(
      node({ method: 'POST', url: 'https://x.test', bodyTemplate: '{{q}}', params: [{ name: 'q' }] }),
      JSON.stringify({ q: { nested: true } }),
    );
    expect(withBody.body).toBe('{"nested":true}');
  });
});

describe('withConnectionBaseUrl', () => {
  function connection(config: Record<string, string>): ResolvedConnection {
    return {
      id: 'conn-x',
      type: 'http',
      config,
      secrets: {},
      auth: { mode: 'none' },
      allowWrites: false,
    };
  }

  it('substitutes {{baseUrl}} with the connection config value', () => {
    expect(
      withConnectionBaseUrl('{{baseUrl}}/rest/api/3/search', connection({ baseUrl: 'https://acme.atlassian.net' })),
    ).toBe('https://acme.atlassian.net/rest/api/3/search');
  });

  it('leaves the url untouched with no connection or no configured baseUrl', () => {
    expect(withConnectionBaseUrl('{{baseUrl}}/x', undefined)).toBe('{{baseUrl}}/x');
    expect(withConnectionBaseUrl('{{baseUrl}}/x', connection({}))).toBe('{{baseUrl}}/x');
  });
});
