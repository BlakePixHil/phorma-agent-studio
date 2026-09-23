/**
 * Capability gating of the Action_Registry (multi-organisation-phorma
 * Requirement 8).
 *
 * The claim is narrow and the placement is the whole point. `minLevel` is DATA on
 * each entry; the one comparison lives in `available()`, and everything the
 * assistant sees is derived from it - the Agent-mode tool list, the Plan-mode op
 * set, the Ask-mode read subset and the prompt catalogue. So the suite asserts
 * three things together, at every level:
 *
 * 1. Each derived surface equals EXACTLY the allowed subset - no extra entry and
 *    no omitted entry (Property 15).
 * 2. The registry INDEX still holds every entry, so `byId` can still tell "no such
 *    action" from "not for you", and a promotion needs no reload.
 * 3. `risk` and `minLevel` do not interfere (Property 17): the tier decides whether
 *    the user is asked, the minimum decides whether the action exists at all.
 *
 * The second describe runs against the REAL ten surface services, because the
 * defect this feature can actually ship is an entry that forgot to declare a
 * minimum: an absent value reads as the least capable level, so a forgotten write
 * action is offered to an operator and nothing fails anywhere.
 *
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.6**
 */

import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
import { AiEditSessionService } from '../ai-edit-session.service';
import { CAPABILITY_LEVELS, atLeast, isCapabilityLevel, type CapabilityLevel } from '../capabilities';
import { CapabilityService } from '../capability.service';
import { CloudService } from '../cloud.service';
import { ConnectionsService } from '../connections.service';
import { ConnectorsService } from '../connectors.service';
import { DeploymentsService } from '../deployments.service';
import { EvalRunnerService } from '../eval-runner.service';
import { EvalService } from '../eval.service';
import { LocalAgentRouterService } from '../local-agent-router.service';
import { NotificationCenterService } from '../notification-center.service';
import { NotificationsService } from '../notifications.service';
import { PanelRegistryService } from '../panel-registry.service';
import { PortalService } from '../portal.service';
import { PromptLibraryService } from '../prompt-library.service';
import { RunControllerService } from '../run-controller.service';
import { RunHistoryService } from '../run-history.service';
import { SettingsRegistryService } from '../settings-registry';
import { SkillsService } from '../skills.service';
import { TauriService } from '../tauri.service';
import { UsageAnalyticsService } from '../usage-analytics.service';
import { WorkflowBackupService } from '../cloud/workflow-backup.service';
import { WorkflowService } from '../workflow.service';
import { WorkflowVersionsService } from '../workflow-versions.service';
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
import { actionOk, type ActionAccess, type StudioAction } from './studio-action.model';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 100 };

/** Every declared level, read from the contract rather than transcribed. */
const LEVELS = [...CAPABILITY_LEVELS];

/** The three access scopes a caller can ask `available()` for. */
const SCOPES: readonly (ActionAccess | 'all')[] = ['read', 'write', 'all'];

/**
 * True when `level` satisfies an entry's declared minimum.
 *
 * Written as an explicit `undefined` test rather than `?? <level>`, because a level
 * literal in a default position is a capability DECISION outside the capability
 * module - `scripts/check-capability-isolation.mjs` fails on it, and this spec is
 * not exempt from that scan.
 */
function allowedAt(level: CapabilityLevel, action: StudioAction): boolean {
  return action.minLevel === undefined || atLeast(level, action.minLevel);
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 1: the filter, over a fixture that spans every level, tier and access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One fixture entry per (level x access x tier) combination that matters, plus one
 * entry declaring NO minimum - the documented default, which has to behave as the
 * least capable level rather than as "unrestricted".
 */
function fixtureActions(): StudioAction[] {
  const entries: StudioAction[] = [
    {
      id: 'fixture_undeclared',
      label: 'Undeclared minimum',
      description: 'Declares no minimum at all.',
      surface: 'graph',
      access: 'read',
      risk: 'silent',
      run: () => actionOk(),
    },
  ];
  for (const level of LEVELS) {
    for (const access of ['read', 'write'] as const) {
      for (const risk of ['silent', 'confirm'] as const) {
        entries.push({
          id: `fixture_${level}_${access}_${risk}`,
          label: `Fixture ${level} ${access} ${risk}`,
          description: `A ${access} action at the ${level} minimum.`,
          surface: 'graph',
          access,
          risk,
          minLevel: level,
          run: () => actionOk({ ran: true }),
        });
      }
    }
  }
  return entries;
}

interface FixtureHarness {
  registry: StudioActionRegistryService;
  capability: CapabilityService;
  confirm: jasmine.Spy;
  fixtures: StudioAction[];
}

/** A registry whose ten surface services are replaced by one fixture list. */
function fixtureHarness(approve = true): FixtureHarness {
  const fixtures = fixtureActions();
  const empty = { actions: () => [] as StudioAction[] };
  const confirm = jasmine.createSpy('confirm').and.resolveTo(approve);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: GraphActionsService, useValue: { actions: () => fixtures, beginPlacement: () => undefined } },
      { provide: PromptActionsService, useValue: empty },
      { provide: EvalActionsService, useValue: empty },
      { provide: RunActionsService, useValue: empty },
      { provide: WorkflowActionsService, useValue: empty },
      { provide: SkillActionsService, useValue: empty },
      { provide: ConnectionActionsService, useValue: empty },
      { provide: PortalActionsService, useValue: empty },
      { provide: UsageActionsService, useValue: empty },
      { provide: SettingsActionsService, useValue: { actions: () => [], reveal: () => true } },
      { provide: ConfirmDialogService, useValue: { confirm } },
      { provide: TauriService, useValue: { isDesktop: false } },
    ],
  });
  return {
    registry: TestBed.inject(StudioActionRegistryService),
    capability: TestBed.inject(CapabilityService),
    confirm,
    fixtures,
  };
}

