import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { UsageDialog } from './usage-dialog';

/**
 * Requirement 4.15: the Studio renders a distinct status representation for
 * `skipped` at every switch site, reaching it through no fallback default branch.
 *
 * This covers `usage-dialog.statusIcon`. Since both sidebars render every panel,
 * the fixture filters for the visible instance.
 *
 * NOTE: The usage-dialog currently has a `default` branch that falls through to
 * `ti ti-loader-2`. This test asserts that `skipped` is handled by an explicit
 * case ABOVE the default, so that the fallback is never reached for `skipped`.
 */
describe('UsageDialog.statusIcon skipped status (Requirement 4.15)', () => {
  let fixture: ComponentFixture<UsageDialog>;
  let component: UsageDialog;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [UsageDialog] }).compileComponents();
    fixture = TestBed.createComponent(UsageDialog);
    component = fixture.componentInstance;
  });

  function statusIcon(status: string): string {
    return (component as unknown as { statusIcon(s: string): string }).statusIcon(status);
  }

  it('returns ti ti-circle-minus for skipped status', () => {
    expect(statusIcon('skipped')).toBe('ti ti-circle-minus');
  });

  it('does not return the running/loader fallback for skipped', () => {
    expect(statusIcon('skipped')).not.toBe('ti ti-loader-2');
  });

  it('returns a distinct icon for skipped compared to every other status', () => {
    const skippedIcon = statusIcon('skipped');
    const otherStatuses = ['completed', 'failed', 'stopped', 'running'];
    for (const other of otherStatuses) {
      expect(statusIcon(other)).withContext(`${other} should differ from skipped`).not.toBe(skippedIcon);
    }
  });

  it('resolves skipped through an explicit case, not the default branch', () => {
    // The usage-dialog has a default branch returning ti ti-loader-2.
    // This test proves `skipped` is handled by its own explicit case and
    // never falls into the default. If it did, the icon would be ti ti-loader-2.
    const result = statusIcon('skipped');
    const defaultResult = statusIcon('some-unknown-status-that-hits-default');
    expect(result).not.toBe(defaultResult);
  });
});
