import { Injectable, inject } from '@angular/core';

import { environment } from '../../environments/environment';
import { AdminRequestService, type AdminResult } from './admin-api';
import type {
  OrgAdminRoute,
  OrgCreateResponse,
  OrgListResponse,
  OrgMemberWriteResponse,
  OrgMembersResponse,
  OrgTierResponse,
} from './org-models';

/** Path prefix the organisation Admin_API owns. Twin of `ORG_ADMIN_PREFIX` in `cloud/`. */
export const ORG_ADMIN_PREFIX = '/api/admin/organisations/';

/**
 * The six organisation calls, typed.
 *
 * A third service beside `TelemetryApiService` and `BillingApiService` because it
 * is a third route family on the Worker, but over the SAME
 * `AdminRequestService` - so the bearer header, the no-session short circuit and
 * the two auth signals are shared and cannot drift. One operator allowlist gates
 * all three prefixes, so a 403 here and a 403 on a telemetry read are the same
 * fact.
 *
 * This file is the prefix plus named methods and nothing else. In particular it
 * validates nothing and maps nothing: the Worker owns every refusal, including
 * `role_unknown` for a level token outside its vocabulary, and a client-side copy
 * of that check would be a second place for the vocabulary to live.
 */
@Injectable({ providedIn: 'root' })
export class OrgApiService {
  private readonly transport = inject(AdminRequestService);
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  /** Every organisation, with its authoritative member count and its plan. */
  fetchOrganisations(): Promise<AdminResult<OrgListResponse>> {
    return this.transport.read<OrgListResponse>(this.url('list'));
  }

  /** One organisation's members, off the authoritative membership table. */
  fetchMembers(orgId: string): Promise<AdminResult<OrgMembersResponse>> {
    return this.transport.read<OrgMembersResponse>(this.url('members'), { orgId });
  }

  /** Creates the organisation upstream and provisions its account row, with no paid plan. */
  createOrganisation(input: {
    name: string;
    slug?: string;
    createdBy?: string;
  }): Promise<AdminResult<OrgCreateResponse>> {
    return this.transport.mutate<OrgCreateResponse>('POST', this.url('create'), {
      body: {
        name: input.name,
        ...(input.slug ? { slug: input.slug } : {}),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      },
    });
  }

  /**
   * Invites a member or changes their level. One call for both, because they are
   * one write: the Worker records exactly one level per person per organisation.
   */
  setMemberLevel(input: {
    orgId: string;
    userId: string;
    level: string;
  }): Promise<AdminResult<OrgMemberWriteResponse>> {
    return this.transport.mutate<OrgMemberWriteResponse>('POST', this.url('members'), {
      body: input,
    });
  }

  /** Removes a member. Effective on their next request, not on their next token. */
  removeMember(input: {
    orgId: string;
    userId: string;
  }): Promise<AdminResult<OrgMemberWriteResponse>> {
    return this.transport.mutate<OrgMemberWriteResponse>('DELETE', this.url('members'), {
      params: { orgId: input.orgId, userId: input.userId },
    });
  }

  /**
   * Assigns an organisation's plan, which is the only way it becomes entitled.
   * Raising a ceiling is a plan change here; there is no credit-grant path.
   */
  setTier(input: { orgId: string; tier: string }): Promise<AdminResult<OrgTierResponse>> {
    return this.transport.mutate<OrgTierResponse>('POST', this.url('tier'), { body: input });
  }

  /** The absolute URL of one route. */
  url(route: OrgAdminRoute): string {
    return `${this.baseUrl}${ORG_ADMIN_PREFIX}${route}`;
  }
}