describe('StudioActionRegistryService capability filtering', () => {
  // Feature: multi-organisation-phorma, Property 15: Every capability-derived studio surface equals the allowed subset
  it('offers exactly the allowed subset for every access scope, no extra and no omission', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEVELS), fc.constantFrom(...SCOPES), (level, scope) => {
        const { registry, capability, fixtures } = fixtureHarness();
        capability.resolveFrom(level);

        const expected = fixtures
          .filter(action => (scope === 'all' || action.access === scope) && allowedAt(level, action))
          .map(action => action.id)
          .sort();

        expect(registry.available(scope).map(action => action.id).sort()).toEqual(expected);
        // Both derived surfaces, asserted against the SAME expectation rather than
        // against each other: two derivations agreeing on a wrong set is the
        // failure a same-source comparison cannot see.
        expect(registry.toolDefinitions(scope).map(tool => tool.name).sort()).toEqual(expected);
        expect([...registry.availableIds(scope)].sort()).toEqual(expected);
      }),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 15: Every capability-derived studio surface equals the allowed subset
  it('names exactly the allowed subset in the prompt catalogue', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEVELS), level => {
        const { registry, capability, fixtures } = fixtureHarness();
        capability.resolveFrom(level);

        const catalogue = registry.summarizeActions('all');
        for (const action of fixtures) {
          // `- <id>` is how `summarizeActions` writes a line, so this reads
          // presence rather than an accidental substring of another id.
          expect(catalogue.includes(`- ${action.id}`))
            .withContext(`${action.id} at ${level}`)
            .toBe(allowedAt(level, action));
        }
      }),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 15: Every capability-derived studio surface equals the allowed subset
  it('keeps every entry in the registry index whatever the level', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEVELS), level => {
        const { registry, capability, fixtures } = fixtureHarness();
        capability.resolveFrom(level);

        // The index is the record of what the studio can do, and the level does not
        // edit it: `byId` has to resolve a filtered id, or `execute` could not tell
        // "there is no such action" from "not for you".
        expect(registry.all().map(action => action.id).sort()).toEqual(
          fixtures.map(action => action.id).sort(),
        );
        for (const action of fixtures) {
          expect(registry.byId(action.id)).withContext(action.id).toBeTruthy();
        }
      }),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 16: A level change is idempotent and needs no reload
  it('recomputes the offered set on a level change, with no reconstruction', () => {
    const { registry, capability } = fixtureHarness();

    capability.resolveFrom('operator');
    const asOperator = registry.available('all').map(action => action.id);
    capability.resolveFrom('builder');
    const asBuilder = registry.available('all').map(action => action.id);
    capability.resolveFrom('operator');

    expect(asBuilder.length).toBeGreaterThan(asOperator.length);
    // The same instance, the same session: a promotion is one signal write.
    expect(registry.available('all').map(action => action.id)).toEqual(asOperator);
  });

  // ─── Dispatch: gating is absence, and refusal is the backstop ──────────────

  it('refuses an action above the level even when its id is supplied directly', async () => {
    const { registry, capability, confirm } = fixtureHarness();
    capability.resolveFrom('operator');

    const result = await registry.execute('fixture_builder_write_silent', {});

    expect(result.ok).toBeFalse();
    expect(result.message).toContain('not available to this account');
    // The refusal lands BEFORE the guardrail, so a capability refusal never reads
    // as a declined confirmation.
    expect(confirm).not.toHaveBeenCalled();
    // And it reaches the turn record rather than only the model's context.
    expect(registry.turnFailures().join(' ')).toContain('not available to this account');
  });

  it('runs an allowed action at exactly the declared minimum', async () => {
    const { registry, capability } = fixtureHarness();
    capability.resolveFrom('editor');

    expect((await registry.execute('fixture_editor_write_silent', {})).ok).toBeTrue();
    expect((await registry.execute('fixture_operator_read_silent', {})).ok).toBeTrue();
    expect((await registry.execute('fixture_builder_write_silent', {})).ok).toBeFalse();
  });

  it('treats an entry with no declared minimum as the least capable level allows', async () => {
    const { registry, capability } = fixtureHarness();
    capability.resolveFrom('operator');

    // The documented default: absent means "no particular level", resolved inside
    // the capability module. An absent minimum must not read as "unrestricted" on
    // one surface and "admin only" on another.
    expect(registry.availableIds('all').has('fixture_undeclared')).toBeTrue();
    expect((await registry.execute('fixture_undeclared', {})).ok).toBeTrue();
  });

  it('still says there is no such action for an id that does not exist', async () => {
    const { registry, capability } = fixtureHarness();
    capability.resolveFrom('operator');

    const result = await registry.execute('fixture_not_a_real_action', {});

    expect(result.ok).toBeFalse();
    expect(result.message).toContain('no studio action called');
  });

  // Feature: multi-organisation-phorma, Property 17: Capability gating and confirmation tiers are independent
  it('asks for confirmation exactly on the confirm tier, and refuses exactly below the minimum', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...LEVELS),
        fc.constantFrom(...LEVELS),
        fc.constantFrom<'read' | 'write'>('read', 'write'),
        fc.constantFrom<'silent' | 'confirm'>('silent', 'confirm'),
        async (level, minimum, access, risk) => {
          const { registry, capability, confirm } = fixtureHarness();
          capability.resolveFrom(level);

          const result = await registry.execute(`fixture_${minimum}_${access}_${risk}`, {});

          // The refusal is a function of the level and the minimum ALONE - the tier
          // does not move it either way.
          expect(result.ok).withContext(`${level} vs ${minimum}`).toBe(atLeast(level, minimum));
          // And the dialog is a function of the tier alone, for every action the
          // level allows. Below the minimum there is nothing to confirm, because
          // gating is absence rather than a guarded action.
          expect(confirm.calls.count()).toBe(atLeast(level, minimum) && risk === 'confirm' ? 1 : 0);
        },
      ),
      RUNS,
    );
  });

  it('keeps a declined confirmation distinguishable from a capability refusal', async () => {
    const { registry, capability, confirm } = fixtureHarness(false);
    capability.resolveFrom('builder');

    const result = await registry.execute('fixture_builder_write_confirm', {});

    expect(confirm).toHaveBeenCalled();
    expect(result.ok).toBeFalse();
    expect(result.message).toContain('declined');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2: the real ten surfaces
// ─────────────────────────────────────────────────────────────────────────────

/** Surfaces whose panel tab declares a minimum, so their actions must match it. */
const BUILDER_SURFACES = ['evals', 'skills', 'connections', 'portal'] as const;

/**
 * The real registry over stubbed collaborators.
 *
 * Every `actions()` implementation builds literals and lazy closures, so a bare
 * object satisfies the collaborators that are only read when an executor runs.
 * `PanelRegistryService` is stubbed rather than real on purpose: it reads and
 * writes `phorma.layout.*` at construction, and a spec that leaves a value behind
 * in the one shared `localStorage` is how an order-dependent flake starts.
 */
function realRegistry(): { registry: StudioActionRegistryService; capability: CapabilityService; addNode: jasmine.Spy } {
  const addNode = jasmine.createSpy('addNode').and.returnValue({ ok: false });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: TauriService, useValue: { isDesktop: false } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(false) } },
      { provide: WorkflowService, useValue: { library: () => [], activeDoc: () => null, graph: () => ({ nodes: [], connections: [] }), activeName: () => 'Draft' } },
      { provide: LocalAgentRouterService, useValue: { addNode } },
      { provide: AiEditSessionService, useValue: {} },
      { provide: PromptLibraryService, useValue: {} },
      { provide: EvalService, useValue: { suites: () => [] } },
      { provide: EvalRunnerService, useValue: {} },
      { provide: RunControllerService, useValue: { pendingApprovals: () => [] } },
      { provide: RunHistoryService, useValue: {} },
      { provide: NotificationCenterService, useValue: { pendingActions: () => [] } },
      { provide: NotificationsService, useValue: {} },
      { provide: WorkflowVersionsService, useValue: {} },
      { provide: CloudService, useValue: { effectiveWorkerUrl: () => '' } },
      { provide: DeploymentsService, useValue: {} },
      { provide: WorkflowBackupService, useValue: {} },
      { provide: SkillsService, useValue: { byId: () => new Map() } },
      { provide: ConnectionsService, useValue: { connections: () => [] } },
      { provide: ConnectorsService, useValue: { byId: () => new Map() } },
      { provide: PortalService, useValue: {} },
      { provide: UsageAnalyticsService, useValue: {} },
      { provide: SettingsRegistryService, useValue: { pages: [] } },
      { provide: PanelRegistryService, useValue: { allowedTabs: () => [], tabs: () => [] } },
    ],
  });
  return {
    registry: TestBed.inject(StudioActionRegistryService),
    capability: TestBed.inject(CapabilityService),
    addNode,
  };
}

