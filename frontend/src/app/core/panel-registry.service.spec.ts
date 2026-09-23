/**
 * Subtractive panel registration (Requirement 7.3).
 *
 * The claim that matters is not "a builder tab disappears for an operator" - it is
 * WHERE it disappears. The filter lives in the `leftTabs` / `rightTabs` computeds
 * and NOT in `_tabs`, because `loadTabs()` merges the saved side, order and
 * visibility onto `DEFAULT_TABS` and a constructor `effect` persists `_tabs`. Had
 * the filter dropped entries from `_tabs`, the next persist would delete them from
 * the user's saved layout, and a member later promoted to builder would find their
 * arrangement gone. So this suite asserts three things together each time: the tab
 * is absent from what the sidebar renders, PRESENT in the registry, and still in
 * localStorage - and that a promotion puts it back where the user left it.
 *
 * `PanelRegistryService` reads and writes `phorma.layout.*` at construction, so
 * every case starts from a cleared namespace rather than from whatever the previous
 * spec file left behind.
 *
 * **Validates: Requirements 7.3, 7.7**
 */

import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import { CAPABILITY_LEVELS, atLeast, type CapabilityLevel } from './capabilities';
import { CapabilityService } from './capability.service';
import { PanelRegistryService, type PanelTab } from './panel-registry.service';
import { TauriService } from './tauri.service';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 100 };

/** Every declared level, read from the contract rather than transcribed. */
const LEVELS = [...CAPABILITY_LEVELS];

interface Harness {
  panels: PanelRegistryService;
  capability: CapabilityService;
}

/** Drops every layout key, so a case starts on a fresh install. */
function clearLayout(): void {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('phorma.layout.')) localStorage.removeItem(key);
  }
}

function harness(): Harness {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
  });
  return {
    panels: TestBed.inject(PanelRegistryService),
    capability: TestBed.inject(CapabilityService),
  };
}

/** Every tab id the two sidebars would render, both sides together. */
function rendered(panels: PanelRegistryService): string[] {
  return [...panels.leftTabs(), ...panels.rightTabs()].map(tab => tab.id);
}

/** Every VISIBLE tab id in the registry, ignoring capability entirely. */
function visibleInRegistry(panels: PanelRegistryService): string[] {
  return panels
    .tabs()
    .filter(tab => tab.visible)
    .map(tab => tab.id);
}

/** The declared minimum of each tab, read off the registry. */
function minimumOf(panels: PanelRegistryService, id: string): CapabilityLevel | undefined {
  return panels.tabs().find(tab => tab.id === id)?.minLevel;
}

