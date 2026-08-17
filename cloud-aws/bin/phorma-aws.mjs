#!/usr/bin/env node
/**
 * phorma-aws launcher.
 *
 * This file is a launcher and nothing else. Every verb, exit code, config parse,
 * Sentinel_Envelope encode and Preflight call lives in type-checked TypeScript
 * under `src/cli/`, which `tsc --noEmit` and the vitest suite both cover. The
 * shim used to carry untyped copies of all of it; that second implementation is
 * what Requirement 3.3 forbids, so there is deliberately nothing to duplicate
 * here.
 *
 * `tsx/esm/api` compiles the TypeScript in-process, so the Studio's
 * `npx phorma-aws <verb> ...` needs no build step and no second tool: `cdk.json`
 * already runs the CDK app through `tsx`, and `tsx` is an exact pin in
 * `dependencies` for exactly this reason (Req 6.1, 6.2).
 *
 * `runVerb` RETURNS a code, and we assign `process.exitCode` rather than calling
 * `process.exit`: exiting mid-write can truncate the final Sentinel_Envelope line
 * the Studio is waiting for.
 *
 * Feature: aws-byo-deploy
 * Requirements: 3.3, 6.1, 6.2
 */

import { tsImport } from 'tsx/esm/api';

const { runVerb } = await tsImport('../src/cli/main.ts', import.meta.url);

process.exitCode = await runVerb(process.argv.slice(2));
