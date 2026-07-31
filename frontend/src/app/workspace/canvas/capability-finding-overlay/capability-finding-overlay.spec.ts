import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { CapabilityFindingOverlay } from './capability-finding-overlay';
import type { CapabilityFinding } from '@phorma/engine';

/**
 * Requirement 17.8: when a node carries a capability finding, the Studio
 * shows that finding inline on the node and leaves every node editing
 * action available. `properties-form.spec.ts` covers the properties-panel
 * half of this requirement; this covers the canvas badge/popover half —
 * the overlay renders every finding's message, colours itself by the worst
 * severity present, and never disables anything (there is nothing on this
 * overlay TO disable — it is a read-only badge, which is itself part of the
 * "editing action available" guarantee).
 */
describe('CapabilityFindingOverlay (Requirement 17.8)', () => {
  let fixture: ComponentFixture<CapabilityFindingOverlay>;

  function render(findings: CapabilityFinding[]): void {
    fixture = TestBed.createComponent(CapabilityFindingOverlay);
    fixture.componentRef.setInput('nodeId', 'node-1');
    fixture.componentRef.setInput('findings', findings);
    fixture.detectChanges();
  }

  it('renders a red badge and every finding message when any finding is severity error', () => {
    render([
      { severity: 'warning', message: 'Non-static url — egress not declared.' },
      { severity: 'error', message: 'Connection "conn-does-not-exist" is unknown to this host.' },
    ]);

    const root = fixture.nativeElement as HTMLElement;
    const badge = root.querySelector<HTMLButtonElement>('.phorma-cap-badge')!;
    expect(badge).toBeTruthy();
    expect(badge.classList).not.toContain('phorma-cap-badge--warning');

    badge.click();
    fixture.detectChanges();

    const items = Array.from(root.querySelectorAll('.phorma-cap-popover__list li')).map(el =>
      el.textContent?.trim(),
    );
    expect(items).toContain('Non-static url — egress not declared.');
    expect(items).toContain('Connection "conn-does-not-exist" is unknown to this host.');
  });

  it('renders an amber badge when every finding is a warning', () => {
    render([{ severity: 'warning', message: 'Non-static url — egress not declared.' }]);

    const root = fixture.nativeElement as HTMLElement;
    const badge = root.querySelector<HTMLButtonElement>('.phorma-cap-badge')!;
    expect(badge.classList).toContain('phorma-cap-badge--warning');
  });

  it('never disables the badge — clicking always toggles the popover regardless of severity', () => {
    render([{ severity: 'error', message: 'Unsupported node kind "sql-query" on Browser preview.' }]);

    const root = fixture.nativeElement as HTMLElement;
    const badge = root.querySelector<HTMLButtonElement>('.phorma-cap-badge')!;
    expect(badge.disabled).toBeFalse();

    badge.click();
    fixture.detectChanges();
    expect(root.querySelector('.phorma-cap-popover')).toBeTruthy();

    badge.click();
    fixture.detectChanges();
    expect(root.querySelector('.phorma-cap-popover')).toBeNull();
  });
});
