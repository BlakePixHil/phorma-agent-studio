import { CLOUDFLARE_CAPABILITIES, portBaseId, validateAgainstCapabilities } from '@phorma/engine';
import { WORKFLOW_TEMPLATES, findWorkflowTemplate } from './workflow-templates';
import type { WorkflowGraph } from './workflow.model';

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

  it('builds every template without throwing, with unique node ids', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const spec = template.build();
      expect(spec.id).withContext(`${template.id} spec id`).toBe(template.id);
      const ids = spec.graph.nodes.map(node => node.id);
      expect(new Set(ids).size).withContext(`${template.id} unique node ids`).toBe(ids.length);
    }
  });

  it('resolves every connection to real ports on real nodes', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const graph = template.build().graph;
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

  it('finds every template by id', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(findWorkflowTemplate(template.id)).toBe(template);
    }
  });
});

describe('Jira Time-Log Safety Net template', () => {
  const template = findWorkflowTemplate('tpl-jira-safety-net')!;

  it('is registered', () => {
    expect(template).toBeTruthy();
  });

  it('passes Cloudflare Worker capability validation with zero findings - genuinely deployable', () => {
    // The whole point of this template: no stdio MCP, no OAuth MCP, and every
    // connection reference is left blank for the user to fill in, so it must
    // clear the SAME validator the push path runs with nothing to report.
    const spec = template.build();
    const findings = validateAgainstCapabilities(spec, CLOUDFLARE_CAPABILITIES, []);
    expect(findings).toEqual([]);
  });

  it('wires both schedule triggers and every tool to the agent', () => {
    const graph = template.build().graph;
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

  it('gives Add Worklog two named params; the other Jira calls keep the single-input default', () => {
    const graph = template.build().graph;
    const addWorklog = graph.nodes.find(node => node.id === 'tpl-jira-add-worklog')!;
    const params = (addWorklog.data as { params?: { name: string }[] }).params ?? [];
    expect(params.map(param => param.name).sort()).toEqual(['body', 'issueKey']);

    const search = graph.nodes.find(node => node.id === 'tpl-jira-search')!;
    expect((search.data as { params?: unknown[] }).params ?? []).toEqual([]);

    const worklogs = graph.nodes.find(node => node.id === 'tpl-jira-worklogs')!;
    expect((worklogs.data as { params?: unknown[] }).params ?? []).toEqual([]);
  });

  it('uses the non-deprecated /search/jql endpoint (Atlassian removed /search)', () => {
    const graph = template.build().graph;
    const search = graph.nodes.find(node => node.id === 'tpl-jira-search')!;
    expect((search.data as { url: string }).url).toBe('{{baseUrl}}/rest/api/3/search/jql');
  });

  it('raises the tool-result cap and tool-round budget on the Jira agent so worklog tails are not truncated and the email step is reached', () => {
    const graph = template.build().graph;
    const agent = graph.nodes.find(node => node.id === 'tpl-jira-agent')!;
    const data = agent.data as { toolResultCapChars?: number; maxToolRounds?: number };
    expect(data.toolResultCapChars).toBeGreaterThan(8000);
    expect(data.maxToolRounds).toBeGreaterThan(8);
  });

  it('uses a bearer (not OAuth) email preset, so it stays deployable', () => {
    const graph = template.build().graph;
    const email = graph.nodes.find(node => node.id === 'tpl-jira-email')!;
    const data = email.data as { authMode?: string; authKey?: string };
    expect(data.authMode).not.toBe('oauth');
    expect(data.authKey).toBeTruthy();
  });
});
