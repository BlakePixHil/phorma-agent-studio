/**
 * Unit tests for the production `SecretsBackend`.
 *
 * The Check_Pipeline runs with no AWS credentials present and this file is part
 * of it, so the assertions below double as the credential-free construction
 * check: importing the module builds no client, and calling the factory
 * resolves no credentials and reaches no network.
 *
 * Behaviour that needs a Secret_Store behind it is covered against the
 * in-memory port implementation in `secrets.spec.ts`.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2, 8.3
 */

import { describe, expect, it } from 'vitest';

import { createSecretsBackend } from './secrets-backend.js';
import type { SecretsBackend } from './ports.js';

const PORT_METHODS: (keyof SecretsBackend)[] = ['get', 'put'];

describe('createSecretsBackend', () => {
  it('exposes exactly the two SecretsBackend operations', () => {
    const backend = createSecretsBackend({ region: 'eu-west-1' });

    for (const method of PORT_METHODS) {
      expect(typeof backend[method]).toBe('function');
    }
    expect(Object.keys(backend).sort()).toEqual([...PORT_METHODS].sort());
  });

  it('builds an independent backend per call, with or without an App_CMK key id', () => {
    const first = createSecretsBackend({ region: 'eu-west-1' });
    const second = createSecretsBackend({
      region: 'eu-west-1',
      appCmkKeyId: 'arn:aws:kms:eu-west-1:123456789012:key/abcd',
    });

    expect(second).not.toBe(first);
    expect(second.put).not.toBe(first.put);
  });
});