describe('the registered Studio_Actions', () => {
  it('declares a minimum Capability_Level on every entry (8.1)', () => {
    const { registry } = realRegistry();

    const undeclared = registry
      .all()
      .filter(action => action.minLevel === undefined)
      .map(action => action.id);

    // An absent minimum reads as the least capable level, so a forgotten
    // declaration silently OFFERS a write action to an operator and nothing fails
    // anywhere. This assertion is the only thing that catches it.
    expect(undeclared).toEqual([]);
    for (const action of registry.all()) {
      expect(isCapabilityLevel(action.minLevel)).withContext(action.id).toBeTrue();
    }
    // Vacuous-pass guard: an empty registry would satisfy everything above.
    expect(registry.all().length).toBeGreaterThan(60);
  });

  it('keeps every action id unique across the ten surfaces', () => {
    const { registry } = realRegistry();
    const ids = registry.all().map(action => action.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('gates the four builder-only panel surfaces entirely, reads included', () => {
    const { registry, capability } = realRegistry();
    capability.resolveFrom('editor');

    // Their panel tabs carry the same minimum in `DEFAULT_TABS`, so an action left
    // open here would answer about a surface the studio does not show, and the
    // post-action panel reveal would do nothing.
    const offered = registry.availableIds('all');
    for (const action of registry.all()) {
      if ((BUILDER_SURFACES as readonly string[]).includes(action.surface)) {
        expect(offered.has(action.id)).withContext(action.id).toBeFalse();
      }
    }
  });

  it('leaves an operator every run, trace, usage and notification capability', () => {
    const { registry, capability } = realRegistry();
    capability.resolveFrom('operator');

    const offered = registry.availableIds('all');
    // The operator level exists for this list: trigger, watch, answer, and read.
    for (const id of [
      'run_start',
      'run_stop',
      'run_read_state',
      'run_list',
      'run_resolve_approval',
      'run_resolve_question',
      'notifications_read',
      'notifications_resolve_approval',
      'usage_read_summary',
      'usage_read_hotspots',
      'workflow_list',
      'workflow_read',
      'graph_read_state',
      'prompt_read',
      'deployment_list',
    ]) {
      expect(offered.has(id)).withContext(id).toBeTrue();
    }
  });

  it('withholds graph structure from an operator and grants prompt edits to an editor', () => {
    const { registry, capability } = realRegistry();

    capability.resolveFrom('operator');
    const asOperator = registry.availableIds('all');
    for (const id of ['graph_add_node', 'graph_connect_nodes', 'graph_remove_node', 'prompt_write']) {
      expect(asOperator.has(id)).withContext(id).toBeFalse();
    }

    capability.resolveFrom('editor');
    const asEditor = registry.availableIds('all');
    // The line the editor level exists to draw: values inside an existing graph,
    // not the shape of it.
    for (const id of ['prompt_write', 'graph_update_node', 'workflow_save']) {
      expect(asEditor.has(id)).withContext(id).toBeTrue();
    }
    for (const id of ['graph_add_node', 'workflow_create', 'deploy_workflow', 'settings_write']) {
      expect(asEditor.has(id)).withContext(id).toBeFalse();
    }
  });

  it('offers a builder every registered action', () => {
    const { registry, capability } = realRegistry();
    capability.resolveFrom('builder');

    // Nothing is declared above builder today: `member.manage` and
    // `billing.manage` have no action entry, and an admin-only action would be
    // invisible to the builder who owns the workflow.
    expect(registry.availableIds('all').size).toBe(registry.all().length);
  });

  it('refuses a real above-level action without reaching its executor', async () => {
    const { registry, capability, addNode } = realRegistry();
    capability.resolveFrom('operator');

    const result = await registry.execute('graph_add_node', { type: 'agent-researcher' });

    expect(result.ok).toBeFalse();
    // The refusal is not the security boundary - the worker re-gates every action
    // that reaches a route (8.5) - but it must not half-run either.
    expect(addNode).not.toHaveBeenCalled();
  });

  it('changes nothing for an install with no organisation', () => {
    const { registry } = realRegistry();

    // The compatibility case, and the reason this can ship before any
    // organisation exists: the default level allows every registered action.
    expect(registry.availableIds('all').size).toBe(registry.all().length);
    expect(registry.availableIds('read').size).toBe(
      registry.all().filter(action => action.access === 'read').length,
    );
  });
});
