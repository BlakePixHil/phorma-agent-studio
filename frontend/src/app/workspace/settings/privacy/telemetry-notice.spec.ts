/**
 * Rendering examples for the First_Run_Notice (1.2).
 *
 * What 1.2 asks for is three things in one card: that collection is disclosed, a
 * control that opens the Privacy_Settings_Section, and a link to the privacy
 * policy. The card deliberately carries NO numbers - the full accounting is
 * derived from `COUNTER_CATALOG` on the Privacy page, and a count restated here
 * would be a second place for one fact to go stale. The spec asserts that
 * absence, so the copy cannot drift back.
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

  it('discloses anonymous collection, the exclusions, and where to configure it', () => {
    const body = text(root.querySelector('.phorma-tnotice__text'));

    // What it is, in the words a first-run card can afford.
    expect(body).toContain('anonymous');

    // The exclusions, which are the half of the disclosure that reassures.
    for (const excluded of ['prompts', 'workflows', 'data', 'credentials']) {
      expect(body).toContain(excluded);
    }

    // And the signpost. The card does not enumerate; it points at the page that
    // derives the full list from the catalog.
    expect(body).toContain('Privacy settings');

    // No numbers. A count here reads as a specification the reader is expected
    // to audit, and it duplicates a fact that already has one home.
    expect(body).not.toMatch(/\d/);

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
