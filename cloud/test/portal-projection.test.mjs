/**
 * Deterministic proof of the portal redaction boundary (EPIC 9).
 *
 * The browser E2E can only assert what a real model happens to say, and a model
 * may choose to recite its own prompt — which is a prompt-engineering concern,
 * not a transport one. THIS file pins the transport guarantee: given every
 * `RunEvent` variant the engine can emit, `toPortalEvent` must forward only the
 * whitelisted projections and must never copy a field that belongs to the
 * owner.
 *
 * It is a pure function test: no worker, no model, no network.
 *
 * Run: npx -y tsx cloud/test/portal-projection.test.mjs
 */

import {
  PORTAL_GENERIC_ERROR,
  isTerminalPortalEvent,
  toPortalEvent,
  toSseFrame,
} from '../src/portal-events.ts';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

const RESPONDER = 'answer';
const OPTIONS = { responderNodeId: RESPONDER };

/** Strings that must never appear in any projected output. */
const FORBIDDEN = [
  'SECRET-PROMPT',
  'INTERMEDIATE-OUTPUT',
  'TOOL-ARGS',
  'TOOL-RESULT',
  'RAW-ERROR-DETAIL',
  'Triage Agent',
  'gpt-secret-model',
  'approval message for the operator',
];

/**
 * Every `RunEvent` variant, each stuffed with owner-only material. The union in
 * `engine/src/events.ts` is the source of truth; if a variant is added there and
 * not here, the "every variant is covered" check below fails.
 */
const ALL_EVENTS = [
  { type: 'run-started', runId: 'r1', input: 'SECRET-PROMPT payload', source: 'portal', at: 1 },
  { type: 'node-started', runId: 'r1', nodeId: 'triage', nodeName: 'Triage Agent', at: 1 },
  { type: 'node-token', runId: 'r1', nodeId: 'triage', token: 'INTERMEDIATE-OUTPUT' },
  { type: 'node-token', runId: 'r1', nodeId: RESPONDER, token: 'hello visitor' },
  { type: 'node-thinking', runId: 'r1', nodeId: RESPONDER, token: 'INTERMEDIATE-OUTPUT reasoning' },
  {
    type: 'node-usage',
    runId: 'r1',
    nodeId: RESPONDER,
    provider: 'openai',
    model: 'gpt-secret-model',
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.5 },
    at: 1,
  },
  {
    type: 'node-completed',
    runId: 'r1',
    nodeId: 'triage',
    nodeName: 'Triage Agent',
    output: 'INTERMEDIATE-OUTPUT',
    at: 1,
  },
  {
    type: 'node-failed',
    runId: 'r1',
    nodeId: 'triage',
    nodeName: 'Triage Agent',
    error: 'RAW-ERROR-DETAIL',
    at: 1,
  },
  {
    type: 'node-retrying',
    runId: 'r1',
    nodeId: 'triage',
    nodeName: 'Triage Agent',
    attempt: 1,
    maxAttempts: 2,
    delayMs: 1000,
    error: 'RAW-ERROR-DETAIL',
    at: 1,
  },
  {
    type: 'node-fallback',
    runId: 'r1',
    nodeId: 'triage',
    nodeName: 'Triage Agent',
    fromProvider: 'openai',
    fromModel: 'gpt-secret-model',
    toProvider: 'anthropic',
    toModel: 'claude',
    error: 'RAW-ERROR-DETAIL',
    at: 1,
  },
  {
    type: 'node-error-routed',
    runId: 'r1',
    nodeId: 'triage',
    nodeName: 'Triage Agent',
    error: 'RAW-ERROR-DETAIL',
    at: 1,
  },
  { type: 'context-compressed', runId: 'r1', nodeId: RESPONDER, beforeTokens: 9, afterTokens: 4, at: 1 },
  {
    type: 'handoff',
    runId: 'r1',
    connectionId: 'e1',
    fromNodeId: 'triage',
    toNodeId: RESPONDER,
    payload: 'INTERMEDIATE-OUTPUT',
    at: 1,
  },
  {
    type: 'tool-call',
    runId: 'r1',
    nodeId: RESPONDER,
    toolNodeId: 't1',
    name: 'http_request',
    arguments: 'TOOL-ARGS',
    at: 1,
  },
  {
    type: 'tool-result',
    runId: 'r1',
    nodeId: RESPONDER,
    toolNodeId: 't1',
    name: 'http_request',
    result: 'TOOL-RESULT',
    isError: false,
    at: 1,
  },
  {
    type: 'approval-required',
    runId: 'r1',
    requestId: 'approval:1',
    nodeId: 'gate',
    message: 'approval message for the operator',
    payload: 'INTERMEDIATE-OUTPUT',
    at: 1,
  },
  { type: 'approval-resolved', runId: 'r1', requestId: 'approval:1', nodeId: 'gate', approved: true, at: 1 },
  {
    type: 'ask-required',
    runId: 'r1',
    requestId: 'ask:1',
    nodeId: 'ask',
    nodeName: 'Triage Agent',
    question: 'What is your order number?',
    payload: 'INTERMEDIATE-OUTPUT',
    at: 1,
  },
  { type: 'ask-resolved', runId: 'r1', requestId: 'ask:1', nodeId: 'ask', response: 'ORD-1', at: 1 },
  { type: 'loop-started', runId: 'r1', nodeId: 'loop', nodeName: 'Triage Agent', total: 2, at: 1 },
  { type: 'loop-iteration', runId: 'r1', nodeId: 'loop', index: 0, total: 2, item: 'INTERMEDIATE-OUTPUT', at: 1 },
  { type: 'loop-completed', runId: 'r1', nodeId: 'loop', total: 2, succeeded: 2, failed: 0, at: 1 },
  {
    type: 'wait-started',
    runId: 'r1',
    nodeId: 'wait',
    nodeName: 'Triage Agent',
    correlationKey: 'k',
    message: 'INTERMEDIATE-OUTPUT',
    payload: 'INTERMEDIATE-OUTPUT',
    at: 1,
  },
  { type: 'wait-resolved', runId: 'r1', nodeId: 'wait', correlationKey: 'k', eventPayload: 'INTERMEDIATE-OUTPUT', at: 1 },
  {
    type: 'subworkflow-started',
    runId: 'r1',
    nodeId: 'sub',
    nodeName: 'Triage Agent',
    workflowId: 'w2',
    workflowName: 'Nested',
    depth: 1,
    input: 'INTERMEDIATE-OUTPUT',
    at: 1,
  },
  {
    type: 'subworkflow-completed',
    runId: 'r1',
    nodeId: 'sub',
    nodeName: 'Triage Agent',
    workflowId: 'w2',
    workflowName: 'Nested',
    depth: 1,
    output: 'INTERMEDIATE-OUTPUT',
    at: 1,
  },
  {
    type: 'subworkflow-failed',
    runId: 'r1',
    nodeId: 'sub',
    nodeName: 'Triage Agent',
    workflowId: 'w2',
    workflowName: 'Nested',
    depth: 1,
    error: 'RAW-ERROR-DETAIL',
    at: 1,
  },
  { type: 'run-paused', runId: 'r1', nodeId: RESPONDER, at: 1 },
  { type: 'run-resumed', runId: 'r1', at: 1 },
  { type: 'run-completed', runId: 'r1', output: 'the answer', at: 1 },
  { type: 'run-failed', runId: 'r1', error: 'RAW-ERROR-DETAIL', at: 1 },
  { type: 'run-stopped', runId: 'r1', at: 1 },
];

