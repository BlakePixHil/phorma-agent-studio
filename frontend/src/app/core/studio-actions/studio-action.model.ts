/**
 * Studio_Action model - the declarative description of one executable studio
 * capability (spec: `.kiro/specs/agent-studio-actions/requirements.md`).
 *
 * Every assistant mode consumes the SAME registry entries: Agent mode turns
 * them into live tool definitions, Plan mode proposes them as reviewable
 * ops, Ask mode receives the read-only subset. Adding a capability is one
 * registry entry plus its executor - no edit to the tool list, the apply
 * switch, or the prompts (Requirement 1.6).
 *
 * Keep this file free of Angular imports so it stays trivially testable.
 */

import type { ToolDefinition } from '@phorma/engine';

import type { CapabilityLevel } from '../capabilities';

/** Whether an action reads studio state or writes it. */
export type ActionAccess = 'read' | 'write';

/** The studio area an action belongs to. */
export type ActionSurface =
  | 'graph'
  | 'evals'
  | 'runs'
  | 'prompts'
  | 'workflows'
  | 'versions'
  | 'deploy'
  | 'skills'
  | 'connections'
  | 'portal'
  | 'usage'
  | 'settings'
  | 'navigation'
  | 'web';

/**
 * Guardrail tier. `silent` executes immediately; `confirm` routes through
 * `ConfirmDialogService` first (Requirement 6).
 */
export type ActionRisk = 'silent' | 'confirm';

/**
 * Supported parameter shapes for an action's JSON schema. `any` exists for the
 * one genuinely polymorphic case - a settings value, whose type is decided by
 * the setting's own control descriptor rather than by the schema.
 */
export type ActionParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'object'
  | 'any';

/** One declared parameter of a Studio_Action. */
export interface ActionParam {
  type: ActionParamType;
  description: string;
  required?: boolean;
  /** Allowed values for `string` params (also narrows the tool schema). */
  enum?: readonly string[];
}

/** Validated argument bag handed to an executor. */
export type ActionArgs = Record<string, unknown>;

/**
 * The structured value every execution returns (Requirement 1.4). `ok: false`
 * always carries a single-sentence `message`.
 */
export interface ActionResult {
  ok: boolean;
  /** Single-sentence failure reason, or a short note on success. */
  message?: string;
  /** Payload for successful reads and writes. Never contains secrets. */
  data?: unknown;
  /**
   * False when the effect sits outside Edit_Session coverage, so the turn
   * summary can separate it from revertable graph edits (Requirement 7.4).
   */
  revertable?: boolean;
}

/** One Action_Registry entry. */
export interface StudioAction {
  /** Stable id, also the Agent-mode tool name. */
  id: string;
  /** Short imperative label used in confirms and activity lines. */
  label: string;
  /** Plain-language description offered to the model. */
  description: string;
  surface: ActionSurface;
  access: ActionAccess;
  risk: ActionRisk;
  /**
   * The minimum Capability_Level this action requires
   * (multi-organisation-phorma Requirement 8.1).
   *
   * DATA, not a decision. The comparison happens once, in
   * `StudioActionRegistryService.available`, through `CapabilityService.allows` -
   * the same seam `PanelTab.minLevel` goes through. An absent value reads as the
   * least capable level, and that default lives INSIDE the capability module
   * rather than here, so no call site carries a level literal
   * (Requirement 7.4).
   *
   * Declared on EVERY entry even where it repeats the default, because the field
   * is what says the tier was considered. `risk` and `minLevel` are orthogonal
   * (Requirement 8.6): `risk` asks the user, `minLevel` decides whether the
   * action is offered at all, and neither substitutes for the other.
   */
  minLevel?: CapabilityLevel;
  params?: Record<string, ActionParam>;
  /** True when the action mutates the canvas graph (Edit_Session coverage). */
  graphEdit?: boolean;
  /** True when the action needs the desktop shell (Requirement 10.4). */
  requiresDesktop?: boolean;
  /** Confirm-dialog body for `risk: 'confirm'`; falls back to the label. */
  confirmSummary?: (args: ActionArgs) => string;
  /** Human-readable activity line, e.g. "Creating eval suite 'Smoke'". */
  activity?: (args: ActionArgs) => string;
  run: (args: ActionArgs) => ActionResult | Promise<ActionResult>;
}

