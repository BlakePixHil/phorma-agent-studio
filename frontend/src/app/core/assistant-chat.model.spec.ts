/**
 * Legacy chat threads keep rendering after `activity: string[]` became
 * `steps: ChatStep[]`. The store holds whole objects with no schema, so the
 * upgrade happens on read and must be exact: each old "X" / "X - done" pair is
 * ONE step, and a "- failed: why" line keeps its reason and its red status.
 */

import { normalizeChatThread, normalizeChatTurn, type ChatTurn } from './assistant-chat.model';

function legacyTurn(activity: string[]): ChatTurn {
  return {
    id: 'turn-1',
    role: 'assistant',
    text: 'Done.',
    mode: 'agent',
    activity,
    at: 1_000,
  };
}

describe('normalizeChatTurn', () => {
  it('collapses each start/end pair into one step carrying the status', () => {
    const turn = normalizeChatTurn(
      legacyTurn([
        'Adding node "Researcher"',
        'Adding node "Researcher" - done',
        'Connecting Researcher to Writer',
        'Connecting Researcher to Writer - failed: Port not found.',
      ]),
    );

    expect(turn.activity).toBeUndefined();
    expect(turn.steps?.map(step => [step.label, step.status, step.error])).toEqual([
      ['Adding node "Researcher"', 'done', undefined],
      ['Connecting Researcher to Writer', 'failed', 'Port not found.'],
    ]);
  });

  it('treats an unpaired legacy line as a finished step', () => {
    const turn = normalizeChatTurn(legacyTurn(['Reading the usage summary']));
    expect(turn.steps?.map(step => step.status)).toEqual(['done']);
  });

  it('gives every step a unique, stable id', () => {
    const turn = normalizeChatTurn(legacyTurn(['A', 'A - done', 'A', 'A - done']));
    const ids = turn.steps?.map(step => step.id) ?? [];
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    expect(normalizeChatTurn(legacyTurn(['A', 'A - done', 'A', 'A - done'])).steps?.map(s => s.id)).toEqual(ids);
  });

  it('leaves a current turn untouched and is idempotent', () => {
    const current: ChatTurn = {
      id: 't',
      role: 'assistant',
      text: 'x',
      mode: 'ask',
      steps: [{ id: 'c1', action: 'web_fetch', label: 'Reading example.com', status: 'done', startedAt: 1 }],
      at: 1,
    };
    expect(normalizeChatTurn(current)).toBe(current);
    const once = normalizeChatTurn(legacyTurn(['A', 'A - done']));
    expect(normalizeChatTurn(once)).toBe(once);
  });

  it('normalizes every turn of a thread', () => {
    const thread = normalizeChatThread({
      id: 'chat-1',
      workflowId: null,
      title: 't',
      turns: [legacyTurn(['A', 'A - done']), { id: 'u', role: 'user', text: 'hi', mode: 'ask', at: 0 }],
      createdAt: 0,
      updatedAt: 0,
    });
    expect(thread.turns[0].steps?.length).toBe(1);
    expect(thread.turns[1].steps).toBeUndefined();
  });
});
