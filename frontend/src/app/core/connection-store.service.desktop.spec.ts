import { TestBed } from '@angular/core/testing';

import type { Connection } from '@phorma/engine';

import { CapabilityService } from './capability.service';
import { ConnectionStoreService, hostSecretSentinel } from './connection-store.service';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { TauriService } from './tauri.service';

/**
 * Requirement 2.5: on the DESKTOP host (a real keychain worth trusting),
 * `resolve()` must reject the moment a declared `secretKeys` entry is absent
 * from the keychain, naming the connection and the first missing key, and it
 * must never construct — let alone return — a `ResolvedConnection` that holds
 * some secrets and is silently missing others. This is the sibling of
 * `connection-store.service.spec.ts` (task 17.2), which covers the browser-host
 * rejection path where `resolve()` always rejects before touching a secret at
 * all; here the keychain is reachable, so the missing-secret check itself is
 * what must fail closed.
 */
describe('ConnectionStoreService (desktop host)', () => {
  let service: ConnectionStoreService;
  let db: IndexedDbStorageService;
  const savedIds: string[] = [];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    service = TestBed.inject(ConnectionStoreService);
    db = TestBed.inject(IndexedDbStorageService);
  });

  afterEach(async () => {
    while (savedIds.length > 0) {
      await db.removeConnection(savedIds.pop()!);
    }
  });

  function connection(
    id: string,
    auth: Connection['auth'],
    secretKeys: string[] = [],
  ): Connection {
    const now = new Date().toISOString();
    return {
      id,
      name: id,
      type: 'http',
      config: {},
      secretKeys,
      auth,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Spies on the private keychain-presence check, controlling it per key. */
  function stubPresence(present: Record<string, boolean>): jasmine.Spy {
    return spyOn(
      service as unknown as { hasSecret: (id: string, key: string) => Promise<boolean> },
      'hasSecret',
    ).and.callFake(async (_id: string, key: string) => present[key] ?? false);
  }

  it('rejects resolve() naming the connection and the missing secret when a single declared secret is absent', async () => {
    const conn = connection('conn-desktop-single-missing', { mode: 'bearer', secretKey: 'apiKey' }, [
      'apiKey',
    ]);
    await db.saveConnection(conn);
    savedIds.push(conn.id);

    const hasSecretSpy = stubPresence({});

    await expectAsync(service.resolve(conn.id)).toBeRejectedWithError(
      /Connection "conn-desktop-single-missing".*missing the secret "apiKey"/,
    );

    expect(hasSecretSpy).toHaveBeenCalledTimes(1);
  });

  it('stops at the first missing secret and constructs no partial bundle when later declared secrets would have been present', async () => {
    const conn = connection(
      'conn-desktop-partial',
      { mode: 'basic', userSecretKey: 'user', passwordSecretKey: 'pass' },
      ['user', 'pass', 'extra'],
    );
    await db.saveConnection(conn);
    savedIds.push(conn.id);

    // "user" is present, "pass" is missing, "extra" (declared after "pass")
    // would also be present — but must never be checked, because the bundle
    // is already rejected once "pass" is found missing.
    const hasSecretSpy = stubPresence({ user: true, pass: false, extra: true });

    await expectAsync(service.resolve(conn.id)).toBeRejectedWithError(/missing the secret "pass"/);

    // Presence was checked in declared order and stopped at the first miss:
    // "user" then "pass", never "extra".
    expect(hasSecretSpy.calls.allArgs()).toEqual([
      [conn.id, 'user'],
      [conn.id, 'pass'],
    ]);

    // The session cache used to build outbound-request credential references
    // (`credentialsFor`) holds no entry for a connection whose resolution
    // failed — there is nothing "half-resolved" left behind for a later call
    // to pick up.
    expect(
      (service as unknown as { resolved: Map<string, unknown> }).resolved.has(conn.id),
    ).toBeFalse();
  });

  it('resolves with every declared secret present, naming no missing secret', async () => {
    const conn = connection(
      'conn-desktop-complete',
      { mode: 'basic', userSecretKey: 'user', passwordSecretKey: 'pass' },
      ['user', 'pass'],
    );
    await db.saveConnection(conn);
    savedIds.push(conn.id);

    stubPresence({ user: true, pass: true });

    const resolved = await service.resolve(conn.id);

    expect(Object.keys(resolved.secrets).sort()).toEqual(['pass', 'user']);
    expect(
      (service as unknown as { resolved: Map<string, unknown> }).resolved.has(conn.id),
    ).toBeTrue();
  });

  /**
   * The rule the whole sentinel mechanism exists for: secrets stay out of the
   * webview. The test above checks the secret NAMES, so `freezeResolved` could
   * be changed to put real keychain values in that map and every other case in
   * this file would still pass. That is the one thing a spec named after the
   * keychain path must not leave unchecked.
   */
  it('hands out a sentinel per declared secret, never a value (Requirement 3.3)', async () => {
    const conn = connection('conn-desktop-sentinel', { mode: 'bearer', secretKey: 'apiKey' }, [
      'apiKey',
      'refreshToken',
    ]);
    await db.saveConnection(conn);
    savedIds.push(conn.id);

    stubPresence({ apiKey: true, refreshToken: true });

    const resolved = await service.resolve(conn.id);

    for (const key of ['apiKey', 'refreshToken']) {
      expect(resolved.secrets[key]).withContext(key).toBe(hostSecretSentinel(conn.id, key));
      // A sentinel names the connection and key so Rust can look the value up;
      // it must be exactly that and carry no material of its own.
      expect(resolved.secrets[key]).withContext(key).toContain(conn.id);
      expect(resolved.secrets[key]).withContext(key).toContain(key);
    }
  });

  it('freezes secrets and config so a node cannot mutate the resolved bundle (Requirement 2.6)', async () => {
    const conn = connection('conn-desktop-frozen', { mode: 'bearer', secretKey: 'apiKey' }, [
      'apiKey',
    ]);
    await db.saveConnection(conn);
    savedIds.push(conn.id);

    stubPresence({ apiKey: true });

    const resolved = await service.resolve(conn.id);

    expect(Object.isFrozen(resolved.secrets)).toBeTrue();
    expect(Object.isFrozen(resolved.config)).toBeTrue();

    // Frozen in the strong sense: a write is refused, not silently applied.
    const before = resolved.secrets['apiKey'];
    try {
      (resolved.secrets as Record<string, string>)['apiKey'] = 'injected';
      (resolved.secrets as Record<string, string>)['smuggled'] = 'injected';
    } catch {
      /* strict mode throws; either way the assertions below hold */
    }
    expect(resolved.secrets['apiKey']).toBe(before);
    expect(resolved.secrets['smuggled']).toBeUndefined();
  });
});

