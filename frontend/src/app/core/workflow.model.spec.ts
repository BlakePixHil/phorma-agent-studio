import {
  TOOL_LINK_ON_DATA_NODE_MESSAGE,
  isDataNode,
  rejectsToolLink,
  toolLinkRejection,
  type PortRole,
  type WorkflowNodeKind,
} from './workflow.model';

function endpoint(kind: WorkflowNodeKind, role: PortRole) {
  return { node: { kind }, role };
}

describe('data node tool-link rejection', () => {
  it('classifies the eight data node kinds', () => {
    const kinds: WorkflowNodeKind[] = [
      'http-request',
      'sql-query',
      'transform',
      'aggregate',
      'assert',
      'state-get',
      'state-set',
      'notify',
    ];
    for (const kind of kinds) {
      expect(isDataNode({ kind })).withContext(kind).toBeTrue();
      expect(rejectsToolLink({ kind })).withContext(kind).toBeTrue();
    }
    expect(isDataNode({ kind: 'agent' })).toBeFalse();
    expect(isDataNode({ kind: 'http-tool' })).toBeFalse();
  });

  it('rejects a tool-link whose target is a data node', () => {
    expect(
      toolLinkRejection(endpoint('agent', 'tools'), endpoint('http-request', 'tools')),
    ).toBe(TOOL_LINK_ON_DATA_NODE_MESSAGE);
  });

  it('rejects a tool-link whose source is a data node', () => {
    expect(toolLinkRejection(endpoint('sql-query', 'tools'), endpoint('agent', 'tools'))).toBe(
      TOOL_LINK_ON_DATA_NODE_MESSAGE,
    );
  });

  it('allows a tool-link between an agent and a real tool node', () => {
    expect(toolLinkRejection(endpoint('agent', 'tools'), endpoint('http-tool', 'tools'))).toBeNull();
  });

  it('allows a handoff into and out of a data node', () => {
    expect(
      toolLinkRejection(endpoint('agent', 'message-out'), endpoint('transform', 'message-in')),
    ).toBeNull();
    expect(
      toolLinkRejection(endpoint('notify', 'message-out'), endpoint('agent', 'message-in')),
    ).toBeNull();
  });

  it('states that data nodes cannot be agent tools', () => {
    expect(TOOL_LINK_ON_DATA_NODE_MESSAGE.toLowerCase()).toContain('data nodes cannot be attached');
    expect(TOOL_LINK_ON_DATA_NODE_MESSAGE.toLowerCase()).toContain('tool');
  });
});
