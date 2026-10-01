/**
 * Workflow variables: named, typed values declared once in
 * `WorkflowSettings.variables` and read as `{{vars.name}}` in payload
 * templates and agent prompts, and as `vars.name` in expressions.
 *
 * Precedence is fixed: the `vars.` prefix ALWAYS resolves against the variable
 * scope and NEVER against the payload. Payload data is often untrusted (a
 * fetched record, a webhook body), and a configured switch such as a dry-run
 * flag must not be something a record can shadow.
 *
 * Variables are configuration, not credentials. A name or value that looks
 * like a secret is refused here and the author is pointed at Connections,
 * which keep secrets in the host's keychain or secret store.
 *
 * Pure: no I/O, no ambient state. Hosts call `resolveWorkflowVariables` when a
 * run starts; the capability validator calls `validateWorkflowVariables` and
 * the reference scanners.
 */

import { credentialShapeOf } from './connectors.js';
import type { Json } from './expr.js';
import type { WorkflowSettings, WorkflowVariable, WorkflowVariableType } from './types.js';

/** Resolved `name -> value` record one run frame reads as `vars`. */
export type VariableScope = Readonly<Record<string, Json>>;

export const VARIABLE_TYPES: readonly WorkflowVariableType[] = [
  'text',
  'markdown',
  'number',
  'boolean',
  'list',
] as const;

/** Identifier rule shared by templates (`{{vars.x}}`) and expressions (`vars.x`). */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Largest single value, measured as UTF-8 JSON. */
export const VARIABLE_VALUE_MAX_BYTES = 65_536;

/** Largest resolved scope, measured as UTF-8 JSON. */
export const VARIABLE_SCOPE_MAX_BYTES = 262_144;

/** Most variables one workflow may declare. */
export const MAX_WORKFLOW_VARIABLES = 100;

/** One problem with a declared variable. `name` is the declared name, possibly invalid. */
export interface VariableIssue {
  name: string;
  message: string;
}

/**
 * Credential-shaped name fragments, matched against the lower-cased name with
 * separators removed. `token` alone is NOT listed: `maxTokens` is a legitimate
 * setting. Only the compound forms that name a credential are.
 */
const SECRET_NAME_FRAGMENTS: readonly string[] = [
  'secret',
  'password',
  'passwd',
  'passphrase',
  'apikey',
  'privatekey',
  'accesskey',
  'credential',
  'bearer',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'apitoken',
  'sessiontoken',
  'clientsecret',
];

