/**
 * The `unknown` error category: an error that reached the top of the
 * application without any surface having classified it.
 *
 * Every other error category is counted at the seam that already knows what
 * failed - the model transport, the tool host, the MCP connect path, the data
 * fetcher, storage, the deploy services, the account session, the validation
 * surfaces, the run controller. An unclassified throw has no such seam by
 * definition, so it is counted here, where Angular already funnels everything
 * that nobody handled: a throw inside change detection or an event handler, plus
 * the `error` and `unhandledrejection` window events that
 * `provideBrowserGlobalErrorListeners()` forwards.
 *
 * Requirement 11.3: only the CATEGORY is recorded. The error object never leaves
 * this file, and `recordError` has no parameter a message or a stack could
 * travel in. Requirement 5.8: telemetry never addresses the user, so the
 * original reporting behaviour is delegated to Angular's own handler unchanged
 * and a telemetry failure here cannot swallow the error report.
 */

import { ErrorHandler, Injectable, inject } from '@angular/core';

import { TelemetryService } from './telemetry.service';

@Injectable()
export class TelemetryErrorHandler extends ErrorHandler {
  // Safe DI direction: `TelemetryService` is a leaf that injects only
  // `TauriService`, so handling an error cannot construct half the application.
  private readonly telemetry = inject(TelemetryService);

  override handleError(error: unknown): void {
    try {
      this.telemetry.recordError('unknown');
    } catch {
      // Counting is best effort and must never displace the error report below.
    }
    super.handleError(error);
  }
}
