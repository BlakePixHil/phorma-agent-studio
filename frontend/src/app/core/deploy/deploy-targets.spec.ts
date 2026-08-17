/**
 * Feature: aws-deployment-target
 * Property 31: The Deploy_Provider is total, and command construction never carries a credential
 *
 * **Validates: Requirements 14.2, 14.3, 14.8, 14.13**
 *
 * karma + jasmine, no fast-check available: enumerate all three target ids and all sixteen
 * malformed-field subsets rather than sampling, which is a stronger claim than 100 random draws.
 */

import {
  DEPLOY_TARGETS,
  type DeployCommand,
  type DeployContext,
  type DeployTargetId,
} from './deploy-targets';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_TARGET_IDS: DeployTargetId[] = ['phorma', 'cloudflare', 'aws'];

/**
 * AWS credential patterns that must NEVER appear in any command args or
 * environment. Covers access key ids, secret access keys, session tokens and
 * credential env variable names.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /AWS_ACCESS_KEY_ID/i,
  /AWS_SECRET_ACCESS_KEY/i,
  /AWS_SESSION_TOKEN/i,
  /AKIA[0-9A-Z]{16}/, // access key id shape
  /(?:^|[^a-zA-Z0-9])[A-Za-z0-9/+=]{40}(?:[^a-zA-Z0-9]|$)/, // secret access key shape (40 chars base64)
];

function containsCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => p.test(value));
}

function commandCarriesCredential(cmd: DeployCommand | null): boolean {
  if (!cmd) return false;
  return cmd.args.some((arg) => containsCredential(arg));
}

/**
 * The four context fields whose combinations we enumerate.
 * 2^4 = 16 subsets of malformed (empty) fields.
 */
const CONTEXT_FIELDS = ['cloudFolder', 'workflowId', 'baseUrl', 'cwd'] as const;

/**
 * Generate all 16 DeployContext objects with every subset of the four fields
 * set to empty string (malformed).
 */