/** Builds a successful Action_Result. */
export function actionOk(data?: unknown, extra?: Partial<ActionResult>): ActionResult {
  return { ok: true, ...(data === undefined ? {} : { data }), ...extra };
}

/** Builds a failed Action_Result with a one-sentence message. */
export function actionFail(message: string): ActionResult {
  return { ok: false, message };
}

/** Reads a validated string argument. */
export function argStr(args: ActionArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads a validated number argument. */
export function argNum(args: ActionArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reads a validated boolean argument. */
export function argBool(args: ActionArgs, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Reads a validated string-list argument. */
export function argList(args: ActionArgs, key: string): string[] | undefined {
  const value = args[key];
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? (value as string[])
    : undefined;
}

/** Reads a validated object argument. */
export function argObj(args: ActionArgs, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Outcome of schema validation for one call. */
export type ArgValidation =
  | { ok: true; args: ActionArgs }
  | { ok: false; message: string };

function typeMatches(type: ActionParamType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every(item => typeof item === 'string');
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'any':
      return true;
  }
}

/**
 * Validates raw arguments against an action's declared parameters
 * (Requirement 3.4). Unknown keys are dropped rather than rejected - models
 * routinely add extras and a hard failure there is pure friction. Numbers
 * arriving as numeric strings are coerced, because several providers stringify
 * every argument.
 */
export function validateArgs(action: StudioAction, raw: unknown): ArgValidation {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { ok: false, message: `Arguments for '${action.id}' must be a JSON object.` };
  }
  const source = (raw ?? {}) as Record<string, unknown>;
  const params = action.params ?? {};
  const args: ActionArgs = {};
  for (const [key, param] of Object.entries(params)) {
    let value = source[key];
    if (value === undefined || value === null) {
      if (param.required) {
        return { ok: false, message: `Invalid parameter '${key}': it is required.` };
      }
      continue;
    }
    if (param.type === 'number' && typeof value === 'string' && value.trim() !== '') {
      const coerced = Number(value);
      if (Number.isFinite(coerced)) value = coerced;
    }
    if (param.type === 'boolean' && typeof value === 'string') {
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
    }
    if (!typeMatches(param.type, value)) {
      return {
        ok: false,
        message: `Invalid parameter '${key}': expected ${param.type}.`,
      };
    }
    if (param.enum && typeof value === 'string' && !param.enum.includes(value)) {
      return {
        ok: false,
        message: `Invalid parameter '${key}': expected one of ${param.enum.join(', ')}.`,
      };
    }
    args[key] = value;
  }
  return { ok: true, args };
}

function jsonSchemaOf(param: ActionParam): Record<string, unknown> {
  const base: Record<string, unknown> = { description: param.description };
  switch (param.type) {
    case 'string[]':
      return { ...base, type: 'array', items: { type: 'string' } };
    case 'object':
      return { ...base, type: 'object' };
    // Intentionally untyped: the accepted type depends on the target setting.
    case 'any':
      return base;
    default:
      return {
        ...base,
        type: param.type,
        ...(param.enum ? { enum: [...param.enum] } : {}),
      };
  }
}

/** Derives the Agent-mode tool definition from a registry entry. */
export function toolDefinitionOf(action: StudioAction): ToolDefinition {
  const params = action.params ?? {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, param] of Object.entries(params)) {
    properties[key] = jsonSchemaOf(param);
    if (param.required) required.push(key);
  }
  return {
    name: action.id,
    description: action.description,
    parameters: { type: 'object', properties, required },
  } as ToolDefinition;
}

/** Default activity line when an action declares none. */
export function describeAction(action: StudioAction, args: ActionArgs): string {
  if (action.activity) {
    try {
      return action.activity(args);
    } catch {
      // A broken activity formatter must never break a turn.
    }
  }
  return action.label;
}
