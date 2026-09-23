import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';

import { OrgApiService } from '../../core/org-api.service';
import {
  DEGRADED_CLERK,
  UNPAID_ORG_TIER,
  type OrgListResponse,
  type OrgMembersResponse,
  type OrgSummary,
} from '../../core/org-models';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/** One entry of a level or tier select, built from the vocabulary the Worker sent. */
export interface TokenOption {
  label: string;
  value: string;
}

/** Title-cased display copy for a wire token. `none` reads as "No plan". */
export function tokenLabel(token: string): string {
  if (token === UNPAID_ORG_TIER) return 'No plan';
  if (token === '') return '-';
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Organisations: create one, hand its members their capability levels, and assign
 * its plan (Requirement 13).
 *
 * ## The only surface that writes membership
 *
 * Requirement 13.7: there is no organisation-facing member management route in
 * this release, so this view is the one place in the product where a membership is
 * written. That is why it is an operator surface rather than a studio one, and why
 * every write here lands on the same `/api/admin/*` allowlist the rest of the
 * dashboard reads through.
 *
 * ## It declares no vocabulary
 *
 * The level and tier selects are built from `levels` and `tiers` on the responses.
 * The Capability_Level tokens already exist as a twinned pair in `cloud/` and
 * `frontend/`, and a third copy here would be a third thing to keep in step with
 * no test comparing all three - so the Worker states what it accepts and this view
 * offers exactly that. A level added to the contract appears in the select with no
 * change to this file, and the view can never offer a token the Worker would
 * refuse.
 *
 * ## Two resources, and the members one is PARAMETERISED on the selection
 *
 * The list is the page; the member table is a drill-down. Keying the member
 * `resource()` on the selected id is what makes selecting a row refetch, with no
 * manual fetch call and no stale table from the previously selected organisation.
 *
 * ## Removal is a two-step inline confirm, not a dialog
 *
 * The repo has zero `p-dialog` usage, and the studio's `ConfirmDialogService` is
 * not in this package. A destructive action still must not be one click, so the
 * remove button ARMS the row and a second button confirms it. Selecting another
 * organisation or writing anything disarms it, so an armed row cannot outlive the
 * screen it was armed on.
 *
 * ## Refusals are shown, not swallowed
 *
 * A write answers through one `notice` signal carrying the Worker's own sentence.
 * The two that matter are `role_unknown`, which cannot happen from this UI and
 * would mean the vocabulary drifted, and `org_partial_write`, which means the
 * identity provider and the membership record now disagree - the one state no
 * later request can discover, so it must reach the operator rather than a log.
 */
@Component({
  selector: 'admin-organisations',
  // `FormsModule` for the standalone one-way `[ngModel]` on each `p-select`:
  // PrimeNG's select is a ControlValueAccessor, so that is how a value is pushed
  // into it. The change handler is what writes, never the binding, so nothing here
  // mutates a resource value.
  imports: [ButtonModule, FormsModule, InputTextModule, SelectModule, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-orgs-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-orgs-title">
          <i class="ti ti-building-community" aria-hidden="true"></i>
          <span>Organisations</span>
        </h1>
        <p class="admin-view__range">{{ organisationCount() }} on record</p>
      </header>

      @if (list(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          @if (notice(); as message) {
            <p class="admin-footnote" role="status">
              <i class="ti {{ noticeIcon() }}" aria-hidden="true"></i>
              <span>{{ message }}</span>
            </p>
          }

          @if (data.degraded.includes(clerkDegraded)) {
            <p class="admin-footnote" role="status">
              <i class="ti ti-alert-triangle" aria-hidden="true"></i>
              <span>
                Organisation names could not be read from the identity provider, so they show as
                dashes. Membership and plan below are unaffected.
              </span>
            </p>
          }

          <section class="admin-view__section" aria-labelledby="admin-orgs-list">
            <h2 class="admin-view__section-title" id="admin-orgs-list">All organisations</h2>
            @if (data.organisations.length === 0) {
              <p class="admin-footnote">
                <i class="ti ti-database-off" aria-hidden="true"></i>
                <span>No organisations yet. Create one below.</span>
              </p>
            } @else {
              <table class="admin-table">
                <caption class="admin-table__caption">
                  Every organisation, its plan and its member count
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Organisation</th>
                    <th scope="col">Plan</th>
                    <th scope="col">Status</th>
                    <th scope="col" class="admin-table__number">Members</th>
                    <th scope="col">
                      <span class="admin-orgs__sr">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  @for (org of data.organisations; track org.id) {
                    <tr>
                      <th scope="row">
                        <span class="admin-table__label">{{ org.name ?? '-' }}</span>
                        <span class="admin-orgs__id">{{ org.id }}</span>
                      </th>
                      <td>{{ label(org.tier) }}</td>
                      <td>{{ label(org.status) }}</td>
                      <td class="admin-table__number">{{ org.members }}</td>
                      <td>
                        <button
                          pButton
                          type="button"
                          size="small"
                          class="phorma-btn-content"
                          [text]="true"
                          [attr.aria-pressed]="selectedId() === org.id"
                          (click)="select(org.id)"
                        >
                          <i class="ti ti-users" aria-hidden="true"></i>
                          <span>Manage</span>
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>

          <section class="admin-view__section" aria-labelledby="admin-orgs-create">
            <h2 class="admin-view__section-title" id="admin-orgs-create">New organisation</h2>
            <article class="admin-card">
              <div class="admin-orgs__form">
                <label class="admin-orgs__field">
                  <span class="admin-orgs__label">Name</span>
                  <input
                    pInputText
                    pSize="small"
                    type="text"
                    name="orgName"
                    autocomplete="off"
                    [value]="draftName()"
                    (input)="onNameInput($event)"
                  />
                </label>
                <button
                  pButton
                  type="button"
                  size="small"
                  class="phorma-btn-content"
                  [disabled]="draftName().trim() === '' || busy()"
                  (click)="create()"
                >
                  <i class="ti ti-plus" aria-hidden="true"></i>
                  <span>Create</span>
                </button>
              </div>
              <p class="admin-stat__note">
                A new organisation gets no plan. Assign one below once it should be able to run
                workflows.
              </p>
            </article>
          </section>

          @if (selected(); as org) {
            <section class="admin-view__section" aria-labelledby="admin-orgs-plan">
              <h2 class="admin-view__section-title" id="admin-orgs-plan">
                Plan for {{ org.name ?? org.id }}
              </h2>
              <article class="admin-card">
                <div class="admin-orgs__form">
                  <label class="admin-orgs__field">
                    <span class="admin-orgs__label">Plan</span>
                    <p-select
                      size="small"
                      optionLabel="label"
                      optionValue="value"
                      [options]="tierOptions()"
                      [ngModel]="draftTier()"
                      (onChange)="onTierChange($event.value)"
                    />
                  </label>
                  <button
                    pButton
                    type="button"
                    size="small"
                    class="phorma-btn-content"
                    [disabled]="busy() || draftTier() === org.tier"
                    (click)="applyTier()"
                  >
                    <i class="ti ti-check" aria-hidden="true"></i>
                    <span>Apply plan</span>
                  </button>
                </div>
                <p class="admin-stat__note">
                  A plan change moves the spend ceiling on the existing provider key. It is never a
                  credit grant, and nothing here reaches the payment provider.
                </p>
              </article>
            </section>

            <section class="admin-view__section" aria-labelledby="admin-orgs-members">
              <h2 class="admin-view__section-title" id="admin-orgs-members">
                Members of {{ org.name ?? org.id }}
              </h2>
              @if (members(); as roster) {
                @if (roster.members.length === 0) {
                  <p class="admin-footnote">
                    <i class="ti ti-user-off" aria-hidden="true"></i>
                    <span>Nobody is in this organisation yet.</span>
                  </p>
                } @else {
                  <table class="admin-table">
                    <caption class="admin-table__caption">
                      Each member and the one level they hold here
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Member</th>
                        <th scope="col">Level</th>
                        <th scope="col">
                          <span class="admin-orgs__sr">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (member of roster.members; track member.userId) {
                        <tr>
                          <th scope="row">
                            <span class="admin-table__label">{{ member.userId }}</span>
                          </th>
                          <td>
                            <p-select
                              size="small"
                              optionLabel="label"
                              optionValue="value"
                              [options]="levelOptions()"
                              [ngModel]="member.level"
                              [disabled]="busy()"
                              (onChange)="changeLevel(member.userId, $event.value)"
                            />
                          </td>
                          <td>
                            @if (armedUserId() === member.userId) {
                              <button
                                pButton
                                type="button"
                                size="small"
                                class="phorma-btn-content"
                                [outlined]="true"
                                severity="secondary"
                                [disabled]="busy()"
                                (click)="confirmRemove(member.userId)"
                              >
                                <i class="ti ti-trash" aria-hidden="true"></i>
                                <span>Confirm removal</span>
                              </button>
                              <button
                                pButton
                                type="button"
                                size="small"
                                class="phorma-btn-content"
                                [text]="true"
                                (click)="disarm()"
                              >
                                <span>Cancel</span>
                              </button>
                            } @else {
                              <button
                                pButton
                                type="button"
                                size="small"
                                class="phorma-btn-content"
                                [text]="true"
                                [disabled]="busy()"
                                (click)="arm(member.userId)"
                              >
                                <i class="ti ti-user-minus" aria-hidden="true"></i>
                                <span>Remove</span>
                              </button>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }

                <article class="admin-card">
                  <div class="admin-orgs__form">
                    <label class="admin-orgs__field">
                      <span class="admin-orgs__label">Add by user id</span>
                      <input
                        pInputText
                        pSize="small"
                        type="text"
                        name="memberUserId"
                        autocomplete="off"
                        placeholder="user_..."
                        [value]="draftUserId()"
                        (input)="onUserIdInput($event)"
                      />
                    </label>
                    <label class="admin-orgs__field">
                      <span class="admin-orgs__label">Level</span>
                      <p-select
                        size="small"
                        optionLabel="label"
                        optionValue="value"
                        [options]="levelOptions()"
                        [ngModel]="draftLevel()"
                        (onChange)="onLevelChange($event.value)"
                      />
                    </label>
                    <button
                      pButton
                      type="button"
                      size="small"
                      class="phorma-btn-content"
                      [disabled]="draftUserId().trim() === '' || busy()"
                      (click)="addMember()"
                    >
                      <i class="ti ti-user-plus" aria-hidden="true"></i>
                      <span>Add</span>
                    </button>
                  </div>
                  <p class="admin-stat__note">
                    A level change or a removal takes effect on the member's next request, not on
                    their next sign-in.
                  </p>
                </article>
              } @else {
                <admin-view-state
                  emptyMessage="Nobody is in this organisation yet."
                  [state]="membersState()"
                  (retry)="reloadMembers()"
                />
              }
            </section>
          }

          <p class="admin-footnote">
            <i class="ti ti-lock" aria-hidden="true"></i>
            <span>
              Operator-only. This is the only surface that writes membership, so nothing in the
              studio can change a level.
            </span>
          </p>
        </div>
      } @else {
        <admin-view-state
          emptyMessage="No organisations yet."
          [state]="listState()"
          (retry)="reloadList()"
        />
      }
    </section>
  `,
  styles: `
    /* The dashboard has been read-only until now, so the shared stylesheet carries
       no form class to reuse. These rules are the whole of it - a row that wraps, a
       field that stacks its label, the id line under a name, and a
       screen-reader-only heading for the action column - and they stay
       component-scoped rather than joining the shared sheet until a second view
       needs a form. */
    .admin-orgs__form {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.571rem; /* 8px */
    }

    .admin-orgs__field {
      display: flex;
      flex-direction: column;
      gap: 0.214rem; /* 3px */
      min-width: 12rem;
    }

    .admin-orgs__label {
      color: var(--admin-text-muted);
      font-size: 0.857rem; /* 12px */
    }

    /* A second line under the name: the id is what every refusal and every log
       line names, so it has to be copyable from here. */
    .admin-orgs__id {
      display: block;
      color: var(--admin-text-muted);
      font-size: 0.786rem; /* 11px */
      font-variant-numeric: tabular-nums;
    }

    .admin-orgs__sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Organisations {
  private readonly api = inject(OrgApiService);

  readonly clerkDegraded = DEGRADED_CLERK;

  /** Which organisation the member and plan sections are about. */
  readonly selectedId = signal<string | null>(null);

  /** The row whose removal has been armed but not confirmed. */
  readonly armedUserId = signal<string | null>(null);

  /** True while a write is in flight, so no control can fire a second one. */
  readonly busy = signal(false);

  /** The Worker's own sentence for the last write, success or refusal. */
  readonly notice = signal<string | null>(null);

  /** Whether {@link notice} is reporting a refusal, which changes the icon only. */
  private readonly noticeFailed = signal(false);

  readonly noticeIcon = computed(() =>
    this.noticeFailed() ? 'ti-alert-triangle' : 'ti-circle-check',
  );

  readonly draftName = signal('');
  readonly draftUserId = signal('');
  readonly draftLevel = signal('');
  readonly draftTier = signal(UNPAID_ORG_TIER);

  private readonly listData = resource({
    loader: () => this.api.fetchOrganisations().then(unwrapAdminResult),
  });

  /**
   * Keyed on the selection, so choosing a row refetches and nothing has to
   * remember to. `params` returning null leaves the resource idle, which is what
   * keeps the member section from issuing a request before anything is selected.
   */
  private readonly membersData = resource({
    // `undefined` and NOT `null`: `undefined` is what leaves an Angular resource
    // IDLE, so the member section issues no request before anything is selected.
    // A `null` would be a perfectly good parameter value and the loader would run
    // with it.
    params: () => this.selectedId() ?? undefined,
    loader: ({ params }) => this.api.fetchMembers(params).then(unwrapAdminResult),
  });

  readonly listState = computed(() =>
    viewStateOf<OrgListResponse>({
      loading: this.listData.isLoading(),
      error: this.listData.error(),
      // Guarded read: `value()` THROWS in the error state, so a bare read would
      // make this computed throw instead of resolving to `failed`.
      value: this.listData.hasValue() ? this.listData.value() : undefined,
    }),
  );

  readonly membersState = computed(() =>
    viewStateOf<OrgMembersResponse>({
      loading: this.membersData.isLoading(),
      error: this.membersData.error(),
      value: this.membersData.hasValue() ? this.membersData.value() : undefined,
    }),
  );

  readonly list = computed(() => loadedValue(this.listState()));
  readonly members = computed(() => loadedValue(this.membersState()));

  readonly organisationCount = computed(() => this.list()?.organisations.length ?? 0);

  readonly selected = computed<OrgSummary | null>(() => {
    const id = this.selectedId();
    if (id === null) return null;
    return this.list()?.organisations.find((org) => org.id === id) ?? null;
  });

  /**
   * The level select options, from whichever response last carried a vocabulary.
   * The member roster is preferred because it is the more specific answer, and the
   * list is the fallback so the "add member" select works before a roster loads.
   */
  readonly levelOptions = computed<TokenOption[]>(() =>
    (this.members()?.levels ?? this.list()?.levels ?? []).map((token) => ({
      label: tokenLabel(token),
      value: token,
    })),
  );

  readonly tierOptions = computed<TokenOption[]>(() =>
    (this.list()?.tiers ?? []).map((token) => ({ label: tokenLabel(token), value: token })),
  );

  label(token: string): string {
    return tokenLabel(token);
  }

  onNameInput(event: Event): void {
    this.draftName.set(readInputValue(event));
  }

  onUserIdInput(event: Event): void {
    this.draftUserId.set(readInputValue(event));
  }

  onLevelChange(value: string): void {
    this.draftLevel.set(value);
  }

  onTierChange(value: string): void {
    this.draftTier.set(value);
  }

  /**
   * Selects an organisation, or clears the selection when the same row is chosen
   * again. Always disarms: an armed removal must not survive a change of subject.
   */
  select(orgId: string): void {
    this.disarm();
    this.selectedId.set(this.selectedId() === orgId ? null : orgId);
    const org = this.list()?.organisations.find((candidate) => candidate.id === orgId);
    this.draftTier.set(org?.tier ?? UNPAID_ORG_TIER);
    this.draftUserId.set('');
    // The lowest level is the safe default for a new member: it can trigger a run
    // and nothing else, so an operator has to choose to hand out more.
    this.draftLevel.set(this.levelOptions()[0]?.value ?? '');
  }

  arm(userId: string): void {
    this.armedUserId.set(userId);
  }

  disarm(): void {
    this.armedUserId.set(null);
  }

  async create(): Promise<void> {
    const name = this.draftName().trim();
    if (name === '') return;
    await this.write(() => this.api.createOrganisation({ name }), 'Organisation created with no plan.');
    this.draftName.set('');
  }

  async addMember(): Promise<void> {
    const orgId = this.selectedId();
    const userId = this.draftUserId().trim();
    const level = this.draftLevel();
    if (orgId === null || userId === '' || level === '') return;
    await this.write(
      () => this.api.setMemberLevel({ orgId, userId, level }),
      `${userId} is now ${tokenLabel(level).toLowerCase()} here.`,
    );
    this.draftUserId.set('');
  }

  async changeLevel(userId: string, level: string): Promise<void> {
    const orgId = this.selectedId();
    if (orgId === null || level === '') return;
    await this.write(
      () => this.api.setMemberLevel({ orgId, userId, level }),
      `${userId} is now ${tokenLabel(level).toLowerCase()}. Effective on their next request.`,
    );
  }

  async confirmRemove(userId: string): Promise<void> {
    const orgId = this.selectedId();
    if (orgId === null) return;
    this.disarm();
    await this.write(
      () => this.api.removeMember({ orgId, userId }),
      `${userId} removed. Effective on their next request.`,
    );
  }

  async applyTier(): Promise<void> {
    const orgId = this.selectedId();
    const tier = this.draftTier();
    if (orgId === null) return;
    await this.write(
      () => this.api.setTier({ orgId, tier }),
      `Plan set to ${tokenLabel(tier).toLowerCase()}.`,
    );
  }

  reloadList(): void {
    this.listData.reload();
  }

  reloadMembers(): void {
    this.membersData.reload();
  }

  /**
   * Runs one write, reports its outcome, and refetches both resources.
   *
   * BOTH, because a membership write moves the member count the list renders and a
   * plan write moves the plan it renders, so refetching only the section that was
   * edited would leave the table above it stating a superseded fact.
   *
   * The refusal copy is the WORKER's sentence, never a local one: the two answers
   * an operator has to act on are `role_unknown` (the vocabulary drifted, which
   * this UI cannot cause) and `org_partial_write` (the identity provider and the
   * membership record now disagree), and only the Worker knows which happened.
   */
  private async write(
    call: () => Promise<{ kind: string; reason?: string }>,
    success: string,
  ): Promise<void> {
    this.busy.set(true);
    try {
      const result = await call();
      if (result.kind === 'ok') {
        this.noticeFailed.set(false);
        this.notice.set(success);
      } else {
        this.noticeFailed.set(true);
        this.notice.set(describeWriteFailure(result));
      }
    } finally {
      this.busy.set(false);
    }
    this.listData.reload();
    if (this.selectedId() !== null) this.membersData.reload();
  }
}

/** Display copy for a refused write. */
export function describeWriteFailure(result: { kind: string; reason?: string }): string {
  if (result.kind === 'forbidden') return 'This account cannot manage organisations.';
  if (result.kind === 'no-session') return 'Your session ended. Sign in again.';
  if (result.kind === 'session-rejected') return 'The admin API rejected this session.';
  return result.reason ?? 'The change could not be applied.';
}

function readInputValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement ? target.value : '';
}
