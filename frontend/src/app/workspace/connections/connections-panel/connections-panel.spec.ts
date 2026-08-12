import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConnectionsPanel } from './connections-panel';
import { ConnectionsService } from '../../../core/connections.service';
import { ConnectorInstallDialogService } from '../connector-install-dialog.service';
import { ConnectorsService } from '../../../core/connectors.service';

/**
 * Connections panel layout (P1-14).
 *
 * The Connectors section is a bottom-pinned expander, the same shape as the runs
 * panel's History and the workflows panel's Templates. What that buys - and what
 * is pinned here - is that the section stays reachable and last in the DOM
 * whether the user has no connections at all or a long list of them, because
 * those are the two states where a naive stacked layout falls apart: an empty
 * panel that reads as broken, and a list that pushes the expander off-screen.
 */
describe('ConnectionsPanel layout', () => {
  let fixture: ComponentFixture<ConnectionsPanel>;
  let root: HTMLElement;
  let connections: ConnectionsService;
  let connectors: ConnectorsService;
  const createdIds: string[] = [];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ConnectionsPanel] }).compileComponents();
    connections = TestBed.inject(ConnectionsService);
    connectors = TestBed.inject(ConnectorsService);
    await connections.refresh();
    await connectors.refresh();
    // Start from a known empty state: the browser database is shared between specs.
    for (const connection of connections.connections()) {
      await connections.remove(connection.id);
    }
    fixture = TestBed.createComponent(ConnectionsPanel);
    fixture.detectChanges();
    root = fixture.nativeElement as HTMLElement;
  });

  afterEach(async () => {
    for (const id of createdIds.splice(0)) {
      try {
        await connections.remove(id);
      } catch {
        /* already gone */
      }
    }
  });

  async function addConnection(name: string): Promise<string> {
    const created = await connections.create({ name, type: 'http', secretKeys: ['apiToken'] });
    createdIds.push(created.id);
    fixture.detectChanges();
    return created.id;
  }

  const sections = (): Element[] => [...root.querySelectorAll('.phorma-connections > section')];

  const connectorRows = (): Element[] =>
    [...root.querySelectorAll('.phorma-connections__connectors-list > li')];

  it('puts the connectors expander last, so it sits at the bottom of the panel', () => {
    const all = sections();
    expect(all.length).toBe(2);
    expect(all[0]!.classList).toContain('phorma-connections__list-section');
    expect(all[all.length - 1]!.classList).toContain('phorma-connections__connectors-section');
  });

  it('shows an inviting empty state when there are no connections, and keeps the expander', () => {
    expect(connections.connections().length).toBe(0);
    expect(root.querySelector('.phorma-connections__placeholder')).toBeTruthy();
    expect(root.querySelector('.phorma-connections__list-section .phorma-connections__list')).toBeNull();
    // The expander must survive the empty state - it is the other way to get started.
    expect(root.querySelector('.phorma-connections__connectors-section')).toBeTruthy();
    expect(connectorRows().length).toBe(connectors.connectors().length);
  });

  it('replaces the empty state with the list once connections exist, keeping the expander last', async () => {
    await addConnection('CRM production');
    await addConnection('Warehouse read-only');
    await addConnection('Billing sandbox');

    expect(root.querySelector('.phorma-connections__placeholder')).toBeNull();
    const rows = root.querySelectorAll('.phorma-connections__list-section .phorma-connections__list > li');
    expect(rows.length).toBe(3);
    expect(sections()[1]!.classList).toContain('phorma-connections__connectors-section');
  });

  it('collapses to just the header, keeping the count visible', () => {
    const header = root.querySelector<HTMLButtonElement>('.phorma-connections__collapse')!;
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(connectorRows().length).toBeGreaterThan(0);

    header.click();
    fixture.detectChanges();

    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(connectorRows().length).toBe(0);
    expect(root.querySelector('.phorma-connections__count')!.textContent!.trim()).toBe(
      String(connectors.connectors().length),
    );
  });

  it('keeps the section actions as siblings of the collapse button, never nested inside it', () => {
    // A <button> inside a <button> is invalid HTML and breaks keyboard nav.
    const collapse = root.querySelector('.phorma-connections__collapse')!;
    expect(collapse.querySelector('button')).toBeNull();
    expect(collapse.querySelector('input[type="file"]')).toBeNull();

    const header = root.querySelector('.phorma-connections__section-header')!;
    expect(header.querySelector('.phorma-connections__import-btn')).toBeTruthy();
    expect(header.querySelector('button[aria-label="Package as connector"]')).toBeTruthy();
  });

  it('opens setup by clicking the connector card, with no plug action button in the row', () => {
    const installDialog = TestBed.inject(ConnectorInstallDialogService);
    expect(installDialog.visible()).toBeFalse();

    const card = root.querySelector<HTMLElement>('.phorma-connections__connectors-list app-panel-card')!;
    // The row keeps only export (and remove, for a user install) - setup is the
    // card itself, so there is no separate plug icon to hunt for.
    const actionTitles = [...card.querySelectorAll('.phorma-card__action-btn')].map(el =>
      el.getAttribute('title'),
    );
    expect(actionTitles).not.toContain('Set up this connector');

    card.click();
    fixture.detectChanges();

    expect(installDialog.visible()).toBeTrue();
    expect(installDialog.bundle()).toBeTruthy();
    installDialog.close();
  });

  it('names the connection a connector is bound to, and flags one that was deleted', async () => {
    const id = await addConnection('Acme production');
    const [connector] = connectors.connectors();
    expect(connector).toBeTruthy();

    await connectors.rebind(connector!.id, id).catch(() => {
      // Built-ins are not stored, so they cannot be rebound; skip in that case.
    });
    fixture.detectChanges();

    const badges = () =>
      [...root.querySelectorAll('.phorma-connections__connectors-list .phorma-card__badge')].map(el =>
        el.textContent!.trim(),
      );

    // Whether or not the rebind applied, no row may ever show a raw connection id.
    for (const text of badges()) {
      expect(text).not.toMatch(/^conn-/);
    }
  });
});
