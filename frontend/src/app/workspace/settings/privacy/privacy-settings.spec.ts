/**
 * Rendering examples for the Privacy_Settings_Section (1.4).
 *
 * The claim worth proving here is not that the section has a toggle - it is that
 * the "what is collected" copy is DERIVED from `telemetry-catalog.ts` and
 * `ENV_KEYS` rather than written out by hand. A hand-written list is the one way
 * this page can lie: the code starts counting something new and the disclosure
 * still describes the old set. So every assertion below computes its expectation
 * from `COUNTER_CATALOG` and `ENV_KEYS` and compares it against the DOM. Add a
 * counter family, a dimension, or an environment field and this spec expects the
 * rendered page to change with it, without anyone touching the template.
 *
 * Nothing real is involved. `TelemetryService` exposes `TELEMETRY_TEST_SEAM`
 * (see `core/telemetry.service.spec.ts`), so the clock, storage, `fetch` and both
 * schedulers are substituted: no `localStorage`, no network, no timer.
 */

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { COUNTER_CATALOG } from '../../../core/telemetry-catalog';
import { ENV_KEYS } from '../../../core/telemetry-core';
import type { TelemetryStorageBackend } from '../../../core/telemetry-storage';
import {
  TELEMETRY_TEST_SEAM,
  TelemetryService,
  type TelemetryHarness,
} from '../../../core/telemetry.service';
import { TauriService } from '../../../core/tauri.service';
import { PRIVACY_POLICY_URL, PrivacySettings } from './privacy-settings';

/** A fixed mid-day UTC instant, so the Metric_Day is deterministic. */
const NOW_MS = Date.UTC(2026, 4, 12, 9, 30, 0);

/** A well formed UUID v4 for the `randomUuid` seam. */
const INSTALL_ID = '00000000-0000-4000-8000-00000000beef';

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

/**
 * Every counter family the catalog actually contains, with how many names it
 * expands to, computed by taking each catalog name apart. This is the
 * independent statement of what the page must describe: it is derived from the
 * catalog SET rather than from the family declarations the component reads, so
 * the two would have to drift together to fool it.
 */
function catalogFamilies(): Map<string, number> {
  const families = new Map<string, number>();
  for (const name of COUNTER_CATALOG) {
    const separator = name.indexOf(':');
    const family = separator === -1 ? name : name.slice(0, separator);
    families.set(family, (families.get(family) ?? 0) + 1);
  }
  return families;
}

