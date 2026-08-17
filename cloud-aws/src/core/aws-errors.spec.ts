/**
 * Unit tests for the pure gone-connection classifier.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.7, 8.10, 13.1
 */

import { describe, expect, it } from 'vitest';

import { classify, isGoneError } from './aws-errors.js';

describe('isGoneError', () => {
  it('matches the API Gateway error name', () => {
    const error = new Error('Connection conn-1 is gone');
    error.name = 'GoneException';
    expect(isGoneError(error)).toBe(true);
  });

  it('matches a fully qualified protocol shape id', () => {
    expect(
      isGoneError({ __type: 'com.amazonaws.apigatewaymanagementapi#GoneException' }),
    ).toBe(true);
  });

  it('matches an HTTP status of 410 with no error name', () => {
    expect(isGoneError({ $metadata: { httpStatusCode: 410 } })).toBe(true);
    expect(isGoneError({ statusCode: 410 })).toBe(true);
  });

  it('rejects other AWS errors', () => {
    const throttled = new Error('rate exceeded');
    throttled.name = 'ThrottlingException';
    expect(isGoneError(throttled)).toBe(false);
    expect(isGoneError({ $metadata: { httpStatusCode: 500 } })).toBe(false);
  });

  it('is total over non-object values', () => {
    expect(isGoneError(undefined)).toBe(false);
    expect(isGoneError(null)).toBe(false);
    expect(isGoneError('GoneException')).toBe(false);
    expect(isGoneError(410)).toBe(false);
  });
});

describe('classify re-export', () => {
  it('exposes the lease classifier from one import site', () => {
    expect(classify({ name: 'ConditionalCheckFailedException' })).toBe('condition');
    expect(classify({ name: 'ThrottlingException' })).toBe('transient');
    expect(classify(undefined)).toBe('fatal');
  });
});
