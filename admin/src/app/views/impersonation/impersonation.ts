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
import { AdminHint } from '../kit/hint';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/**
 * The shape an owner id has to have before it is worth sending. A local
 * convenience, not a gate: the Worker ignores an unrecognised value and answers
 * with the operator's own data, so this turns a silent typo into a sentence.
 */
export const OWNER_ID_SHAPE = /^(?:user|org)_[A-Za-z0-9_-]{1,120}$/;

/** What the owner field says when the typed value could not be an owner id. */
export const OWNER_ID_HINT = 'An owner id starts with org_ or user_.';

/**
 * Impersonation: read one customer's account as that customer, and read the record
 * of every time anybody did (Requirement 14).
 *
 * The only surface in the product that can do it, and read-only. The whole body
 * gates on the audit resource; the read is an imperative action (a recorded act
 * that must never re-fire on its own), and the audit reloads after every read so
 * the operator watches their own action land in the record.
 */
@Component({
  selector: 'admin-impersonation',
  imports: [AdminHint, ButtonModule, DatePipe, DecimalPipe, InputTextModule, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-impersonation-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-impersonation-title">
          <i class="ti ti-eye" aria-hidden="true"></i>
          <span>Impersonation</span>
        </h1>
        <p class="admin-view__range">Read-only, and always recorded</p>
        <admin-hint [text]="operatorHint" icon="ti-lock" />
      </header>

      @if (audit(); as auditData) {
        <div class="admin-view__body" data-view-state="loaded">
          <div class="admin-split admin-split--stretch">
            <article class="admin-card admin-card--hero" aria-labelledby="admin-impersonation-read">
              <div class="admin-card__head">
                <h2 class="admin-card__title" id="admin-impersonation-read">
                  <i class="ti ti-eye-search" aria-hidden="true"></i>
                  <span>Read a customer's account</span>
                </h2>
                <div class="admin-card__aside">
                  <span class="admin-chip admin-chip--iris admin-chip--xs">
                    <i class="ti ti-shield-check" aria-hidden="true"></i>
                    <span>Recorded</span>
                    <admin-hint text="Every read here writes an audit row before the answer is served. A read that cannot be recorded is refused." />
                  </span>
                </div>
              </div>

              <div class="admin-form">
                <label class="admin-field admin-field--grow">
                  <span class="admin-label">Owner id</span>
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

              @if (notice(); as message) {
                <span class="admin-chip admin-chip--bad" role="status">
                  <i class="ti ti-alert-triangle" aria-hidden="true"></i>
                  <span>{{ message }}</span>
                </span>
              }

              @if (viewing(); as owner) {
                @if (deployments(); as data) {
                  <hr class="admin-divider" />
                  <div class="admin-card__head">
                    <p class="admin-label">Deployments of <span class="admin-id admin-imp__inline">{{ owner }}</span></p>
                    <div class="admin-card__aside">
                      <span class="admin-chip admin-chip--muted admin-chip--xs">{{ data.month }}</span>
                    </div>
                  </div>
                  @if (data.deployments.length === 0) {
                    <p class="admin-empty-inline admin-imp__warning">
                      <i class="ti ti-database-off" aria-hidden="true"></i>
                      <span>
                        Nothing is deployed under {{ owner }}. If that is unexpected, check the id and
                        check that this account is on the operator allowlist - an unrecognised id and an
                        unauthorised caller both answer with your own account and no error.
                      </span>
                    </p>
                  } @else {
                    <table class="admin-table">
                      <caption class="admin-table__caption">What {{ owner }} is running, for {{ data.month }}</caption>
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
                              <span class="admin-id">{{ row.workflowId }}</span>
                            </th>
                            <td>{{ row.updatedAt | date: 'short' }}</td>
                            <td>
                              @if (row.cronArmed) {
                                <span class="admin-badge admin-imp__armed">
                                  <i class="ti ti-clock" aria-hidden="true"></i>Armed
                                </span>
                              } @else {
                                -
                              }
                            </td>
                            <td class="admin-table__number">{{ figure(row.runsThisMonth) }}</td>
                            <td class="admin-table__number">{{ figure(row.creditsSpent) }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  }
                }
              }
            </article>

            <article class="admin-card" aria-labelledby="admin-impersonation-audit">
              <div class="admin-card__head">
                <h2 class="admin-card__title" id="admin-impersonation-audit">
                  <i class="ti ti-history" aria-hidden="true"></i>
                  <span>Who read what, and when</span>
                </h2>
                <div class="admin-card__aside">
                  @if (auditData.truncated) {
                    <span class="admin-chip admin-chip--muted admin-chip--xs">
                      <i class="ti ti-info-circle" aria-hidden="true"></i>
                      <span>Older rows exist. This list is capped at {{ auditData.limit | number }}.</span>
                    </span>
                  }
                </div>
              </div>
              @if (auditData.entries.length === 0) {
                <p class="admin-empty-inline">
                  <i class="ti ti-shield-check" aria-hidden="true"></i>
                  <span>Nobody has read a customer's account through this surface.</span>
                </p>
              } @else {
                <ol class="admin-timeline" [attr.aria-label]="'The ' + auditData.entries.length + ' most recent reads, newest first'">
                  @for (entry of auditData.entries; track entry.id) {
                    <li class="admin-timeline__item">
                      <span class="admin-timeline__when">{{ entry.at | date: 'MMM d, HH:mm' }}</span>
                      <div class="admin-timeline__what">
                        <span class="admin-timeline__who">
                          <span class="admin-id">{{ entry.actingUserId }}</span>
                          <i class="ti ti-arrow-right" aria-label="read as"></i>
                          <span class="admin-id admin-imp__owner">{{ entry.ownerId }}</span>
                        </span>
                        <span class="admin-timeline__request">
                          <span class="admin-method">{{ entry.method }}</span>
                          <span class="admin-id">{{ entry.path }}</span>
                        </span>
                      </div>
                    </li>
                  }
                </ol>
              }
            </article>
          </div>
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
    .admin-imp__inline {
      display: inline;
      text-transform: none;
      letter-spacing: 0;
    }

    .admin-imp__owner {
      color: rgb(var(--admin-tone-iris));
    }

    .admin-imp__armed {
      --tone: var(--admin-tone-good);
    }

    .admin-imp__warning {
      align-items: flex-start;
      color: rgb(var(--admin-tone-warn));
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Impersonation {
  private readonly api = inject(ImpersonationApiService);

  readonly operatorHint =
    "Operator-only, and read-only. A write attempted while reading as a customer is refused by the worker, and building inside a customer's organisation needs a real membership.";

  readonly draftOwner = signal('');

  /** The owner the table is about, or null before the first read. */
  readonly viewing = signal<string | null>(null);

  readonly busy = signal(false);

  /** The one sentence a failed read answers with, or null. */
  readonly notice = signal<string | null>(null);

  readonly deployments = signal<SupportDeploymentsResponse | null>(null);

  private readonly auditData = resource({
    loader: () => this.api.fetchAudit().then(unwrapAdminResult),
  });

  /** No `isEmpty`: an empty audit is a real and reassuring answer. */
  readonly auditState = computed(() =>
    viewStateOf<ImpersonationAuditResponse>({
      loading: this.auditData.isLoading(),
      error: this.auditData.error(),
      value: this.auditData.hasValue() ? this.auditData.value() : undefined,
    }),
  );

  readonly audit = computed(() => loadedValue(this.auditState()));

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
   * Reads the named owner's deployments as that owner, then reloads the audit -
   * even when the read failed, because a refusal on the audit-write path is
   * exactly when the operator needs to see what was recorded.
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

  /** A count, or a dash for a null: a null means no ledger was read. */
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
