/**
 * Unit and property tests for the Config_Parser's optional image and endpoint
 * fields: `imageUri`, `triggerApiUrl` and `monitorApiUrl`.
 *
 * The expectation here is derived INDEPENDENTLY of the implementation. Nothing
 * in this file imports `IMAGE_URI_RE` or calls `isEndpointUrl` - a test whose
 * oracle is the production pattern proves only that the pattern equals itself,
 * and a shared bug passes. The shape rules are restated below as structural
 * predicates (split the reference, check each part's alphabet) so a change to
 * either side has to be argued for.
 *
 * Requirements: 2.6, 2.8, 2.9, 3.2
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseAwsDeployConfig, ConfigError, type AwsDeployConfig } from './config.js';

/** Iterations per property. The repo floor is 100; parsing is pure and cheap. */
const RUNS = 100;

/** The three optional fields this file covers. */
const OPTIONAL_FIELDS = ['imageUri', 'triggerApiUrl', 'monitorApiUrl'] as const;
type OptionalField = (typeof OPTIONAL_FIELDS)[number];

/**
 * A configuration whose required fields all pass, so every outcome below is
 * attributable to the one field under test.
 */
const BASE_RAW: Record<string, unknown> = {
  accountId: '123456789012',
  region: 'eu-west-1',
  namePrefix: 'phorma',
  permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/phorma-boundary',
  bootstrapQualifier: 'hnb659fds',
  egressAllowList: ['api.anthropic.com'],
  costAllocationTags: { 'phorma:env': 'prod' },
  alarmNotificationArn: 'arn:aws:sns:eu-west-1:123456789012:phorma-alarms',
};

// ---------------------------------------------------------------------------
// Independent expectation: the documented image reference shape
// ---------------------------------------------------------------------------

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

/** Registry host alphabet - lowercase only, as OCI requires. */
const HOST_CHARS = `${LOWER}${DIGITS}.-`;
/** Repository path alphabet - lowercase only, `/` separates segments. */
const REPOSITORY_CHARS = `${LOWER}${DIGITS}._/-`;
/** Tag alphabet - mixed case allowed, 1-128 characters. */
const TAG_CHARS = `${LOWER}${UPPER}${DIGITS}._-`;
/** Digest alphabet - 64 lowercase hex characters. */
const HEX_CHARS = `${DIGITS}abcdef`;

function allCharsIn(value: string, allowed: string): boolean {
  for (const ch of value) {
    if (!allowed.includes(ch)) {
      return false;
    }
  }
  return true;
}

/**
 * `{registry}[:{port}]/{repository}` - the half of an image reference that sits
 * before the tag or digest separator. A bare name with no registry fails: the
 * documented shape always carries a registry host.
 */
function isRegistryAndRepository(body: string): boolean {
  const slash = body.indexOf('/');
  if (slash < 0) {
    return false;
  }
  const authority = body.slice(0, slash);
  const repository = body.slice(slash); // keeps the leading '/'

  const colon = authority.indexOf(':');
  const host = colon < 0 ? authority : authority.slice(0, colon);
  const port = colon < 0 ? undefined : authority.slice(colon + 1);
  if (host.length === 0 || !allCharsIn(host, HOST_CHARS)) {
    return false;
  }
  if (port !== undefined && (port.length === 0 || !allCharsIn(port, DIGITS))) {
    return false;
  }

  // At least one character after the leading '/'.
  if (repository.length < 2 || !allCharsIn(repository.slice(1), REPOSITORY_CHARS)) {
    return false;
  }
  return true;
}

/**
 * The documented `imageUri` shape (Req 2.6, 2.8):
 * `{registry}[:{port}]/{repository}:{tag}` or
 * `{registry}[:{port}]/{repository}@sha256:{digest}`.
 *
 * Neither the tag nor the digest alphabet contains `@`, `:` or `/`, so the
 * separator is unambiguous: the first `@` if there is one, otherwise the last
 * `:`. A value with no tag and no digest carries no reference and fails.
 */
