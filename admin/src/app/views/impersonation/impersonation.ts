import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';

import { ImpersonationApiService } from '../../core/impersonation-api.service';
import type {
  ImpersonationAuditResponse,
  SupportDeploymentsResponse,
} from '../../core/impersonation-models';
import { isOk } from '../../core/admin-api';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/**
 * The shape an owner id has to have before it is worth sending.
 *
 * A LOCAL convenience only, and it is important that it is not a gate: the Worker
 * IGNORES a value it does not recognise and answers with the operator's own data
 * and no error, so a typo here would otherwise read as "that customer has nothing
 * deployed". Checking the shape before sending is what turns that silence into a
 * sentence. The Worker's own classifier is still the authority.
 */
export const OWNER_ID_SHAPE = /^(?:user|org)_[A-Za-z0-9_-]{1,120}$/;

/** What the owner field says when the typed value could not be an owner id. */
export const OWNER_ID_HINT = 'An owner id starts with org_ or user_.';

/**
 * Impersonation: read one customer's account as that customer, and read the record
 * of every time anybody did (Requirement 14).
 *
 * ## This is the only surface in the product that can do it
 *
 * Requirement 14.12: the studio offers nothing. Impersonation is reachable from
 * here, through `AdminRequestService.sendActingAs`, which is the ONE method that
 * sets the act-as header - so the no-session guarantee and the 401-versus-403 split
 * are inherited from the same funnel as every other admin call rather than
 * reimplemented for this one.
 *
 * ## It is READ-ONLY, and the UI does not pretend otherwise
 *
 * There is no action on this page that writes anything to a customer's account, and
 * that is not restraint - the Worker refuses every non-GET with
 * `impersonation_read_only` at two independent layers and the entitlement gate
 * spends nothing for an impersonated caller. Offering a control that exists only to
 * be refused would misdescribe the feature.
 *
 * ## The audit is the page; the customer read is the action
 *
 * So the whole body gates on the audit resource, exactly as every other view in this
 * package gates on its own - which is also what keeps "exactly one
 * `[data-view-state]` element in the DOM" true, the assertion this package uses to
 * prove its states are mutually exclusive.
 *
 * The read is a plain action rather than a second `resource()`, because it is
 * imperative in a way a resource is not: it is a recorded act, it must happen exactly
 * when an operator asks for it, and it must never re-fire on its own. Every accepted
 * read writes exactly one audit row BEFORE the answer is produced, so the audit is
 * reloaded afterwards - an operator watches their own action appear in the record,
 * which is the cheapest possible demonstration that the record is real.
 *
 * ## Being ignored is silent, by design, so the copy says so
 *
 * A caller who is not on the Worker's allowlist gets their OWN data back with no
 * error at all. That is deliberate (probing the header must reveal nothing), and it
 * means a surface like this has to explain the one outcome it cannot detect: a read
 * that answers "nothing deployed" for an account that definitely has something.
 */