/**
 * The Cloud_Library keychain gate (multi-organisation Requirements 9.5, 17.5).
 *
 * The host here HAS a keychain - `isDesktop` is true - and that is the whole point.
 * The case this exists for is a builder on their own desktop who is an `editor` in
 * somebody else's organisation: writing that organisation's credential into this
 * machine's keychain is exactly what must not happen, so the gate is explicit
 * rather than left to the `isDesktop` check that would happily allow it.
 *
 * The desktop contract itself is unchanged: the webview still sees only a boolean
 * for a stored key, and nothing here adds a raw value to a response or a signal.
 */
describe('ConnectionStoreService Cloud_Library keychain gate', () => {
  let service: ConnectionStoreService;
  let capability: CapabilityService;
  let db: IndexedDbStorageService;
  let invoked: string[];
  const savedIds: string[] = [];

  beforeEach(() => {
    invoked = [];
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    service = TestBed.inject(ConnectionStoreService);
    capability = TestBed.inject(CapabilityService);
    db = TestBed.inject(IndexedDbStorageService);
    // Records any keychain call that slips past the gate. The real path imports
    // `@tauri-apps/api/core`, which is absent under karma, so a call that DID get
    // through would reject - this makes the failure name itself instead.
    spyOn(
      service as unknown as { storeSecret: (id: string, key: string, value: string) => Promise<void> },
      'storeSecret',
    ).and.callFake(async (id: string, key: string) => {
      invoked.push(`set:${id}:${key}`);
    });
  });

  afterEach(async () => {
    while (savedIds.length > 0) {
      await db.removeConnection(savedIds.pop()!);
    }
  });

  it('supports secrets for a builder on desktop', () => {
    capability.resolveFrom('builder');
    expect(service.secretsSupported).toBeTrue();
  });

  it('refuses every keychain write at operator and editor level, naming the vault', async () => {
    for (const level of ['operator', 'editor'] as const) {
      capability.resolveFrom(level);

      expect(service.secretsSupported).withContext(level).toBeFalse();
      await expectAsync(service.writeSecret('conn-gate', 'apiKey', 'plaintext'))
        .withContext(level)
        .toBeRejectedWithError(/cloud vault/);
      await expectAsync(service.clearSecret('conn-gate', 'apiKey'))
        .withContext(level)
        .toBeRejectedWithError(/cloud vault/);
      expect(await service.secretPresent('conn-gate', 'apiKey'))
        .withContext(level)
        .toBeFalse();
      expect(invoked).withContext(level).toEqual([]);
    }
  });

  it('refuses to resolve a connection out of the local keychain in Cloud_Library mode', async () => {
    const now = new Date().toISOString();
    const conn: Connection = {
      id: 'conn-gate-resolve',
      name: 'conn-gate-resolve',
      type: 'http',
      config: {},
      secretKeys: ['apiKey'],
      auth: { mode: 'bearer', secretKey: 'apiKey' },
      createdAt: now,
      updatedAt: now,
    };
    await db.saveConnection(conn);
    savedIds.push(conn.id);

    capability.resolveFrom('editor');

    await expectAsync(service.resolve(conn.id)).toBeRejectedWithError(/cloud vault/);
    expect(invoked).toEqual([]);
  });
});
