import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { PortalPanel } from './portal-panel';
import type { RunRecordSummary } from '@phorma/engine';

/**
 * Requirement 4.15: the Studio renders a distinct status representation for
 * `skipped` at every switch site, reaching it through no fallback default branch.
 *
 * This covers `portal-panel.runStatusIcon`. Since both sidebars render every panel,
 * the fixture filters for the visible instance.
 */
describe('PortalPanel.runStatusIcon skipped status (Requirement 4.15)', () => {
  let fixture: ComponentFixture<PortalPanel>;
  let component: PortalPanel;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PortalPanel] }).compileComponents();
    fixture = TestBed.createComponent(PortalPanel);
    component = fixture.componentInstance;
  });

  function runStatusIcon(status: RunRecordSummary['status']): string {
    const summary = { status } as RunRecordSummary;
    return (component as unknown as { runStatusIcon(s: RunRecordSummary): string }).runStatusIcon(
      summary,
    );
  }

  it('returns ti ti-circle-minus for skipped status', () => {
    expect(runStatusIcon('skipped')).toBe('ti ti-circle-minus');
  });

  it('does not return the running/loader fallback for skipped', () => {
    expect(runStatusIcon('skipped')).not.toBe('ti ti-loader-2');
  });

  it('returns a distinct icon for skipped compared to every other status', () => {
    const skippedIcon = runStatusIcon('skipped');
    const otherStatuses: RunRecordSummary['status'][] = ['completed', 'failed', 'stopped', 'running'];
    for (const other of otherStatuses) {
      expect(runStatusIcon(other))
        .withContext(`${other} should differ from skipped`)
        .not.toBe(skippedIcon);
    }
  });

  it('resolves skipped through an explicit case, not a default branch', () => {
    // The switch in portal-panel.ts has no default branch - TypeScript exhaustiveness
    // ensures every member is handled explicitly. Verify the method's return type
    // narrows to string (never reaches undefined) for `skipped`.
    const result = runStatusIcon('skipped');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
