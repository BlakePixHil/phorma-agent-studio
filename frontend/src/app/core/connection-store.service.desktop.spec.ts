import { TestBed } from '@angular/core/testing';

import type { Connection } from '@phorma/engine';

import { ConnectionStoreService } from './connection-store.service';
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
});
