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
import { hashTone, toneVar } from '../charts/tones';
import { AdminHint } from '../kit/hint';
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
  const words = token.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A badge colour for any token, derived from the token so no vocabulary is declared here. */
export function tokenTone(token: string): string {
  return token === UNPAID_ORG_TIER || token === '' ? toneVar('muted') : toneVar(hashTone(token));
}

const STATUS_TONES: Readonly<Record<string, string>> = {
  active: toneVar('good'),
  past_due: toneVar('warn'),
  canceled: toneVar('muted'),
  unprovisioned: toneVar('bad'),
};

/**
 * Organisations: create one, hand its members their capability levels, and assign
 * its plan (Requirement 13).
 *
 * The only surface in the product that writes membership. It declares no
 * vocabulary: the level and tier selects are built from the Worker's `levels`
 * and `tiers`, and badge colours hash the token rather than naming it. The
 * member resource is keyed on the selection. Removal is a two-step inline
 * confirm, and a refused write shows the Worker's own sentence.
 */
@Component({
  selector: 'admin-organisations',
  // `FormsModule` for the one-way `[ngModel]` on each `p-select`; the change
  // handler is what writes, never the binding.
  imports: [AdminHint, ButtonModule, FormsModule, InputTextModule, SelectModule, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-orgs-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-orgs-title">
          <i class="ti ti-building-community" aria-hidden="true"></i>
          <span>Organisations</span>
        </h1>
        <p class="admin-view__range">{{ organisationCount() }} on record</p>
        <admin-hint [text]="operatorHint" icon="ti-lock" />
      </header>

      @if (list(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          @if (notice() || data.degraded.includes(clerkDegraded)) {
            <div class="admin-status">
              @if (notice(); as message) {
                <span class="admin-chip" [class.admin-chip--bad]="noticeFailed()" [class.admin-chip--good]="!noticeFailed()" role="status">
                  <i class="ti {{ noticeIcon() }}" aria-hidden="true"></i>
                  <span>{{ message }}</span>
                </span>
              }
              @if (data.degraded.includes(clerkDegraded)) {
                <span class="admin-chip admin-chip--warn" role="status">
                  <i class="ti ti-alert-triangle" aria-hidden="true"></i>
                  <span>Organisation names could not be read from the identity provider</span>
                  <admin-hint text="They show as dashes. Membership and plan are unaffected." />
                </span>
              }
            </div>
          }

          <div class="admin-split">
            <article class="admin-card" aria-labelledby="admin-orgs-list">
              <div class="admin-card__head">
                <h2 class="admin-card__title" id="admin-orgs-list">
                  <i class="ti ti-list" aria-hidden="true"></i>
                  <span>All organisations</span>
                </h2>
              </div>

              @if (data.organisations.length === 0) {
                <p class="admin-empty-inline">
                  <i class="ti ti-database-off" aria-hidden="true"></i>
                  <span>No organisations yet. Create one below.</span>
                </p>
              } @else {
                <table class="admin-table">
                  <caption class="admin-table__caption">Every organisation, its plan and its member count</caption>
                  <thead>
                    <tr>
                      <th scope="col">Organisation</th>
                      <th scope="col">Plan</th>
                      <th scope="col">Status</th>
                      <th scope="col" class="admin-table__number">Members</th>
                      <th scope="col"><span class="admin-sr">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (org of data.organisations; track org.id) {
                      <tr [class.admin-table__row--selected]="selectedId() === org.id">
                        <th scope="row">
                          <span class="admin-orgs__who">
                            <span class="admin-avatar" [style.--tone]="avatarTone(org.id)" aria-hidden="true">{{ initials(org.name ?? org.id) }}</span>
                            <span>
                              <span class="admin-table__label">{{ org.name ?? '-' }}</span>
                              <span class="admin-id">{{ org.id }}</span>
                            </span>
                          </span>
                        </th>
                        <td><span class="admin-badge" [style.--tone]="tone(org.tier)">{{ label(org.tier) }}</span></td>
                        <td><span class="admin-badge" [style.--tone]="statusTone(org.status)">{{ label(org.status) }}</span></td>
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

              <hr class="admin-divider" />
              <div aria-labelledby="admin-orgs-create">
                <p class="admin-label" id="admin-orgs-create">New organisation</p>
                <div class="admin-form">
                  <label class="admin-field">
                    <span class="admin-sr">Name</span>
                    <input
                      pInputText
                      pSize="small"
                      type="text"
                      name="orgName"
                      autocomplete="off"
                      placeholder="Organisation name"
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
                  <admin-hint text="A new organisation gets no plan. Assign one once it should be able to run workflows." />
                </div>
              </div>
            </article>

            <div class="admin-stack-col">
              @if (selected(); as org) {
                <article class="admin-card admin-card--hero" aria-labelledby="admin-orgs-plan">
                  <div class="admin-card__head">
                    <span class="admin-avatar" [style.--tone]="avatarTone(org.id)" aria-hidden="true">{{ initials(org.name ?? org.id) }}</span>
                    <div>
                      <h2 class="admin-card__title" id="admin-orgs-plan">Plan for {{ org.name ?? org.id }}</h2>
                      <span class="admin-id">{{ org.id }}</span>
                    </div>
                  </div>
                  <div class="admin-form">
                    <label class="admin-field">
                      <span class="admin-label">Plan</span>
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
                    <admin-hint text="A plan change moves the spend ceiling on the existing provider key. It is never a credit grant, and nothing here reaches the payment provider." />
                  </div>
                </article>

                <article class="admin-card" aria-labelledby="admin-orgs-members">
                  <div class="admin-card__head">
                    <h2 class="admin-card__title" id="admin-orgs-members">
                      <i class="ti ti-users-group" aria-hidden="true"></i>
                      <span>Members of {{ org.name ?? org.id }}</span>
                    </h2>
                  </div>
                  @if (members(); as roster) {
                    @if (roster.members.length === 0) {
                      <p class="admin-empty-inline">
                        <i class="ti ti-user-off" aria-hidden="true"></i>
                        <span>Nobody is in this organisation yet.</span>
                      </p>
                    } @else {
                      <table class="admin-table">
                        <caption class="admin-table__caption">Each member and the one level they hold here</caption>
                        <thead>
                          <tr>
                            <th scope="col">Member</th>
                            <th scope="col">Level</th>
                            <th scope="col"><span class="admin-sr">Actions</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (member of roster.members; track member.userId) {
                            <tr>
                              <th scope="row">
                                <span class="admin-orgs__who">
                                  <span class="admin-avatar" [style.--tone]="avatarTone(member.userId)" aria-hidden="true">{{ memberInitial(member.userId) }}</span>
                                  <span class="admin-table__label admin-id">{{ member.userId }}</span>
                                </span>
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
                              <td class="admin-orgs__actions">
                                @if (armedUserId() === member.userId) {
                                  <button
                                    pButton
                                    type="button"
                                    size="small"
                                    class="phorma-btn-content"
                                    severity="danger"
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
                                    severity="secondary"
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

                    <hr class="admin-divider" />
                    <div class="admin-form">
                      <label class="admin-field admin-field--grow">
                        <span class="admin-label">Add by user id</span>
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
                      <label class="admin-field">
                        <span class="admin-label">Level</span>
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
                      <admin-hint text="A level change or a removal takes effect on the member's next request, not on their next sign-in." />
                    </div>
                  } @else {
                    <admin-view-state
                      emptyMessage="Nobody is in this organisation yet."
                      [state]="membersState()"
                      [inline]="true"
                      (retry)="reloadMembers()"
                    />
                  }
                </article>
              } @else {
                <article class="admin-card admin-orgs__placeholder">
                  <i class="ti ti-hand-click" aria-hidden="true"></i>
                  <p>Choose <strong>Manage</strong> on an organisation to set its plan and members.</p>
                </article>
              }
            </div>
          </div>
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
    .admin-orgs__who {
      display: flex;
      align-items: center;
      gap: 0.643rem;
      min-width: 0;
    }

    .admin-orgs__who .admin-id {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .admin-orgs__actions {
      white-space: nowrap;
    }

    .admin-orgs__placeholder {
      align-items: center;
      justify-content: center;
      min-height: 12rem;
      color: var(--admin-text-muted);
      text-align: center;
    }

    .admin-orgs__placeholder .ti {
      font-size: 1.714rem;
      color: rgb(var(--admin-tone-iris));
    }

    .admin-orgs__placeholder p {
      margin: 0;
      max-width: 18rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Organisations {
  private readonly api = inject(OrgApiService);

  readonly clerkDegraded = DEGRADED_CLERK;
  readonly operatorHint =
    'Operator-only. This is the only surface that writes membership, so nothing in the studio can change a level.';

  /** Which organisation the member and plan sections are about. */
  readonly selectedId = signal<string | null>(null);

  /** The row whose removal has been armed but not confirmed. */
  readonly armedUserId = signal<string | null>(null);

  /** True while a write is in flight, so no control can fire a second one. */
  readonly busy = signal(false);

  /** The Worker's own sentence for the last write, success or refusal. */
  readonly notice = signal<string | null>(null);

  /** Whether {@link notice} is reporting a refusal. */
  readonly noticeFailed = signal(false);

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
   * Keyed on the selection. `undefined` (not `null`) is what leaves an Angular
   * resource IDLE, so nothing is fetched before a row is chosen.
   */
  private readonly membersData = resource({
    params: () => this.selectedId() ?? undefined,
    loader: ({ params }) => this.api.fetchMembers(params).then(unwrapAdminResult),
  });

  readonly listState = computed(() =>
    viewStateOf<OrgListResponse>({
      loading: this.listData.isLoading(),
      error: this.listData.error(),
      // Guarded read: `value()` THROWS in the error state.
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

  /** Level options from the roster if loaded, else the list, so "add member" works early. */
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

  tone(token: string): string {
    return tokenTone(token);
  }

  statusTone(status: string): string {
    return STATUS_TONES[status] ?? toneVar(hashTone(status));
  }

  avatarTone(id: string): string {
    return toneVar(hashTone(id));
  }

  /** Clerk ids share a prefix, so the tail is what tells two members apart. */
  memberInitial(userId: string): string {
    return userId.replace(/^user_/, '').slice(-2).toUpperCase() || '?';
  }

  initials(name: string): string {
    const words = name.replace(/^(org|user)_/, '').split(/[\s_-]+/).filter(Boolean);
    return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toUpperCase() || '?';
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

  /** Selects an organisation, or clears it when chosen again. Always disarms. */
  select(orgId: string): void {
    this.disarm();
    this.selectedId.set(this.selectedId() === orgId ? null : orgId);
    const org = this.list()?.organisations.find((candidate) => candidate.id === orgId);
    this.draftTier.set(org?.tier ?? UNPAID_ORG_TIER);
    this.draftUserId.set('');
    // The lowest level is the safe default: an operator has to choose to hand out more.
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
   * Runs one write, reports its outcome, and refetches BOTH resources: a
   * membership write moves the list's member count and a plan write moves its
   * plan. The refusal copy is the Worker's sentence, never a local one.
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
