import { summarizeDeploySpec, deployGoesLive } from './deploy-readiness';
import type { WorkflowNode, WorkflowSpec } from '../../../core/workflow.model';

function node(kind: WorkflowNode['kind'], id: string, data: object = {}): WorkflowNode {
  return {
    id,
    name: `${kind} node`,
    kind,
    category: 'flow',
    icon: 'ti ti-cog',
    position: { x: 0, y: 0 },
    ports: [{ id: `${id}-in`, name: 'In', role: 'message-in' }],
    data: data as WorkflowNode['data'],
  };
}

function spec(nodes: WorkflowNode[], subWorkflows?: WorkflowSpec['subWorkflows']): WorkflowSpec {
  return {
    version: 1,
    id: 'wf-test',
    name: 'Test',
    graph: { nodes, connections: [] },
    savedAt: '2026-09-16T00:00:00Z',
    ...(subWorkflows ? { subWorkflows } : {}),
  };
}

describe('summarizeDeploySpec', () => {
  it('counts agents across the top-level graph and every embedded workflow', () => {
    const summary = summarizeDeploySpec(
      spec([node('agent', 'a1'), node('agent', 'a2')], {
        child: {
          id: 'child',
          name: 'Child',
          graph: { nodes: [node('agent', 'a3')], connections: [] },
        },
      }),
    );

    expect(summary.agents).toBe(3);
    expect(summary.subWorkflows).toBe(1);
  });

  it('describes an armed schedule in plain language', () => {
    const summary = summarizeDeploySpec(
      spec([node('schedule-trigger', 's1', { cron: '0 9 * * 1,2,3,4,5', timezone: 'UTC' })]),
    );

    expect(summary.schedules.length).toBe(1);
    expect(summary.schedules[0].nodeId).toBe('s1');
    expect(summary.schedules[0].description).toContain('09:00');
    expect(summary.schedules[0].description).toContain('weekdays');
  });

  it('renders the stored UTC cron in the zone the schedule was authored in', () => {
    // Asserted as a shift rather than a fixed hour: Sydney's offset moves with
    // daylight saving, so pinning a clock time would fail half the year.
    const summary = summarizeDeploySpec(
      spec([node('schedule-trigger', 's1', { cron: '0 22 * * *', timezone: 'Australia/Sydney' })]),
    );

    expect(summary.schedules[0].description).toContain('Australia/Sydney');
    expect(summary.schedules[0].description).not.toContain('22:00');
  });

  it('ignores a schedule node whose cron is blank, because it arms nothing', () => {
    const summary = summarizeDeploySpec(
      spec([node('schedule-trigger', 's1', { cron: '   ' }), node('schedule-trigger', 's2', {})]),
    );

    expect(summary.schedules).toEqual([]);
  });

  it('falls back to the raw cron when the expression is not visually representable', () => {
    const summary = summarizeDeploySpec(
      spec([node('schedule-trigger', 's1', { cron: '0 9 * 1,6 *', timezone: 'UTC' })]),
    );

    expect(summary.schedules[0].description).toContain('0 9 * 1,6 *');
  });

  it('reports portal slugs and webhook endpoints', () => {
    const summary = summarizeDeploySpec(
      spec([
        node('portal-trigger', 'p1', { slug: 'support', mode: 'chat' }),
        node('webhook-trigger', 'w1', {}),
        node('webhook-trigger', 'w2', {}),
      ]),
    );

    expect(summary.portalSlugs).toEqual(['support']);
    expect(summary.webhooks).toBe(2);
  });

  it('reports an unpublished portal as an empty slug rather than dropping it', () => {
    const summary = summarizeDeploySpec(spec([node('portal-trigger', 'p1', { mode: 'chat' })]));

    expect(summary.portalSlugs).toEqual(['']);
  });
});

describe('deployGoesLive', () => {
  it('is false for a workflow with nothing that self-starts or is reachable', () => {
    expect(deployGoesLive(summarizeDeploySpec(spec([node('agent', 'a1')])))).toBeFalse();
  });

  it('is true once any schedule, portal or webhook is present', () => {
    const cases: WorkflowNode[] = [
      node('schedule-trigger', 's1', { cron: '0 9 * * *' }),
      node('portal-trigger', 'p1', { mode: 'chat' }),
      node('webhook-trigger', 'w1', {}),
    ];
    for (const trigger of cases) {
      expect(deployGoesLive(summarizeDeploySpec(spec([trigger])))).toBeTrue();
    }
  });
});
