/**
 * Studio-internal System One assists: palette search by meaning, next-step
 * suggestions, and failed-run triage. Pure question builders and answer
 * readers plus one `evaluate` helper; the callers own UI state.
 *
 * Loaded with a dynamic `import()` from the surfaces that use it, so none of
 * it lands in the initial bundle. Every call is optional polish: callers
 * degrade silently to the non-System-One behaviour on any failure.
 */

import type {
  ChoiceAnswer,
  DecisionAnswer,
  DecisionClient,
  DecisionQuestion,
} from '@phorma/engine';

/** A catalog entry as the assists see it. */
export interface AssistEntry {
  id: string;
  label: string;
  description: string;
}

/** One ranked suggestion. */
export interface AssistSuggestion {
  id: string;
  label: string;
  probability: number;
}

/** Choice option labels must be unique; disambiguate duplicates. */
function uniqueLabels(entries: readonly AssistEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map(entry => {
    const base = entry.label.trim() || entry.id;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function rankQuestion(
  instructions: string,
  entries: readonly AssistEntry[],
): { question: DecisionQuestion; labels: string[] } {
  const capped = entries.slice(0, 255);
  const labels = uniqueLabels(capped);
  const criteria: Record<string, string> = {};
  labels.forEach((label, index) => {
    criteria[label] = capped[index]!.description.slice(0, 300) || label;
  });
  return { question: { type: 'choice', instructions, criteria }, labels };
}

function ranked(
  entries: readonly AssistEntry[],
  labels: readonly string[],
  answer: DecisionAnswer | undefined,
  limit: number,
  minProbability: number,
): AssistSuggestion[] {
  if (answer?.type !== 'choice') return [];
  const probabilities = (answer as ChoiceAnswer).probabilities;
  return labels
    .map((label, index) => ({
      id: entries[index]!.id,
      label: entries[index]!.label,
      probability: probabilities[label] ?? 0,
    }))
    .filter(entry => entry.probability >= minProbability)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit);
}

/**
 * Palette search by meaning: which node types best fit what the user typed.
 * Used only when the literal search finds nothing, so a typo or a goal
 * ("send a slack message when a form is filled") still leads somewhere.
 */
export async function suggestNodesForQuery(
  client: DecisionClient,
  model: string,
  query: string,
  entries: readonly AssistEntry[],
  limit = 4,
): Promise<AssistSuggestion[]> {
  const { question, labels } = rankQuestion(
    'Which workflow building block best matches what the user is looking for in `search`?',
    entries,
  );
  const result = await client.evaluate({
    model,
    state: { search: query.slice(0, 500) },
    questions: { match: question },
  });
  return ranked(entries, labels, result.answers['match'], limit, 0.05);
}

/**
 * Next-step suggestion for the selected node: which building block most
 * naturally follows it, given the workflow so far.
 */
export async function suggestNextNodes(
  client: DecisionClient,
  model: string,
  context: { workflowName: string; selected: string; existing: readonly string[] },
  entries: readonly AssistEntry[],
  limit = 3,
): Promise<AssistSuggestion[]> {
  const { question, labels } = rankQuestion(
    'Which building block should come directly after `selected` in this workflow?',
    entries,
  );
  const result = await client.evaluate({
    model,
    state: {
      workflow: context.workflowName.slice(0, 200),
      selected: context.selected.slice(0, 1000),
      existing_steps: context.existing.slice(0, 60).join(', ').slice(0, 4000),
    },
    questions: { next: question },
  });
  return ranked(entries, labels, result.answers['next'], limit, 0.08);
}

/** Categories a failed run can fall into, with the remedy each points at. */
export const TRIAGE_CATEGORIES: Readonly<Record<string, { description: string; remedy: string }>> = {
  'Missing credentials': {
    description: 'An API key, token, secret or connection is missing, invalid or expired (401, 403, unauthorized).',
    remedy: 'Check the key in Settings or the connection used by the failing step.',
  },
  'Rate limited or quota': {
    description: 'Too many requests, a rate limit, a quota, exhausted credits or a billing limit (429, 402).',
    remedy: 'Wait and retry, raise the retry backoff, or check the plan and credits.',
  },
  'Bad configuration': {
    description: 'A node is misconfigured: a wrong model id, URL, path, missing field or invalid setting.',
    remedy: 'Open the failing step in Properties and fix the setting the message names.',
  },
  'Unexpected data': {
    description: 'The data had the wrong shape: invalid JSON, a missing field, a type mismatch, or an empty result.',
    remedy: 'Inspect the payload handed to the failing step and adjust the upstream output or path.',
  },
  'Upstream outage': {
    description: 'A remote service was down, overloaded, timed out, or returned a 5xx or network error.',
    remedy: 'Retry later, or add retries and a fallback model to the step.',
  },
  'Timeout or loop limit': {
    description: 'The run or a step hit a timeout, the tool-round limit or the execution budget.',
    remedy: 'Raise the timeout or limit, or simplify the loop that ran long.',
  },
  'Model output problem': {
    description: 'The model answered but the answer was unusable, refused, off task or flagged by a check.',
    remedy: 'Tighten the prompt, add a fallback model, or relax the verification threshold.',
  },
};

export interface TriageVerdict {
  category: string;
  confidence: number;
  remedy: string;
  /** P(the failure is transient and a plain retry would likely succeed). */
  retryLikely: number;
}

/** Classifies a failed run's error into one actionable category. */
export async function triageFailure(
  client: DecisionClient,
  model: string,
  failure: { error: string; failedStep?: string; recentTrace: readonly string[] },
): Promise<TriageVerdict | null> {
  const criteria: Record<string, string> = {};
  for (const [label, entry] of Object.entries(TRIAGE_CATEGORIES)) criteria[label] = entry.description;
  const result = await client.evaluate({
    model,
    state: {
      error: failure.error.slice(0, 4000),
      failed_step: (failure.failedStep ?? 'unknown').slice(0, 200),
      recent_trace: failure.recentTrace.slice(-12).join('\n').slice(0, 6000),
    },
    questions: {
      category: { type: 'choice', instructions: 'What most likely caused this workflow run to fail?', criteria },
      transient: {
        type: 'noul',
        instructions: 'Would simply running the workflow again, unchanged, most likely succeed?',
      },
    },
  });
  const answer = result.answers['category'];
  if (answer?.type !== 'choice') return null;
  const chosen = (answer as ChoiceAnswer).choice;
  const entry = TRIAGE_CATEGORIES[chosen];
  if (!entry) return null;
  const transient = result.answers['transient'];
  return {
    category: chosen,
    confidence: (answer as ChoiceAnswer).confidence,
    remedy: entry.remedy,
    retryLikely: transient?.type === 'noul' ? transient.noul : 0,
  };
}
