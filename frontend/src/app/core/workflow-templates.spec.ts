import {
  CLOUDFLARE_CAPABILITIES,
  portBaseId,
  usesDecisions,
  validateAgainstCapabilities,
} from '@phorma/engine';
import { WORKFLOW_TEMPLATES, findWorkflowTemplate } from './workflow-templates';
import type { StateSetNodeData, WorkflowGraph, WorkflowSpec } from './workflow.model';

/**
 * Structural integrity for every template. A template is a hand-authored
 * WorkflowSpec, so nothing catches a typo'd port key or a dangling
 * connection until it is actually run through the same validators the app
 * uses at push time.
 */
describe('workflow templates', () => {
  function portIds(graph: WorkflowGraph): Set<string> {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      for (const port of node.ports) ids.add(port.id);
    }
    return ids;
  }

  it('builds every template without throwing, with unique node ids', async () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const spec = (await template.build());
      expect(spec.id).withContext(`${template.id} spec id`).toBe(template.id);
      const ids = spec.graph.nodes.map(node => node.id);
      expect(new Set(ids).size).withContext(`${template.id} unique node ids`).toBe(ids.length);
    }
  });

  it('resolves every connection to real ports on real nodes', async () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const graph = (await template.build()).graph;
      const ids = portIds(graph);
      for (const connection of graph.connections) {
        expect(ids.has(portBaseId(connection.outputId)))
          .withContext(`${template.id}: ${connection.id} outputId ${connection.outputId}`)
          .toBeTrue();
        expect(ids.has(portBaseId(connection.inputId)))
          .withContext(`${template.id}: ${connection.id} inputId ${connection.inputId}`)
          .toBeTrue();
      }
    }
  });

  it('finds every template by id', async () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(findWorkflowTemplate(template.id)).toBe(template);
    }
  });
});

describe('Jira Time-Log Safety Net template', () => {
  const template = findWorkflowTemplate('tpl-jira-safety-net')!;

  it('is registered', async () => {
    expect(template).toBeTruthy();
  });

  it('passes Cloudflare Worker capability validation with zero findings - genuinely deployable', async () => {
    // The whole point of this template: no stdio MCP, no OAuth MCP, and every
    // connection reference is left blank for the user to fill in, so it must
    // clear the SAME validator the push path runs with nothing to report.
    const spec = (await template.build());
    const findings = validateAgainstCapabilities(spec, CLOUDFLARE_CAPABILITIES, []);
    expect(findings).toEqual([]);
  });

  it('wires both schedule triggers and every tool to the agent', async () => {
    const graph = (await template.build()).graph;
    expect(graph.nodes.some(node => node.kind === 'agent')).toBeTrue();

    const toolLinks = graph.connections.filter(connection => connection.kind === 'tool-link');
    const toolNodeIds = graph.nodes
      .filter(node => node.kind === 'http-tool' || node.kind === 'mcp-tool')
      .map(node => node.id);
    expect(toolNodeIds.length).toBe(5);
    for (const toolId of toolNodeIds) {
      const linked = toolLinks.some(link => link.inputId.startsWith(`${toolId}-`));
      expect(linked).withContext(`${toolId} is tool-linked to the agent`).toBeTrue();
    }

    const triggers = graph.nodes.filter(node => node.kind === 'schedule-trigger');
    expect(triggers.length).toBe(2);
    for (const trigger of triggers) {
      const handsOff = graph.connections.some(
        connection => connection.kind === 'handoff' && connection.outputId.startsWith(`${trigger.id}-`),
      );
      expect(handsOff).withContext(`${trigger.name} hands off to the agent`).toBeTrue();
    }
  });

  it('gives Add Worklog two named params; the other Jira calls keep the single-input default', async () => {
    const graph = (await template.build()).graph;
    const addWorklog = graph.nodes.find(node => node.id === 'tpl-jira-add-worklog')!;
    const params = (addWorklog.data as { params?: { name: string }[] }).params ?? [];
    expect(params.map(param => param.name).sort()).toEqual(['body', 'issueKey']);

    const search = graph.nodes.find(node => node.id === 'tpl-jira-search')!;
    expect((search.data as { params?: unknown[] }).params ?? []).toEqual([]);

    const worklogs = graph.nodes.find(node => node.id === 'tpl-jira-worklogs')!;
    expect((worklogs.data as { params?: unknown[] }).params ?? []).toEqual([]);
  });

  it('uses the non-deprecated /search/jql endpoint (Atlassian removed /search)', async () => {
    const graph = (await template.build()).graph;
    const search = graph.nodes.find(node => node.id === 'tpl-jira-search')!;
    expect((search.data as { url: string }).url).toBe('{{baseUrl}}/rest/api/3/search/jql');
  });

  it('raises the tool-result cap and tool-round budget on the Jira agent so worklog tails are not truncated and the email step is reached', async () => {
    const graph = (await template.build()).graph;
    const agent = graph.nodes.find(node => node.id === 'tpl-jira-agent')!;
    const data = agent.data as { toolResultCapChars?: number; maxToolRounds?: number };
    expect(data.toolResultCapChars).toBeGreaterThan(8000);
    expect(data.maxToolRounds).toBeGreaterThan(8);
  });

  it('uses a bearer (not OAuth) email preset, so it stays deployable', async () => {
    const graph = (await template.build()).graph;
    const email = graph.nodes.find(node => node.id === 'tpl-jira-email')!;
    const data = email.data as { authMode?: string; authKey?: string };
    expect(data.authMode).not.toBe('oauth');
    expect(data.authKey).toBeTruthy();
  });
});

