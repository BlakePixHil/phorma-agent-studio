/**
 * Unit and property tests for the Container_Image source decision.
 *
 * Requirements: 4.1, 4.2
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  HOST_DOCKERFILE,
  resolveContainerImage,
  type ContainerImageChoice,
} from './container-image.js';
import type { AwsDeployConfig } from './config.js';

/** Iterations per property. The repo floor is 100; this decision is pure and cheap. */
const RUNS = 100;

/**
 * The OCI reference shape the Config_Parser will enforce (Req 2.8, task 8.4).
 * `resolveContainerImage` deliberately does NOT apply it - the switch is a
 * routing decision, not a validator. The pattern is here only so the
 * generators can prove they produce both valid and invalid references, and so
 * the routing-not-validating clause is asserted against a real yardstick.
 */
const OCI_REFERENCE_RE =
  /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._/-]+)+(:[A-Za-z0-9._-]{1,128}|@sha256:[a-f0-9]{64})$/;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const WHITESPACE_CHARS = [' ', '\t', '\n', '\r', '\f', '\v'] as const;

const chars = (source: string) => fc.constantFrom(...source.split(''));

/** One or more whitespace characters, mixed forms. */
const whitespaceRunArb = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 1, maxLength: 6 })
  .map((cs) => cs.join(''));

/** Zero or more whitespace characters - padding that `trim()` must remove. */
const paddingArb = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 0, maxLength: 4 })
  .map((cs) => cs.join(''));

/** `imageUri` values that all count as ABSENT: undefined, blank, whitespace-only. */
const absentImageUriArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  whitespaceRunArb,
);

const registryArb = fc.constantFrom(
  'docker.io',
  'ghcr.io',
  'public.ecr.aws',
  '123456789012.dkr.ecr.us-east-1.amazonaws.com',
  'registry.example.com:5000',
);

const repositoryArb = fc
  .array(fc.constantFrom('phorma', 'agent-studio', 'host', 'a.b', 'x_y', 'v2'), {
    minLength: 1,
    maxLength: 3,
  })
  .map((segments) => segments.join('/'));

const tagArb = fc
  .array(chars('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'), {
    minLength: 1,
    maxLength: 12,
  })
  .map((cs) => cs.join(''));

const digestArb = fc
  .array(chars('0123456789abcdef'), { minLength: 64, maxLength: 64 })
  .map((cs) => `sha256:${cs.join('')}`);

/** `{registry}/{repository}:{tag}` */
const taggedReferenceArb = fc
  .tuple(registryArb, repositoryArb, tagArb)
  .map(([registry, repository, tag]) => `${registry}/${repository}:${tag}`);

/** `{registry}/{repository}@sha256:{digest}` */
const digestReferenceArb = fc
  .tuple(registryArb, repositoryArb, digestArb)
  .map(([registry, repository, digest]) => `${registry}/${repository}@${digest}`);

/** Real OCI references of both accepted shapes. */
const ociReferenceArb = fc.oneof(taggedReferenceArb, digestReferenceArb);

/**
 * Values that are non-empty after trimming but are NOT valid OCI references.
 * `resolveContainerImage` must still route these to `reference`: validation
 * belongs to the Config_Parser, not to the switch.
 */
const nonOciReferenceArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'not an image',
    'nginx',
    'MiXeDcAsE/Repo:tag',
    '///',
    ':latest',
    '@sha256:short',
    'registry.example.com/repo:',
    'ghcr.io/phorma@sha256:zzzz',
    '{{IMAGE}}',
    '-',
    '1',
  ),
  fc
    .string({ minLength: 1, maxLength: 24 })
    .filter((s) => s.trim().length > 0 && !OCI_REFERENCE_RE.test(s.trim())),
);

/** Present values: valid references, invalid references, and both with padding. */
const presentImageUriArb: fc.Arbitrary<string> = fc.oneof(
  ociReferenceArb,
  nonOciReferenceArb,
  fc
    .tuple(paddingArb, fc.oneof(ociReferenceArb, nonOciReferenceArb), paddingArb)
    .map(([before, ref, after]) => `${before}${ref}${after}`),
);

/** Every `imageUri` shape, absent and present alike. */
const anyImageUriArb: fc.Arbitrary<string | undefined> = fc.oneof(
  absentImageUriArb,
  presentImageUriArb,
);

/**
 * The rest of `AwsDeployConfig`, varied independently of `imageUri`, so the
 * property shows the decision reads `imageUri` and nothing else.
 */
