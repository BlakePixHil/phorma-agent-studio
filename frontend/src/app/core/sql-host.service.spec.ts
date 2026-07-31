import { TestBed } from '@angular/core/testing';

import type { SqlDriver } from '@phorma/engine';

import { SqlHostService } from './sql-host.service';
import { TauriService } from './tauri.service';

/**
 * Requirement 18.4: the browser preview host can execute no SQL driver at
 * all — there is no desktop process to hand the statement to, so
 * `supports()` must answer false for every driver rather than opening (or
 * pretending to open) a connection that cannot work.
 */
describe('SqlHostService (browser host)', () => {
  let service: SqlHostService;

  const ALL_DRIVERS: SqlDriver[] = ['postgres', 'mysql', 'mssql', 'sqlite'];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    service = TestBed.inject(SqlHostService);
  });

  it('reports no support for any SQL driver outside the desktop app', () => {
    for (const driver of ALL_DRIVERS) {
      expect(service.supports(driver)).withContext(driver).toBeFalse();
    }
  });

  it('rejects query() for every driver, naming the browser host rather than attempting a call', async () => {
    for (const driver of ALL_DRIVERS) {
      await expectAsync(
        service.query({
          driver,
          statement: 'select 1',
          params: {},
          connection: {
            id: 'conn-browser-sql',
            type: 'sql',
            config: {},
            secrets: {},
            auth: { mode: 'none' },
            allowWrites: false,
          },
          maxRows: 10_000,
          maxResultBytes: 4 * 1024 * 1024,
          statementTimeoutMs: 30_000,
        }),
      ).toBeRejectedWithError(/cannot execute the SQL driver/);
    }
  });
});