describe('System One templates', () => {
  for (const id of ['tpl-support-triage', 'tpl-verified-extraction']) {
    it(`${id} is deployable to Cloudflare and uses System One`, async () => {
      const spec = await findWorkflowTemplate(id)!.build();
      expect(validateAgainstCapabilities(spec, CLOUDFLARE_CAPABILITIES, [])).toEqual([]);
      expect(usesDecisions(spec.graph)).toBeTrue();
    });
  }

  it('points every support-triage route criterion and the unsure port at real ports', async () => {
    const router = (await findWorkflowTemplate('tpl-support-triage')!.build()).graph.nodes.find(
      node => node.kind === 'router',
    )!;
    const ids = new Set(router.ports.map(port => port.id));
    const data = router.data as { routeCriteria: Record<string, string>; unsurePortId: string };
    for (const portId of Object.keys(data.routeCriteria)) expect(ids.has(portId)).withContext(portId).toBeTrue();
    expect(ids.has(data.unsurePortId)).toBeTrue();
  });
});

describe('Weekly Job Applications template', () => {
  const template = findWorkflowTemplate('tpl-weekly-job-applications')!;
  const build = () => template.build() as Promise<WorkflowSpec>;

  it('is registered with the briefcase icon', () => {
    expect(template).toBeTruthy();
    expect(template.icon).toBe('ti ti-briefcase');
    expect(template.description).toMatch(/Resend/);
    expect(template.description).toMatch(/deploy/i);
  });

  it('builds with unique ids and every connection resolving', async () => {
    const spec = await build();
    const ids = spec.graph.nodes.map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const ports = new Set(spec.graph.nodes.flatMap(node => node.ports.map(port => port.id)));
    for (const connection of spec.graph.connections) {
      expect(ports.has(portBaseId(connection.outputId))).withContext(connection.outputId).toBeTrue();
      expect(ports.has(portBaseId(connection.inputId))).withContext(connection.inputId).toBeTrue();
    }
  });

  it('validates against Cloudflare with zero findings', async () => {
    expect(validateAgainstCapabilities(await build(), CLOUDFLARE_CAPABILITIES, [])).toEqual([]);
  });

  it('writes every applied: and screened: entry for 30 days under keys its reads use', async () => {
    const spec = await build();
    const ledgerKey = (key: unknown) => typeof key === 'string' && /^(applied|screened):/.test(key);
    const writes = spec.graph.nodes.filter(
      node => node.kind === 'state-set' && ledgerKey((node.data as StateSetNodeData).key),
    );
    const reads = spec.graph.nodes.filter(
      node => node.kind === 'state-get' && ledgerKey((node.data as { key: string }).key),
    );
    expect(writes.length).toBe(3);
    expect(reads.length).toBe(2);
    const readKeys = new Set(reads.map(node => (node.data as { key: string }).key));
    for (const write of writes) {
      const data = write.data as StateSetNodeData;
      expect(data.ttlSec).withContext(write.id).toBe(2_592_000);
      expect(readKeys.has(data.key)).withContext(`${write.id} key ${data.key}`).toBeTrue();
    }
  });

  it('ships in dry run', async () => {
    const dryRun = (await build()).settings?.variables?.find(variable => variable.name === 'dryRun');
    expect(dryRun?.type).toBe('boolean');
    expect(dryRun?.value).toBeTrue();
  });

  it('contains no stdio or OAuth MCP node and no local-only step', async () => {
    const spec = await build();
    for (const node of spec.graph.nodes) {
      if (node.kind !== 'mcp-tool') continue;
      const data = node.data as { transport?: string; authMode?: string };
      expect(data.transport).not.toBe('stdio');
      expect(data.authMode).not.toBe('oauth');
    }
    expect(spec.graph.nodes.some(node => node.kind === 'sql-query')).toBeFalse();
  });

  it('claims every outbound application under one idempotency key per posting', async () => {
    const spec = await build();
    const sends = spec.graph.nodes.filter(
      node => node.name === 'Email application' || node.name === 'Submit by API',
    );
    expect(sends.length).toBe(2);
    for (const send of sends) {
      expect((send.data as { idempotencyKey?: string }).idempotencyKey).toBe('apply:{{posting.key}}');
    }
  });

  it('forces every send to the no-send branch while dryRun is on', async () => {
    const route = (await build()).graph.nodes.find(node => node.name === 'Apply by')!;
    expect((route.data as { expression: string }).expression.startsWith('vars.dryRun ?')).toBeTrue();
  });

  it('targets Melbourne: schedule zone, home location and Australia-open remote regions', async () => {
    const spec = await build();
    const schedule = spec.graph.nodes.find(node => node.kind === 'schedule-trigger')!;
    expect((schedule.data as { timezone?: string }).timezone).toBe('Australia/Melbourne');
    const value = (name: string) =>
      spec.settings?.variables?.find(variable => variable.name === name)?.value as unknown;
    expect(value('homeLocations')).toEqual(['melbourne']);
    expect(value('remoteRegions') as string[]).toContain('australia');
    expect(value('remoteRegions') as string[]).not.toContain('usa');
    // Adzuna ships off: it needs the user's own free app id and key.
    expect(value('adzunaAppId')).toBe('');
  });
});