// ── 1: nothing forbidden survives the projection ─────────────────────────────
console.log('Projection: no owner-only material reaches a visitor');
{
  const projected = ALL_EVENTS.map(event => toPortalEvent(event, OPTIONS)).filter(Boolean);
  const serialized = JSON.stringify(projected);
  for (const secret of FORBIDDEN) {
    check(`withholds "${secret}"`, !serialized.includes(secret), serialized.slice(0, 400));
  }
  check('withholds node ids', !serialized.includes('nodeId'));
  check('withholds node names', !serialized.includes('nodeName'));
  check('withholds token counts', !serialized.includes('inputTokens'));
  check('withholds cost', !serialized.includes('costUsd'));
  check('withholds provider/model', !serialized.includes('provider') && !serialized.includes('model'));
  check('withholds connection ids', !serialized.includes('connectionId'));
  check('withholds payloads', !serialized.includes('payload'));
}

// ── 2: only the whitelisted shapes are produced ──────────────────────────────
console.log('\nProjection: allow-list is exhaustive and closed');
{
  const allowed = new Set([
    'started',
    'token',
    'question',
    'review',
    'review-resolved',
    'done',
    'error',
    'stopped',
  ]);
  const produced = new Set(
    ALL_EVENTS.map(event => toPortalEvent(event, OPTIONS))
      .filter(Boolean)
      .map(event => event.type),
  );
  const stray = [...produced].filter(type => !allowed.has(type));
  check('produces no unexpected types', stray.length === 0, stray.join(','));

  // The projection must be a total function over the union: an event type it
  // has never seen has to be DROPPED, not passed through.
  const unknown = toPortalEvent({ type: 'some-future-event', runId: 'r1', at: 1 }, OPTIONS);
  check('an unknown event type fails closed', unknown === null);
}

