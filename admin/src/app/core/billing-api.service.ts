import { Injectable, inject } from '@angular/core';

import { environment } from '../../environments/environment';
import { AdminRequestService, type AdminResult } from './admin-api';
import type { BillingCostsResponse, BillingRevenueResponse, BillingRoute } from './billing-models';
import type { DateRange } from './models';

/** Path prefix the billing Admin_API owns. Twin of `BILLING_ADMIN_PREFIX` in `cloud/`. */
export const BILLING_ADMIN_PREFIX = '/api/admin/billing/';

/**
 * The two billing calls, typed.
 *
 * A separate service from `TelemetryApiService` because it is a separate route
 * family on the Worker, but over the SAME `AdminRequestService` - so the bearer
 * header, the no-session short circuit and the two auth signals are shared and
 * cannot drift. This file is the billing prefix plus two named methods.
 *
 * `costs` takes a range and ignores most of it: runway is a property of the
 * account right now rather than of the selected window, so the Worker measures
 * burn over its own trailing window. The range is still sent, because one request
 * shape for every admin call is worth more than saving two query parameters, and
 * the Worker validates it either way.
 */
@Injectable({ providedIn: 'root' })
export class BillingApiService {
  private readonly transport = inject(AdminRequestService);
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  /** OpenRouter balance, burn, runway, committed ceilings and the attention list. */
  fetchCosts(range: DateRange): Promise<AdminResult<BillingCostsResponse>> {
    return this.transport.get<BillingCostsResponse>(this.url('costs'), range);
  }

  /** Stripe gross/tax/net, the processing fee, and the measured margin. */
  fetchRevenue(range: DateRange): Promise<AdminResult<BillingRevenueResponse>> {
    return this.transport.get<BillingRevenueResponse>(this.url('revenue'), range);
  }

  /** The absolute URL of one billing route. */
  url(route: BillingRoute): string {
    return `${this.baseUrl}${BILLING_ADMIN_PREFIX}${route}`;
  }
}
