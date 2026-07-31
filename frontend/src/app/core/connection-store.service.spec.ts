import { TestBed } from '@angular/core/testing';

import type { Connection } from '@phorma/engine';

import { ConnectionStoreService, NO_KEYCHAIN_MESSAGE } from './connection-store.service';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { TauriService } from './tauri.service';

/**
 * Requirement 3.8: in the browser preview (no keychain worth trusting),
 * `resolve()` must reject with the desktop-or-worker message for EVERY
 * connection, and it must do so without ever reading a secret or reaching the
 * network — a browser build has no safe place to hold or apply a credential.
 */
describe('ConnectionStoreService (browser host)', () => {
  let service: ConnectionStoreService;
  let db: IndexedDbStorageService;
  const savedIds: string[] = [];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
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

  it('rejects resolve() for every connection with the desktop-or-worker message, reading no secret and making no request', async () => {
    const cases: Connection[] = [
      connection('conn-browser-none', { mode: 'none' }),
      connection('conn-browser-bearer', { mode: 'bearer', secretKey: 'apiKey' }, ['apiKey']),
      connection(
        'conn-browser-basic',
        { mode: 'basic', userSecretKey: 'user', passwordSecretKey: 'pass' },
        ['user', 'pass'],
      ),
      connection(
        'conn-browser-oauth',
        {
          mode: 'oauth2-client-credentials',
          tokenUrl: 'https://example.test/token',
          clientIdSecretKey: 'clientId',
          clientSecretKey: 'clientSecret',
        },
        ['clientId', 'clientSecret'],
      ),
    ];
    for (const conn of cases) {
      await db.saveConnection(conn);
      savedIds.push(conn.id);
    }

    // The private keychain-presence check: never invoked, because the
    // desktop-or-worker rejection happens before any secret is read.
    const hasSecretSpy = spyOn(
      service as unknown as { hasSecret: (id: string, key: string) => Promise<boolean> },
      'hasSecret',
    ).and.callThrough();
    const fetchSpy = spyOn(window, 'fetch');

    for (const conn of cases) {
      await expectAsync(service.resolve(conn.id)).toBeRejectedWithError(NO_KEYCHAIN_MESSAGE);
    }

    expect(hasSecretSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still rejects an unknown connection before reaching the desktop-or-worker check, without reading a secret', async () => {
    const hasSecretSpy = spyOn(
      service as unknown as { hasSecret: (id: string, key: string) => Promise<boolean> },
      'hasSecret',
    ).and.callThrough();

    await expectAsync(service.resolve('conn-browser-does-not-exist')).toBeRejectedWithError(
      /is not known to this machine/,
    );

    expect(hasSecretSpy).not.toHaveBeenCalled();
  });
});