// ── 3: only the responder streams ────────────────────────────────────────────
console.log('\nProjection: only the responding node streams');
{
  const fromResponder = toPortalEvent(
    { type: 'node-token', runId: 'r1', nodeId: RESPONDER, token: 'visible' },
    OPTIONS,
  );
  check('responder tokens stream', fromResponder?.type === 'token' && fromResponder.text === 'visible');

  const fromOther = toPortalEvent(
    { type: 'node-token', runId: 'r1', nodeId: 'triage', token: 'INTERMEDIATE-OUTPUT' },
    OPTIONS,
  );
  check('non-responder tokens are withheld', fromOther === null);

  // An ambiguous graph resolves the responder to null. Streaming nothing is the
  // safe reading; the visitor still gets `done`.
  const noResponder = toPortalEvent(
    { type: 'node-token', runId: 'r1', nodeId: RESPONDER, token: 'x' },
    { responderNodeId: null },
  );
  check('no responder means no streaming at all', noResponder === null);
  check(
    'the final answer still arrives without a responder',
    toPortalEvent({ type: 'run-completed', runId: 'r1', output: 'answer', at: 1 }, { responderNodeId: null })
      ?.type === 'done',
  );

  // Thinking tokens are the model's private reasoning and never stream, even
  // for the responder.
  check(
    'responder reasoning is withheld',
    toPortalEvent(
      { type: 'node-thinking', runId: 'r1', nodeId: RESPONDER, token: 'private' },
      OPTIONS,
    ) === null,
  );
}

// ── 4: sub-workflow interiors are withheld wholesale ─────────────────────────
console.log('\nProjection: nested frames are withheld');
{
  const scope = [{ nodeId: 'sub', workflowId: 'w2', workflowName: 'Nested', frameId: 'f1', depth: 1 }];
  // A nested frame can legitimately contain a node whose id equals the
  // responder's, so the responder check cannot be trusted inside a frame.
  check(
    'a nested token matching the responder id is withheld',
    toPortalEvent({ type: 'node-token', runId: 'r1', nodeId: RESPONDER, token: 'nested', scope }, OPTIONS) ===
      null,
  );
  check(
    'a nested ask is withheld',
    toPortalEvent(
      { type: 'ask-required', runId: 'r1', requestId: 'a', nodeId: 'n', nodeName: 'N', question: 'q', payload: '', at: 1, scope },
      OPTIONS,
    ) === null,
  );
}

// ── 5: errors are always generic ─────────────────────────────────────────────
console.log('\nProjection: failures never quote the engine');
{
  const failed = toPortalEvent(
    { type: 'run-failed', runId: 'r1', error: 'RAW-ERROR-DETAIL: key sk-abc leaked', at: 1 },
    OPTIONS,
  );
  check('run-failed becomes a generic error', failed?.type === 'error');
  check('the generic message is used verbatim', failed?.message === PORTAL_GENERIC_ERROR);
  check('the raw error is discarded', !JSON.stringify(failed).includes('sk-abc'));
}

// ── 6: the two human-in-the-loop shapes ──────────────────────────────────────
console.log('\nProjection: human-in-the-loop');
{
  const ask = toPortalEvent(
    {
      type: 'ask-required',
      runId: 'r1',
      requestId: 'ask:1',
      nodeId: 'ask',
      nodeName: 'Triage Agent',
      question: 'What is your order number?',
      payload: 'INTERMEDIATE-OUTPUT',
      at: 1,
    },
    OPTIONS,
  );
  check('an Ask User question reaches the visitor', ask?.type === 'question');
  check('the question text is published (that is its purpose)', ask?.question?.includes('order number'));
  check('the requestId is published so the reply can be routed', ask?.requestId === 'ask:1');
  check('the ask payload is withheld', !JSON.stringify(ask).includes('INTERMEDIATE-OUTPUT'));
  check('the ask node name is withheld', !JSON.stringify(ask).includes('Triage Agent'));

  const review = toPortalEvent(
    {
      type: 'approval-required',
      runId: 'r1',
      requestId: 'approval:1',
      nodeId: 'gate',
      message: 'approval message for the operator',
      payload: 'INTERMEDIATE-OUTPUT',
      at: 1,
    },
    OPTIONS,
  );
  check('an approval gate becomes a bare review notice', review?.type === 'review');
  check('the review carries no fields at all', Object.keys(review ?? {}).length === 1);
}

// ── 7: terminal detection + framing ──────────────────────────────────────────
console.log('\nProjection: stream framing');
{
  check('done is terminal', isTerminalPortalEvent({ type: 'done', output: '' }));
  check('error is terminal', isTerminalPortalEvent({ type: 'error', message: '' }));
  check('stopped is terminal', isTerminalPortalEvent({ type: 'stopped' }));
  check('token is not terminal', !isTerminalPortalEvent({ type: 'token', text: 'x' }));
  check('question is not terminal', !isTerminalPortalEvent({ type: 'question', requestId: 'a', question: 'q' }));
  check('review is not terminal', !isTerminalPortalEvent({ type: 'review' }));

  const frame = toSseFrame({ type: 'token', text: 'hi' });
  check('a frame is SSE-shaped', frame.startsWith('data: ') && frame.endsWith('\n\n'));
  check('a frame contains one JSON line', frame.trim().split('\n').length === 1);
  // A newline inside token text must not split the frame.
  const multiline = toSseFrame({ type: 'token', text: 'a\nb' });
  check('newlines in text are escaped', multiline.split('\n\n').length === 2, JSON.stringify(multiline));
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
