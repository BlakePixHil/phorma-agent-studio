import { Injectable, inject } from '@angular/core';

import {
  TAURI_DESKTOP_CAPABILITIES,
  type SqlDriver,
  type SqlHost,
  type SqlRequest,
  type SqlResult,
} from '@phorma/engine';

import { toDataHostError } from './data-fetch.service';
import { TauriService } from './tauri.service';

/**
 * `SqlHostService` — parameterised SQL execution on the desktop host
 * (design §5.4, §7.1, §13; Requirements 10.4, 10.10, 10.11, 10.14, 18.3).
 *
 * The statement and its parameters are handed to the Rust `sql_query` command
 * separately and stay separate all the way to the driver: the command rewrites
 * `:name` into the driver's own placeholder dialect and binds each value, so a
 * payload holding `'; DROP TABLE users; --` is bound as a value and can never be
 * read as SQL (Requirement 10.4).
 *
 * Connection secrets are read from the keychain inside Rust and are absent from
 * the returned rows, the column names and every error message (Requirement 3.3),
 * which is why this service passes secret NAMES only.
 *
 * The three limits arrive already resolved by the engine (node data, then
 * connection limits, then the host default) and are enforced by the driver path,
 * which reports truncation rather than silently returning a short result.
 */
@Injectable({ providedIn: 'root' })
export class SqlHostService implements SqlHost {
  private readonly tauri = inject(TauriService);

  /**
   * The drivers this host can actually execute. Consulted by the engine before
   * `query`, so an unsupported driver fails the node with a message naming the
   * host instead of opening a connection that cannot work.
   */
  supports(driver: SqlDriver): boolean {
    return this.tauri.isDesktop && TAURI_DESKTOP_CAPABILITIES.sqlDrivers.includes(driver);
  }

  async query(request: SqlRequest): Promise<SqlResult> {
    if (!this.supports(request.driver)) {
      throw new Error(
        `The ${TAURI_DESKTOP_CAPABILITIES.label} host cannot execute the SQL driver ` +
          `"${request.driver}" outside the desktop app.`,
      );
    }

    const { invoke } = await import('@tauri-apps/api/core');
    let result: SqlResultDto;
    try {
      result = await invoke<SqlResultDto>('sql_query', {
        connectionId: request.connection.id,
        // NAMES only: the values behind them are the keychain's business.
        secretKeys: Object.keys(request.connection.secrets),
        request: {
          driver: request.driver,
          statement: request.statement,
          params: request.params,
          config: { ...request.connection.config },
          limits: request.connection.limits ?? null,
          maxRows: request.maxRows,
          maxResultBytes: request.maxResultBytes,
          statementTimeoutMs: request.statementTimeoutMs,
        },
      });
    } catch (error) {
      throw toDataHostError(error);
    }

    return {
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      columns: result.columns,
      durationMs: result.durationMs,
    };
  }
}

/** The `sql_query` answer, mirroring `SqlResultDto` in `backend/src-tauri/src/sql.rs`. */
interface SqlResultDto {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  columns: { name: string; type: string }[];
  durationMs: number;
}
