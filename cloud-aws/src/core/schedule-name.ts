/**
 * Deterministic schedule naming from (workflowId, nodeId).
 *
 * EventBridge Scheduler schedule names are at most 64 characters and allow
 * `[a-zA-Z0-9_.-]`. The name must be:
 * 1. Deterministic: same inputs always produce the same output
 * 2. At most 64 characters
 * 3. Injective: distinct (workflowId, nodeId) pairs produce distinct names
 * 4. Unique within the schedule group
 * 5. Use only allowed characters
 * 6. Carry a per-workflow prefix that `ListSchedules` can filter on
 *
 * Requirement 6 is why the name is built in two segments rather than as one
 * digest over the pair. The IaC_App creates ONE schedule group per deployment,
 * so a group holds every workflow's schedules together. With a single opaque
 * digest there is no way to ask "which of these belong to workflow X", and the
 * only available implementation of "replace this workflow's schedules" was to
 * list the group and delete all of it - which silently deleted every OTHER
 * workflow's schedules on any spec push.
 *
 * Strategy: `sched-` for console readability, then a hash of the workflow id,
 * then `-`, then a hash of the node id. `schedulePrefix(workflowId)` reproduces
 * everything up to and including the separator, so the adapter can scope both
 * its list and its deletes to one workflow.
 *
 * Hash digits come from multiple rounds of FNV-1a (32-bit) with distinct salts.
 * The workflow segment is 16 hex chars (64 bits) and the node segment 40 hex
 * chars (160 bits), for a 63-character name inside the 64 limit. The two
 * segments are hashed separately, and the separator is not a hex digit, so the
 * boundary is unambiguous and distinct pairs cannot collide by re-splitting.
 *
 * Requirements: 6.5
 * Feature: aws-deployment-target, aws-byo-deploy
 */

/** Maximum length of an EventBridge Scheduler schedule name. */
const MAX_SCHEDULE_NAME_LENGTH = 64;

/** Prefix for readability in the AWS console. */
const PREFIX = 'sched-';

/** Separator between the workflow segment and the node segment. */
const SEPARATOR = '-';

/** Hex characters in the workflow segment. 64 bits of hash output. */
const WORKFLOW_HASH_LENGTH = 16;

/** Hex characters in the node segment. 160 bits of hash output. */
const NODE_HASH_LENGTH = 40;

/**
 * Salt offset for the node segment, so the two segments never run the same
 * rounds over the same bytes. Without it, `scheduleName('a', 'a')` would repeat
 * its own workflow digits in the node segment.
 */
const NODE_SALT_OFFSET = 1024;

/** FNV-1a constants. */
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * Encode a string to UTF-8 bytes without relying on TextEncoder (which requires
 * DOM lib types).
 */
function toUtf8Bytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/**
 * FNV-1a (32-bit) over a byte array with a seed mixed into the offset basis,
 * yielding 8 lower-case hex chars.
 */
function fnv1a32(bytes: number[], seed: number): string {
  let hash = (FNV_OFFSET ^ seed) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Produce `count` hex chars of hash output by running FNV-1a-32 with distinct
 * integer seeds. Each round yields 8 hex chars; we concatenate and slice.
 */
function multiRoundHash(input: string, count: number, saltOffset = 0): string {
  const bytes = toUtf8Bytes(input);
  const rounds = Math.ceil(count / 8);
  let result = '';
  for (let i = 0; i < rounds; i++) {
    result += fnv1a32(bytes, saltOffset + i);
  }
  return result.slice(0, count);
}

/**
 * The name prefix every schedule for one workflow shares.
 *
 * This is the filter `SchedulerBackend.listSchedules` passes to `ListSchedules`
 * as `NamePrefix`, which is what scopes a spec push's delete-then-create to one
 * workflow. It ends with the separator, so it cannot match a longer workflow
 * hash that merely starts with the same digits.
 */
export function schedulePrefix(workflowId: string): string {
  return `${PREFIX}${multiRoundHash(workflowId, WORKFLOW_HASH_LENGTH)}${SEPARATOR}`;
}

/**
 * Derive a deterministic, injective schedule name from a (workflowId, nodeId)
 * pair. The result is at most 64 characters, uses only `[a-z0-9-]`, is unique
 * within a schedule group for distinct input pairs, and always begins with
 * `schedulePrefix(workflowId)`.
 */
export function scheduleName(workflowId: string, nodeId: string): string {
  const node = multiRoundHash(nodeId, NODE_HASH_LENGTH, NODE_SALT_OFFSET);
  const name = `${schedulePrefix(workflowId)}${node}`;
  // A compile-time budget would be better, but the lengths are constants and
  // this keeps the 64-character contract checkable at the one place it matters.
  if (name.length > MAX_SCHEDULE_NAME_LENGTH) {
    throw new Error(
      `Schedule name length ${name.length} exceeds the EventBridge Scheduler ` +
        `limit of ${MAX_SCHEDULE_NAME_LENGTH}.`,
    );
  }
  return name;
}
