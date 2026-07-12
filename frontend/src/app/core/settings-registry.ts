import { Injectable, inject } from '@angular/core';

import { CanvasStateService, MINIMAP_ANCHORS, type MinimapAnchor } from './canvas-state.service';
import { BEDROCK_REGIONS } from './workflow.model';
import { SettingsService } from './settings.service';
import { ThemeService, type ThemeMode } from './theme.service';
import { OnboardingService } from '../workspace/onboarding/onboarding.service';

/**
 * Settings registry — the single declarative source of truth for the
 * application Settings dialog.
 *
 * Every non-sensitive setting is a `SettingDef` descriptor whose `get`/`set`
 * delegate to the owning service's signals; the dialog renders pages,
 * sections, and controls generically from this registry. Adding or removing
 * a setting is one descriptor entry — no dialog template changes needed.
 *
 * Sections that need bespoke UI (API keys, palette swatches, integration
 * credential forms, the default-model picker) declare a `customTemplate` id
 * that the dialog maps to a dedicated ng-template. Sensitive values are
 * NEVER read through this registry — secret sections only surface
 * "configured" booleans.
 */

// ── Descriptor types ─────────────────────────────────────────────────────────

export interface SettingSelectOption {
  value: string;
  label: string;
}

/** Control shape for a generic (auto-rendered) setting. */
export type SettingControl =
  | { type: 'toggle' }
  | { type: 'select'; options: SettingSelectOption[] }
  | { type: 'number'; min?: number; max?: number; step?: number; suffix?: string }
  | { type: 'slider'; min: number; max: number; step: number }
  | { type: 'text'; placeholder?: string }
  /** Action button; `set` is invoked on click, `get` is unused. */
  | { type: 'button'; label: string; icon?: string };

export interface SettingDef {
  /** Stable id, unique within the registry (used as control DOM id). */
  id: string;
  label: string;
  /** One-line explanation rendered under the label. */
  description?: string;
  control: SettingControl;
  /** Extra terms matched by the settings search box. */
  keywords?: string[];
  get: () => unknown;
  set: (value: unknown) => void;
}

/** Ids of bespoke section templates implemented by the settings dialog. */
export type SettingsCustomTemplate =
  | 'api-keys'
  | 'palette-picker'
  | 'default-model'
  | 'integrations'
  | 'cloud-provider';

export interface SettingsSectionDef {
  id: string;
  /** Section heading; omitted for a page's single unlabelled section. */
  label?: string;
  /** Note rendered under the heading (e.g. storage caveats). */
  note?: string;
  /** Generic settings rendered from descriptors. */
  settings: SettingDef[];
  /** Bespoke template rendered after (or instead of) the generic settings. */
  customTemplate?: SettingsCustomTemplate;
  /** Search terms for custom-template sections that carry no descriptors. */
  keywords?: string[];
  /**
   * Optional visibility predicate. When present and it returns false, the
   * section is hidden (e.g. provider-specific config shown only for the
   * chosen provider). Reads signals, so it reacts to setting changes.
   */
  visible?: () => boolean;
}

export interface SettingsPageDef {
  id: string;
  label: string;
  /** Tabler icon class (`ti ti-*`). */
  icon: string;
  description?: string;
  sections: SettingsSectionDef[];
}