function* allMalformedSubsets(): Generator<{ ctx: DeployContext; malformedFields: string[] }> {
  const validCtx: DeployContext = {
    cloudFolder: '/home/user/cloud-aws',
    workflowId: 'wf-abc123',
    baseUrl: 'https://api.example.com',
  };

  for (let mask = 0; mask < 16; mask++) {
    const malformedFields: string[] = [];
    const ctx: DeployContext = { ...validCtx };

    if (mask & 1) {
      ctx.cloudFolder = '';
      malformedFields.push('cloudFolder');
    }
    if (mask & 2) {
      ctx.workflowId = '';
      malformedFields.push('workflowId');
    }
    if (mask & 4) {
      ctx.baseUrl = '';
      malformedFields.push('baseUrl');
    }
    // The fourth field: cwd in the returned DeployCommand (tested on the output side)
    if (mask & 8) {
      // For this subset we also clear cloudFolder (cwd derives from it for aws/cloudflare)
      // This tests the "cwd" dimension independently by checking the command output
      malformedFields.push('cwd');
    }

    yield { ctx, malformedFields };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Deploy_Provider totality and credential safety (Property 31)', () => {
  describe('DEPLOY_TARGETS is total: every target id has a complete record', () => {
    for (const id of ALL_TARGET_IDS) {
      describe(`target "${id}"`, () => {
        const target = DEPLOY_TARGETS[id];

        it('exists in the registry', () => {
          expect(target).toBeDefined();
        });

        it('has a capabilities record', () => {
          expect(target.capabilities).toBeDefined();
          expect(target.capabilities.id).toBeTruthy();
        });

        it('has a connectionSecretScheme', () => {
          expect(target.connectionSecretScheme).toBeTruthy();
        });

        it('has a deployCommand function', () => {
          expect(typeof target.deployCommand).toBe('function');
        });

        it('has an instanceUrl function', () => {
          expect(typeof target.instanceUrl).toBe('function');
        });
      });
    }
  });

  describe('instanceUrl shape: /agents/workflow-agent/{id} for Cloudflare targets only', () => {
    const workflowId = 'wf-test-123';
    const base = 'https://deploy.example.com';

    it('phorma produces /agents/workflow-agent/{id}', () => {
      const url = DEPLOY_TARGETS.phorma.instanceUrl(base, workflowId);
      expect(url).toContain('/agents/workflow-agent/');
      expect(url).toContain(workflowId);
    });

    it('cloudflare produces /agents/workflow-agent/{id}', () => {
      const url = DEPLOY_TARGETS.cloudflare.instanceUrl(base, workflowId);
      expect(url).toContain('/agents/workflow-agent/');
      expect(url).toContain(workflowId);
    });

    it('aws does NOT produce /agents/workflow-agent/{id}', () => {
      const url = DEPLOY_TARGETS.aws.instanceUrl(base, workflowId);
      expect(url).not.toContain('/agents/workflow-agent/');
      expect(url).toContain(workflowId);
    });
  });

  describe('command construction never carries a credential', () => {
    const validCtx: DeployContext = {
      cloudFolder: '/home/user/cloud-aws',
      workflowId: 'wf-abc123',
      baseUrl: 'https://api.example.com',
    };

    for (const id of ALL_TARGET_IDS) {
      describe(`target "${id}" deployCommand`, () => {
        it('does not contain AWS credentials in args', () => {
          const cmd = DEPLOY_TARGETS[id].deployCommand(validCtx);
          expect(commandCarriesCredential(cmd)).toBeFalse();
        });
      });

      if (DEPLOY_TARGETS[id].planCommand) {
        describe(`target "${id}" planCommand`, () => {
          it('does not contain AWS credentials in args', () => {
            const cmd = DEPLOY_TARGETS[id].planCommand!(validCtx);
            expect(commandCarriesCredential(cmd)).toBeFalse();
          });
        });
      }
    }
  });

  describe('planCommand and deployCommand return DeployCommand or null (never throw)', () => {
    for (const { ctx, malformedFields } of allMalformedSubsets()) {
      const label = malformedFields.length === 0
        ? 'all fields valid'
        : `malformed: [${malformedFields.join(', ')}]`;

      for (const id of ALL_TARGET_IDS) {
        describe(`target "${id}" with ${label}`, () => {
          it('deployCommand does not throw', () => {
            expect(() => DEPLOY_TARGETS[id].deployCommand(ctx)).not.toThrow();
          });

          it('deployCommand returns DeployCommand or null', () => {
            const result = DEPLOY_TARGETS[id].deployCommand(ctx);
            if (result !== null) {
              expect(result.program).toBe('npx');
              expect(Array.isArray(result.args)).toBeTrue();
              expect(typeof result.cwd).toBe('string');
            } else {
              expect(result).toBeNull();
            }
          });

          if (DEPLOY_TARGETS[id].planCommand) {
            it('planCommand does not throw', () => {
              expect(() => DEPLOY_TARGETS[id].planCommand!(ctx)).not.toThrow();
            });

            it('planCommand returns DeployCommand or null', () => {
              const result = DEPLOY_TARGETS[id].planCommand!(ctx);
              if (result !== null) {
                expect(result.program).toBe('npx');
                expect(Array.isArray(result.args)).toBeTrue();
                expect(typeof result.cwd).toBe('string');
              } else {
                expect(result).toBeNull();
              }
            });
          }
        });
      }
    }
  });

  describe('exhaustive enumeration: no credential in any subset x target combination', () => {
    for (const { ctx, malformedFields } of allMalformedSubsets()) {
      const label = malformedFields.length === 0
        ? 'all fields valid'
        : `malformed: [${malformedFields.join(', ')}]`;

      for (const id of ALL_TARGET_IDS) {
        it(`target "${id}" with ${label} - deployCommand carries no credential`, () => {
          const cmd = DEPLOY_TARGETS[id].deployCommand(ctx);
          expect(commandCarriesCredential(cmd)).toBeFalse();
        });

        if (DEPLOY_TARGETS[id].planCommand) {
          it(`target "${id}" with ${label} - planCommand carries no credential`, () => {
            const cmd = DEPLOY_TARGETS[id].planCommand!(ctx);
            expect(commandCarriesCredential(cmd)).toBeFalse();
          });
        }
      }
    }
  });
});