function imageUriMatchesShape(value: string): boolean {
  const at = value.indexOf('@');
  if (at >= 0) {
    const digest = value.slice(at + 1);
    if (!digest.startsWith('sha256:')) {
      return false;
    }
    const hex = digest.slice('sha256:'.length);
    if (hex.length !== 64 || !allCharsIn(hex, HEX_CHARS)) {
      return false;
    }
    return isRegistryAndRepository(value.slice(0, at));
  }

  const colon = value.lastIndexOf(':');
  if (colon < 0) {
    return false;
  }
  const tag = value.slice(colon + 1);
  if (tag.length < 1 || tag.length > 128 || !allCharsIn(tag, TAG_CHARS)) {
    return false;
  }
  return isRegistryAndRepository(value.slice(0, colon));
}

// ---------------------------------------------------------------------------
// Independent expectation: the documented endpoint shape
// ---------------------------------------------------------------------------

/** Authority: a host, optionally `:port`. Host case is not constrained. */
const ORACLE_AUTHORITY_RE = /^[A-Za-z0-9._~-]+(:\d{1,5})?$/;
/** One path segment, allowing the unreserved and sub-delimiter characters. */
const ORACLE_SEGMENT_RE = /^[A-Za-z0-9._~%!$&'()*+,;=:@-]*$/;

/**
 * The documented endpoint shape (Req 2.8, 2.9): `{scheme}://{authority}[{path}]`
 * with no surrounding whitespace, no query, no fragment, and a trailing slash
 * only where the field allows one.
 *
 * `triggerApiUrl` is a base the Studio joins route paths onto, so a trailing
 * slash is a defect there. `monitorApiUrl` carries the API Gateway stage path
 * (`/live`), so a path and a trailing slash are both fine.
 */
function endpointMatchesShape(
  value: string,
  scheme: 'https' | 'wss',
  allowTrailingSlash: boolean,
): boolean {
  if (value !== value.trim()) {
    return false;
  }
  if (value.includes('?') || value.includes('#')) {
    return false;
  }
  if (!allowTrailingSlash && value.endsWith('/')) {
    return false;
  }
  const prefix = `${scheme}://`;
  // A scheme is case-insensitive per the URL specification.
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) {
    return false;
  }
  const rest = value.slice(prefix.length);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  if (!ORACLE_AUTHORITY_RE.test(authority)) {
    return false;
  }
  if (slash < 0) {
    return true;
  }
  return rest
    .slice(slash + 1)
    .split('/')
    .every((segment) => ORACLE_SEGMENT_RE.test(segment));
}

/** Absent, accepted, or rejected - the three outcomes the parser can produce. */
type Expectation = 'absent' | 'accept' | 'reject';

/**
 * Blank and whitespace-only mean ABSENT for all three fields: a cleared form
 * field serializes as `""`, and that is what routes `imageUri` back to the
 * asset build path in `resolveContainerImage`.
 */
function expectationFor(field: OptionalField, value: string): Expectation {
  if (value.trim().length === 0) {
    return 'absent';
  }
  switch (field) {
    case 'imageUri':
      return imageUriMatchesShape(value) ? 'accept' : 'reject';
    case 'triggerApiUrl':
      return endpointMatchesShape(value, 'https', false) ? 'accept' : 'reject';
    case 'monitorApiUrl':
      return endpointMatchesShape(value, 'wss', true) ? 'accept' : 'reject';
  }
}

// ---------------------------------------------------------------------------
// Parse harness
// ---------------------------------------------------------------------------

type Outcome =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly error: unknown };

function parseField(field: OptionalField, value: unknown, extras: object = {}): Outcome {
  try {
    const parsed: AwsDeployConfig = parseAwsDeployConfig({
      ...BASE_RAW,
      ...extras,
      [field]: value,
    });
    return { ok: true, value: parsed[field] };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Assert the parser's outcome for one field equals the independently derived
 * expectation, and that every rejection is a `ConfigError` naming the field.
 */
function assertFieldOutcome(field: OptionalField, value: string, extras: object = {}): void {
  const expected = expectationFor(field, value);
  const outcome = parseField(field, value, extras);
  const label = `${field}=${JSON.stringify(value)}`;

  if (expected === 'reject') {
    expect(outcome.ok, `expected rejection for ${label}`).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error, `rejection for ${label} must be a ConfigError`).toBeInstanceOf(
        ConfigError,
      );
      expect((outcome.error as Error).message, `message must name ${field}`).toContain(field);
    }
    return;
  }

  expect(outcome.ok, `expected acceptance for ${label}`).toBe(true);
  if (outcome.ok) {
    // Nothing is trimmed or repaired: an accepted value comes back verbatim.
    expect(outcome.value).toBe(expected === 'absent' ? undefined : value);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const chars = (source: string) => fc.constantFrom(...source.split(''));

const stringOf = (source: string, minLength: number, maxLength: number) =>
  fc.array(chars(source), { minLength, maxLength }).map((cs) => cs.join(''));

const WHITESPACE_CHARS = [' ', '\t', '\n', '\r', '\f', '\v'] as const;

/** One or more whitespace characters - a value that counts as ABSENT. */
const whitespaceRunArb = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 1, maxLength: 6 })
  .map((cs) => cs.join(''));

