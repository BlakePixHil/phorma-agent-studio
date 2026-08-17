/**
 * E2E scenario: Capability refusal at push and at run.
 *
 * AWS_CAPABILITIES declares `stdioMcp: false` and `mcpOAuth: false`. A workflow
 * containing a stdio MCP node is refused by the Capability_Validator at push
 * time. Similarly, an unsupported SQL driver (one not in `sqlDrivers`) is
 * refused.
 *
 * This script also demonstrates that an unsupported driver node produces error
 * findings from the validator.
 *
 * Scenarios:
 *   1. A stdio MCP node produces an error finding against AWS_CAPABILITIES
 *   2. A push containing a stdio MCP node is refused (findings gate the push)
 *   3. An unsupported SQL driver produces an error finding
 *   4. An OAuth MCP node produces an error finding against AWS_CAPABILITIES
 *
 * Run: npx -y tsx cloud-aws/test/capability-refusal.e2e.mts
 *
 * Requirements: 1.6, 16.5
 * Feature: aws-deployment-target
 */
import assert from 'node:assert/strict';

import {
  AWS_CAPABILITIES,
  validateAgainstCapabilities,
  type CapabilityFinding,
} from '@phorma/engine';
import type { WorkflowGraph, WorkflowNode } from '@phorma/engine';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  \u2713 ${name}`);
  else {
    failures += 1;
    console.error(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<WorkflowNode> & { id: string; kind: string }): WorkflowNode {
  return {
    name: overrides.name ?? overrides.kind,
    category: 'tool',
    icon: 'ti ti-box',
    position: { x: 0, y: 0 },
    ports: [],
    data: {},
    ...overrides,
  };
}

function makeGraph(nodes: WorkflowNode[]): WorkflowGraph {
  return { nodes, connections: [] };
}

function makeSpec(graph: WorkflowGraph) {
  return { graph, subWorkflows: [] };
}

// ---------------------------------------------------------------------------
// Scenario 1: Stdio MCP node refused by AWS_CAPABILITIES (Req 1.6, 16.5)
// ---------------------------------------------------------------------------
console.log('Scenario 1: Stdio MCP node produces error findings against AWS_CAPABILITIES');
{
  const mcpNode = makeNode({
    id: 'mcp-stdio-1',
    kind: 'mcp-tool',
    name: 'Local MCP Server',
    data: { transport: 'stdio', command: 'some-binary', args: [] },
  });

  const graph = makeGraph([mcpNode]);
  const spec = makeSpec(graph);
  const findings = validateAgainstCapabilities(spec, AWS_CAPABILITIES, []);

  check('findings array is non-empty', findings.length > 0, `got ${findings.length}`);
  check(
    'at least one error finding',
    findings.some((f) => f.severity === 'error'),
    `severities: ${findings.map((f) => f.severity).join(', ')}`,
  );

  const stdiofinding = findings.find(
    (f) => f.severity === 'error' && f.nodeId === 'mcp-stdio-1',
  );
  check('finding references the MCP node', stdiofinding !== undefined);
  check(
    'finding message mentions stdio or local',
    stdiofinding?.message.toLowerCase().includes('stdio') ||
      stdiofinding?.message.toLowerCase().includes('local') ||
      false,
    `message: ${stdiofinding?.message}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 2: Push refused when error findings exist (Req 16.5)
// ---------------------------------------------------------------------------
console.log('Scenario 2: Push is refused when capability error findings exist');
{
  // Simulate the push-time gate: if validateAgainstCapabilities returns any
  // error finding, the push MUST NOT proceed. The Host_Adapter answers with
  // the findings and leaves the spec unchanged.
  const mcpNode = makeNode({
    id: 'mcp-push-1',
    kind: 'mcp-tool',
    name: 'Blocked MCP Tool',
    data: { transport: 'stdio', command: 'blocked-server' },
  });

  const graph = makeGraph([mcpNode]);
  const spec = makeSpec(graph);
  const findings = validateAgainstCapabilities(spec, AWS_CAPABILITIES, []);

  const hasError = findings.some((f) => f.severity === 'error');
  check('push is gated by error findings', hasError);

  // Simulate the push path decision: if error findings exist, refuse the push
  // (send no spec, return findings). This mirrors Req 16.5.
  let pushAccepted = false;
  let refusalFindings: CapabilityFinding[] = [];

  if (hasError) {
    // Host_Adapter refuses: answers with findings, leaves spec unchanged
    refusalFindings = findings;
    pushAccepted = false;
  } else {
    pushAccepted = true;
  }

  check('push was refused', !pushAccepted);
  check(
    'refusal carries the findings',
    refusalFindings.length > 0,
    `got ${refusalFindings.length} findings`,
  );
  check(
    'refusal findings contain error severity',
    refusalFindings.some((f) => f.severity === 'error'),
  );
}

// ---------------------------------------------------------------------------
// Scenario 3: Unsupported SQL driver refused (Req 1.6, 16.5)
// ---------------------------------------------------------------------------
console.log('Scenario 3: Unsupported SQL driver produces error findings');
{
  // AWS_CAPABILITIES supports: postgres, mysql, mssql, sqlite.
  // Use a driver NOT in the list to trigger refusal.
  const sqlNode = makeNode({
    id: 'sql-unsupported-1',
    kind: 'sql-query',
    name: 'Oracle Query',
    data: { driver: 'oracle', statement: 'SELECT 1' },
  });

  const graph = makeGraph([sqlNode]);
  const spec = makeSpec(graph);
  const findings = validateAgainstCapabilities(spec, AWS_CAPABILITIES, []);

  check('findings array is non-empty for unsupported driver', findings.length > 0, `got ${findings.length}`);

  const driverFinding = findings.find(
    (f) => f.severity === 'error' && f.nodeId === 'sql-unsupported-1',
  );
  check('finding references the sql-query node', driverFinding !== undefined);
  check(
    'finding message mentions driver',
    driverFinding?.message.toLowerCase().includes('driver') || false,
    `message: ${driverFinding?.message}`,
  );

  // The same push-time gate applies: these error findings would refuse a push
  const hasError = findings.some((f) => f.severity === 'error');
  check('push would be refused for unsupported driver', hasError);
}

// ---------------------------------------------------------------------------
// Scenario 4: OAuth MCP node refused by AWS_CAPABILITIES (Req 1.6)
// ---------------------------------------------------------------------------
console.log('Scenario 4: OAuth MCP node produces error findings against AWS_CAPABILITIES');
{
  const oauthMcpNode = makeNode({
    id: 'mcp-oauth-1',
    kind: 'mcp-tool',
    name: 'OAuth MCP Server',
    data: { transport: 'http', authMode: 'oauth', url: 'https://example.com/mcp' },
  });

  const graph = makeGraph([oauthMcpNode]);
  const spec = makeSpec(graph);
  const findings = validateAgainstCapabilities(spec, AWS_CAPABILITIES, []);

  check('oauth findings are non-empty', findings.length > 0, `got ${findings.length}`);

  const oauthFinding = findings.find(
    (f) => f.severity === 'error' && f.nodeId === 'mcp-oauth-1',
  );
  check('finding references the OAuth MCP node', oauthFinding !== undefined);
  check(
    'finding message mentions OAuth',
    oauthFinding?.message.toLowerCase().includes('oauth') || false,
    `message: ${oauthFinding?.message}`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
