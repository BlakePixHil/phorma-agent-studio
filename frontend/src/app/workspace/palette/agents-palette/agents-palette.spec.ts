import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AgentsPalette } from './agents-palette';

/**
 * The MCP preset list is rendered INSIDE the Tools group, which makes that
 * group's visibility load-bearing for every preset. Dropping it for having no
 * matching catalog entries hid all presets, so searching any server name
 * ("jira", "resend") returned "No nodes match your search" even though the
 * preset existed - the palette was the only way to find those servers.
 */
describe('AgentsPalette MCP grouping', () => {
  let fixture: ComponentFixture<AgentsPalette>;
  let root: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AgentsPalette] }).compileComponents();
    fixture = TestBed.createComponent(AgentsPalette);
    fixture.detectChanges();
    root = fixture.nativeElement as HTMLElement;
  });

  function search(query: string): void {
    const input = root.querySelector<HTMLInputElement>('.phorma-palette__search input')!;
    input.value = query;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  const headings = (): string[] =>
    [...root.querySelectorAll('.phorma-palette__heading')].map(el => el.textContent!.trim());

  /**
   * MCP sub-group headings only. Connector steps (P1-14) render their own
   * sub-headings in the Data group and carry a `--connector` modifier, so the
   * two families stay distinguishable here instead of one silently changing the
   * other's expectations.
   */
  const subheadings = (): string[] =>
    [
      ...root.querySelectorAll(
        '.phorma-palette__subheading:not(.phorma-palette__subheading--connector)',
      ),
    ].map(el => el.textContent!.trim());

  const connectorSubheadings = (): string[] =>
    [...root.querySelectorAll('.phorma-palette__subheading--connector')].map(el =>
      el.textContent!.trim(),
    );

  it('splits MCP presets into Remote, Sign-in (OAuth) and Local sub-groups, remote first', () => {
    // Deployability decides the order: Remote servers are cloud-deployable,
    // Sign-in (OAuth) servers are cloud-reachable but not deployable (the
    // signed-in session never leaves this device), Local needs a subprocess.
    expect(subheadings()).toEqual(['Remote MCP', 'Sign-in (OAuth) MCP', 'Local MCP']);
  });

  it('keeps the Tools group when only a preset matches the query', () => {
    search('resend');

    expect(headings()).toContain('Tools');
    expect(subheadings()).toEqual(['Remote MCP']);
    expect(root.querySelector('.phorma-palette__empty')).toBeNull();
  });

  it('shows both the OAuth remote and the local server for the same product', () => {
    search('jira');

    // Jira's remote server is OAuth-only - it is cloud-reachable, but not
    // cloud-deployable, so it groups with Sign-in (OAuth), not Remote.
    expect(subheadings()).toEqual(['Sign-in (OAuth) MCP', 'Local MCP']);
    const labels = [...root.querySelectorAll('.phorma-palette__label')].map(el =>
      el.textContent!.trim(),
    );
    expect(labels).toContain('Jira & Confluence (OAuth)');
    expect(labels).toContain('Jira');
  });

  it('marks each preset tile with a transport pip', () => {
    search('jira');

    const tiles = [...root.querySelectorAll('.phorma-palette__item')];
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.querySelector('.phorma-palette__transport-pip'))
        .withContext(tile.textContent?.trim())
        .toBeTruthy();
    }
  });

  it('still reports an empty state when nothing matches at all', () => {
    search('zzzznotathing');

    expect(headings()).toEqual([]);
    expect(connectorSubheadings()).toEqual([]);
    expect(root.querySelector('.phorma-palette__empty')).toBeTruthy();
  });

  /**
   * P1-14: connector steps hang off the Data group the way MCP presets hang off
   * Tools, and for the same reason - that group's visibility is load-bearing for
   * them. A search matching only a connector name must keep Data alive.
   */
  it('renders the built-in connectors as sub-groups of Data', () => {
    expect(connectorSubheadings().length).toBeGreaterThan(0);
    expect(headings()).toContain('Data');
  });

  it('keeps the Data group when only a connector step matches the query', () => {
    search('paginated');

    expect(headings()).toContain('Data');
    expect(connectorSubheadings().length).toBeGreaterThan(0);
    expect(root.querySelector('.phorma-palette__empty')).toBeNull();
  });
});