/** Zero or more whitespace characters - padding that must NOT be repaired. */
const paddingArb = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 0, maxLength: 3 })
  .map((cs) => cs.join(''));

/** Blank forms: every one of these means absent. */
const blankArb = fc.oneof(fc.constant(''), whitespaceRunArb);

/** Free-form junk. Not filtered: the image oracle is total over any string. */
const junkArb = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.string({ unit: 'grapheme', maxLength: 12 }),
  fc.string({ unit: 'binary', maxLength: 12 }),
);

// --- imageUri ---------------------------------------------------------------

const registryArb = fc.constantFrom(
  'docker.io',
  'ghcr.io',
  'public.ecr.aws',
  '123456789012.dkr.ecr.eu-west-1.amazonaws.com',
  'registry.example.com:5000',
);

const repositoryArb = fc
  .array(fc.constantFrom('phorma', 'agent-studio', 'host', 'a.b', 'x_y', 'v2'), {
    minLength: 1,
    maxLength: 3,
  })
  .map((segments) => segments.join('/'));

/** Mixed-case tags are legal; the registry and repository halves are not. */
const tagArb = stringOf(TAG_CHARS, 1, 12);

const hexArb = (length: number) => stringOf(HEX_CHARS, length, length);

const taggedImageArb = fc
  .tuple(registryArb, repositoryArb, tagArb)
  .map(([registry, repository, tag]) => `${registry}/${repository}:${tag}`);

const digestImageArb = fc
  .tuple(registryArb, repositoryArb, hexArb(64))
  .map(([registry, repository, hex]) => `${registry}/${repository}@sha256:${hex}`);

/** Both documented image shapes. */
const acceptedImageArb = fc.oneof(taggedImageArb, digestImageArb);

/** Digests off the documented shape: 63, 65, non-hex, uppercase, empty. */
const badDigestArb = fc
  .tuple(
    registryArb,
    repositoryArb,
    fc.oneof(
      hexArb(63),
      hexArb(65),
      hexArb(63).map((hex) => `${hex}g`),
      hexArb(64).map((hex) => hex.toUpperCase()),
      fc.constant('A'.repeat(64)),
      fc.constant(''),
      hexArb(64).map((hex) => `${hex}:`),
      hexArb(64).map((hex) => ` ${hex}`),
    ),
  )
  .map(([registry, repository, digest]) => `${registry}/${repository}@sha256:${digest}`);

/** Case violations: an uppercase registry or repository must be rejected. */
const uppercaseImageArb = fc.oneof(
  fc.tuple(repositoryArb, tagArb).map(([repository, tag]) => `Ghcr.io/${repository}:${tag}`),
  fc.tuple(registryArb, tagArb).map(([registry, tag]) => `${registry}/Phorma/host:${tag}`),
  fc
    .tuple(registryArb, repositoryArb, tagArb)
    .map(([registry, repository, tag]) => `${registry.toUpperCase()}/${repository}:${tag}`),
);

