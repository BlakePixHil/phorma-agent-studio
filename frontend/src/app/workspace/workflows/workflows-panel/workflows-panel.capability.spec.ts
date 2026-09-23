import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { WorkflowsPanel } from './workflows-panel';
import { CapabilityService } from '../../../core/capability.service';

/**
 * Requirement 9.1: a member (`operator` or `editor`) is PRESENTED the Cloud_Library,
 * and it replaces the local library rather than sitting beside it - a session with no
 * local data has nothing to show in a "Saved" list and cannot save into one.
 *
 * The level is driven through `CapabilityService.resolveFrom`, which is exactly why
 * that seam exists: the level does not come from Clerk, it is pushed in by whoever
 * holds the verified `/api/me` answer.
 */
describe('WorkflowsPanel Cloud_Library mode (Requirement 9.1)', () => {
  let fixture: ComponentFixture<WorkflowsPanel>;
  let capability: CapabilityService;

  function visible(selector: string): HTMLElement[] {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(selector)];
  }

  beforeEach(async () => {
    // `WorkflowService` persists the open-tab session, so this suite touches a
    // `phorma.layout.*` key that every later spec would otherwise inherit.
    localStorage.removeItem('phorma.layout.openWorkflows');
    await TestBed.configureTestingModule({
      imports: [WorkflowsPanel],
      providers: [provideRouter([])],
    }).compileComponents();
    capability = TestBed.inject(CapabilityService);
    fixture = TestBed.createComponent(WorkflowsPanel);
  });

  afterEach(() => localStorage.removeItem('phorma.layout.openWorkflows'));

  it('renders the local library for a builder', () => {
    capability.resolveFrom('builder');
    fixture.detectChanges();

    expect(visible('.phorma-workflows__saved-section').length).toBe(1);
    expect(visible('app-cloud-library').length).toBe(0);
  });

  it('replaces the local library with the Cloud_Library for a member', async () => {
    for (const level of ['operator', 'editor'] as const) {
      capability.resolveFrom(level);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      // The saved-library section and the template gallery, neither of which a
      // member can save into. The panel CONTAINER can still appear - the deferred
      // block's placeholder reuses it - so the sections are what the claim is about.
      expect(visible('.phorma-workflows__saved-section').length)
        .withContext(`${level} must not be offered the local library`)
        .toBe(0);
      expect(visible('.phorma-workflows__templates-section').length)
        .withContext(`${level} must not be offered the template gallery`)
        .toBe(0);
      expect(visible('app-cloud-library').length)
        .withContext(`${level} must be offered the Cloud_Library`)
        .toBe(1);
    }
  });
});
