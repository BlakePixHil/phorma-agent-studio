import { Injectable, inject } from '@angular/core';

import { PanelRegistryService } from '../panel-registry.service';
import {
  SettingsRegistryService,
  type SettingDef,
  type SettingsPageDef,
  type SettingsSectionDef,
} from '../settings-registry';
import {
  actionFail,
  actionOk,
  argStr,
  type ActionArgs,
  type ActionResult,
  type StudioAction,
} from './studio-action.model';

/** Tab ids the navigation action accepts (Requirement 2.10). */
const NAVIGABLE_TABS = [
  'agents',
  'workflows',
  'runs',
  'skills',
  'connections',
  'prompt',
  'properties',
  'usage',
  'evals',
  'assistant',
  'portal',
] as const;

/**
 * Surfaces `settings` (Requirement 2.9) and `navigation` (Requirement 2.10).
 *
 * Settings are read and written strictly through the descriptors declared in
 * {@link SettingsRegistryService}, which is also the boundary that keeps
 * secrets out: API keys and integration credentials live in bespoke custom
 * templates with no `SettingDef`, so they are unreachable from here by
 * construction (Requirement 6.5).
 *
 * Declared minimums (multi-organisation-phorma Requirement 8.1): `settings_write`
 * is builder, because the declared settings include the cloud provider, the worker
 * URL and the default model - configuration of how everything ships and what it
 * costs. Reading them is open, and so is `navigate_panel`, which shows the user a
 * panel they already have.
 */
@Injectable({ providedIn: 'root' })
export class SettingsActionsService {
  private readonly registry = inject(SettingsRegistryService);
  private readonly panels = inject(PanelRegistryService);

  actions(): StudioAction[] {
    return [
      {
        id: 'settings_read',
        label: 'Read application settings',
        description:
          'Lists the application settings that can be read and written, with their page, control type, allowed values and current value. Secrets are never included.',
        surface: 'settings',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        params: {
          pageId: { type: 'string', description: 'Limit to one settings page id.' },
          query: { type: 'string', description: 'Filter by setting id, label or keyword.' },
        },
        activity: () => 'Reading application settings',
        run: args => this.readSettings(args),
      },
      {
        id: 'settings_write',
        label: 'Change an application setting',
        description:
          'Writes one declared application setting. Read settings_read first to learn the setting id and the values it accepts.',
        surface: 'settings',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: {
          settingId: { type: 'string', description: 'Setting id.', required: true },
          value: {
            type: 'any',
            description:
              'New value: boolean for a toggle, one of the listed options for a select, a number for number/slider, a string for text. Omit for a button setting.',
          },
        },
        confirmSummary: args => {
          const found = this.findSetting(argStr(args, 'settingId'));
          const label = found?.setting.label ?? argStr(args, 'settingId') ?? 'a setting';
          if (found?.setting.control.type === 'button') {
            return `Run "${label}" from Settings, ${found.page.label}?`;
          }
          return `Change the "${label}" setting to ${describeValue(args['value'])}?`;
        },
        activity: args =>
          `Changing the "${this.findSetting(argStr(args, 'settingId'))?.setting.label ?? 'application'}" setting`,
        run: args => this.writeSetting(args),
      },
      {
        id: 'navigate_panel',
        label: 'Open a panel',
        description:
          'Reveals and activates a studio panel so the user can see it. Use this after working on a surface, or when the user asks where something is.',
        surface: 'navigation',
        access: 'write',
        risk: 'silent',
        minLevel: 'operator',
        params: {
          tabId: {
            type: 'string',
            description: 'Panel tab id.',
            required: true,
            enum: NAVIGABLE_TABS,
          },
        },
        activity: args => `Opening the ${argStr(args, 'tabId') ?? ''} panel`,
        run: args => this.navigate(args),
      },
    ];
  }

  /**
   * Reveals and activates a tab, honouring the side it currently lives on and
   * expanding that sidebar if the user collapsed it. Shared with the registry's
   * post-action panel reveal (Requirement 8.6).
   *
   * Reads `allowedTabs()` rather than `tabs()`, for the same reason the Window
   * menu does: `tabs()` is the record of the user's arrangement and holds every
   * entry regardless of level, so revealing off it would let `navigate_panel`
   * report that it opened a panel the sidebar then filters straight back out. A
   * level that allows the tab sees no change at all, and a level that does not
   * gets the same "no such panel" answer it would get for a typo - which, from
   * inside that studio, is the honest answer.
   */
  reveal(tabId: string): boolean {
    const tab = this.panels.allowedTabs().find(item => item.id === tabId);
    if (!tab) return false;
    this.panels.setActive(tab.side, tabId);
    if (tab.side === 'left') this.panels.collapsedLeft.set(false);
    else this.panels.collapsedRight.set(false);
    return true;
  }

