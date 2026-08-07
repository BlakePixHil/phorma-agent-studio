import { TestBed } from '@angular/core/testing';

import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';

/**
 * MCP secret "configured" flags must survive concurrent refreshes.
 *
 * `GraphCanvas.mcpCredentialRefresher` fires `refreshMcpSecretFlags` (node
 * scope) AND `refreshPresetSecretFlags` (preset scope) for every MCP node in
 * one synchronous block, unawaited. The Settings dialog fires one per preset.
 * So several refreshes are always in flight at once, each awaiting its own
 * `has_secret` IPC round-trips.
 *
 * The reported symptom of getting this wrong is severe and entirely
 * misleading: a credential that IS in the keychain reads back as missing on
 * every app start, because the last refresh to resolve overwrites the whole
 * flag map with a snapshot it took before the others had written theirs. The
 * user re-enters the credential (a single, uncontended refresh), it appears to
 * save, and it "vanishes" again next launch.
 */
describe('SettingsService MCP secret flags', () => {
  let settings: SettingsService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    settings = TestBed.inject(SettingsService);
    localStorage.removeItem('phorma.mcp-secrets');
  });

  afterEach(() => {
    localStorage.removeItem('phorma.mcp-secrets');
  });

  /**
   * Stubs the keychain-presence check with a per-key delay, standing in for the
   * desktop `has_secret` IPC round-trip. The delays are what expose a
   * lost-update bug: without them every refresh resolves in one microtask and
   * the interleaving that loses flags never happens.
   */
  function stubPresence(present: Record<string, boolean>, delays: Record<string, number> = {}) {
    return spyOn(
      settings as unknown as {
        hasMcpSecret: (scope: unknown, envKey: string) => Promise<boolean>;
      },
      'hasMcpSecret',
    ).and.callFake(async (scope: unknown, envKey: string) => {
      const flagKey =
        typeof scope === 'object' && scope !== null && 'node' in scope
          ? `${(scope as { node: string }).node}:${envKey}`
          : `preset:${(scope as { preset: string }).preset}:${envKey}`;
      await new Promise(resolve => setTimeout(resolve, delays[flagKey] ?? 0));
      return present[flagKey] ?? false;
    });
  }

  it('keeps node-scoped and preset-scoped flags for the same env key', async () => {
    // The node override is unset; the app-default (preset) credential IS set.
    // The node-scope refresh deliberately resolves LAST.
    stubPresence(
      { 'preset:email:EMAIL_CREDENTIALS': true, 'node-email-1:EMAIL_CREDENTIALS': false },
      { 'node-email-1:EMAIL_CREDENTIALS': 20, 'preset:email:EMAIL_CREDENTIALS': 5 },
    );

    // Exactly what the canvas effect does for one preset-backed MCP node.
    await Promise.all([
      settings.refreshMcpSecretFlags('node-email-1', ['EMAIL_CREDENTIALS']),
      settings.refreshPresetSecretFlags('email', ['EMAIL_CREDENTIALS']),
    ]);

    const flags = settings.mcpSecretsConfigured();
    expect(flags['preset:email:EMAIL_CREDENTIALS'])
      .withContext('the preset-scoped flag a concurrent node-scope refresh must not clobber')
      .toBeTrue();
    expect(flags['node-email-1:EMAIL_CREDENTIALS']).toBeFalse();
  });

  it('keeps flags from many concurrent refreshes across different presets', async () => {
    stubPresence(
      {
        'preset:email:EMAIL_CREDENTIALS': true,
        'preset:jira:JIRA_API_TOKEN': true,
        'preset:jira:JIRA_URL': true,
      },
      {
        'preset:email:EMAIL_CREDENTIALS': 5,
        'preset:jira:JIRA_URL': 15,
        'preset:slack:SLACK_BOT_TOKEN': 25,
      },
    );

    // The Settings → Integrations page opening: one refresh per preset.
    await Promise.all([
      settings.refreshPresetSecretFlags('email', ['EMAIL_CREDENTIALS']),
      settings.refreshPresetSecretFlags('jira', ['JIRA_URL', 'JIRA_API_TOKEN']),
      settings.refreshPresetSecretFlags('slack', ['SLACK_BOT_TOKEN']),
    ]);

    const flags = settings.mcpSecretsConfigured();
    expect(flags['preset:email:EMAIL_CREDENTIALS']).toBeTrue();
    expect(flags['preset:jira:JIRA_API_TOKEN']).toBeTrue();
    expect(flags['preset:jira:JIRA_URL']).toBeTrue();
    expect(flags['preset:slack:SLACK_BOT_TOKEN']).toBeFalse();
  });

  it('reflects a cleared secret without dropping unrelated flags', async () => {
    await settings.setPresetSecret('email', 'EMAIL_CREDENTIALS', 'you@example.com:pw');
    await settings.setPresetSecret('jira', 'JIRA_API_TOKEN', 'ATATT-token');
    expect(settings.mcpSecretsConfigured()['preset:email:EMAIL_CREDENTIALS']).toBeTrue();

    await settings.setPresetSecret('email', 'EMAIL_CREDENTIALS', '');

    const flags = settings.mcpSecretsConfigured();
    expect(flags['preset:email:EMAIL_CREDENTIALS']).toBeFalse();
    expect(flags['preset:jira:JIRA_API_TOKEN'])
      .withContext('clearing one secret must not disturb another')
      .toBeTrue();
  });
});
