/**
 * Rendering examples for the First_Run_Notice (1.2).
 *
 * What 1.2 asks for is three things in one card: the categories of data
 * collected, a control that opens the Privacy_Settings_Section, and a link to the
 * privacy policy. The category count is read off `COUNTER_CATALOG`, so the
 * headline number cannot drift from what the code counts.
 *
 * The fourth assertion is a negative one the design is explicit about: the notice
 * must NOT carry `role="dialog"`. The app's global key handlers probe for that
 * attribute to decide whether an overlay owns Escape, so claiming to be a dialog
 * here would let an unrequested disclosure swallow the canvas shortcut.
 *
 * Storage and the network are substituted through `TELEMETRY_TEST_SEAM`, and
 * `dismissNotice` is spied, so nothing here persists or uploads anything.
 */

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { McpOAuthService } from '../../../core/mcp-oauth.service';
import { COUNTER_CATALOG } from '../../../core/telemetry-catalog';
import type { TelemetryStorageBackend } from '../../../core/telemetry-storage';
import { TELEMETRY_TEST_SEAM, TelemetryService } from '../../../core/telemetry.service';
import { TauriService } from '../../../core/tauri.service';
import { SettingsDialogService } from '../settings-dialog.service';
import { PRIVACY_POLICY_URL } from './privacy-settings';
import { TelemetryNotice } from './telemetry-notice';

/** `Map`-backed storage, so the real `localStorage` is never touched. */
class FakeStorage implements TelemetryStorageBackend {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

/** Collapses template whitespace so copy can be matched as one line. */
function text(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The button whose visible label contains `label`. */
function buttonLabelled(root: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    text(button).includes(label),
  );
}

describe('TelemetryNotice rendering', () => {
  let fixture: ComponentFixture<TelemetryNotice>;
  let root: HTMLElement;
  let telemetry: TelemetryService;
  let settingsDialog: SettingsDialogService;
  let dismiss: jasmine.Spy;
  let openSettings: jasmine.Spy;
  let openExternal: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        {
          provide: TauriService,
          useValue: { isDesktop: false, osVersion: () => Promise.resolve('test-os 1.0') },
        },
      ],
    });

    telemetry = TestBed.inject(TelemetryService);
    telemetry[TELEMETRY_TEST_SEAM]({
      fetch: () => Promise.reject(new Error('the notice must not upload anything')),
      scheduleIdle: () => undefined,
      setTimer: () => 0,
      storageBackend: new FakeStorage(),
    });
    dismiss = spyOn(telemetry, 'dismissNotice');

    settingsDialog = TestBed.inject(SettingsDialogService);
    openSettings = spyOn(settingsDialog, 'open');
    openExternal = spyOn(TestBed.inject(McpOAuthService), 'openExternal').and.resolveTo();

    fixture = TestBed.createComponent(TelemetryNotice);
    fixture.detectChanges();
    root = fixture.nativeElement as HTMLElement;
  });

  it('states the categories of data collected, counting them from the catalog', () => {
    const body = text(root.querySelector('.phorma-tnotice__text'));

    // The headline number is the catalog size, so the disclosure cannot claim to
    // count fewer things than the code does.
    expect(body).toContain(`${COUNTER_CATALOG.size} of them`);

    // The Client_Environment categories, named in plain language.
    for (const category of ['app version', 'platform', 'locale', 'timezone']) {
      expect(body).toContain(category);
    }

    // And the exclusions, which are the half of the disclosure that reassures.
    for (const excluded of ['prompts', 'workflows', 'data', 'credentials']) {
      expect(body).toContain(excluded);
    }

    expect(text(root.querySelector('.phorma-tnotice__title'))).toContain(
      'Anonymous usage counters are on',
    );
  });

  it('carries a control that opens the Privacy settings page', () => {
    const button = buttonLabelled(root, 'Privacy settings');
    expect(button).toBeTruthy();

    button?.click();

    expect(openSettings).toHaveBeenCalledOnceWith('privacy');
    // The user is being handed the full detail, so the card gets out of the way.
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('carries the privacy policy link', () => {
    const button = buttonLabelled(root, 'Privacy policy');
    expect(button).toBeTruthy();
    expect(button?.querySelector('i.ti-external-link')).toBeTruthy();

    button?.click();

    expect(openExternal).toHaveBeenCalledOnceWith(PRIVACY_POLICY_URL);
  });

  it('dismisses through the service, and only through it', () => {
    const button = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss the privacy notice"]',
    );
    expect(button).toBeTruthy();
    expect(button?.querySelector('i.ti-x')).toBeTruthy();

    button?.click();

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('is not a dialog', () => {
    // No focus trap to install and no Escape to claim: the card announces itself
    // and stays out of the way.
    expect(root.querySelectorAll('[role="dialog"]').length).toBe(0);
    expect(root.querySelector('.phorma-tnotice')?.getAttribute('role')).toBe('status');
  });

  it('uses Tabler icons only', () => {
    const icons = [...root.querySelectorAll('i')];
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.classList).toContain('ti');
      expect(icon.className).not.toContain('pi-');
    }
  });
});
