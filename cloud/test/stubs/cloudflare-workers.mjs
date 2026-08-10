/**
 * Node stand-in for the `cloudflare:workers` built-in module.
 *
 * `portal-registry.ts` and `secret-vault.ts` extend `DurableObject`, so any test
 * that imports them transitively (for example `status.test.mjs`) cannot resolve
 * the real built-in outside workerd. Only the class identity is needed - the
 * tests address those Durable Objects through stub namespaces and never
 * instantiate them.
 */

export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {}
export class RpcTarget {}
export const env = {};