// ── Registry service ─────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class SettingsRegistryService {
  private readonly settings = inject(SettingsService);
  private readonly theme = inject(ThemeService);
  private readonly canvas = inject(CanvasStateService);
  private readonly onboarding = inject(OnboardingService);

  /** All settings pages, in nav order. */
  readonly pages: SettingsPageDef[] = [
    {
      id: 'general',
      label: 'General',
      icon: 'ti ti-adjustments',
      description: 'Workflow document behaviour.',
      sections: [
        {
          id: 'workflows',
          label: 'Workflows',
          settings: [
            {
              id: 'autosave-enabled',
              label: 'Autosave',
              description: 'Automatically save named workflows shortly after each change.',
              keywords: ['save', 'automatic'],
              control: { type: 'toggle' },
              get: () => this.settings.autosaveEnabled(),
              set: value => this.settings.autosaveEnabled.set(!!value),
            },
            {
              id: 'confirm-workflow-delete',
              label: 'Confirm before deleting workflows',
              description: 'Ask for confirmation when removing a workflow from the library.',
              keywords: ['delete', 'remove', 'confirmation'],
              control: { type: 'toggle' },
              get: () => this.settings.confirmWorkflowDelete(),
              set: value => this.settings.confirmWorkflowDelete.set(!!value),
            },
          ],
        },
        {
          id: 'setup-wizard',
          label: 'Setup wizard',
          settings: [
            {
              id: 'run-setup-wizard',
              label: 'Setup wizard',
              description: 'Re-run first-time setup: install Ollama, download a local model, or configure API keys.',
              keywords: ['onboarding', 'setup', 'wizard', 'ollama', 'install', 'model', 'download', 'first run'],
              control: { type: 'button', label: 'Run setup wizard', icon: 'ti ti-sparkles' },
              get: () => undefined,
              set: () => this.onboarding.open(),
            },
          ],
        },
      ],
    },
    {
      id: 'appearance',
      label: 'Appearance',
      icon: 'ti ti-palette',
      description: 'Theme and interface layout.',
      sections: [
        {
          id: 'theme',
          label: 'Theme',
          settings: [
            {
              id: 'theme-mode',
              label: 'Color mode',
              description: 'Light or dark interface theme.',
              keywords: ['dark', 'light', 'theme'],
              control: {
                type: 'select',
                options: [
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                ],
              },
              get: () => this.theme.mode(),
              set: value => this.theme.setMode(value as ThemeMode),
            },
          ],
        },
        {
          id: 'accent',
          label: 'Accent palette',
          settings: [],
          customTemplate: 'palette-picker',
          keywords: ['color', 'accent', 'palette', 'primary'],
        },
        {
          id: 'minimap-layout',
          label: 'Minimap',
          settings: [
            {
              id: 'minimap-anchor',
              label: 'Minimap position',
              description: 'Which corner of the canvas the minimap docks to.',
              keywords: ['minimap', 'corner', 'anchor'],
              control: {
                type: 'select',
                options: MINIMAP_ANCHORS.map(anchor => ({
                  value: anchor,
                  label: anchor.replace('-', ' '),
                })),
              },
              get: () => this.canvas.minimapAnchor(),
              set: value => this.canvas.minimapAnchor.set(value as MinimapAnchor),
            },
          ],
        },
      ],
    },
    {
      id: 'canvas',
      label: 'Canvas',
      icon: 'ti ti-grid-dots',
      description: 'Grid, minimap, and navigation behaviour.',
      sections: [
        {
          id: 'grid',
          label: 'Grid',
          settings: [
            {
              id: 'grid-visible',
              label: 'Show grid',
              description: 'Display the dot grid on the canvas background.',
              keywords: ['grid', 'dots', 'background'],
              control: { type: 'toggle' },
              get: () => this.canvas.gridVisible(),
              set: value => this.canvas.gridVisible.set(!!value),
            },
            {
              id: 'grid-snap',
              label: 'Snap to grid',
              description: 'Snap nodes to the grid while dragging.',
              keywords: ['snap', 'align'],
              control: { type: 'toggle' },
              get: () => this.canvas.gridSnap(),
              set: value => this.canvas.gridSnap.set(!!value),
            },
            {
              id: 'grid-snap-size',
              label: 'Snap spacing',
              description: 'Grid cell size in canvas pixels used when snapping and rendering the dot grid.',
              keywords: ['snap', 'size', 'spacing', 'grid', 'dots'],
              control: { type: 'number', min: 8, max: 64, step: 4, suffix: 'px' },
              get: () => this.settings.gridSnapSize(),
              set: value => this.settings.gridSnapSize.set(this.clampNumber(value, 8, 64, 24)),
            },
          ],
        },
        {
          id: 'navigation',
          label: 'Navigation',
          settings: [
            {
              id: 'minimap-visible',
              label: 'Show minimap',
              description: 'Display the canvas overview minimap.',
              keywords: ['minimap', 'overview'],
              control: { type: 'toggle' },
              get: () => this.canvas.minimapVisible(),
              set: value => this.canvas.minimapVisible.set(!!value),
            },
            {
              id: 'zoom-sensitivity',
              label: 'Zoom sensitivity',
              description: 'How fast the mouse wheel zooms the canvas.',
              keywords: ['zoom', 'wheel', 'scroll', 'speed'],
              control: { type: 'slider', min: 0.25, max: 3, step: 0.25 },
              get: () => this.settings.zoomSensitivity(),
              set: value => this.settings.zoomSensitivity.set(this.clampNumber(value, 0.25, 3, 1)),
            },
          ],
        },
      ],
    },
    {
      id: 'models',
      label: 'Models',
      icon: 'ti ti-sparkles',
      description: 'Default model for agents and local model server.',
      sections: [
        {
          id: 'default-model',
          label: 'Default model',
          note: 'Agents without an explicit model inherit this at run time.',
          settings: [],
          customTemplate: 'default-model',
          keywords: ['model', 'provider', 'default', 'llm', 'temperature'],
        },
        {
          id: 'ollama',
          label: 'Ollama',
          // Shown only when Ollama is the chosen application default provider.
          visible: () => this.settings.defaultProvider() === 'ollama',
          settings: [
            {
              id: 'ollama-base-url',
              label: 'Ollama server URL',
              description: 'Base URL of the local Ollama server (no API key required).',
              keywords: ['ollama', 'local', 'url', 'server'],
              control: { type: 'text', placeholder: 'http://localhost:11434' },
              get: () => this.settings.ollamaBaseUrl(),
              set: value => this.settings.setOllamaBaseUrl(String(value ?? '')),
            },
          ],
        },
        {
          id: 'bedrock',
          label: 'Amazon Bedrock',
          // Shown only when Amazon Bedrock is the chosen application default.
          visible: () => this.settings.defaultProvider() === 'bedrock',
          settings: [
            {
              id: 'bedrock-region',
              label: 'Default AWS region',
              description:
                'Region used for Bedrock agents that don’t set their own. Individual agents can override this, so a workflow can mix models from different regions. Set your Bedrock API key under API Keys.',
              keywords: ['bedrock', 'aws', 'amazon', 'region', 'endpoint'],
              control: {
                type: 'select',
                options: BEDROCK_REGIONS.map(region => ({ value: region, label: region })),
              },
              get: () => this.settings.bedrockRegion(),
              set: value => this.settings.setBedrockRegion(String(value ?? '')),
            },
          ],
        },
      ],
    },
    {
      id: 'api-keys',
      label: 'API Keys',
      icon: 'ti ti-key',
      description: 'Provider credentials, stored securely.',
      sections: [
        {
          id: 'provider-keys',
          settings: [],
          customTemplate: 'api-keys',
          keywords: ['api', 'key', 'anthropic', 'openai', 'gemini', 'openrouter', 'credentials'],
        },
      ],
    },
    {
      id: 'integrations',
      label: 'Integrations',
      icon: 'ti ti-plug-connected',
      description: 'Default credentials for MCP integrations like the email reader.',
      sections: [
        {
          id: 'mcp-presets',
          settings: [],
          customTemplate: 'integrations',
          keywords: ['email', 'imap', 'mcp', 'reader', 'inbox', 'credentials', 'integration'],
        },
      ],
    },
    {
      id: 'cloud',
      label: 'Cloud',
      icon: 'ti ti-cloud',
      description: 'Where your agents run when deployed.',
      sections: [
        {
          id: 'cloud-provider',
          settings: [],
          customTemplate: 'cloud-provider',
          keywords: [
            'cloud', 'phorma', 'cloudflare', 'hosted', 'deploy', 'worker',
            'wrangler', 'subscription', 'token', 'monitor',
          ],
        },
      ],
    },
    {
      id: 'updates',
      label: 'Updates',
      icon: 'ti ti-refresh',
      description: 'Automatic app updates.',
      sections: [
        {
          id: 'auto-update',
          label: 'Automatic updates',
          settings: [
            {
              id: 'auto-update-toggle',
              label: 'Download updates automatically',
              description: 'Download and stage new versions in the background. A restart prompt appears when ready.',
              keywords: ['update', 'auto', 'download', 'background', 'automatic'],
              control: { type: 'toggle' },
              get: () => this.settings.autoUpdate(),
              set: value => this.settings.autoUpdate.set(!!value),
            },
          ],
        },
      ],
    },
    {
      id: 'execution',
      label: 'Execution',
      icon: 'ti ti-player-play',
      description: 'Run behaviour and engine limits.',
      sections: [
        {
          id: 'runs',
          label: 'Runs',
          settings: [
            {
              id: 'auto-open-console',
              label: 'Open console on run',
              description: 'Automatically open the console dock when a run starts.',
              keywords: ['console', 'terminal', 'dock', 'run'],
              control: { type: 'toggle' },
              get: () => this.settings.autoOpenConsoleOnRun(),
              set: value => this.settings.autoOpenConsoleOnRun.set(!!value),
            },
            {
              id: 'max-tool-rounds',
              label: 'Max tool rounds',
              description: 'Maximum tool-call rounds per agent turn before the engine stops looping.',
              keywords: ['tools', 'rounds', 'loop', 'limit', 'budget'],
              control: { type: 'number', min: 1, max: 32, step: 1 },
              get: () => this.settings.maxToolRounds(),
              set: value => this.settings.maxToolRounds.set(this.clampNumber(value, 1, 32, 8)),
            },
          ],
        },
      ],
    },
  ];

  /** Finds a page by id (falls back to the first page). */
  page(id: string): SettingsPageDef {
    return this.pages.find(page => page.id === id) ?? this.pages[0];
  }

  /**
   * Returns the ids of pages with at least one section or setting matching
   * the query (label, description, keywords). Empty query matches all.
   */
  matchingPageIds(query: string): ReadonlySet<string> {
    const needle = query.trim().toLowerCase();
    if (!needle) return new Set(this.pages.map(page => page.id));
    const matches = new Set<string>();
    for (const page of this.pages) {
      if (this.textMatches(needle, page.label, page.description)) {
        matches.add(page.id);
        continue;
      }
      for (const section of page.sections) {
        if (this.sectionMatches(needle, section)) {
          matches.add(page.id);
          break;
        }
      }
    }
    return matches;
  }

  /** Whether a section matches the (lowercased) search needle. */
  sectionMatches(needle: string, section: SettingsSectionDef): boolean {
    if (this.textMatches(needle, section.label, section.note, ...(section.keywords ?? []))) {
      return true;
    }
    return section.settings.some(setting =>
      this.textMatches(needle, setting.label, setting.description, ...(setting.keywords ?? [])),
    );
  }

  private textMatches(needle: string, ...haystacks: (string | undefined)[]): boolean {
    return haystacks.some(text => text?.toLowerCase().includes(needle));
  }

  private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }
}