  // ── Executors ────────────────────────────────────────────────────────────

  private readSettings(args: ActionArgs): ActionResult {
    const pageId = argStr(args, 'pageId');
    const query = argStr(args, 'query')?.toLowerCase();
    const rows: unknown[] = [];
    for (const { page, section, setting } of this.declaredSettings()) {
      if (pageId && page.id !== pageId) continue;
      if (query) {
        const haystack = [
          setting.id,
          setting.label,
          setting.description ?? '',
          ...(setting.keywords ?? []),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      rows.push({
        id: setting.id,
        label: setting.label,
        description: setting.description,
        page: page.id,
        section: section.label ?? section.id,
        control: setting.control.type,
        ...(setting.control.type === 'select'
          ? { options: setting.control.options.map(option => option.value) }
          : {}),
        ...(setting.control.type === 'number' || setting.control.type === 'slider'
          ? { min: setting.control.min, max: setting.control.max }
          : {}),
        ...(setting.control.type === 'button' ? {} : { value: safeGet(setting) }),
      });
    }
    return actionOk({
      settings: rows,
      pages: this.registry.pages.map(page => ({ id: page.id, label: page.label })),
    });
  }

  private writeSetting(args: ActionArgs): ActionResult {
    const settingId = argStr(args, 'settingId');
    if (!settingId) return actionFail('Missing the setting id.');
    const found = this.findSetting(settingId);
    if (!found) {
      return actionFail(`Setting '${settingId}' is not declared, so it cannot be written.`);
    }
    const control = found.setting.control;
    const raw = args['value'];

    if (control.type === 'button') {
      found.setting.set(undefined);
      return actionOk({ settingId, ran: true }, { revertable: false });
    }
    if (raw === undefined || raw === null) {
      return actionFail(`Setting '${settingId}' needs a value.`);
    }

    switch (control.type) {
      case 'toggle': {
        const value = coerceBoolean(raw);
        if (value === null) return actionFail(`Setting '${settingId}' expects true or false.`);
        found.setting.set(value);
        return actionOk({ settingId, value }, { revertable: false });
      }
      case 'select': {
        const value = String(raw);
        if (!control.options.some(option => option.value === value)) {
          return actionFail(
            `Setting '${settingId}' expects one of ${control.options.map(option => option.value).join(', ')}.`,
          );
        }
        found.setting.set(value);
        return actionOk({ settingId, value }, { revertable: false });
      }
      case 'number':
      case 'slider': {
        const value = coerceNumber(raw);
        if (value === null) return actionFail(`Setting '${settingId}' expects a number.`);
        const min = control.min;
        const max = control.max;
        if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
          return actionFail(
            `Setting '${settingId}' expects a number between ${min ?? '-'} and ${max ?? '-'}.`,
          );
        }
        found.setting.set(value);
        return actionOk({ settingId, value }, { revertable: false });
      }
      case 'text': {
        const value = String(raw);
        found.setting.set(value);
        return actionOk({ settingId, value }, { revertable: false });
      }
    }
  }

  private navigate(args: ActionArgs): ActionResult {
    const tabId = argStr(args, 'tabId');
    if (!tabId) return actionFail('Missing the panel tab id.');
    if (!this.reveal(tabId)) return actionFail(`There is no panel with the tab id '${tabId}'.`);
    return actionOk({ tabId }, { revertable: false });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Every generic (descriptor-driven) setting in currently visible sections. */
  private declaredSettings(): {
    page: SettingsPageDef;
    section: SettingsSectionDef;
    setting: SettingDef;
  }[] {
    const rows: { page: SettingsPageDef; section: SettingsSectionDef; setting: SettingDef }[] = [];
    for (const page of this.registry.pages) {
      for (const section of page.sections) {
        if (section.visible && !section.visible()) continue;
        for (const setting of section.settings) rows.push({ page, section, setting });
      }
    }
    return rows;
  }

  private findSetting(
    settingId: string | undefined,
  ): { page: SettingsPageDef; setting: SettingDef } | null {
    if (!settingId) return null;
    const match = this.declaredSettings().find(row => row.setting.id === settingId);
    return match ? { page: match.page, setting: match.setting } : null;
  }
}

/** Reads a descriptor value defensively - a throwing getter must not fail the turn. */
function safeGet(setting: SettingDef): unknown {
  try {
    return setting.get();
  } catch {
    return null;
  }
}

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function describeValue(value: unknown): string {
  if (value === undefined || value === null) return 'its default';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}
