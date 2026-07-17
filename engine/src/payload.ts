/**
 * Structured payload helpers.
 *
 * Payloads flowing between nodes are strings, but workflows increasingly
 * carry structured JSON (job lists, report figures, correlation ids). These
 * helpers let templates address fields inside a JSON payload —
 * `{{input}}` stays the whole payload; `{{invoice.total}}` digs into it —
 * and let flow nodes (ForEach) extract arrays robustly.
 */

/** Resolves a dotted path (`a.b.0.c`) inside a parsed JSON value. */
export function resolveJsonPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

/**
 * Interpolates `{{token}}` placeholders in a template against a payload.
 *
 * - `{{input}}` — the whole payload (or `(no input provided)` when empty).
 * - `{{a.b.c}}` — a dotted path into the payload parsed as JSON. Non-string
 *   values are re-serialized as JSON.
 * - Unresolvable tokens are left untouched so prompt text like
 *   `{{example}}` survives verbatim.
 */
export function interpolatePayload(template: string, payload: string): string {
  const whole = payload || '(no input provided)';
  let parsed: unknown;
  let didParse = false;
  return template.replace(/\{\{\s*([\w$][\w$.-]*)\s*\}\}/g, (match, path: string) => {
    if (path === 'input') return whole;
    if (!didParse) {
      didParse = true;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = undefined;
      }
    }
    const value = resolveJsonPath(parsed, path);
    if (value === undefined) return match;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/**
 * Extracts the array a ForEach node should iterate.
 *
 * Tries, in order:
 *  1. The payload parsed as a JSON array.
 *  2. `itemsPath` resolved inside the payload parsed as JSON.
 *  3. When the parsed payload is an object with exactly one array property,
 *     that property (agents often wrap lists: `{ "jobs": [...] }`).
 *  4. The first top-level JSON array embedded in the text (agents frequently
 *     surround JSON with prose or code fences).
 *
 * Returns null when no array can be found.
 */
export function extractItems(payload: string, itemsPath?: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = undefined;
  }

  if (itemsPath?.trim() && parsed !== undefined) {
    const at = resolveJsonPath(parsed, itemsPath.trim());
    if (Array.isArray(at)) return at;
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const arrays = Object.values(parsed as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as unknown[];
  }

  // Fall back to the first JSON array embedded in the text.
  const start = payload.indexOf('[');
  if (start >= 0) {
    for (let end = payload.lastIndexOf(']'); end > start; end = payload.lastIndexOf(']', end - 1)) {
      try {
        const candidate = JSON.parse(payload.slice(start, end + 1));
        if (Array.isArray(candidate)) return candidate;
      } catch {
        // keep shrinking
      }
    }
  }
  return null;
}

/**
 * Merges an external event payload into the payload that was waiting.
 * When both parse as JSON objects the fields are shallow-merged (event wins);
 * otherwise the event payload replaces the waiting payload (falling back to
 * the waiting payload when the event carries nothing).
 */
export function mergePayloads(waiting: string, event: string): string {
  if (!event.trim()) return waiting;
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(waiting);
  } catch {
    a = undefined;
  }
  try {
    b = JSON.parse(event);
  } catch {
    b = undefined;
  }
  if (
    a && b &&
    typeof a === 'object' && typeof b === 'object' &&
    !Array.isArray(a) && !Array.isArray(b)
  ) {
    return JSON.stringify({ ...(a as object), ...(b as object) });
  }
  return event;
}