/** Collapses template whitespace so copy can be matched as one line. */
function text(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('PrivacySettings rendering', () => {
  let fixture: ComponentFixture<PrivacySettings>;
  let root: HTMLElement;
  let telemetry: TelemetryService;
  let harness: TelemetryHarness;
  let requests: string[];

  beforeEach(async () => {
    requests = [];
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
    harness = telemetry[TELEMETRY_TEST_SEAM]({
      now: () => NOW_MS,
      fetch: (url) => {
        requests.push(url);
        return Promise.resolve({ status: 200 });
      },
      scheduleIdle: () => undefined,
      setTimer: () => 0,
      randomUuid: () => INSTALL_ID,
      storageBackend: new FakeStorage(),
    });
    // Initialize directly rather than through `bootstrap()`, so the section
    // renders against a resolved install id, environment and accumulator.
    await harness.initialize();

    fixture = TestBed.createComponent(PrivacySettings);
    root = fixture.nativeElement as HTMLElement;
    await settle();
  });

  /**
   * `ngModel` writes its initial value to the control on a microtask, so the
   * toggle's `checked` state is one turn behind the first render.
   */
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  afterEach(() => {
    // The seam kept every write in the fake, so there is nothing to clean up
    // except the assertion that telemetry never reached the network from here.
    expect(requests).toEqual([]);
  });

  const lists = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('dl.phorma-privacy__list')];

  const paragraphs = (): string[] =>
    [...root.querySelectorAll('.phorma-privacy__desc')].map((p) => text(p));

  it('renders the single consent toggle, bound to Consent_State', () => {
    const switches = root.querySelectorAll('p-toggleswitch');
    expect(switches.length).toBe(1);

    const input = root.querySelector<HTMLInputElement>('#privacy-telemetry-enabled');
    expect(input).toBeTruthy();
    expect(input?.type).toBe('checkbox');
    expect(input?.checked).toBe(telemetry.enabled());
    expect(telemetry.enabled()).toBeTrue();

    // The label is associated with the control, not just adjacent to it.
    const label = root.querySelector<HTMLLabelElement>('label[for="privacy-telemetry-enabled"]');
    expect(text(label)).toContain('Share anonymous usage counters');
  });

  it('renders the Install_Id the service minted, with copy and reset affordances', () => {
    const field = root.querySelector<HTMLInputElement>('input[aria-label="Install ID"]');
    expect(field).toBeTruthy();
    expect(field?.readOnly).toBeTrue();
    expect(field?.value).toBe(telemetry.installId());
    expect(field?.value).toBe(INSTALL_ID);

    expect(root.querySelector('.phorma-privacy__id-row i.ti-copy')).toBeTruthy();
    expect(root.querySelector('.phorma-privacy__id-row i.ti-refresh')).toBeTruthy();
  });

  it('derives the counter list from the Counter_Catalog rather than hard coding it', () => {
    const expected = catalogFamilies();
    const countersList = lists()[0];
    expect(countersList).toBeTruthy();

    const rows = [...(countersList?.querySelectorAll('.phorma-privacy__list-row') ?? [])];
    expect(rows.length).toBe(expected.size);

    // One row per family, each naming the family and how many catalog names it
    // covers, and each carrying plain-language copy beside the raw name.
    const rendered = new Map<string, number>();
    for (const row of rows) {
      const family = text(row.querySelector('dd code'));
      const countCopy = text(row.querySelector('.phorma-privacy__count'));
      const parsed = Number.parseInt(countCopy, 10);
      expect(countCopy).toMatch(/^\d+ counters?$/);
      expect(text(row.querySelector('dt')).length).toBeGreaterThan(0);
      rendered.set(family, parsed);
    }

    expect([...rendered.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [family, names] of expected) {
      expect(rendered.get(family)).toBe(names);
    }

    // The per-family counts account for the whole catalog, and the headline
    // total is the catalog size itself.
    const summed = [...rendered.values()].reduce((total, names) => total + names, 0);
    expect(summed).toBe(COUNTER_CATALOG.size);

    const total = paragraphs().find((copy) => copy.includes('counters in total'));
    expect(total).toBeDefined();
    expect(Number.parseInt(total ?? '', 10)).toBe(COUNTER_CATALOG.size);
  });

  it('derives the environment list from ENV_KEYS, in order', () => {
    const envList = lists()[1];
    expect(envList).toBeTruthy();

    const keys = [...(envList?.querySelectorAll('.phorma-privacy__list-row') ?? [])].map((row) => ({
      key: text(row.querySelector('dt code')),
      label: text(row.querySelector('dd')),
    }));

    expect(keys.map((entry) => entry.key)).toEqual([...ENV_KEYS]);
    for (const entry of keys) {
      expect(entry.label.length).toBeGreaterThan(0);
    }

    const copy = paragraphs().find((line) => line.includes('facts about this install'));
    expect(copy).toBeDefined();
    expect(copy).toContain(String(ENV_KEYS.length));
  });

  it('previews exactly the object the uploader would send, with the queue and rejection counts', () => {
    const preview = root.querySelector('pre.phorma-privacy__preview');
    expect(preview).toBeTruthy();

    const pending = telemetry.pendingRollup();
    expect(pending).not.toBeNull();
    // Parsed back rather than string-compared: the claim is that the preview IS
    // the pending Rollup (11.6), not that it is formatted a certain way.
    expect(JSON.parse(preview?.textContent ?? '')).toEqual(pending);

    const meta = text(root.querySelector('.phorma-privacy__meta'));
    expect(meta).toContain(`${telemetry.queueLength()} waiting to upload`);
    expect(meta).toContain(`${telemetry.rejectedCount()} rejected and dropped`);
  });

  it('renders the privacy policy reference', () => {
    expect(text(root)).toContain(PRIVACY_POLICY_URL);
    expect(root.querySelector('button[aria-label="Open the privacy policy"]')).toBeTruthy();
  });

  it('replaces the preview with an explanation once collection is off', async () => {
    telemetry.setEnabled(false);
    await settle();

    expect(root.querySelector('pre.phorma-privacy__preview')).toBeNull();
    expect(telemetry.pendingRollup()).toBeNull();
    // The info note about what is never collected stays; the pending-state note
    // is the one that changes.
    const pendingNote = root.querySelector('.phorma-privacy__note:not(.phorma-privacy__note--info)');
    expect(text(pendingNote)).toContain('Collection is off');

    const input = root.querySelector<HTMLInputElement>('#privacy-telemetry-enabled');
    expect(input?.checked).toBeFalse();
  });
});
