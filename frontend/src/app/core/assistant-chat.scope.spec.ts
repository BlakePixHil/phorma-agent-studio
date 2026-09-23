/**
 * The open conversation survives an Agent-mode turn.
 *
 * The reported defect: "in agent mode sometimes the chat disappears". Two causes,
 * both in the thread-scoping effect of `AssistantChatService`, and each is
 * reproduced here against the real service with only its three collaborators
 * doubled:
 *
 * 1. The effect read `activeDoc()`, which is a NEW object on every graph edit, so
 *    it re-ran for every node the agent added - and its guard only held once the
 *    workflow had a persisted thread. A workflow's FIRST chat is persisted when
 *    the turn settles, so during that first turn every edit reset the open
 *    thread to null: the panel fell back to the thread list and the turn's reply
 *    was appended to nothing.
 * 2. A turn that changed the active workflow (`workflow_open`, `workflow_create`,
 *    saving a draft, the user clicking another tab) cleared the thread mid-turn,
 *    and clearing it on settle would be the same defect a few seconds later.
 */

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import type { ChatThread } from './assistant-chat.model';
import { AssistantChatService } from './assistant-chat.service';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { TelemetryService } from './telemetry.service';
import { WorkflowBuilderService } from './workflow-builder.service';
import { WorkflowService } from './workflow.service';

interface Doc {
  docId: string;
  workflowId: string | null;
  graph: { nodes: unknown[]; edges: unknown[] };
}

describe('AssistantChatService thread scope during a turn', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup() {
    const activeDoc = signal<Doc | null>({ docId: 'doc-1', workflowId: null, graph: { nodes: [], edges: [] } });
    const saved: ChatThread[] = [];
    let releaseTurn: (summary: string) => void = () => undefined;
    let onTurnStarted: () => void = () => undefined;

    const builder = {
      resolveModel: () => ({ provider: 'ollama', model: 'llama3.2' }),
      modeAvailable: () => true,
      canAutoApply: () => true,
      wasCancelled: false,
      lastTurnUsage: null,
      lastTurnNonRevertableEffects: [] as string[],
      lastTurnFailures: [] as string[],
      cancel: () => undefined,
      runAgentTurn: () =>
        new Promise<string>(resolve => {
          releaseTurn = resolve;
          onTurnStarted();
        }),
    };
    const storage = {
      listChatThreads: async (workflowId: string | null) =>
        saved.filter(thread => thread.workflowId === workflowId).map(thread => structuredClone(thread)),
      saveChatThread: async (thread: ChatThread) => {
        const index = saved.findIndex(entry => entry.id === thread.id);
        if (index >= 0) saved[index] = thread;
        else saved.push(thread);
      },
      getChatThread: async (id: string) => saved.find(thread => thread.id === id),
      removeChatThread: async () => undefined,
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: WorkflowService, useValue: { activeDoc } },
        { provide: WorkflowBuilderService, useValue: builder },
        { provide: IndexedDbStorageService, useValue: storage },
        { provide: TelemetryService, useValue: { count: () => undefined } },
      ],
    });
    const chat = TestBed.inject(AssistantChatService);
    TestBed.flushEffects();

    /** Starts an Agent turn and resolves once the builder is running it. */
    const startTurn = async (text: string) => {
      const started = new Promise<void>(resolve => (onTurnStarted = resolve));
      const settled = chat.send(text, 'agent');
      await started;
      return {
        finish: async (summary: string) => {
          releaseTurn(summary);
          await settled;
          TestBed.flushEffects();
        },
      };
    };

    /** A graph edit: same workflow, new doc object - exactly what `updateDoc` does. */
    const editGraph = () => {
      const doc = activeDoc()!;
      activeDoc.set({ ...doc, graph: { ...doc.graph, nodes: [...doc.graph.nodes, {}] } });
      TestBed.flushEffects();
    };

    return { chat, activeDoc, saved, startTurn, editGraph };
  }

  it('keeps a FIRST conversation open while the agent edits the graph', async () => {
    const rig = setup();
    const turn = await rig.startTurn('Build me a research workflow');
    const threadId = rig.chat.activeThread()?.id;
    expect(threadId).toBeDefined();
    // Nothing is persisted yet: this is the window the old guard failed in.
    expect(rig.saved.length).toBe(0);

    for (let i = 0; i < 5; i++) rig.editGraph();
    expect(rig.chat.activeThread()?.id).withContext('mid-turn').toBe(threadId);

    await turn.finish('Added five nodes.');
    const thread = rig.chat.activeThread();
    expect(thread?.id).toBe(threadId);
    expect(thread?.turns.map(t => t.role)).toEqual(['user', 'assistant']);
    expect(thread?.turns[1].text).toContain('Added five nodes.');
    expect(rig.saved.length).toBe(1);
  });

  it('keeps the conversation when the turn itself switches workflow', async () => {
    const rig = setup();
    const turn = await rig.startTurn('Open my invoice workflow and summarise it');
    const threadId = rig.chat.activeThread()?.id;

    // `workflow_open` mid-turn.
    rig.activeDoc.set({ docId: 'doc-2', workflowId: 'wf-invoices', graph: { nodes: [], edges: [] } });
    TestBed.flushEffects();
    expect(rig.chat.activeThread()?.id).withContext('mid-turn').toBe(threadId);

    await turn.finish('It has three agents.');
    // Still the same conversation after settling, with the reply in it...
    expect(rig.chat.activeThread()?.id).toBe(threadId);
    expect(rig.chat.activeThread()?.turns.length).toBe(2);
    // ...persisted under the workflow it STARTED in, not the one it opened.
    expect(rig.saved[0]?.workflowId).toBeNull();
    expect(rig.saved[0]?.turns.length).toBe(2);
  });

  it('still rescopes on a real workflow switch between turns', async () => {
    const rig = setup();
    const turn = await rig.startTurn('Hello');
    await turn.finish('Hi.');
    expect(rig.chat.activeThread()).not.toBeNull();

    rig.activeDoc.set({ docId: 'doc-3', workflowId: 'wf-other', graph: { nodes: [], edges: [] } });
    TestBed.flushEffects();
    // Idle, so this is the user changing context: the thread list follows it.
    expect(rig.chat.activeThread()).toBeNull();
  });

  it('ignores graph edits between turns too', async () => {
    const rig = setup();
    const turn = await rig.startTurn('Hello');
    await turn.finish('Hi.');
    const threadId = rig.chat.activeThread()?.id;

    rig.editGraph();
    rig.editGraph();
    expect(rig.chat.activeThread()?.id).toBe(threadId);
  });
});
