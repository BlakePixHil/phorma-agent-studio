/**
 * Evals — test suites against workflows (EPIC 4).
 *
 * A suite is a list of cases (input + expectation + matcher). The engine
 * owns the shared types and the pure scoring logic so it behaves identically
 * in the studio and any future cloud runner. Running the workflow itself is
 * the host's job (the studio's eval runner calls `startRun` per case and
 * hands the final output to {@link scoreOutput}).
 *
 * Matchers:
 * - `exact`    — trimmed string equality.
 * - `contains` — case-insensitive substring.
 * - `llm-judge` — a one-off model call grades the output against the
 *   expectation (plus optional free-form criteria) and returns strict JSON.
 * - `decision-judge` - System One answers a calibrated battery (answers the
 *   input, matches expected, contradicts expected, meets criteria) and the
 *   weighted composite is the score. Deterministic at a fixed model version,
 *   and roughly a thousand times cheaper than an LLM judge.
 *
 * Pure TypeScript, zero framework dependencies — same rules as the rest of
 * the engine package.
 */

import type { ModelClient, ModelRequest } from './model.js';
import type { ModelProviderId } from './types.js';
import type { RunEnvironment } from './run-record.js';
import { DEFAULT_DECISION_MODEL, decisionCostUsd, type DecisionClient } from './decisions.js';
import { judgeQuestions, judgeScore } from './decision-batteries.js';

/** How a case's expected value is compared against the run output. */
export type EvalMatcher = 'exact' | 'contains' | 'llm-judge' | 'decision-judge';

/** True for matchers that grade against a reference answer (and take criteria). */
export function isJudgeMatcher(matcher: EvalMatcher): boolean {
  return matcher === 'llm-judge' || matcher === 'decision-judge';
}

/** One test case in a suite. */
export interface EvalCase {
  id: string;
  name: string;
  /** The run input handed to the workflow trigger. */
  input: string;
  /** The expected output (exact/contains) or reference answer (llm-judge). */
  expected: string;
  matcher: EvalMatcher;
  /** Extra grading instructions for the judge (llm-judge only). */
  judgeCriteria?: string;
}

/** A provider/model pair (judge model, or one comparison pass). */
export interface EvalModelRef {
  provider: ModelProviderId;
  model: string;
}

/** A persisted eval suite, keyed to a workflow. */
export interface EvalSuite {
  id: string;
  /** Library workflow id, or null for unsaved drafts. */
  workflowId: string | null;
  name: string;
  cases: EvalCase[];
  /** Model used for llm-judge scoring; host default model when absent. */
  judge?: EvalModelRef;
  /** decision-judge tuning: pass threshold (default 0.7) and pinned model. */
  decisionJudge?: { passAt?: number; model?: string };
  /**
   * Comparison matrix: when present, the suite runs once per model with
   * `RunOptions.defaultModel` overridden (agents pinning an explicit model
   * are unaffected). Absent/empty = a single pass with host defaults.
   */
  models?: EvalModelRef[];
  createdAt: number;
  updatedAt: number;
}

/** Verdict produced by {@link scoreOutput}. */
export interface EvalScore {
  pass: boolean;
  /** 0..1 — 0/1 for deterministic matchers, graded for llm-judge. */
  score: number;
  /** Judge reasoning, or a short note on deterministic mismatches. */
  reasoning?: string;
}

/** Outcome of a single case execution within one model pass. */
export interface EvalCaseResult {
  caseId: string;
  /** RunRecord id of the underlying workflow run (source `eval`). */
  runId: string;
  /** `provider:model` label of the comparison pass, absent for defaults. */
  model?: string;
  status: 'passed' | 'failed' | 'error';
  /** Final run output (clipped by the host before persisting). */
  output: string;
  score?: number;
  judgeReasoning?: string;
  /** Run failure or judge failure message when status = error. */
  error?: string;
  durationMs: number;
  costUsd?: number;
}

/** Terminal (or in-flight) status of a suite run. */
export type EvalRunStatus = 'running' | 'completed' | 'cancelled' | 'failed';

/** One persisted execution of a suite. */
export interface EvalRunSummary {
  id: string;
  suiteId: string;
  workflowId: string | null;
  suiteName: string;
  environment: RunEnvironment;
  status: EvalRunStatus;
  /** `provider:model` labels of comparison passes; empty = defaults pass. */
  models: string[];
  results: EvalCaseResult[];
  startedAt: number;
  endedAt?: number;
}

