/**
 * The assistant never changes the user's layout as a side effect of an action.
 *
 * The reported defect: while the assistant looked things up, the sidebar
 * physically switched tabs. Every successful action ran a "post-action reveal"
 * that activated the panel owning its surface - so a read of the run list
 * activated Runs, a prompt read activated Prompt, a usage read activated Usage.
 * In the default layout Prompt, Usage, Evals and Portal share the RIGHT sidebar
 * with the Assistant, so those reveals also hid the pane the conversation was
 * streaming into, which read as "the chat disappeared".
 *
 * The assertion is made at the only seam that CAN change the layout -
 * `PanelRegistryService` - with every mutator spied, and the actions come from a
 * fixture spanning every surface the old reveal map named. A spy on
 * `SettingsActionsService.reveal` alone would miss a future path that reaches the
 * panel registry some other way.
 */

import { TestBed } from '@angular/core/testing';

import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
import { PanelRegistryService } from '../panel-registry.service';
import { TauriService } from '../tauri.service';
import { ConnectionActionsService } from './connection-actions.service';
import { EvalActionsService } from './eval-actions.service';
import { GraphActionsService } from './graph-actions.service';
import { PortalActionsService } from './portal-actions.service';
import { PromptActionsService } from './prompt-actions.service';
import { RunActionsService } from './run-actions.service';
import { SettingsActionsService } from './settings-actions.service';
import { SkillActionsService } from './skill-actions.service';
import { StudioActionRegistryService } from './studio-action-registry.service';
import { UsageActionsService } from './usage-actions.service';
import { WorkflowActionsService } from './workflow-actions.service';
import { actionOk, type ActionSurface, type StudioAction } from './studio-action.model';

/** Every surface the removed reveal map used to switch a tab for. */
const SURFACES: readonly ActionSurface[] = [
  'evals',
  'runs',
  'prompts',
  'workflows',
  'versions',
  'skills',
  'connections',
  'portal',
  'usage',
  'graph',
];

function fixtures(): StudioAction[] {
  return SURFACES.flatMap(surface =>
    (['read', 'write'] as const).map(access => ({
      id: `fixture_${surface}_${access}`,
      label: `Fixture ${surface} ${access}`,
      description: `A ${access} on ${surface}.`,
      surface,
      access,
      risk: 'silent' as const,
      run: () => actionOk({ surface }),
    })),
  );
}

describe('StudioActionRegistryService leaves the layout alone', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup() {
    const empty = { actions: () => [] as StudioAction[] };
    const panels = jasmine.createSpyObj<PanelRegistryService>('PanelRegistryService', [
      'setActive',
      'showTab',
      'hideTab',
      'moveTab',
      'expandLeft',
      'expandRight',
      'allowedTabs',
      'tabs',
    ]);
    const reveal = jasmine.createSpy('reveal').and.returnValue(true);
    const list = fixtures();
    TestBed.configureTestingModule({
      providers: [
        { provide: GraphActionsService, useValue: { actions: () => list, beginPlacement: () => undefined } },
        { provide: PromptActionsService, useValue: empty },
        { provide: EvalActionsService, useValue: empty },
        { provide: RunActionsService, useValue: empty },
        { provide: WorkflowActionsService, useValue: empty },
        { provide: SkillActionsService, useValue: empty },
        { provide: ConnectionActionsService, useValue: empty },
        { provide: PortalActionsService, useValue: empty },
        { provide: UsageActionsService, useValue: empty },
        { provide: SettingsActionsService, useValue: { actions: () => [], reveal } },
        { provide: PanelRegistryService, useValue: panels },
        { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: TauriService, useValue: { isDesktop: false } },
      ],
    });
    return { registry: TestBed.inject(StudioActionRegistryService), panels, reveal, list };
  }

  it('reveals no panel for any successful read or write, in any mode', async () => {
    const { registry, panels, reveal, list } = setup();
    registry.beginTurn({ nodes: [], edges: [] } as never);

    for (const action of list) {
      // Ask mode dispatches with `readOnly`, Agent mode with nothing, Plan with
      // `confirmed` - drive all three so no dispatch shape reintroduces it.
      for (const options of [{}, { readOnly: true }, { confirmed: true }]) {
        if (options.hasOwnProperty('readOnly') && action.access !== 'read') continue;
        const result = await registry.execute(action.id, {}, options);
        expect(result.ok).withContext(`${action.id} ${JSON.stringify(options)}`).toBeTrue();
      }
    }

    expect(reveal).not.toHaveBeenCalled();
    expect(panels.setActive).not.toHaveBeenCalled();
    expect(panels.showTab).not.toHaveBeenCalled();
    expect(panels.expandLeft).not.toHaveBeenCalled();
    expect(panels.expandRight).not.toHaveBeenCalled();
    // Vacuous-pass guard: every surface of the old reveal map was exercised.
    expect(registry.turnEffects().length).toBeGreaterThanOrEqual(SURFACES.length * 2);
  });
});
