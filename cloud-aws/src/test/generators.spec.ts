/**
 * Smoke test for the shared generators fixture.
 *
 * Validates that every exported arbitrary produces values and that edge-case
 * generators hit the boundaries they claim to straddle.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  payloadStraddling300KB,
  payloadStraddling64KB,
  stateValueStraddling32768,
  ttlSecEdge,
  retentionDaysEdge,
  cronExpressionEdge,
  scheduleTriggerNodes51,
  secretKeyCountEdge,
  utf8ByteLength,
  CAP_300KB,
  CAP_64KB,
  STATE_VALUE_BYTE_CAP,
} from './generators.js';

describe('generators', () => {
  it('payloadStraddling300KB produces strings near 300 KB', () => {
    fc.assert(
      fc.property(payloadStraddling300KB(), payload => {
        const bytes = utf8ByteLength(payload);
        // Within a reasonable straddling window around 300 KB
        expect(bytes).toBeGreaterThan(CAP_300KB - 64);
        expect(bytes).toBeLessThan(CAP_300KB + 2048);
      }),
      { numRuns: 50 },
    );
  });

  it('payloadStraddling64KB produces strings near 64 KB', () => {
    fc.assert(
      fc.property(payloadStraddling64KB(), payload => {
        const bytes = utf8ByteLength(payload);
        expect(bytes).toBeGreaterThan(CAP_64KB - 64);
        expect(bytes).toBeLessThan(CAP_64KB + 2048);
      }),
      { numRuns: 50 },
    );
  });

  it('stateValueStraddling32768 produces strings near the byte cap with astral chars', () => {
    fc.assert(
      fc.property(stateValueStraddling32768(), value => {
        const bytes = utf8ByteLength(value);
        // Near 32,768 bytes
        expect(bytes).toBeGreaterThan(STATE_VALUE_BYTE_CAP - 128);
        expect(bytes).toBeLessThan(STATE_VALUE_BYTE_CAP + 128);
        // Should contain multi-byte characters (astral plane = 4 bytes)
        // Character count should be less than byte count
        expect(value.length).not.toBe(bytes);
      }),
      { numRuns: 50 },
    );
  });

  it('ttlSecEdge produces zero, negative, fractional and out-of-range values', () => {
    const values = fc.sample(ttlSecEdge(), 100);
    const hasZero = values.some(v => v === 0);
    const hasNegative = values.some(v => v < 0);
    const hasFractional = values.some(v => v !== Math.floor(v));
    const hasLarge = values.some(v => v > 31_536_000);
    expect(hasZero).toBe(true);
    expect(hasNegative).toBe(true);
    expect(hasFractional).toBe(true);
    expect(hasLarge).toBe(true);
  });

  it('retentionDaysEdge produces 0, 367, 30.5 and valid-range values', () => {
    const values = fc.sample(retentionDaysEdge(), 200);
    expect(values).toContain(0);
    expect(values).toContain(367);
    expect(values).toContain(30.5);
    const hasValid = values.some(v => v >= 1 && v <= 366 && Number.isInteger(v));
    expect(hasValid).toBe(true);
  });

  it('cronExpressionEdge produces blank, invalid and valid expressions', () => {
    const values = fc.sample(cronExpressionEdge(), 200);
    const hasBlank = values.some(v => v.trim() === '');
    const hasInvalid = values.some(v => v === 'not a cron' || v === '60 * * * *');
    const hasValid = values.some(v => v === '0 * * * *' || v === '*/5 * * * *');
    expect(hasBlank).toBe(true);
    expect(hasInvalid).toBe(true);
    expect(hasValid).toBe(true);
  });

  it('scheduleTriggerNodes51 produces exactly 51 schedule-trigger nodes', () => {
    fc.assert(
      fc.property(scheduleTriggerNodes51(), nodes => {
        expect(nodes).toHaveLength(51);
        for (const node of nodes) {
          expect(node.kind).toBe('schedule-trigger');
          expect((node.data as { cron: string }).cron).toBeTruthy();
        }
      }),
      { numRuns: 10 },
    );
  });

  it('secretKeyCountEdge produces arrays of 0 or 32 keys', () => {
    const samples = fc.sample(secretKeyCountEdge(), 50);
    const lengths = new Set(samples.map(s => s.length));
    expect(lengths.has(0)).toBe(true);
    expect(lengths.has(32)).toBe(true);
    // No other lengths should appear
    for (const len of lengths) {
      expect(len === 0 || len === 32).toBe(true);
    }
  });
});