/** Stable `provider:model` label for a comparison pass. */
export function evalModelLabel(ref: EvalModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

/** Pass counts for a suite run (a result row's at-a-glance projection). */
export function evalPassCounts(run: EvalRunSummary): { passed: number; total: number } {
  const passed = run.results.filter((result) => result.status === 'passed').length;
  return { passed, total: run.results.length };
}

const JUDGE_SYSTEM_PROMPT = `You are a strict evaluation judge for AI workflow outputs.
You will receive a workflow's INPUT, its actual OUTPUT, an EXPECTED reference answer, and optional extra CRITERIA.
Grade how well the OUTPUT satisfies the EXPECTED answer (and CRITERIA when given).
Respond with ONLY a JSON object — no prose, no code fences:
{"pass": boolean, "score": number, "reasoning": string}
- "score" is 0 to 1 (1 = fully satisfies the expectation).
- "pass" is true only when the output genuinely satisfies the expectation.
- "reasoning" is one or two concise sentences.`;

/** Options for {@link scoreOutput} when the case uses the llm-judge matcher. */
export interface EvalJudgeOptions {
  client: ModelClient;
  judge: EvalModelRef;
  /** Extra ModelRequest fields (ollamaBaseUrl, bedrockRegion, …). */
  request?: Partial<
    Pick<ModelRequest, 'ollamaBaseUrl' | 'lmstudioBaseUrl' | 'bedrockRegion' | 'maxTokens'>
  >;
}

/** Options for {@link scoreOutput} when the case uses the decision-judge matcher. */
export interface EvalDecisionJudgeOptions {
  client: DecisionClient;
  /** Pinned model; `jev-latest` when absent. */
  model?: string;
  /** Composite score at or above this passes (default 0.7). */
  passAt?: number;
}

/** A decision-judge verdict carries its own cost so hosts can add it to the case. */
export interface EvalDecisionScore extends EvalScore {
  costUsd: number;
}

/**
 * Scores a run output against a case. Deterministic matchers are pure;
 * `llm-judge` requires {@link EvalJudgeOptions} and makes one model call;
 * `decision-judge` requires {@link EvalDecisionJudgeOptions} and makes one
 * System One call. Judge failures (unusable response, thrown error) reject -
 * the caller records the case as `error`, never silently passed/failed.
 */
export async function scoreOutput(
  evalCase: EvalCase,
  output: string,
  judge?: EvalJudgeOptions,
  decisionJudge?: EvalDecisionJudgeOptions,
): Promise<EvalScore> {
  switch (evalCase.matcher) {
    case 'exact': {
      const pass = output.trim() === evalCase.expected.trim();
      return {
        pass,
        score: pass ? 1 : 0,
        reasoning: pass ? undefined : 'Output does not exactly match the expected text.',
      };
    }
    case 'contains': {
      const pass = output.toLowerCase().includes(evalCase.expected.trim().toLowerCase());
      return {
        pass,
        score: pass ? 1 : 0,
        reasoning: pass ? undefined : 'Output does not contain the expected text.',
      };
    }
    case 'llm-judge': {
      if (!judge) throw new Error('llm-judge matcher requires a judge model.');
      return judgeOutput(evalCase, output, judge);
    }
    case 'decision-judge': {
      if (!decisionJudge) {
        throw new Error(
          'decision-judge matcher requires System One. Add a TypeSafe key in Settings or sign in to Phorma Cloud.',
        );
      }
      return decisionJudgeOutput(evalCase, output, decisionJudge);
    }
  }
}

/** One System One call grading `output` against the case. */
export async function decisionJudgeOutput(
  evalCase: EvalCase,
  output: string,
  options: EvalDecisionJudgeOptions,
): Promise<EvalDecisionScore> {
  const clipField = (text: string): string => clip(text || '(empty)', 20_000);
  const result = await options.client.evaluate({
    model: options.model?.trim() || DEFAULT_DECISION_MODEL,
    state: {
      input: clipField(evalCase.input),
      output: clipField(output),
      expected: clipField(evalCase.expected),
    },
    questions: judgeQuestions(evalCase.judgeCriteria),
  });
  const verdict = judgeScore(result.answers, options.passAt ?? 0.7);
  return { ...verdict, costUsd: decisionCostUsd(result.usage) };
}

async function judgeOutput(
  evalCase: EvalCase,
  output: string,
  judge: EvalJudgeOptions,
): Promise<EvalScore> {
  const criteria = evalCase.judgeCriteria?.trim();
  const user = [
    `INPUT:\n${evalCase.input}`,
    `OUTPUT:\n${output}`,
    `EXPECTED:\n${evalCase.expected}`,
    ...(criteria ? [`CRITERIA:\n${criteria}`] : []),
  ].join('\n\n');
  const request: ModelRequest = {
    provider: judge.judge.provider,
    model: judge.judge.model,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
    temperature: 0,
    ...judge.request,
  };
  let text = '';
  for await (const chunk of judge.client.stream(request)) {
    if (chunk.type === 'text') text += chunk.text;
  }
  const verdict = parseJudgeVerdict(text);
  if (!verdict) {
    throw new Error(`Judge returned an unparseable verdict: ${clip(text, 300)}`);
  }
  return verdict;
}

/**
 * Extracts a `{pass, score, reasoning}` object from judge output. Tolerates
 * surrounding prose and code fences; returns null when nothing usable is
 * found.
 */
export function parseJudgeVerdict(text: string): EvalScore | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  // Walk balanced braces so trailing prose after the JSON doesn't break parsing.
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      try {
        const raw = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        if (typeof raw['pass'] !== 'boolean') return null;
        const score =
          typeof raw['score'] === 'number' ? Math.min(1, Math.max(0, raw['score'])) : raw['pass'] ? 1 : 0;
        return {
          pass: raw['pass'],
          score,
          reasoning: typeof raw['reasoning'] === 'string' ? raw['reasoning'] : undefined,
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
