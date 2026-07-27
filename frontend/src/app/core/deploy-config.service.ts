/**
 * BYO-Cloudflare deploy configuration.
 *
 * `cloud/wrangler.jsonc` is version-controlled and shared with Phorma's own
 * hosted deploy, so a user must never be asked to hand-edit it: their edits
 * would conflict on every `git pull`, which is exactly the update path a
 * published portal depends on.
 *
 * Instead, when a user needs anything beyond the generic defaults - a specific
 * Cloudflare account, a custom worker name, or a custom portal domain - the
 * studio writes a **gitignored override config** (`wrangler.byo.jsonc`) beside
 * it and deploys with `--config`. The committed file stays pristine.
 *
 * None of this exists for Phorma Cloud users: we deploy their runtime, so they
 * never see a worker, an account id, or wrangler at all.
 */

import { Injectable, computed, signal } from '@angular/core';

import { loadLayout, saveLayout } from './layout-storage';

/** Filename of the generated override, written next to `wrangler.jsonc`. */
export const BYO_CONFIG_FILENAME = 'wrangler.byo.jsonc';

/**
 * Durable Object migrations, mirrored from `cloud/wrangler.jsonc`.
 *
 * The generated config REPLACES the committed one, so it must carry every
 * migration tag: a config missing `v2` would fail to deploy for anyone whose
 * worker already has the `PortalIndex` class. Keep this in lockstep with
 * `cloud/wrangler.jsonc` - `deploy-config.spec.ts` asserts the tags are present.
 */
const DO_MIGRATIONS = [
  { tag: 'v1', new_sqlite_classes: ['WorkflowAgent'] },
  { tag: 'v2', new_sqlite_classes: ['PortalIndex'] },
] as const;

/** Durable Object bindings, mirrored from `cloud/wrangler.jsonc`. */
const DO_BINDINGS = [
  { name: 'WorkflowAgent', class_name: 'WorkflowAgent' },
  { name: 'PortalIndex', class_name: 'PortalIndex' },
] as const;

/** Compatibility settings, mirrored from `cloud/wrangler.jsonc`. */
const COMPATIBILITY_DATE = '2025-05-01';
const COMPATIBILITY_FLAGS = ['nodejs_compat'] as const;

/** Default worker name, mirrored from `cloud/wrangler.jsonc`. */
const DEFAULT_WORKER_NAME = 'phorma-agent-studio-cloud';

/** A Cloudflare worker name: lower-case alphanumerics and dashes. */
const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

/** A 32-character hex Cloudflare account id. */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;

/** A bare hostname (no scheme, no path, no port). */
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

@Injectable({ providedIn: 'root' })
export class DeployConfigService {
  /**
   * Cloudflare account id. Only needed when a login has access to more than
   * one account - wrangler cannot prompt us to choose, because the deploy runs
   * with `CI=true` and no stdin.
   */
  readonly accountId = signal(loadLayout('cfAccountId', ''));

  /** Worker name. Changes the `workers.dev` hostname. */
  readonly workerName = signal(loadLayout('cfWorkerName', ''));

  /**
   * Custom domain for PUBLIC portal pages, e.g. `chat.acme.com`.
   *
   * Deliberately separate from the worker URL: that one also carries the
   * private control plane (push, monitor, run history), and routing owner API
   * traffic through a public marketing domain by accident would be a nasty
   * surprise.
   */
  readonly portalDomain = signal(loadLayout('portalDomain', ''));

  // ── Validation ─────────────────────────────────────────────────────────────

  readonly accountIdValid = computed(() => {
    const value = this.accountId();
    return !value || ACCOUNT_ID_PATTERN.test(value);
  });

  readonly workerNameValid = computed(() => {
    const value = this.workerName();
    return !value || WORKER_NAME_PATTERN.test(value);
  });

  readonly portalDomainValid = computed(() => {
    const value = this.portalDomain();
    return !value || DOMAIN_PATTERN.test(value);
  });

  /** True when every filled-in field is well formed. */
  readonly valid = computed(
    () => this.accountIdValid() && this.workerNameValid() && this.portalDomainValid(),
  );

  /**
   * True when anything deviates from the committed defaults, i.e. an override
   * config is required. With nothing set we deploy the plain `wrangler.jsonc`,
   * so the simple path stays exactly as simple as it was.
   */
  readonly needsOverride = computed(
    () => this.valid() && (!!this.accountId() || !!this.workerName() || !!this.portalDomain()),
  );

  /** The worker name a deploy will actually use. */
  readonly effectiveWorkerName = computed(() => this.workerName() || DEFAULT_WORKER_NAME);

  // ── Setters ────────────────────────────────────────────────────────────────

  setAccountId(value: string): void {
    this.accountId.set(value.trim().toLowerCase());
    saveLayout('cfAccountId', this.accountId());
  }

  setWorkerName(value: string): void {
    this.workerName.set(value.trim().toLowerCase());
    saveLayout('cfWorkerName', this.workerName());
  }

  setPortalDomain(value: string): void {
    // Accept a pasted URL and reduce it to a hostname, because that is what
    // people will paste.
    const cleaned = value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    this.portalDomain.set(cleaned);
    saveLayout('portalDomain', this.portalDomain());
  }

  // ── Config generation ──────────────────────────────────────────────────────

  /**
   * Builds the override config as pretty JSON.
   *
   * Deliberately omits the `env` block: the hosted environment is Phorma's own
   * deploy target and has no business in a user's generated file. Also omits
   * `r2_buckets` - the `RELEASES` bucket is a Phorma-internal updater feature.
   */
  buildOverrideConfig(): string {
    const config: Record<string, unknown> = {
      $schema: 'node_modules/wrangler/config-schema.json',
      name: this.effectiveWorkerName(),
      main: 'src/index.ts',
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: [...COMPATIBILITY_FLAGS],
      durable_objects: { bindings: DO_BINDINGS.map(binding => ({ ...binding })) },
      migrations: DO_MIGRATIONS.map(migration => ({
        tag: migration.tag,
        new_sqlite_classes: [...migration.new_sqlite_classes],
      })),
      observability: { enabled: true },
    };

    if (this.accountId()) config['account_id'] = this.accountId();

    const domain = this.portalDomain();
    if (domain) {
      // `custom_domain` makes wrangler create/attach the DNS record itself, as
      // long as the zone lives in the same Cloudflare account.
      config['routes'] = [{ pattern: domain, custom_domain: true }];
    }

    const header = [
      '// GENERATED BY PHORMA AGENT STUDIO - do not edit by hand.',
      '//',
      '// Written by Settings -> Cloud so your account id, worker name and portal',
      '// domain never have to be hand-edited into the version-controlled',
      '// wrangler.jsonc (which would conflict on every `git pull`).',
      '//',
      '// This file is gitignored. Delete it to fall back to wrangler.jsonc.',
      '// Regenerated on every Deploy.',
      '',
    ].join('\n');

    return `${header}${JSON.stringify(config, null, 2)}\n`;
  }
}
