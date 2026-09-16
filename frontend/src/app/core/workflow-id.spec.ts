/**
 * Workflow id minting (Requirement 14).
 *
 * A workflow id is no longer a local label. It is the Durable Object instance
 * name, the deployment registry key, the backup object key and the restore
 * identity, so two installs minting the same id would have one silently address
 * the other's deployment, run history and backups. The old
 * `wf-${Date.now().toString(36)}` collided for any two saves inside one
 * millisecond, which is exactly what a restore-all does.
 *
 * The property below therefore pins the case that used to FAIL: ids minted with
 * the clock frozen must still differ.
 */

import fc from 'fast-check';

import { isWorkflowId, mintWorkflowId } from './workflow-id';

describe('mintWorkflowId', () => {
  it('keeps the legacy prefix so existing ids stay addressable (14.2)', () => {
    expect(mintWorkflowId().startsWith('wf-')).toBeTrue();
    expect(isWorkflowId('wf-mabc123')).toBeTrue();
  });

  it('produces only characters that are safe in a storage key and a URL path', () => {
    // The `deploy:{owner}:{workflowId}` registry key REFUSES a colon, and the
    // backup object key is a path segment, so this is a hard constraint rather
    // than a tidiness preference.
    for (let index = 0; index < 200; index += 1) {
      expect(mintWorkflowId()).toMatch(/^wf-[0-9a-z]+-[0-9a-f]{12}$/);
    }
  });

  it('mints distinct ids within a single millisecond (property, 14.3)', () => {
    // Freeze the clock: with the old implementation every id in this batch was
    // byte-identical.
    const frozen = Date.now();
    const realNow = Date.now;
    spyOn(Date, 'now').and.returnValue(frozen);
    try {
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 64 }), count => {
          const ids = Array.from({ length: count }, () => mintWorkflowId());
          return new Set(ids).size === ids.length;
        }),
        { numRuns: 200 },
      );
    } finally {
      expect(realNow).toBeDefined();
    }
  });

  it('still mints when crypto.randomUUID is unavailable', () => {
    // `randomUUID` is gated on a secure context and the desktop webview origin is
    // platform dependent, so the fallback ladder is load-bearing: a throw here
    // would break the first save of every workflow.
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    try {
      const ids = Array.from({ length: 50 }, () => mintWorkflowId());
      expect(new Set(ids).size).toBe(50);
      for (const id of ids) expect(id).toMatch(/^wf-[0-9a-z]+-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: original,
      });
    }
  });

  it('rejects a value carrying the registry key separator', () => {
    expect(isWorkflowId('wf-abc:evil')).toBeFalse();
    expect(isWorkflowId('not-a-workflow')).toBeFalse();
    expect(isWorkflowId(42)).toBeFalse();
  });
});
