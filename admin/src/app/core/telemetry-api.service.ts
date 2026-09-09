import { Injectable, inject } from '@angular/core';

import { environment } from '../../environments/environment';
import { AdminRequestService, type AdminResult } from './admin-api';
import type {
  DateRange,
  EnvironmentResponse,
  FeaturesResponse,
  GeographyResponse,
  SummaryResponse,
  TelemetryRoute,
  TrendResponse,
} from './models';

/**
 * The five telemetry aggregate calls, typed.
 *
 * The credential handling, the session funnel and the two auth signals live in
 * `admin-api.ts`, shared with `billing-api.service.ts` - both route families sit
 * behind one operator allowlist on the Worker, so one transport serves both and
 * there is only ever one place a bearer header is built. This file is now just
 * the telemetry prefix plus five named methods.
 *
 * Everything the transport exports is RE-EXPORTED below rather than moved out of
 * reach, because `views/view-data.ts`, the shell and three spec files import
 * those names from here. Re-exporting keeps the extraction a refactor instead of
 * a rename spread across the package.
 */

export {
  AdminRequestService,
  FORBIDDEN,
  NO_SESSION,
  REQUEST_FAILURE_FALLBACK,
  SESSION_REJECTED,
  SESSION_TOKEN_RESOLVER,
  clerkSessionTokenResolver,
  describeRequestFailure,
  isOk,
  toSessionToken,
  type AdminResult,
  type SessionToken,
  type SessionTokenResolver,
} from './admin-api';

/** Path prefix the telemetry Admin_API owns. Twin of `TELEMETRY_ADMIN_PREFIX` in `cloud/`. */
export const TELEMETRY_ADMIN_PREFIX = '/api/admin/telemetry/';

@Injectable({ providedIn: 'root' })
export class TelemetryApiService {
  private readonly transport = inject(AdminRequestService);
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  /**
   * True once any admin call has been answered 403 (10.4). Proxied from the
   * shared transport, so a 403 on either route family flips one signal.
   */
  readonly forbidden = this.transport.forbidden;

  /** True once any admin call was answered 401 for a token we did send. */
  readonly sessionRejected = this.transport.sessionRejected;

  /** Active installs for 1/7/30 days plus range totals (10.5). */
  fetchSummary(range: DateRange): Promise<AdminResult<SummaryResponse>> {
    return this.transport.get<SummaryResponse>(this.url('summary'), range);
  }

  /** Installs and runs by country and by region (10.6). */
  fetchGeography(range: DateRange): Promise<AdminResult<GeographyResponse>> {
    return this.transport.get<GeographyResponse>(this.url('geography'), range);
  }

  /** Installs by app version, platform, runtime mode and locale (10.7). */
  fetchEnvironment(range: DateRange): Promise<AdminResult<EnvironmentResponse>> {
    return this.transport.get<EnvironmentResponse>(this.url('environment'), range);
  }

  /** Summed Counter values grouped by Counter name (10.8). */
  fetchFeatures(range: DateRange): Promise<AdminResult<FeaturesResponse>> {
    return this.transport.get<FeaturesResponse>(this.url('features'), range);
  }

  /** Per-day installs, sessions and runs (10.9). */
  fetchTrend(range: DateRange): Promise<AdminResult<TrendResponse>> {
    return this.transport.get<TrendResponse>(this.url('trend'), range);
  }

  /** The absolute URL of one aggregate route. */
  url(route: TelemetryRoute): string {
    return `${this.baseUrl}${TELEMETRY_ADMIN_PREFIX}${route}`;
  }
}
