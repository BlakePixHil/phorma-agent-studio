import { Injectable, inject } from '@angular/core';

import { environment } from '../../environments/environment';
import { AdminRequestService, type AdminResult } from './admin-api';
import type {
  ImpersonationAuditResponse,
  SupportDeploymentsResponse,
} from './impersonation-models';

/** Path of the audit read. Twin of `IMPERSONATION_ADMIN_PATH` in `cloud/`. */
export const IMPERSONATION_ADMIN_PATH = '/api/admin/impersonation';

/** The customer-facing read this surface performs AS the customer. */
export const SUPPORT_DEPLOYMENTS_PATH = '/api/deployments';

/**
 * Two calls, and they are deliberately of two different kinds.
 *
 * `fetchAudit` is an ordinary operator read of an `/api/admin/*` route - the fourth
 * such family, beside telemetry, billing and organisations.
 *
 * `fetchDeploymentsAs` is the impersonation itself: it reads a route the CUSTOMER's
 * own studio reads, as that customer, through `sendActingAs`. It is the only method
 * in this package that does that, which is what keeps "exactly one place sets the
 * act-as header" true one layer up as well as inside the transport.
 *
 * Like the other three feature services, this one validates nothing and maps
 * nothing. The Worker owns every refusal, including the one that matters most here:
 * an operator who is not on the allowlist, or a value that is not an owner id, is
 * answered with their OWN data and no error at all - so there is no client-side
 * check that could usefully disagree with it.
 */
@Injectable({ providedIn: 'root' })
export class ImpersonationApiService {
  private readonly transport = inject(AdminRequestService);
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  /** The append-only audit, newest first. */
  fetchAudit(options: { owner?: string } = {}): Promise<AdminResult<ImpersonationAuditResponse>> {
    return this.transport.read<ImpersonationAuditResponse>(this.auditUrl(), {
      ...(options.owner ? { owner: options.owner } : {}),
    });
  }

  /**
   * What one owner is running, read AS that owner.
   *
   * Every call writes an audit row on the Worker before the answer is produced, and
   * a failure to write it refuses the request - so there is no way to perform this
   * read without leaving the record of it.
   */
  fetchDeploymentsAs(ownerId: string): Promise<AdminResult<SupportDeploymentsResponse>> {
    return this.transport.sendActingAs<SupportDeploymentsResponse>(
      `${this.baseUrl}${SUPPORT_DEPLOYMENTS_PATH}`,
      ownerId,
    );
  }

  /** The absolute URL of the audit read. */
  auditUrl(): string {
    return `${this.baseUrl}${IMPERSONATION_ADMIN_PATH}`;
  }
}
