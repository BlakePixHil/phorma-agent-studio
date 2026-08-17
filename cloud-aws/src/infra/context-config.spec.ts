/**
 * How the IaC_App reads its config from CDK context.
 *
 * The first assertion here is the one that matters: a `--context key=value`
 * argument arrives as a JSON STRING. A reader that accepts only an object
 * silently ignores the operator's config and synthesizes the placeholder, which
 * is the defect this suite pins.
 *
 * Feature: aws-byo-deploy
 * Requirements: 3.1, 3.3, 4.1, 4.2, 13.5
 */

import { describe, it, expect } from 'vitest';
import { ConfigError } from '../core/config.js';
import { configFromContext, placeholderConfig } from './context-config.js';

const QUALIFIER = 'phorma42';

const CONFIG = {
  accountId: '123456789012',
  region: 'eu-west-1',
  namePrefix: 'acme-agents',
  permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/PlatformBoundary',
  bootstrapQualifier: 'phorma',
  egressAllowList: ['api.anthropic.com'],
  costAllocationTags: { app: 'phorma' },
  retentionDays: 30,
  alarmNotificationArn: 'arn:aws:sns:eu-west-1:123456789012:platform-alarms',
  imageUri: '123456789012.dkr.ecr.eu-west-1.amazonaws.com/platform/phorma-host:1.4.2',
};

describe('configFromContext', () => {
  it('parses the JSON string a --context argument delivers', () => {
    // `cdk --context phorma:config=<json>` stores the right-hand side verbatim.
    const config = configFromContext(JSON.stringify(CONFIG), QUALIFIER);

    expect(config.accountId).toBe(CONFIG.accountId);
    expect(config.region).toBe(CONFIG.region);
    expect(config.namePrefix).toBe(CONFIG.namePrefix);
    expect(config.imageUri).toBe(CONFIG.imageUri);
  });

  it('parses an object, which is how cdk.json and cdk.context.json deliver it', () => {
    expect(configFromContext(CONFIG, QUALIFIER).namePrefix).toBe(CONFIG.namePrefix);
  });

  it('falls back to the placeholder when no context is supplied', () => {
    for (const absent of [undefined, null, '', '   ']) {
      const config = configFromContext(absent, QUALIFIER);
      expect(config).toEqual(placeholderConfig(QUALIFIER));
      expect(config.bootstrapQualifier).toBe(QUALIFIER);
    }
  });

  it('places the placeholder on the container image asset path', () => {
    // No `imageUri`, so the first `cdk synth` in the Check_Pipeline covers the
    // asset path and `scripts/synth-image-reference.mjs` covers the other one.
    expect(placeholderConfig(QUALIFIER).imageUri).toBeUndefined();
  });

  it('reports malformed JSON rather than synthesizing the placeholder', () => {
    expect(() => configFromContext('{"accountId":', QUALIFIER)).toThrow(ConfigError);
    expect(() => configFromContext('{"accountId":', QUALIFIER)).toThrow(/not valid JSON/);
  });

  it('reports an invalid config carried as a string', () => {
    const bad = JSON.stringify({ ...CONFIG, accountId: '12345' });
    expect(() => configFromContext(bad, QUALIFIER)).toThrow(ConfigError);
    expect(() => configFromContext(bad, QUALIFIER)).toThrow(/accountId/);
  });
});
