import { ComponentFixture, TestBed } from '@angular/core/testing';

import type { ConnectorBundle } from '@phorma/engine';

import { ConnectorInstallDialog } from './connector-install-dialog';
import { ConnectorInstallDialogService } from '../connector-install-dialog.service';

/**
 * Install dialog chrome (P1-14).
 *
 * Two regressions are pinned here, both reported against the SQL connector's
 * install form because it is the tallest one:
 *
 * 1. The footer buttons overlapped the form. Cause: the CARD scrolled, so the
 *    body (a flex item with `min-height: 0` and the default `flex-shrink: 1`)
 *    was squeezed while its content spilled out visibly and painted over the
 *    footer. The body scrolls now and the footer is pinned.
 * 2. The header carried a big glyph to the left of the title. Gone, here and in
 *    every other modal.
 */
describe('ConnectorInstallDialog chrome', () => {
  let fixture: ComponentFixture<ConnectorInstallDialog>;
  let root: HTMLElement;
  let dialog: ConnectorInstallDialogService;

  /** A bundle with enough config fields to make the form taller than the card. */
  const bundle: ConnectorBundle = {
    format: 1,
    id: 'cx-spec-tall',
    name: 'SQL reporting database',
    description: 'Read-only reporting queries.',
    version: '1.0.0',
    author: 'Phorma',
    icon: 'ti ti-database-search',
    connection: {
      type: 'sql',
      configFields: [
        { name: 'driver', label: 'Driver', required: true, default: 'postgres' },
        { name: 'host', label: 'Host', required: true },
        { name: 'port', label: 'Port', default: '5432' },
        { name: 'database', label: 'Database', required: true },
        { name: 'user', label: 'User', required: true },
      ],
      secretFields: [{ name: 'password', label: 'Password' }],
      auth: { mode: 'none' },
    },
    steps: [
      { id: 'totals', label: 'Totals', kind: 'sql-query', data: { statement: 'select 1' } },
    ],
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ConnectorInstallDialog] }).compileComponents();
    dialog = TestBed.inject(ConnectorInstallDialogService);
    fixture = TestBed.createComponent(ConnectorInstallDialog);
    fixture.detectChanges();
    dialog.open(bundle, { fileName: 'sql.connector.json' });
    fixture.detectChanges();
    root = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => dialog.close());

  it('renders no icon to the left of the heading', () => {
    const header = root.querySelector('.phorma-cx-install__header')!;
    expect(header.querySelector('i')).toBeNull();
    expect(header.querySelector('h2')!.textContent!.trim()).toBe('SQL reporting database');
  });

  /**
   * THE decisive assertion. Verified to fail against the old CSS (card
   * `overflow-y: auto`, body with no overflow of its own): the difference
   * between "content is clipped and scrolls" and "content spills out and paints
   * over the footer" is the overflow declaration, not any measurement - a
   * spilled element and a scrolled-out-of-view element have the same rect.
   */
  it('scrolls the body, not the card, so content cannot spill over the footer', () => {
    const card = root.querySelector<HTMLElement>('.phorma-cx-install__card')!;
    const body = root.querySelector<HTMLElement>('.phorma-cx-install__body')!;

    expect(getComputedStyle(card).overflowY).toBe('hidden');
    expect(getComputedStyle(body).overflowY).toBe('auto');
  });

  it('clips a form taller than the card into the scrolling body, footer below it', () => {
    const card = root.querySelector<HTMLElement>('.phorma-cx-install__card')!;
    const body = root.querySelector<HTMLElement>('.phorma-cx-install__body')!;
    const footer = root.querySelector<HTMLElement>('.phorma-cx-install__footer')!;

    // Force the condition the bug needed - a card shorter than its content -
    // since the karma viewport is tall enough that this form otherwise fits.
    card.style.maxHeight = '320px';

    const bodyRect = body.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();

    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(footerRect.top).toBeGreaterThanOrEqual(bodyRect.bottom - 1);
    expect(footerRect.height).toBeGreaterThan(0);
  });

  it('keeps the install action reachable without scrolling to the end of the form', () => {
    const card = root.querySelector<HTMLElement>('.phorma-cx-install__card')!;
    const footer = root.querySelector<HTMLElement>('.phorma-cx-install__footer')!;
    const cardRect = card.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();

    expect(footerRect.bottom).toBeLessThanOrEqual(cardRect.bottom + 1);
  });
});