@Component({
  selector: 'admin-impersonation',
  imports: [ButtonModule, DatePipe, DecimalPipe, InputTextModule, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-impersonation-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-impersonation-title">
          <i class="ti ti-eye" aria-hidden="true"></i>
          <span>Impersonation</span>
        </h1>
        <p class="admin-view__range">Read-only, and always recorded</p>
      </header>

      @if (audit(); as auditData) {
      <div class="admin-view__body" data-view-state="loaded">
        <section class="admin-view__section" aria-labelledby="admin-impersonation-read">
          <h2 class="admin-view__section-title" id="admin-impersonation-read">
            Read a customer's account
          </h2>
          <article class="admin-card">
            <div class="admin-impersonation__form">
              <label class="admin-impersonation__field">
                <span class="admin-impersonation__label">Owner id</span>
                <input
                  pInputText
                  pSize="small"
                  type="text"
                  name="actAsOwner"
                  autocomplete="off"
                  placeholder="org_... or user_..."
                  [value]="draftOwner()"
                  (input)="onOwnerInput($event)"
                />
              </label>
              <button
                pButton
                type="button"
                size="small"
                class="phorma-btn-content"
                [disabled]="!ownerUsable() || busy()"
                (click)="read()"
              >
                <i class="ti ti-eye-search" aria-hidden="true"></i>
                <span>Read deployments</span>
              </button>
            </div>
            @if (ownerHint(); as hint) {
              <p class="admin-stat__note" role="status">{{ hint }}</p>
            }
            <p class="admin-stat__note">
              Every read here writes an audit row before the answer is served. A read that cannot be
              recorded is refused.
            </p>
          </article>

          @if (notice(); as message) {
            <p class="admin-footnote" role="status">
              <i class="ti ti-alert-triangle" aria-hidden="true"></i>
              <span>{{ message }}</span>
            </p>
          }

          @if (viewing(); as owner) {
            @if (deployments(); as data) {
              <table class="admin-table">
                <caption class="admin-table__caption">
                  What {{ owner }} is running, for {{ data.month }}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Workflow</th>
                    <th scope="col">Updated</th>
                    <th scope="col">Schedule</th>
                    <th scope="col" class="admin-table__number">Runs</th>
                    <th scope="col" class="admin-table__number">Credits</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of data.deployments; track row.workflowId) {
                    <tr>
                      <th scope="row">
                        <span class="admin-table__label">{{ row.workflowName }}</span>
                        <span class="admin-impersonation__id">{{ row.workflowId }}</span>
                      </th>
                      <td>{{ row.updatedAt | date: 'short' }}</td>
                      <td>{{ row.cronArmed ? 'Armed' : '-' }}</td>
                      <td class="admin-table__number">{{ figure(row.runsThisMonth) }}</td>
                      <td class="admin-table__number">{{ figure(row.creditsSpent) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
              @if (data.deployments.length === 0) {
                <p class="admin-footnote">
                  <i class="ti ti-database-off" aria-hidden="true"></i>
                  <span>
                    Nothing is deployed under {{ owner }}. If that is unexpected, check the id and
                    check that this account is on the operator allowlist - an unrecognised id and an
                    unauthorised caller both answer with your own account and no error.
                  </span>
                </p>
              }
            }
          }
        </section>

        <section class="admin-view__section" aria-labelledby="admin-impersonation-audit">
          <h2 class="admin-view__section-title" id="admin-impersonation-audit">
            Who read what, and when
          </h2>
          @if (auditData.entries.length === 0) {
            <p class="admin-footnote">
              <i class="ti ti-shield-check" aria-hidden="true"></i>
              <span>Nobody has read a customer's account through this surface.</span>
            </p>
          } @else {
            <table class="admin-table">
              <caption class="admin-table__caption">
                The {{ auditData.entries.length | number }} most recent reads, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Operator</th>
                  <th scope="col">Read as</th>
                  <th scope="col">Request</th>
                </tr>
              </thead>
              <tbody>
                @for (entry of auditData.entries; track entry.id) {
                  <tr>
                    <th scope="row">
                      <span class="admin-table__label">{{ entry.at | date: 'short' }}</span>
                    </th>
                    <td><span class="admin-impersonation__id">{{ entry.actingUserId }}</span></td>
                    <td><span class="admin-impersonation__id">{{ entry.ownerId }}</span></td>
                    <td>
                      <span class="admin-impersonation__id">
                        {{ entry.method }} {{ entry.path }}
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
            @if (auditData.truncated) {
              <p class="admin-footnote">
                <i class="ti ti-info-circle" aria-hidden="true"></i>
                <span>
                  Older rows exist. This list is capped at {{ auditData.limit | number }}.
                </span>
              </p>
            }
          }
        </section>

        <p class="admin-footnote">
          <i class="ti ti-lock" aria-hidden="true"></i>
          <span>
            Operator-only, and read-only. A write attempted while reading as a customer is refused
            by the worker, and building inside a customer's organisation needs a real membership.
          </span>
        </p>
      </div>
      } @else {
        <admin-view-state
          [state]="auditState()"
          emptyMessage="No impersonated reads on record."
          (retry)="reloadAudit()"
        />
      }
    </section>
  `,
  styles: `
    /* Two rules, and both are already in Organisations for the same reasons - a form
       row that wraps and a monospaced id line. They stay component-scoped until a
       THIRD view needs them, at which point they are promoted into styles.scss
       rather than copied a third time. */
    .admin-impersonation__form {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.571rem; /* 8px */
    }

    .admin-impersonation__field {
      display: flex;
      flex-direction: column;
      gap: 0.214rem; /* 3px */
      min-width: 16rem;
    }

    .admin-impersonation__label {
      color: var(--admin-text-muted);
      font-size: 0.857rem; /* 12px */
    }

    /* An id is what every audit row and every refusal names, so it has to be
       readable and copyable from here. */
    .admin-impersonation__id {
      display: block;
      color: var(--admin-text-muted);
      font-size: 0.786rem; /* 11px */
      font-variant-numeric: tabular-nums;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Impersonation {
  private readonly api = inject(ImpersonationApiService);

  /** What the owner field currently holds. */
  readonly draftOwner = signal('');

  /** The owner the table below is about, or null before the first read. */
  readonly viewing = signal<string | null>(null);

  /** True while a read is in flight, so the button cannot fire a second one. */
  readonly busy = signal(false);

  /** The one sentence a failed read answers with, or null. */
  readonly notice = signal<string | null>(null);

  /** The customer's deployments, for {@link viewing}. */
  readonly deployments = signal<SupportDeploymentsResponse | null>(null);

  private readonly auditData = resource({
    loader: () => this.api.fetchAudit().then(unwrapAdminResult),
  });

  /**
   * Exactly one of loading, loaded, empty or failed.
   *
   * `value` is read through `hasValue()`, never bare: `resource().value()` THROWS
   * while the resource is in its error state, and the literal below evaluates every
   * property eagerly, so a bare read would make this computed throw on any failed
   * request instead of resolving to `failed`. Same guard in every view.
   *
   * No `isEmpty`: an empty audit is a real and reassuring answer, not an empty state
   * to hide behind, so it is rendered as a sentence rather than as the rail's "no
   * data".
   */
  readonly auditState = computed(() =>
    viewStateOf<ImpersonationAuditResponse>({
      loading: this.auditData.isLoading(),
      error: this.auditData.error(),
      value: this.auditData.hasValue() ? this.auditData.value() : undefined,
    }),
  );

  readonly audit = computed(() => loadedValue(this.auditState()));

  /** True when the typed value could be an owner id. */
  readonly ownerUsable = computed(() => OWNER_ID_SHAPE.test(this.draftOwner().trim()));

  /** The shape hint, shown only once something has been typed. */
  readonly ownerHint = computed(() =>
    this.draftOwner().trim() === '' || this.ownerUsable() ? null : OWNER_ID_HINT,
  );

  onOwnerInput(event: Event): void {
    const target = event.target;
    this.draftOwner.set(target instanceof HTMLInputElement ? target.value : '');
  }

  /**
   * Reads the named owner's deployments as that owner, then reloads the audit.
   *
   * The audit reload is not decoration: the row was written by the Worker before the
   * answer was produced, so seeing it appear is the proof the record exists. It runs
   * even when the read FAILED, because a refusal on the audit-write path is exactly
   * the case where the operator needs to see what did and did not get recorded.
   */
  async read(): Promise<void> {
    const owner = this.draftOwner().trim();
    if (!OWNER_ID_SHAPE.test(owner) || this.busy()) return;

    this.busy.set(true);
    this.notice.set(null);
    try {
      const result = await this.api.fetchDeploymentsAs(owner);
      if (isOk(result)) {
        this.deployments.set(result.value);
        this.viewing.set(owner);
      } else {
        // The Worker's own sentence, never a local one. The two refusals that matter
        // here - a read-only violation and an unrecordable read - are only
        // distinguishable from its body.
        this.deployments.set(null);
        this.viewing.set(null);
        this.notice.set(describeReadFailure(result));
      }
    } finally {
      this.busy.set(false);
      this.auditData.reload();
    }
  }

  reloadAudit(): void {
    this.auditData.reload();
  }

  /**
   * A count, or a dash for a null.
   *
   * A null means the Worker had no ledger to read, and rendering it as `0` would
   * state a figure nobody measured - the same rule the spend view follows.
   */
  figure(value: number | null): string {
    return value === null || !Number.isFinite(value) ? '-' : String(value);
  }
}

/** Display copy for a read that did not succeed. */
function describeReadFailure(result: { kind: string; reason?: string }): string {
  if (result.kind === 'forbidden') return 'This account is not an operator.';
  if (result.kind === 'no-session') return 'Your session ended. Sign in again.';
  if (result.kind === 'session-rejected') return 'The admin API rejected this session.';
  return result.reason ?? 'Could not read that account.';
}
