import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';

import { InfoPopover } from '../../../shared/info-popover/info-popover';
import { McpOAuthService } from '../../../core/mcp-oauth.service';
import {
  COUNTER_CATALOG,
  DIMENSIONED_COUNTER_FAMILIES,
  DIMENSIONLESS_COUNTER_FAMILIES,
  type CounterFamily,
  type DimensionedCounterFamily,
} from '../../../core/telemetry-catalog';
import { ENV_KEYS } from '../../../core/telemetry-core';
import { TelemetryService } from '../../../core/telemetry.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';

/**
 * Where the plain-language policy lives.
 *
 * Exported rather than inlined so anything else in the studio that needs to
 * reach the policy takes the same URL. This page is now the ONLY in-app
 * disclosure - the first-run notice was removed and the disclosure moved to the
 * download page - so this link is the one the user can always get back to.
 */
export const PRIVACY_POLICY_URL = 'https://phorma-labs.com/privacy';

/** One Counter_Catalog family, described for a human. */
export interface CollectedCounterFamily {
  /** The family name as it appears in a counter, e.g. `node.created`. */
  family: CounterFamily;
  /** Plain-language description of what the family counts. */
  label: string;
  /** How many catalog names this family expands to. */
  names: number;
}

/** One Client_Environment field, described for a human. */
export interface CollectedEnvField {
  key: (typeof ENV_KEYS)[number];
  label: string;
}

/**
 * Plain-language copy for every counter family.
 *
 * `Record<CounterFamily, string>` is exhaustive, so adding a family to
 * `telemetry-catalog.ts` without describing it here is a compile error. That is
 * the whole point: the section below is DERIVED from the catalog, so the copy
 * cannot quietly drift from what the code actually counts (1.4).
 */
const COUNTER_FAMILY_LABELS: Readonly<Record<CounterFamily, string>> = {
  'session.started': 'How many times the studio is started',
  'run.started': 'How many workflow runs are started',
  'run.completed': 'How many runs finish successfully',
  'run.error': 'How many runs end in a failure',
  'node.created': 'Which kinds of node get added to a canvas',
  'panel.opened': 'Which panels get opened',
  'assistant.invoked': 'Which assistant mode is used',
  'deploy.started': 'Which deploy target is used',
  error: 'Which category a failure fell into, never its message',
};

/** The same exhaustive treatment for the six Client_Environment fields. */
const ENV_FIELD_LABELS: Readonly<Record<(typeof ENV_KEYS)[number], string>> = {
  locale: 'Your interface language, for example en-GB',
  timezone: 'Your timezone name, for example Europe/London',
  platform: 'Windows, macOS, Linux, or other',
  osVersion: 'The operating system version string',
  appVersion: 'The version of the studio you are running',
  runtimeMode: 'Whether this is the desktop app or the browser build',
};

/** Expands the catalog's own family declarations into the rendered list. */
function describeCounterFamilies(): readonly CollectedCounterFamily[] {
  const described: CollectedCounterFamily[] = [];
  for (const family of DIMENSIONLESS_COUNTER_FAMILIES) {
    described.push({ family, label: COUNTER_FAMILY_LABELS[family], names: 1 });
  }
  const dimensioned = Object.keys(DIMENSIONED_COUNTER_FAMILIES) as DimensionedCounterFamily[];
  for (const family of dimensioned) {
    described.push({
      family,
      label: COUNTER_FAMILY_LABELS[family],
      names: DIMENSIONED_COUNTER_FAMILIES[family].length,
    });
  }
  return described;
}

/**
 * Privacy settings - body of the Settings dialog `privacy` page
 * (`customTemplate: 'privacy'`).
 *
 * Five things, top to bottom: the single consent toggle, the Install_Id with
 * copy and reset, what is collected, exactly what would be uploaded next, and
 * the policy link. Nothing here decides anything about telemetry - every action
 * is one call into `TelemetryService`, which owns the transitions.
 *
 * The collected-data lists are DERIVED from `telemetry-catalog.ts` and
 * `ENV_KEYS` rather than written out, so this page cannot claim less than the
 * code collects.
 */
@Component({
  selector: 'app-privacy-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonModule,
    InputTextModule,
    ToggleSwitchModule,
    TooltipModule,
    InfoPopover,
  ],
  templateUrl: './privacy-settings.html',
  styleUrl: './privacy-settings.scss',
})
export class PrivacySettings {
  protected readonly telemetry = inject(TelemetryService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);
  // The app's only external-link helper: `plugin-opener` on desktop, a
  // `noopener` tab in the browser. It lives on the MCP OAuth service because
  // that is where guided provider setup first needed it.
  private readonly links = inject(McpOAuthService);

  protected readonly policyUrl = PRIVACY_POLICY_URL;

  /** Every counter family, in catalog order. */
  protected readonly counterFamilies = describeCounterFamilies();

  /** Total number of permitted counter names. */
  protected readonly counterNameCount = COUNTER_CATALOG.size;

  /** Every Client_Environment field, in `ENV_KEYS` order. */
  protected readonly envFields: readonly CollectedEnvField[] = ENV_KEYS.map((key) => ({
    key,
    label: ENV_FIELD_LABELS[key],
  }));

  /** Whether the Pending upload disclosure is open. Closed on every open. */
  protected readonly pendingOpen = signal(false);

  /**
   * The pending Rollup, pretty-printed. Empty while nothing is pending, which
   * is either disabled consent or an initialization that has not resolved yet
   * (11.6).
   */
  protected readonly preview = computed(() => {
    const rollup = this.telemetry.pendingRollup();
    if (rollup === null) return '';
    try {
      return JSON.stringify(rollup, null, 2);
    } catch {
      return '';
    }
  });

  protected togglePending(): void {
    this.pendingOpen.update((open) => !open);
  }

  /** The one control over Consent_State (1.4, 1.5, 1.7). */
  protected onEnabledChange(next: boolean): void {
    this.telemetry.setEnabled(next === true);
  }

  protected async copyInstallId(): Promise<void> {
    const id = this.telemetry.installId();
    if (id.length === 0) return;
    try {
      await navigator.clipboard.writeText(id);
      this.toast.success('Copied', id);
    } catch {
      this.toast.error('Copy failed', 'The clipboard is unavailable in this context.');
    }
  }

  /**
   * Reset discards pending data, so it goes through the shared confirm rail
   * rather than firing on the click (2.4). No toast on success: the row's value
   * changing IS the feedback, and telemetry raises no toasts.
   */
  protected async resetInstallId(): Promise<void> {
    const confirmed = await this.confirmDialog.confirm({
      title: 'Reset install ID?',
      message:
        'A new random ID is generated. Everything counted so far, including anything ' +
        'waiting to upload, is discarded. Earlier uploads keep the old ID and cannot be ' +
        'linked to the new one.',
      confirmLabel: 'Reset ID',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.telemetry.resetInstallId();
  }

  protected async openPolicy(): Promise<void> {
    try {
      await this.links.openExternal(PRIVACY_POLICY_URL);
    } catch {
      this.toast.error('Could not open the policy', PRIVACY_POLICY_URL);
    }
  }
}
