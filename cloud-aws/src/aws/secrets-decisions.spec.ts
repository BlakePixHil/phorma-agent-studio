/**
 * System One on AWS: the decision client exists only when a `typesafe`
 * provider key is configured, reads the secret lazily on the first call, and
 * seeds the Redactor with it.
 */

import { describe, expect, it } from 'vitest';
import type { Redactor } from '@phorma/engine';

import { FakeSecretsManager } from '../test/fake-secrets-manager.js';
import { SecretsAdapter } from './secrets.js';

function trackingRedactor(): Redactor & { seeded: string[] } {
  const seeded: string[] = [];
  return {
    seeded,
    addLiterals(values: readonly string[]) {
      seeded.push(...values);
    },
    scrub: value => value,
    event: event => event,
    ruleErrors: [],
  };
}

describe('SecretsAdapter.decisionClient', () => {
  it('is absent without a typesafe provider key', () => {
    const adapter = new SecretsAdapter(
      new FakeSecretsManager(),
      { prefix: 'p', connections: new Map(), providerKeys: new Map([['openai', 'p/openai']]) },
      trackingRedactor(),
    );
    expect(adapter.decisionClient()).toBeUndefined();
  });

  it('resolves the key lazily, sends it as a bearer and seeds the redactor', async () => {
    const backend = new FakeSecretsManager();
    backend.seed('p/typesafe', 'ts-secret-value-123');
    const redactor = trackingRedactor();
    const adapter = new SecretsAdapter(
      backend,
      { prefix: 'p', connections: new Map(), providerKeys: new Map([['typesafe', 'p/typesafe']]) },
      redactor,
    );
    const client = adapter.decisionClient();
    expect(client).toBeDefined();
    // Constructing the client reads nothing.
    expect(backend.log).toHaveLength(0);

    const originalFetch = globalThis.fetch;
    let authorization: string | null = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: { ok: { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const result = await client!.evaluate({
        model: 'jev-latest',
        state: 'hello',
        questions: { ok: { type: 'noul', instructions: 'Is it fine?' } },
      });
      expect(result.answers['ok']).toEqual({ type: 'noul', noul: 0.9 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(authorization).toBe('Bearer ts-secret-value-123');
    expect(redactor.seeded).toContain('ts-secret-value-123');
  });
});