describe('PanelRegistryService capability filtering', () => {
  beforeEach(clearLayout);
  afterEach(clearLayout);

  // ─── The declared minimums ────────────────────────────────────────────────

  it('declares a builder minimum on the four builder surfaces and on nothing else', () => {
    const { panels } = harness();

    const declared = panels
      .tabs()
      .filter(tab => tab.minLevel !== undefined)
      .map(tab => tab.id)
      .sort();

    // A content pin, named rather than counted: Skills, Connections, Evals and
    // Portal configure how workflows are built and shipped. Runs, Usage, Prompt,
    // Properties, Agents, Workflows and Assistant are what an operator works in.
    expect(declared).toEqual(['connections', 'evals', 'portal', 'skills']);
    for (const id of declared) {
      expect(minimumOf(panels, id)).toBe('builder');
    }
  });

  // ─── Property 15: the filter is exactly subtractive ───────────────────────

  // Feature: multi-organisation-phorma, Property 15: Capability filtering is exactly subtractive
  it('renders exactly the visible tabs the level allows, no extra and no omission', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEVELS), level => {
        const { panels, capability } = harness();
        // Every tab visible, so the capability filter is the ONLY thing subtracting
        // and an omission cannot be blamed on the default visibility.
        for (const tab of panels.tabs()) panels.showTab(tab.id);
        capability.resolveFrom(level);

        const expected = panels
          .tabs()
          .filter(tab => tab.minLevel === undefined || atLeast(level, tab.minLevel))
          .map(tab => tab.id)
          .sort();

        expect(rendered(panels).sort()).toEqual(expected);
      }),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 15: Capability filtering is exactly subtractive
  it('keeps every filtered tab in the registry and in the saved layout', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEVELS), level => {
        const { panels, capability } = harness();
        for (const tab of panels.tabs()) panels.showTab(tab.id);
        capability.resolveFrom(level);
        // The persist is an `effect`, so it needs a flush: an assertion read in the
        // same tick would see the pre-effect value and look like a missing write.
        TestBed.tick();

        // The registry is the record of the user's arrangement, and the level does
        // not edit it.
        expect(visibleInRegistry(panels).sort()).toEqual(panels.tabs().map(t => t.id).sort());
        const saved = JSON.parse(localStorage.getItem('phorma.layout.panelTabs')!) as PanelTab[];
        expect(saved.map(tab => tab.id).sort()).toEqual(panels.tabs().map(tab => tab.id).sort());
        for (const tab of saved) {
          expect(tab.visible).toBe(true);
        }
      }),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 15: Capability filtering is exactly subtractive
  it('restores the arrangement a demoted member could not see, on promotion', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'left' | 'right'>('left', 'right'),
        fc.nat({ max: 3 }),
        (side, index) => {
          const first = harness();
          // The user arranges a builder tab deliberately: moved to a side and
          // reordered within it.
          const builderTabs = ['skills', 'connections', 'evals', 'portal'];
          const moved = builderTabs[index];
          first.panels.showTab(moved);
          first.panels.moveTab(moved, side, 0);
          first.panels.reorderTab(moved, 1);
          const arrangement = first.panels.tabs().find(tab => tab.id === moved)!;
          TestBed.tick();

          // The same install, demoted. The tab vanishes from the sidebar.
          const second = harness();
          second.capability.resolveFrom('operator');
          expect(rendered(second.panels)).not.toContain(moved);
          TestBed.tick();

          // And a promotion in the SAME session brings it back where it was, with
          // no reload: side and order preserved (Requirement 7.7).
          second.capability.resolveFrom('builder');
          expect(rendered(second.panels)).toContain(moved);
          const restored = second.panels.tabs().find(tab => tab.id === moved)!;
          expect(restored.side).toBe(arrangement.side);
          expect(restored.order).toBe(arrangement.order);
        },
      ),
      { numRuns: 20 },
    );
  });

  // ─── What a menu may offer ────────────────────────────────────────────────

  it('offers a menu only the tabs the level allows, hidden ones included', () => {
    const { panels, capability } = harness();
    capability.resolveFrom('operator');

    const offered = panels.allowedTabs().map(tab => tab.id);

    // Hidden-but-allowed stays offered, because that is what "reopen from the
    // Window menu" means. Above-the-level is absent, because an entry that ticks
    // itself and changes nothing on screen is a broken control.
    expect(offered).toContain('usage');
    expect(offered).toContain('assistant');
    for (const id of ['skills', 'connections', 'evals', 'portal']) {
      expect(offered).not.toContain(id);
    }

    capability.resolveFrom('builder');
    expect(panels.allowedTabs().map(tab => tab.id).sort()).toEqual(
      panels.tabs().map(tab => tab.id).sort(),
    );
  });

  // ─── The active tab a side renders ────────────────────────────────────────

  it('falls back to a rendered tab when the stored active one is filtered out', () => {
    const first = harness();
    first.panels.setActive('right', 'portal');
    expect(first.panels.activeRight()).toBe('portal');
    TestBed.tick();

    const second = harness();
    second.capability.resolveFrom('operator');

    // The stored choice is untouched - it comes back on promotion - but the side
    // renders a tab it is actually showing rather than a blank pane.
    expect(second.panels.activeRight()).not.toBe('portal');
    expect(rendered(second.panels)).toContain(second.panels.activeRight());
    expect(localStorage.getItem('phorma.layout.activeRight')).toBe('"portal"');

    second.capability.resolveFrom('builder');
    expect(second.panels.activeRight()).toBe('portal');
  });

  it('leaves an allowed active tab exactly where the user put it', () => {
    const { panels, capability } = harness();
    capability.resolveFrom('operator');

    panels.setActive('left', 'runs');

    expect(panels.activeLeft()).toBe('runs');
  });

  // ─── Nothing changes for an install with no organisation ──────────────────

  it('renders every default tab at the level an install with no organisation resolves', () => {
    const { panels } = harness();

    // The compatibility case, and the reason the whole filter can ship in one
    // change: the default level allows everything, so today's studio is unchanged.
    for (const tab of panels.tabs()) panels.showTab(tab.id);

    expect(rendered(panels).sort()).toEqual(panels.tabs().map(tab => tab.id).sort());
  });
});