/** True when a variable name reads as a credential name. */
export function looksLikeSecretVariableName(name: string): boolean {
  const squashed = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return squashed === 'token' || SECRET_NAME_FRAGMENTS.some(fragment => squashed.includes(fragment));
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The value coerced to its declared type, or undefined when it cannot be read
 * as that type without guessing. Strings stand in for numbers and booleans
 * because a hand-edited spec often carries `"20"` or `"true"`; a list accepts
 * a newline-separated string for the same reason.
 */
export function coerceVariableValue(type: WorkflowVariableType, value: unknown): Json | undefined {
  switch (type) {
    case 'text':
    case 'markdown':
      return typeof value === 'string' ? value : undefined;
    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      if (typeof value !== 'string' || value.trim() === '') return undefined;
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value !== 'string') return undefined;
      const text = value.trim().toLowerCase();
      if (text === 'true') return true;
      if (text === 'false') return false;
      return undefined;
    }
    case 'list': {
      if (Array.isArray(value)) {
        return value.every(item => typeof item === 'string') ? [...(value as string[])] : undefined;
      }
      if (typeof value === 'string') {
        return value
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Every string the value carries, for credential scanning. */
function stringsOf(value: Json | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

/**
 * Every problem with a declared variable list, in declaration order. An empty
 * array means the list is valid. Never throws, whatever `list` holds.
 */
export function validateWorkflowVariables(list: unknown): VariableIssue[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    return [{ name: '(variables)', message: 'Workflow variables must be a list.' }];
  }

  const issues: VariableIssue[] = [];
  if (list.length > MAX_WORKFLOW_VARIABLES) {
    issues.push({
      name: '(variables)',
      message: `A workflow declares at most ${MAX_WORKFLOW_VARIABLES} variables; this one declares ${list.length}.`,
    });
  }

  const seen = new Set<string>();
  let scopeBytes = 0;
  for (const entry of list) {
    const record = readRecord(entry);
    const rawName = record && typeof record['name'] === 'string' ? record['name'] : '';
    const name = rawName.trim();
    const label = name.length > 0 ? name : '(unnamed)';
    if (!record) {
      issues.push({ name: label, message: 'A workflow variable must be an object.' });
      continue;
    }

    if (!VARIABLE_NAME_PATTERN.test(name)) {
      issues.push({
        name: label,
        message:
          `Variable name "${label}" is invalid: use letters, digits and underscores, ` +
          'starting with a letter or underscore (at most 64 characters).',
      });
      continue;
    }
    if (seen.has(name)) {
      issues.push({ name, message: `Variable "${name}" is declared more than once.` });
      continue;
    }
    seen.add(name);

    if (looksLikeSecretVariableName(name)) {
      issues.push({
        name,
        message:
          `Variable "${name}" is named like a credential. Variables are visible ` +
          'configuration; store secrets in a Connection instead.',
      });
      continue;
    }

    const type = record['type'];
    if (typeof type !== 'string' || !(VARIABLE_TYPES as readonly string[]).includes(type)) {
      issues.push({
        name,
        message: `Variable "${name}" has no usable type; use one of ${VARIABLE_TYPES.join(', ')}.`,
      });
      continue;
    }

    const value = coerceVariableValue(type as WorkflowVariableType, record['value']);
    if (value === undefined) {
      issues.push({ name, message: `Variable "${name}" does not hold a valid ${type} value.` });
      continue;
    }

    const shape = stringsOf(value)
      .map(text => credentialShapeOf(text))
      .find(found => found !== undefined);
    if (shape) {
      issues.push({
        name,
        message:
          `Variable "${name}" appears to hold ${shape}. Store secrets in a ` +
          'Connection, never in a workflow variable.',
      });
      continue;
    }

    const bytes = utf8Bytes(JSON.stringify(value));
    if (bytes > VARIABLE_VALUE_MAX_BYTES) {
      issues.push({
        name,
        message: `Variable "${name}" is ${bytes} bytes, above the ${VARIABLE_VALUE_MAX_BYTES}-byte limit.`,
      });
      continue;
    }
    scopeBytes += bytes;
  }

  if (scopeBytes > VARIABLE_SCOPE_MAX_BYTES) {
    issues.push({
      name: '(variables)',
      message: `Workflow variables total ${scopeBytes} bytes, above the ${VARIABLE_SCOPE_MAX_BYTES}-byte limit.`,
    });
  }
  return issues;
}

/**
 * The run-frame scope for a workflow's settings. Only entries that pass
 * validation are included, so an invalid declaration resolves to "undefined"
 * (a template token stays verbatim) rather than to a guessed value.
 */
export function resolveWorkflowVariables(
  settings: Pick<WorkflowSettings, 'variables'> | undefined | null,
): VariableScope {
  const list = settings?.variables;
  if (!Array.isArray(list)) return {};
  const invalid = new Set(validateWorkflowVariables(list).map(issue => issue.name));
  const scope: Record<string, Json> = {};
  for (const entry of list as WorkflowVariable[]) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!VARIABLE_NAME_PATTERN.test(name) || invalid.has(name)) continue;
    const value = coerceVariableValue(entry.type, entry.value);
    if (value !== undefined) scope[name] = value;
  }
  return scope;
}

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** Distinct variable names a template references through `{{vars.name...}}`. */
export function templateVariableReferences(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_VARIABLE_PATTERN)) names.add(match[1]!);
  return [...names];
}

/**
 * Distinct variable names an expression source references through
 * `vars.name`. Lexical on purpose: it also sees references inside
 * sub-expression strings (`filter($.rows, 'item.n > vars.min')`), which the
 * compiled AST holds only as string literals.
 */
export function expressionVariableReferences(source: string): string[] {
  const names = new Set<string>();
  const pattern = /(^|[^A-Za-z0-9_$.])vars\.([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(pattern)) names.add(match[2]!);
  return [...names];
}
