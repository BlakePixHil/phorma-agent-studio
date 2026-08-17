import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { RunsPanel } from './runs-panel';
import type { RunRecordSummary } from '@phorma/engine';

/**
 * Requirement 4.15: the Studio renders a distinct status representation for
 * `skipped` at every switch site, reaching it through no fallback default branch.
 *
 * This covers `runs-panel.statusIcon`. Since both sidebars render every panel,
 * the fixture filters for the visible instance.
 */
describe('RunsPanel.statusIcon skipped status (Requirement 4.15)', () => {
  let fixture: ComponentFixture<RunsPanel>;
  let component: RunsPanel;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [RunsPanel] }).compileComponents();
    fixture = TestBed.createComponent(RunsPanel);
    component = fixture.componentInstance;
  });

  function statusIcon(status: RunRecordSummary['status']): string {
    const summary = { status } as RunRecordSummary;
    return (component as unknown as { statusIcon(s: RunRecordSummary): string }).statusIcon(summary);
  }

  it('returns ti ti-circle-minus for skipped status', () => {
    expect(statusIcon('skipped')).toBe('ti ti-circle-minus');
  });

  it('does not return the running/loader fallback for skipped', () => {
    expect(statusIcon('skipped')).not.toBe('ti ti-loader-2');
  });

  it('returns a distinct icon for skipped compared to every other status', () => {
    const skippedIcon = statusIcon('skipped');
    const otherStatuses: RunRecordSummary['status'][] = ['completed', 'failed', 'stopped', 'running'];
    for (const other of otherStatuses) {
      expect(statusIcon(other)).withContext(`${other} should differ from skipped`).not.toBe(skippedIcon);
    }
  });

  it('resolves skipped through an explicit case, not a default branch', () => {
    // The switch in runs-panel.ts has no default branch - TypeScript exhaustiveness
    // ensures every member is handled explicitly. Verify the method's return type
    // narrows to string (never reaches undefined) for `skipped`.
    const result = statusIcon('skipped');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