/** Structural violations around the tag and the registry. */
const malformedImageArb = fc.oneof(
  // No tag and no digest at all.
  fc.tuple(registryArb, repositoryArb).map(([registry, repository]) => `${registry}/${repository}`),
  // Empty tag.
  fc.tuple(registryArb, repositoryArb).map(([registry, repository]) => `${registry}/${repository}:`),
  // 129-character tag, one over the limit.
  fc
    .tuple(registryArb, repositoryArb)
    .map(([registry, repository]) => `${registry}/${repository}:${'v'.repeat(129)}`),
  // A bare name with no registry.
  fc.constantFrom('nginx', 'nginx:latest', 'host@sha256:abc', ':latest', '/repo:tag'),
  // A registry and port but no repository.
  fc.constantFrom('registry.example.com:5000', 'ghcr.io:443', 'ghcr.io/'),
  // Tag and digest at once, and a `/` inside the tag.
  fc
    .tuple(registryArb, repositoryArb, tagArb, hexArb(64))
    .map(([registry, repository, tag, hex]) => `${registry}/${repository}:${tag}@sha256:${hex}`),
  fc
    .tuple(registryArb, repositoryArb, tagArb)
    .map(([registry, repository, tag]) => `${registry}/${repository}:${tag}/extra`),
);

/** Padded values: whitespace inside the value is reported, never repaired. */
const paddedImageArb = fc
  .tuple(paddingArb, acceptedImageArb, paddingArb)
  .map(([before, image, after]) => `${before}${image}${after}`)
  .filter((value) => value.trim().length > 0);

/** Every `imageUri` candidate family. */
const imageCandidateArb = fc.oneof(
  acceptedImageArb,
  badDigestArb,
  uppercaseImageArb,
  malformedImageArb,
  paddedImageArb,
  blankArb,
  junkArb,
);

// --- triggerApiUrl and monitorApiUrl ---------------------------------------

const endpointAuthorityArb = fc.constantFrom(
  'abc123.execute-api.eu-west-1.amazonaws.com',
  'def456.execute-api.us-east-1.amazonaws.com',
  'api.example.com',
  'phorma-host.internal:8443',
);

const endpointPathArb = fc.constantFrom('', '/live', '/prod', '/live/v2', '/stage-1');

/**
 * Every scheme the two fields must discriminate between, in both cases. Only
 * `https` belongs to `triggerApiUrl` and only `wss` to `monitorApiUrl`; the
 * oracle decides per field, so one shared generator probes both directions.
 */
const ENDPOINT_SCHEMES = ['https', 'HTTPS', 'wss', 'WSS', 'ws', 'http', 'ftp', 'ssh'] as const;

const wellFormedEndpointArb = fc
  .tuple(
    fc.constantFrom(...ENDPOINT_SCHEMES),
    endpointAuthorityArb,
    endpointPathArb,
    fc.boolean(),
  )
  .map(
    ([scheme, authority, path, trailingSlash]) =>
      `${scheme}://${authority}${path}${trailingSlash ? '/' : ''}`,
  );

/** A query or a fragment disqualifies either field. */
const decoratedEndpointArb = fc
  .tuple(wellFormedEndpointArb, fc.constantFrom('?', '#', '?x=1', '#frag', '?#'))
  .map(([url, suffix]) => `${url}${suffix}`);

/** Surrounding whitespace disqualifies either field (padding may be empty). */
const paddedEndpointArb = fc
  .tuple(paddingArb, wellFormedEndpointArb, paddingArb)
  .map(([before, url, after]) => `${before}${url}${after}`);

/**
 * Malformed endpoints. Free-form junk excludes `:` on purpose: for a special
 * scheme the URL parser rewrites scheme-relative forms such as `https:/host`,
 * which is outside the documented shape and is not what this property is about.
 */
const malformedEndpointArb = fc.oneof(
  fc.constantFrom(
    'https://',
    'wss://',
    'https',
    'wss',
    '//abc123.execute-api.eu-west-1.amazonaws.com/live',
    'abc123.execute-api.eu-west-1.amazonaws.com',
    'api.example.com/live',
    'www.example.com',
  ),
  junkArb.filter((value) => !value.includes(':')),
);

/** Every endpoint candidate family, shared by both endpoint fields. */
const endpointCandidateArb = fc.oneof(
  wellFormedEndpointArb,
  decoratedEndpointArb,
  paddedEndpointArb,
  malformedEndpointArb,
  blankArb,
);

/** Endpoints that satisfy `triggerApiUrl`: https, no trailing slash. */
const acceptedTriggerArb = fc
  .tuple(endpointAuthorityArb, endpointPathArb)
  .map(([authority, path]) => `https://${authority}${path}`);

/** Endpoints that satisfy `monitorApiUrl`: wss, trailing slash allowed. */
const acceptedMonitorArb = fc
  .tuple(endpointAuthorityArb, endpointPathArb, fc.boolean())
  .map(
    ([authority, path, trailingSlash]) =>
      `wss://${authority}${path}${trailingSlash ? '/' : ''}`,
  );