const otherConfigArb: fc.Arbitrary<Omit<AwsDeployConfig, 'imageUri'>> = fc.record({
  accountId: fc
    .array(chars('0123456789'), { minLength: 12, maxLength: 12 })
    .map((cs) => cs.join('')),
  region: fc.constantFrom('us-east-1', 'eu-west-2', 'ap-southeast-1', 'il-central-1'),
  namePrefix: fc
    .array(chars('abcdefghijklmnopqrstuvwxyz0123456789-'), { minLength: 1, maxLength: 32 })
    .map((cs) => cs.join('')),
  permissionsBoundaryArn: fc.constantFrom(
    'arn:aws:iam::123456789012:policy/phorma-boundary',
    'arn:aws:iam::210987654321:policy/team/boundary',
  ),
  bootstrapQualifier: fc.constantFrom('hnb659fds', 'phorma42'),
  appCmkArn: fc.option(
    fc.constant('arn:aws:kms:us-east-1:123456789012:key/abcd-1234'),
    { nil: undefined },
  ),
  vpc: fc.option(
    fc.record({
      id: fc.constant('vpc-0123abcd'),
      subnetIds: fc.array(fc.constantFrom('subnet-0a1b', 'subnet-2c3d', 'subnet-4e5f'), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
    { nil: undefined },
  ),
  dataSourceSecurityGroupId: fc.option(fc.constant('sg-0ff1ce'), { nil: undefined }),
  egressAllowList: fc.array(
    fc.constantFrom('api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'),
    { minLength: 0, maxLength: 3 },
  ),
  costAllocationTags: fc.dictionary(
    fc.constantFrom('phorma:env', 'phorma:owner', 'CostCenter'),
    fc.constantFrom('prod', 'staging', 'ops'),
    { minKeys: 1, maxKeys: 3 },
  ),
  retentionDays: fc.integer({ min: 1, max: 366 }),
  alarmNotificationArn: fc.constantFrom(
    'arn:aws:sns:us-east-1:123456789012:phorma-alarms',
    'arn:aws:sns:eu-west-2:210987654321:ops',
  ),
  deployTrust: fc.option(
    fc.record({
      identityCenter: fc.constant({
        permissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-1',
      }),
    }),
    { nil: undefined },
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configWith(
  other: Omit<AwsDeployConfig, 'imageUri'>,
  imageUri: string | undefined,
): AwsDeployConfig {
  return imageUri === undefined ? { ...other } : { ...other, imageUri };
}

/** The independent expectation: absent means blank after trimming. */
function expectedKind(imageUri: string | undefined): 'asset' | 'reference' {
  const trimmed = typeof imageUri === 'string' ? imageUri.trim() : '';
  return trimmed.length === 0 ? 'asset' : 'reference';
}

/**
 * Assert the returned value is one of exactly two shapes, carrying exactly the
 * keys its variant declares. Checking `kind` alone would miss a variant that
 * quietly grew an extra field.
 */
function assertExactlyTwoShapes(choice: ContainerImageChoice): void {
  expect(['asset', 'reference']).toContain(choice.kind);
  const keys = Object.keys(choice).sort();
  if (choice.kind === 'asset') {
    expect(keys).toEqual(['dockerfile', 'kind']);
  } else {
    expect(keys).toEqual(['imageUri', 'kind']);
  }
}

const baseOther: Omit<AwsDeployConfig, 'imageUri'> = {
  accountId: '123456789012',
  region: 'us-east-1',
  namePrefix: 'phorma',
  permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/phorma-boundary',
  bootstrapQualifier: 'hnb659fds',
  egressAllowList: ['api.anthropic.com'],
  costAllocationTags: { 'phorma:env': 'prod' },
  retentionDays: 30,
  alarmNotificationArn: 'arn:aws:sns:us-east-1:123456789012:phorma-alarms',
};

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('resolveContainerImage', () => {
  it('yields the asset choice when imageUri is absent', () => {
    expect(resolveContainerImage(baseOther)).toEqual({
      kind: 'asset',
      dockerfile: 'cloud-aws/Dockerfile',
    });
  });

  it('treats an empty string as absent', () => {
    expect(resolveContainerImage({ ...baseOther, imageUri: '' }).kind).toBe('asset');
  });

  it('treats a whitespace-only value as absent', () => {
    expect(resolveContainerImage({ ...baseOther, imageUri: ' \t\n ' }).kind).toBe('asset');
  });

  it('names the repository Dockerfile on the asset path', () => {
    const choice = resolveContainerImage(baseOther);
    expect(choice.kind === 'asset' && choice.dockerfile).toBe(HOST_DOCKERFILE);
    expect(HOST_DOCKERFILE).toBe('cloud-aws/Dockerfile');
  });

  it('carries a tagged reference verbatim', () => {
    const imageUri = 'ghcr.io/phorma/agent-studio:0.2.0-beta.9';
    expect(resolveContainerImage({ ...baseOther, imageUri })).toEqual({
      kind: 'reference',
      imageUri,
    });
  });

  it('carries a digest reference verbatim', () => {
    const imageUri = `123456789012.dkr.ecr.us-east-1.amazonaws.com/phorma@sha256:${'a'.repeat(64)}`;
    expect(resolveContainerImage({ ...baseOther, imageUri })).toEqual({
      kind: 'reference',
      imageUri,
    });
  });

  it('trims surrounding whitespace off the reference', () => {
    const choice = resolveContainerImage({ ...baseOther, imageUri: '  ghcr.io/phorma/host:v1\n' });
    expect(choice).toEqual({ kind: 'reference', imageUri: 'ghcr.io/phorma/host:v1' });
  });

  it('routes an invalid reference to the reference path rather than validating it', () => {
    // Req 2.8 puts OCI validation in the Config_Parser. The switch only routes.
    const choice = resolveContainerImage({ ...baseOther, imageUri: 'not an image' });
    expect(choice).toEqual({ kind: 'reference', imageUri: 'not an image' });
  });
});

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

// Feature: aws-byo-deploy, Property 6: Container image path switch
// **Validates: Requirements 4.1, 4.2**
describe('Property 6: Container image path switch', () => {
  it('yields the asset choice exactly when imageUri is absent (Req 4.1)', () => {
    fc.assert(
      fc.property(otherConfigArb, absentImageUriArb, (other, imageUri) => {
        const choice = resolveContainerImage(configWith(other, imageUri));
        expect(choice.kind).toBe('asset');
        expect(choice).toEqual({ kind: 'asset', dockerfile: HOST_DOCKERFILE });
        assertExactlyTwoShapes(choice);
      }),
      { numRuns: RUNS },
    );
  });

  it('yields the reference choice carrying that exact value exactly when present (Req 4.2)', () => {
    fc.assert(
      fc.property(otherConfigArb, presentImageUriArb, (other, imageUri) => {
        const choice = resolveContainerImage(configWith(other, imageUri));
        expect(choice.kind).toBe('reference');
        expect(choice).toEqual({ kind: 'reference', imageUri: imageUri.trim() });
        assertExactlyTwoShapes(choice);
      }),
      { numRuns: RUNS },
    );
  });

  it('is an iff over every imageUri shape - never a third outcome', () => {
    fc.assert(
      fc.property(otherConfigArb, anyImageUriArb, (other, imageUri) => {
        const choice = resolveContainerImage(configWith(other, imageUri));
        assertExactlyTwoShapes(choice);
        expect(choice.kind).toBe(expectedKind(imageUri));
        if (choice.kind === 'asset') {
          expect(choice.dockerfile).toBe('cloud-aws/Dockerfile');
        } else {
          expect(choice.imageUri).toBe((imageUri as string).trim());
          expect(choice.imageUri.length).toBeGreaterThan(0);
          expect(choice.imageUri).toBe(choice.imageUri.trim());
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('routes, never validates: an invalid OCI reference still yields the reference choice', () => {
    fc.assert(
      fc.property(otherConfigArb, nonOciReferenceArb, (other, imageUri) => {
        // Precondition: the generated value really is not a valid OCI reference.
        expect(OCI_REFERENCE_RE.test(imageUri.trim())).toBe(false);
        const choice = resolveContainerImage(configWith(other, imageUri));
        expect(choice).toEqual({ kind: 'reference', imageUri: imageUri.trim() });
      }),
      { numRuns: RUNS },
    );
  });

  it('accepts both valid OCI reference shapes on the reference path', () => {
    fc.assert(
      fc.property(otherConfigArb, ociReferenceArb, (other, imageUri) => {
        // Sanity: the generator produces references the Config_Parser accepts.
        expect(OCI_REFERENCE_RE.test(imageUri)).toBe(true);
        expect(resolveContainerImage(configWith(other, imageUri))).toEqual({
          kind: 'reference',
          imageUri,
        });
      }),
      { numRuns: RUNS },
    );
  });

  it('depends on imageUri alone - the rest of the configuration cannot change the outcome', () => {
    fc.assert(
      fc.property(otherConfigArb, otherConfigArb, anyImageUriArb, (a, b, imageUri) => {
        const fromA = resolveContainerImage(configWith(a, imageUri));
        const fromB = resolveContainerImage(configWith(b, imageUri));
        expect(fromA).toEqual(fromB);
      }),
      { numRuns: RUNS },
    );
  });
});