/** Values that are not strings at all. `null` and `undefined` mean absent. */
const nonStringArb = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.array(fc.string(), { maxLength: 3 }),
  fc.record({ uri: fc.string() }),
  fc.constant({}),
);

/** Unknown members the parser must ignore, including the provenance notice. */
const unknownMembersArb = fc.oneof(
  fc.constant({}),
  fc.constant({ $generatedBy: 'Phorma Agent Studio - generated file, do not edit' }),
  fc.record({
    $generatedBy: fc.string({ maxLength: 40 }),
    somethingNew: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
  }),
);

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

function parseWith(members: object): AwsDeployConfig {
  return parseAwsDeployConfig({ ...BASE_RAW, ...members });
}

function expectRejection(members: object, field: OptionalField): void {
  let thrown: unknown;
  try {
    parseWith(members);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toContain(field);
}

describe('parseAwsDeployConfig - imageUri (Req 2.6, 2.8)', () => {
  it('accepts a tagged reference verbatim', () => {
    const imageUri = 'ghcr.io/phorma/agent-studio:0.2.0-beta.9';
    expect(parseWith({ imageUri }).imageUri).toBe(imageUri);
  });

  it('accepts a digest reference', () => {
    const imageUri = `123456789012.dkr.ecr.eu-west-1.amazonaws.com/phorma@sha256:${'a'.repeat(64)}`;
    expect(parseWith({ imageUri }).imageUri).toBe(imageUri);
  });

  it('accepts a registry with a port', () => {
    const imageUri = 'registry.example.com:5000/phorma/host:v1';
    expect(parseWith({ imageUri }).imageUri).toBe(imageUri);
  });

  it('accepts a mixed-case tag', () => {
    const imageUri = 'ghcr.io/phorma/host:2.1.0-RC1';
    expect(parseWith({ imageUri }).imageUri).toBe(imageUri);
  });

  it('rejects an uppercase registry', () => {
    expectRejection({ imageUri: 'Ghcr.io/phorma/host:v1' }, 'imageUri');
  });

  it('rejects an uppercase repository', () => {
    expectRejection({ imageUri: 'ghcr.io/Phorma/host:v1' }, 'imageUri');
  });

  it('rejects a 63-character digest', () => {
    expectRejection({ imageUri: `ghcr.io/phorma@sha256:${'a'.repeat(63)}` }, 'imageUri');
  });

  it('rejects a 65-character digest', () => {
    expectRejection({ imageUri: `ghcr.io/phorma@sha256:${'a'.repeat(65)}` }, 'imageUri');
  });

  it('rejects a digest carrying a non-hex character', () => {
    expectRejection({ imageUri: `ghcr.io/phorma@sha256:${'a'.repeat(63)}g` }, 'imageUri');
  });

  it('rejects a reference with no tag and no digest', () => {
    expectRejection({ imageUri: 'ghcr.io/phorma/host' }, 'imageUri');
  });

  it('rejects a bare name with no registry', () => {
    expectRejection({ imageUri: 'nginx:latest' }, 'imageUri');
  });

  it('accepts a two-segment value, since the first segment occupies the registry position', () => {
    // `phorma` is a legal registry host, so this is a well-formed reference.
    expect(parseWith({ imageUri: 'phorma/host:v1' }).imageUri).toBe('phorma/host:v1');
  });

  it('rejects a value padded with whitespace rather than trimming it', () => {
    expectRejection({ imageUri: ' ghcr.io/phorma/host:v1 ' }, 'imageUri');
  });

  it('treats an empty string as absent', () => {
    expect(parseWith({ imageUri: '' }).imageUri).toBeUndefined();
  });

  it('treats a whitespace-only value as absent', () => {
    expect(parseWith({ imageUri: ' \t\n ' }).imageUri).toBeUndefined();
  });

  it('treats null and an omitted member as absent', () => {
    expect(parseWith({ imageUri: null }).imageUri).toBeUndefined();
    expect(parseWith({}).imageUri).toBeUndefined();
  });

  it('rejects a non-string value', () => {
    expectRejection({ imageUri: 42 }, 'imageUri');
  });
});

describe('parseAwsDeployConfig - triggerApiUrl (Req 2.8, 2.9)', () => {
  it('accepts an https origin', () => {
    const triggerApiUrl = 'https://abc123.execute-api.eu-west-1.amazonaws.com';
    expect(parseWith({ triggerApiUrl }).triggerApiUrl).toBe(triggerApiUrl);
  });

  it('accepts an https URL carrying a path', () => {
    const triggerApiUrl = 'https://abc123.execute-api.eu-west-1.amazonaws.com/prod';
    expect(parseWith({ triggerApiUrl }).triggerApiUrl).toBe(triggerApiUrl);
  });

  it.each(['http', 'ws', 'wss', 'ftp'])('rejects the %s scheme', (scheme) => {
    expectRejection({ triggerApiUrl: `${scheme}://api.example.com` }, 'triggerApiUrl');
  });

  it('rejects a query', () => {
    expectRejection({ triggerApiUrl: 'https://api.example.com?stage=prod' }, 'triggerApiUrl');
  });

  it('rejects a fragment', () => {
    expectRejection({ triggerApiUrl: 'https://api.example.com#prod' }, 'triggerApiUrl');
  });

  it('rejects a trailing slash, since route paths are joined onto this base', () => {
    expectRejection({ triggerApiUrl: 'https://api.example.com/' }, 'triggerApiUrl');
  });

  it('rejects surrounding whitespace', () => {
    expectRejection({ triggerApiUrl: ' https://api.example.com ' }, 'triggerApiUrl');
  });

  it('treats blank and whitespace-only values as absent', () => {
    expect(parseWith({ triggerApiUrl: '' }).triggerApiUrl).toBeUndefined();
    expect(parseWith({ triggerApiUrl: '   ' }).triggerApiUrl).toBeUndefined();
  });

  it('rejects a non-string value', () => {
    expectRejection({ triggerApiUrl: ['https://api.example.com'] }, 'triggerApiUrl');
  });
});

describe('parseAwsDeployConfig - monitorApiUrl (Req 2.8, 2.9)', () => {
  it('accepts a wss URL carrying the stage path', () => {
    const monitorApiUrl = 'wss://def456.execute-api.eu-west-1.amazonaws.com/live';
    expect(parseWith({ monitorApiUrl }).monitorApiUrl).toBe(monitorApiUrl);
  });

  it('accepts a trailing slash', () => {
    const monitorApiUrl = 'wss://def456.execute-api.eu-west-1.amazonaws.com/live/';
    expect(parseWith({ monitorApiUrl }).monitorApiUrl).toBe(monitorApiUrl);
  });

  it.each(['https', 'ws', 'http', 'ftp'])('rejects the %s scheme', (scheme) => {
    expectRejection({ monitorApiUrl: `${scheme}://api.example.com/live` }, 'monitorApiUrl');
  });

  it('rejects a query', () => {
    expectRejection({ monitorApiUrl: 'wss://api.example.com/live?x=1' }, 'monitorApiUrl');
  });

  it('rejects a fragment', () => {
    expectRejection({ monitorApiUrl: 'wss://api.example.com/live#x' }, 'monitorApiUrl');
  });

  it('rejects surrounding whitespace', () => {
    expectRejection({ monitorApiUrl: '\twss://api.example.com/live' }, 'monitorApiUrl');
  });

  it('treats blank and whitespace-only values as absent', () => {
    expect(parseWith({ monitorApiUrl: '' }).monitorApiUrl).toBeUndefined();
    expect(parseWith({ monitorApiUrl: '\n' }).monitorApiUrl).toBeUndefined();
  });

  it('rejects a non-string value', () => {
    expectRejection({ monitorApiUrl: true }, 'monitorApiUrl');
  });
});

describe('parseAwsDeployConfig - unknown members (Req 3.2)', () => {
  it('ignores the provenance notice the AWS_Config_Store writes', () => {
    const parsed = parseWith({
      $generatedBy: 'Phorma Agent Studio - generated file, do not edit',
      imageUri: 'ghcr.io/phorma/host:v1',
    });
    expect(parsed.imageUri).toBe('ghcr.io/phorma/host:v1');
    expect((parsed as unknown as Record<string, unknown>).$generatedBy).toBeUndefined();
  });

  it('ignores any other unknown member', () => {
    expect(() => parseWith({ somethingNew: { nested: true } })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Property 16
// ---------------------------------------------------------------------------

// Feature: aws-byo-deploy, Property 16: Config parser accepts exactly the documented endpoint and image shapes
// **Validates: Requirements 2.6, 2.8, 2.9**
describe('Property 16: Config parser accepts exactly the documented endpoint and image shapes', () => {
  it('accepts an imageUri exactly when it matches the documented OCI shape (Req 2.6, 2.8)', () => {
    fc.assert(
      fc.property(imageCandidateArb, (value) => {
        assertFieldOutcome('imageUri', value);
      }),
      { numRuns: RUNS },
    );
  });

  it('accepts a triggerApiUrl exactly when it is an https endpoint (Req 2.8, 2.9)', () => {
    fc.assert(
      fc.property(endpointCandidateArb, (value) => {
        assertFieldOutcome('triggerApiUrl', value);
      }),
      { numRuns: RUNS },
    );
  });

  it('accepts a monitorApiUrl exactly when it is a wss endpoint (Req 2.8, 2.9)', () => {
    fc.assert(
      fc.property(endpointCandidateArb, (value) => {
        assertFieldOutcome('monitorApiUrl', value);
      }),
      { numRuns: RUNS },
    );
  });

  it('discriminates the two endpoint schemes: neither field accepts the other (Req 2.9)', () => {
    fc.assert(
      fc.property(acceptedTriggerArb, acceptedMonitorArb, (triggerUrl, monitorUrl) => {
        // Each value is valid for its own field.
        expect(parseField('triggerApiUrl', triggerUrl)).toEqual({ ok: true, value: triggerUrl });
        expect(parseField('monitorApiUrl', monitorUrl)).toEqual({ ok: true, value: monitorUrl });
        // And rejected, naming the field, when swapped.
        assertFieldOutcome('triggerApiUrl', monitorUrl);
        assertFieldOutcome('monitorApiUrl', triggerUrl);
      }),
      { numRuns: RUNS },
    );
  });

  it('treats blank and whitespace-only as absent for all three fields (Req 2.6, 2.8)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...OPTIONAL_FIELDS), blankArb, (field, value) => {
        const outcome = parseField(field, value);
        expect(outcome).toEqual({ ok: true, value: undefined });
      }),
      { numRuns: RUNS },
    );
  });

  it('raises a ConfigError naming the field for a non-string value (Req 2.8)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...OPTIONAL_FIELDS), nonStringArb, (field, value) => {
        const outcome = parseField(field, value);
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.error).toBeInstanceOf(ConfigError);
          expect((outcome.error as Error).message).toContain(field);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('carries all three accepted values through verbatim together (Req 2.8)', () => {
    fc.assert(
      fc.property(
        acceptedImageArb,
        acceptedTriggerArb,
        acceptedMonitorArb,
        (imageUri, triggerApiUrl, monitorApiUrl) => {
          // The generators really do produce the documented shapes.
          expect(imageUriMatchesShape(imageUri)).toBe(true);
          expect(endpointMatchesShape(triggerApiUrl, 'https', false)).toBe(true);
          expect(endpointMatchesShape(monitorApiUrl, 'wss', true)).toBe(true);

          const parsed = parseAwsDeployConfig({
            ...BASE_RAW,
            imageUri,
            triggerApiUrl,
            monitorApiUrl,
          });
          expect(parsed.imageUri).toBe(imageUri);
          expect(parsed.triggerApiUrl).toBe(triggerApiUrl);
          expect(parsed.monitorApiUrl).toBe(monitorApiUrl);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('ignores $generatedBy and other unknown members, whatever the field value (Req 3.2)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...OPTIONAL_FIELDS),
        fc.oneof(imageCandidateArb, endpointCandidateArb),
        unknownMembersArb,
        (field, value, extras) => {
          // The outcome with unknown members present matches the outcome without.
          assertFieldOutcome(field, value, extras);
          const withExtras = parseField(field, value, extras);
          const withoutExtras = parseField(field, value);
          expect(withExtras.ok).toBe(withoutExtras.ok);
          if (withExtras.ok && withoutExtras.ok) {
            expect(withExtras.value).toBe(withoutExtras.value);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});
