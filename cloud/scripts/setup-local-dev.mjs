#!/usr/bin/env node
/**
 * setup-local-dev.mjs - one command that makes a LOCAL Phorma Cloud worker
 * usable from a local studio build.
 *
 *   cd cloud
 *   npm run dev:setup                 # or: node scripts/setup-local-dev.mjs
 *   npm run dev:setup -- --dry-run    # every check, no writes, no prompts
 *
 * ## Why this exists
 *
 * A local studio build resolves `PHORMA_CLOUD_DEFAULT_URL` from
 * `frontend/src/app/core/phorma-cloud-url.ts`, which is the DEPLOYED PRODUCTION
 * worker. That worker holds the production Clerk key and live Stripe keys, while
 * a dev build ships the `pk_test_` DEVELOPMENT Clerk key - one worker holds one
 * `CLERK_SECRET_KEY`, and a session token minted by one Clerk instance fails
 * `verifyToken` against another, so every authenticated call reads a flat 401.
 * Even if it did authenticate, local clicking would be touching live Stripe.
 *
 * The fix is a LOCAL worker carrying the development Clerk key plus Stripe
 * sandbox keys, with the studio pointed at it. That was a dozen manual steps in
 * `cloud/.dev.vars.example`; this script is those steps, and
 * `.dev.vars.example` remains the authority on every var name and what each one
 * unlocks.
 *
 * ## What it does
 *
 *  1. Refuses to run unless `cloud/.gitignore` still globs `.dev.vars*` (with
 *     the `!.dev.vars.example` negation intact). This script writes real secrets
 *     to disk, so without that safety net it would be creating a committable
 *     secret file.
 *  2. Writes or TOPS UP `cloud/.dev.vars`. An existing value is never
 *     overwritten; only a missing or empty one is filled.
 *  3. Applies the migrations to the LOCAL D1 (local D1 starts empty, and
 *     `/api/me` cannot answer without the schema).
 *  4. Provisions a tenant row through `POST /api/provision`, but only when a
 *     local worker is already answering on `http://localhost:8787`.
 *  5. Prints what the human still has to do, in order.
 *
 * Every step is idempotent and reports what it skipped and why. Node builtins
 * only, no dependency beyond the `wrangler` this package already installs.
 *
 * ## Flags
 *
 *   --dry-run            Perform every check and print every intended action.
 *                        Writes nothing, applies no migration, prompts for
 *                        nothing. Safe on a machine with no secrets to hand.
 *   --tenant <user_...>  Your DEVELOPMENT-instance Clerk user id, which is what
 *                        `tenants.id` IS. Also read from `PHORMA_DEV_TENANT_ID`.
 *   --tier <id>          Tenant tier, default `team`.
 *   --help, -h           This text.
 *
 * ## Environment
 *
 * Three values cannot be generated. Each is read from an environment variable of
 * the same name when one is set, and otherwise PROMPTED FOR on stdin with echo
 * off:
 *
 *   CLERK_SECRET_KEY              required, must be `sk_test_`
 *   STRIPE_SECRET_KEY             required, must be `sk_test_` or `rk_test_`
 *   OPENROUTER_PROVISIONING_KEY   optional, must be `sk-or-`
 *
 * A wrong-MODE key is refused rather than written: an `sk_live_` Clerk key here
 * would point local development at the production Clerk instance, which is the
 * exact bug this script exists to prevent. No secret is ever printed, logged or
 * echoed, not even truncated, and none is passed on a command line.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CLOUD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GITIGNORE_PATH = join(CLOUD_DIR, '.gitignore');
const DEV_VARS_PATH = join(CLOUD_DIR, '.dev.vars');
const DEV_VARS_HOSTED_PATH = join(CLOUD_DIR, '.dev.vars.hosted');

/** Where `wrangler dev` listens by default, and what the studio is pointed at. */
export const WORKER_URL = 'http://localhost:8787';

/** The D1 database name under `env.hosted` in `wrangler.jsonc`. */
const D1_DATABASE = 'phorma-cloud';

/** localStorage key from `frontend/src/app/core/layout-storage.ts` + `phorma-cloud-url.ts`. */
const STUDIO_URL_STORAGE_KEY = 'phorma.layout.phormaCloudUrl';

/**
 * Tier ids `/api/provision` can be given. `TIERS` in `cloud/src/tenants.ts` is
 * the authority; this copy exists so a typo is refused here rather than writing
 * a tenant row with a tier the entitlement gate does not recognise.
 */
const KNOWN_TIERS = ['starter', 'pro', 'team'];

// ── Arguments ───────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const flags = { dryRun: false, tenant: null, tier: 'team', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--dry-run': flags.dryRun = true; break;
      case '--tenant': flags.tenant = next(); break;
      case '--tier': flags.tier = next(); break;
      case '--help': case '-h': flags.help = true; break;
      default: throw new Error(`Unknown argument "${arg}".`);
    }
  }
  if (!KNOWN_TIERS.includes(flags.tier)) {
    throw new Error(
      `--tier must be one of ${KNOWN_TIERS.join(', ')} (see TIERS in cloud/src/tenants.ts).`,
    );
  }
  // Checked HERE rather than at the provisioning step, which is the last thing
  // this script does and only runs when a worker is up: a typo would otherwise be
  // reported after `.dev.vars` was written and the migrations applied, which reads
  // as a failed setup instead of a bad argument.
  if (flags.tenant !== null && !isClerkUserIdShape(flags.tenant)) {
    throw new Error(tenantIdRefusal(flags.tenant, '--tenant'));
  }
  return flags;
}

const HELP = `Usage: node scripts/setup-local-dev.mjs [--dry-run] [--tenant user_...] [--tier team]

Sets up a LOCAL Phorma Cloud worker for a local studio build: writes
\`cloud/.dev.vars\` (development Clerk key, Stripe sandbox key, generated
secrets), applies the migrations to the local D1, and provisions your tenant
row when a worker is already listening on ${WORKER_URL}.

Safe to re-run: an existing value is never overwritten, and every skip is
reported with its reason.

  --dry-run            Every check, every intended action, no writes and no
                       prompts.
  --tenant <user_...>  Your DEVELOPMENT-instance Clerk user id. Also read from
                       PHORMA_DEV_TENANT_ID. Prompted for otherwise.
  --tier <id>          One of ${KNOWN_TIERS.join(', ')}. Default team.
  --help, -h           This text.

CLERK_SECRET_KEY, STRIPE_SECRET_KEY and OPENROUTER_PROVISIONING_KEY are read
from the environment when set, and otherwise prompted for with echo off. Use
sandbox and DEVELOPMENT values only: this script refuses a live-mode key.

PASSING FLAGS: call node directly, NOT through npm.

  node scripts/setup-local-dev.mjs --dry-run          works
  npm run dev:setup \u002d\u002d --dry-run                      does NOT work

npm (10 and 11) swallows an unrecognised flag as its own config, warns
"Unknown cli config", and hands the script only the bare positionals - the same
flag-forwarding failure this repo documents for the Angular test scripts.
\`npm run dev:setup\` with no flags at all is fine.

See the header of this file for the full reasoning, and
\`cloud/.dev.vars.example\` for what every var unlocks.`;

// ── The safety net: `.dev.vars*` must still be gitignored ───────────────────

/**
 * Whether `cloud/.gitignore` still keeps a real `.dev.vars` out of git.
 *
 * Checked BEFORE anything is written, and a failure is fatal. The glob matters
 * as much as the file: with `--env hosted` wrangler reads `.dev.vars.hosted`
 * INSTEAD of `.dev.vars`, so a bare `.dev.vars` pattern would leave the
 * environment-specific variant committable. The `!.dev.vars.example` negation is
 * verified too, because losing it does not expose a secret but does silently
 * untrack the template this script is consistent with.
 *
 * Pure over the file text so a test can pin both directions.
 */
export function checkGitignore(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const problems = [];
  // A pattern that covers `.dev.vars`, `.dev.vars.hosted` and any other suffix.
  const globs = lines.some((line) => /^\.dev\.vars\*+$/.test(line));
  if (!globs) {
    problems.push(
      'no `.dev.vars*` pattern found. This script writes real secrets to ' +
        '`cloud/.dev.vars`, and without that glob the file (or the `.dev.vars.hosted` ' +
        'variant wrangler reads under `--env hosted`) is committable.',
    );
  }
  if (!lines.includes('!.dev.vars.example')) {
    problems.push(
      'the `!.dev.vars.example` negation is missing, so the tracked template is ' +
        'no longer tracked. Restore it before adding secrets alongside it.',
    );
  }
  return { ok: problems.length === 0, problems };
}

// ── Prefix validation ───────────────────────────────────────────────────────

/**
 * The three supplied secrets are validated by PREFIX and by LENGTH, which is all
 * that can be checked without a network call, and is exactly the pair that
 * catches the two failure modes that matter: a key for the wrong MODE, and a
 * PLACEHOLDER.
 *
 * Not one of these functions receives, returns or reports the value. A message
 * names the variable and the expected prefix and nothing else, because a
 * validation error is printed and a printed secret is a leaked secret. Length is
 * reported as a number, which is not the secret.
 */

/**
 * The floor every real key clears comfortably, and no placeholder does.
 *
 * Measured against the genuine article: a Clerk `sk_test_` runs past 50
 * characters, a Stripe `sk_test_` / `rk_test_` past 100, an OpenRouter
 * `sk-or-v1-` key is 73. This machine's environment carried
 * `STRIPE_SECRET_KEY=rk_test_...` at 16 characters and
 * `OPENROUTER_PROVISIONING_KEY=sk-or-...` at 17, both obviously stubs, and a
 * PREFIX check alone accepted them happily - which is worse than rejecting them,
 * because the value lands in `.dev.vars` and the failure resurfaces later as an
 * opaque 401 or a Stripe 400 with nothing pointing back to here.
 *
 * Deliberately one shared floor rather than a per-provider minimum: the point is
 * to catch a stub, not to model each vendor's format, and a vendor lengthening or
 * shortening a key must not turn this into a false refusal.
 */
const MIN_SECRET_LENGTH = 32;

/** A stub check, shared by all three, applied AFTER the prefix is known good. */
function checkNotPlaceholder(key, trimmed, hint) {
  if (trimmed.length >= MIN_SECRET_LENGTH) return null;
  return {
    ok: false,
    message:
      `${key} is ${trimmed.length} characters, which is too short to be a real key ` +
      `(the floor is ${MIN_SECRET_LENGTH}). It has the right prefix, so this looks like a ` +
      `PLACEHOLDER rather than a mistyped secret. ${hint} If it came from your shell ` +
      `environment rather than a prompt, clear it first - an environment value wins over ` +
      `the prompt: Remove-Item Env:\\${key}`,
  };
}

export function validateClerkSecretKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, message: 'CLERK_SECRET_KEY is empty.' };
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('sk_live_') || trimmed.startsWith('pk_live_')) {
    return {
      ok: false,
      message:
        'CLERK_SECRET_KEY is a LIVE key. Refusing it: a live key here points local ' +
        'development at the PRODUCTION Clerk instance, which is the exact bug this ' +
        'script exists to prevent. Take the `sk_test_` secret key from the ' +
        '`flowing-seahorse-72` DEVELOPMENT instance (Clerk Dashboard > API keys), ' +
        'which is the instance the `pk_test_` key in `frontend/src/environments/clerk.ts` ' +
        'signs in against.',
    };
  }
  if (!trimmed.startsWith('sk_test_')) {
    return {
      ok: false,
      message:
        'CLERK_SECRET_KEY must start with `sk_test_` (the DEVELOPMENT instance backend key).',
    };
  }
  const stub = checkNotPlaceholder(
    'CLERK_SECRET_KEY',
    trimmed,
    'Take the real one from the Clerk Dashboard, `flowing-seahorse-72` DEVELOPMENT instance, API keys > Secret keys.',
  );
  if (stub) return stub;
  return { ok: true, value: trimmed };
}

export function validateStripeSecretKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, message: 'STRIPE_SECRET_KEY is empty.' };
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('sk_live_') || trimmed.startsWith('rk_live_')) {
    return {
      ok: false,
      message:
        'STRIPE_SECRET_KEY is a LIVE key. Refusing it: local clicking would move real ' +
        'money. Use a Stripe SANDBOX key (`sk_test_` or a restricted `rk_test_`).',
    };
  }
  if (!trimmed.startsWith('sk_test_') && !trimmed.startsWith('rk_test_')) {
    return {
      ok: false,
      message: 'STRIPE_SECRET_KEY must start with `sk_test_` or `rk_test_` (Stripe sandbox).',
    };
  }
  const stub = checkNotPlaceholder(
    'STRIPE_SECRET_KEY',
    trimmed,
    'Take the real one from the Stripe Dashboard in TEST mode, Developers > API keys.',
  );
  if (stub) return stub;
  return { ok: true, value: trimmed };
}

export function validateOpenRouterProvisioningKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    // Optional. An empty answer is a decision, not an error.
    return { ok: true, value: '' };
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('sk-or-')) {
    return {
      ok: false,
      message:
        'OPENROUTER_PROVISIONING_KEY must start with `sk-or-`. It is the account-level ' +
        'MANAGEMENT key, not a per-tenant runtime key.',
    };
  }
  const stub = checkNotPlaceholder(
    'OPENROUTER_PROVISIONING_KEY',
    trimmed,
    'Take the real one from openrouter.ai > Settings > Provisioning keys. Or leave it empty: ' +
      'it is optional, and without it only hosted INFERENCE refuses (`no_runtime_key`) while ' +
      'the billing and usage surfaces work.',
  );
  if (stub) return stub;
  return { ok: true, value: trimmed };
}

/**
 * The same shape `isClerkUserId` enforces in `cloud/src/tenants.ts`, kept as a
 * copy on purpose: this script must refuse a typo without importing TypeScript
 * (it runs under plain `node`). A bad id is not a validation nicety - `tenants.id`
 * IS the Clerk user id, so a typo creates an orphan row `/api/me` can never
 * find, indistinguishable from a user who has not signed in yet.
 */
const CLERK_USER_ID = /^user_[A-Za-z0-9_-]{1,120}$/;

export function isClerkUserIdShape(value) {
  return typeof value === 'string' && CLERK_USER_ID.test(value);
}

/**
 * One refusal sentence for a bad tenant id, shared by the three places that can
 * receive one (the flag, the environment variable, the prompt) so they cannot
 * drift into three explanations of one mistake. The id is not a secret, so
 * echoing it is what makes the typo visible.
 */
export function tenantIdRefusal(value, source) {
  return (
    `${source} is "${value}", which is not a Clerk user id (user_...). Refusing it: ` +
    '`tenants.id` IS the Clerk user id, so a typo creates an orphan row `/api/me` can ' +
    'never find, which looks exactly like a user who has not signed in yet. Find yours ' +
    'in the Clerk Dashboard, the `flowing-seahorse-72` DEVELOPMENT instance, Users. It ' +
    'has to be the development instance: that is the one a local build signs in against.'
  );
}

// ── `.dev.vars` parse and merge ─────────────────────────────────────────────

/**
 * Every assignment in a `.dev.vars` text, keyed by name.
 *
 * A commented assignment is recorded too, with `active: false`, because
 * `.dev.vars.example` ships several and "already documented here" is a different
 * state from "already set". An ACTIVE assignment always wins over a commented
 * one regardless of order; among duplicates the FIRST active line is the one
 * {@link mergeDevVars} would fill in place. Duplicates are never created here.
 */
export function parseDevVars(text) {
  const entries = new Map();
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const active = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (active) {
      const existing = entries.get(active[1]);
      if (!existing?.active) {
        entries.set(active[1], { key: active[1], value: active[2], index, active: true });
      }
      return;
    }
    const commented = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (commented && !entries.has(commented[1])) {
      entries.set(commented[1], { key: commented[1], value: commented[2], index, active: false });
    }
  });
  return entries;
}

const APPEND_HEADER = '# Added by `npm run dev:setup` (scripts/setup-local-dev.mjs).';

/**
 * Folds `additions` into an existing `.dev.vars` text without ever changing a
 * value that is already there.
 *
 * The three outcomes, and why each is the safe one:
 *
 *  - `kept`: the key already has a non-empty active value. Left untouched, on
 *    the reasoning that a value on disk was put there deliberately and this
 *    script cannot tell a better one from a worse one.
 *  - `filled`: the key is present but EMPTY, which is what copying
 *    `.dev.vars.example` leaves behind (`KEY_ENC_SECRET=`). Filled IN PLACE, so
 *    the operator's own ordering and comments survive and no duplicate appears.
 *  - `added`: the key is absent, or present only as a comment. Appended in
 *    `additions` order under a single header block.
 *
 * An addition with `value: null` is a PLACEHOLDER: it writes a commented line
 * for a value only the operator can supply later (`STRIPE_WEBHOOK_SECRET`), and
 * it is skipped entirely when the key is mentioned in the file at all, so a
 * re-run cannot stack placeholders.
 *
 * Line endings are preserved: rejoining a CRLF file with LF would rewrite every
 * line of a file the operator also edits by hand.
 */
export function mergeDevVars(text, additions) {
  const original = String(text ?? '');
  const eol = /\r\n/.test(original) ? '\r\n' : '\n';
  const lines = original === '' ? [] : original.split(/\r?\n/);
  const entries = parseDevVars(original);

  const kept = [];
  const filled = [];
  const added = [];
  const skipped = [];
  const append = [];

  for (const addition of additions) {
    const { key, value = null, comment = [] } = addition;
    const found = entries.get(key);
    if (found?.active && found.value.trim() !== '') {
      kept.push(key);
      continue;
    }
    if (value === null) {
      if (found) {
        skipped.push({ key, reason: 'already mentioned in the file' });
      } else {
        append.push({ key, value: null, comment, placeholder: addition.placeholder ?? '' });
        added.push(key);
      }
      continue;
    }
    if (value === '') {
      skipped.push({ key, reason: 'no value supplied' });
      continue;
    }
    if (found?.active) {
      lines[found.index] = `${key}=${value}`;
      filled.push(key);
      continue;
    }
    append.push({ key, value, comment });
    added.push(key);
  }

  if (append.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    if (!lines.includes(APPEND_HEADER)) {
      lines.push(APPEND_HEADER);
      lines.push('# `cloud/.dev.vars.example` documents what each one unlocks.');
      lines.push('');
    }
    for (const entry of append) {
      for (const line of entry.comment) lines.push(`# ${line}`);
      lines.push(entry.value === null ? `# ${entry.key}=${entry.placeholder}` : `${entry.key}=${entry.value}`);
      lines.push('');
    }
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const merged = lines.length === 0 ? '' : `${lines.join(eol)}${eol}`;
  return { text: merged, kept, filled, added, skipped, changed: filled.length + added.length > 0 };
}

// ── Hidden stdin ────────────────────────────────────────────────────────────

/**
 * Reads one line without echoing it.
 *
 * RAW MODE, not a muted `readline`. On Windows `setRawMode(true)` goes through
 * libuv's `uv_tty_set_mode(UV_TTY_MODE_RAW)`, which clears `ENABLE_ECHO_INPUT`
 * and `ENABLE_LINE_INPUT` on the console handle - the echo a terminal normally
 * performs is done by the console driver, so switching it off at the driver is
 * the only approach that is silent on PowerShell 5.1 as well as on a POSIX
 * shell. A `readline` interface with `_writeToOutput` overridden suppresses only
 * what NODE writes; the driver keeps echoing underneath on some Windows hosts.
 *
 * Nothing is written per keystroke, not even a mask character: a row of asterisks
 * is a free length disclosure over a shoulder or a shared screen.
 *
 * Requires a TTY. When stdin is a pipe (CI, a wrapper, a tool that captures
 * output) raw mode does not exist, so the caller is told to pass the value
 * through the environment instead. There is no fallback that echoes.
 *
 * `input` and `output` are injectable so a test can prove nothing reaches the
 * output stream.
 */
export function readHiddenLine(label, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(
      new Error(
        `Cannot prompt for ${label} without a terminal: stdin is not a TTY, so echo ` +
          'cannot be switched off. Set the environment variable of the same name and ' +
          're-run, or run this script directly in a terminal.',
      ),
    );
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const chars = [];
    const wasRaw = input.isRaw === true;
    const previousEncoding = input.readableEncoding;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    const restore = () => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      if (previousEncoding) input.setEncoding(previousEncoding);
      input.pause();
      output.write('\n');
    };

    // Escape-sequence state, so an arrow key is dropped WHOLE. Dropping `\u001b`
    // alone is not enough: the `[A` that follows it is printable, so it would land
    // inside the secret and produce a key the operator never typed and cannot see.
    let escape = null;

    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (escape === 'start') {
          escape = char === '[' || char === 'O' ? 'csi' : null;
          continue;
        }
        if (escape === 'csi') {
          // Parameter and intermediate bytes run until a final byte in `@`..`~`.
          if (char >= '\u0040' && char <= '\u007e') escape = null;
          continue;
        }
        switch (char) {
          case '\u001b':
            escape = 'start';
            break;
          case '\r':
          case '\n':
            restore();
            resolvePromise(chars.join(''));
            return;
          case '\u0003': // Ctrl+C: the shell never sees it in raw mode, so honour it here.
            restore();
            rejectPromise(new Error('Interrupted.'));
            return;
          case '\u0004': // Ctrl+D / EOT on an empty line reads as "no value".
            restore();
            resolvePromise(chars.join(''));
            return;
          case '\u007f': // DEL
          case '\b':
            chars.pop();
            break;
          default:
            // Remaining control characters are dropped rather than stored: a
            // Ctrl+key chord must not end up inside a key that then fails to
            // authenticate for a reason nobody can see.
            if (char >= ' ') chars.push(char);
            break;
        }
      }
    };

    input.on('data', onData);
  });
}

/** Reads one visible line. For values that are not secrets, like a tenant id. */
export function readVisibleLine(prompt, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    output.write(prompt);
    let buffer = '';
    const previousEncoding = input.readableEncoding;
    input.resume();
    input.setEncoding('utf8');
    const finish = (error, value) => {
      input.removeListener('data', onData);
      if (previousEncoding) input.setEncoding(previousEncoding);
      input.pause();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      const newline = buffer.search(/\r|\n/);
      if (newline >= 0) finish(null, buffer.slice(0, newline).trim());
    };
    input.on('data', onData);
    input.once('end', () => finish(null, buffer.trim()));
    input.once('error', (error) => finish(error));
  });
}

// ── wrangler ────────────────────────────────────────────────────────────────

/**
 * Runs the wrangler this package already depends on, through `process.execPath`
 * rather than `npx`: `npx` resolves differently on Windows (`npx.cmd` plus a
 * shell, which then needs its own quoting), and pinning the resolved binary means
 * this script cannot silently run a different wrangler than `npm run deploy`
 * does.
 *
 * `stdio` is piped, which is also what makes the call NON-INTERACTIVE.
 * `d1 migrations apply` has no `--yes` flag and normally asks for confirmation;
 * with no TTY on either side wrangler skips the prompt rather than hanging on a
 * keypress that never comes.
 */
function wrangler(args) {
  const wranglerBin = createRequire(join(CLOUD_DIR, 'package.json')).resolve(
    'wrangler/bin/wrangler.js',
  );
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: CLOUD_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ── Worker probe and provisioning ───────────────────────────────────────────

/**
 * Whether a worker is answering on `WORKER_URL`.
 *
 * Any HTTP response counts as listening, including the 404 the root path
 * returns: the point is that a socket answered, not what it said. The marker
 * text from `cloud/src/index.ts`'s fallback response distinguishes OUR worker
 * from whatever else might hold the port, which is worth a warning but not a
 * refusal.
 */
export async function probeWorker(baseUrl = WORKER_URL, timeoutMs = 2500) {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text().catch(() => '');
    return { listening: true, phorma: body.includes('Phorma Agent Studio cloud runtime') };
  } catch {
    return { listening: false, phorma: false };
  }
}

/**
 * `POST /api/provision`, the admin-token route that creates the tenant row
 * `/api/me` resolves. Re-running it is an upgrade rather than a re-provision
 * (the row is written first, so `reconcileRuntimeKey` patches the existing key's
 * limit instead of minting a second one), which is what makes this step safe to
 * repeat.
 *
 * The token travels in a header, never on a command line, and is not part of any
 * message this function returns.
 */
export async function provisionTenant({ baseUrl = WORKER_URL, adminToken, tenantId, tier }) {
  const response = await fetch(`${baseUrl}/api/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ tenantId, tier }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON body is reported as text below */
  }
  return { status: response.status, ok: response.ok, body, text };
}

// ── Closing summary ─────────────────────────────────────────────────────────

/**
 * What the human still has to do, in the order they have to do it. Built as a
 * list so the numbering stays correct when the provisioning step was skipped.
 */
export function closingSummary({ provisioned, workerListening, webhookSecretSet = false }) {
  const steps = [];

  // Only when there is actually nothing there. Telling the operator to start a
  // worker that just answered a provisioning POST reads as though the script did
  // not notice what it had already done, and it invites a second `wrangler dev`
  // that fails on the port.
  if (!workerListening) {
    steps.push(
      `Start the local worker, and leave it running:

     cd cloud
     npx wrangler dev --env hosted`,
    );
  }

  if (!provisioned) {
    steps.push(
      `Re-run this script with that worker up, to provision your tenant row:

     npm run dev:setup

   ${
     workerListening
       ? 'It skips everything it has already done and only provisions.'
       : 'Nothing was listening this time, so the tenant row does not exist yet\n   and `/api/me` has nothing to resolve. The re-run skips everything it has\n   already done.'
   }`,
    );
  }

  steps.push(
    `Forward Stripe sandbox webhooks in a second terminal, and leave that
   running too:

     npm run dev:webhooks

   That wrapper, NOT a bare \`stripe listen\`. The Stripe CLI keeps its own
   credential from \`stripe login\`, which can point at a DIFFERENT sandbox than
   the \`STRIPE_SECRET_KEY\` in \`.dev.vars\` - and it did on this machine. The
   mismatch is close to invisible: the listener starts fine and prints a valid
   \`whsec_\`, the worker verifies against it happily, and no event ever arrives
   because the listener is subscribed to an account nothing is happening on.
   \`scripts/stripe-cli.mjs\` pins the CLI to the same key the worker reads.

${
     webhookSecretSet
       ? `   \`STRIPE_WEBHOOK_SECRET\` is already set in \`.dev.vars\`, so nothing to paste
   unless the listener prints a DIFFERENT one. It is per ENDPOINT, so a restarted
   listener can, and a stale value reads as a 400 with \`no_match\` in the worker
   log. If you do replace it, restart the worker: wrangler reads \`.dev.vars\` at
   startup only.`
       : `   Copy the \`whsec_\` it prints into \`cloud/.dev.vars\`:

     STRIPE_WEBHOOK_SECRET=whsec_...

   Then RESTART the worker: wrangler reads \`.dev.vars\` at startup only. The
   secret is per ENDPOINT, so a restarted listener can print a new one, and a
   stale value reads as a 400 with \`no_match\` in the worker log.`
   }`,
  );

  steps.push(
    `Point the studio at the local worker. Settings > Cloud > Phorma Cloud URL:

     ${WORKER_URL}

   Or, from the studio's devtools console, followed by a reload:

     localStorage.setItem('${STUDIO_URL_STORAGE_KEY}', JSON.stringify('${WORKER_URL}'))

   \`JSON.stringify\` because the layout store keeps JSON, and no trailing
   slash: the settings field strips one, a hand-written value is not
   normalized.`,
  );

  const numbered = steps
    .map((step, index) => `${String(index + 1).padStart(2, ' ')}. ${step}`)
    .join('\n\n');

  return `\nStill to do\n===========\n\n${numbered}\n`;
}

// ── Main ────────────────────────────────────────────────────────────────────

/** Collected so the run ends with one list of what was skipped and why. */
const notes = [];
function note(line) {
  notes.push(line);
}

function abort(message) {
  throw new Error(message);
}

/**
 * Resolves one supplied secret: the environment first, then a hidden prompt.
 * Validation happens here so a bad value is refused before it can be written,
 * and the message never carries the value.
 */
async function resolveSuppliedSecret(spec, { dryRun, declined = false }) {
  const fromEnv = process.env[spec.key];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const result = spec.validate(fromEnv);
    if (!result.ok) abort(`${result.message} (read from the ${spec.key} environment variable.)`);
    console.log(`  ${spec.key}: taken from the environment, prefix accepted.`);
    return result.value;
  }
  // An OPTIONAL key that already has a commented placeholder in `.dev.vars` was
  // declined on an earlier run, so do not ask again. Without this the script is
  // not really re-runnable: every invocation blocks on a prompt for a key the
  // operator has already said no to, which turns an idempotent setup into one
  // that cannot be run unattended. A commented REQUIRED key still re-prompts,
  // because there the file is genuinely incomplete.
  if (declined && spec.required === false) {
    console.log(
      `  ${spec.key}: left unset on an earlier run (commented in \`.dev.vars\`), so not asked ` +
        `again. Delete that line, or set the environment variable, to supply it.`,
    );
    return '';
  }
  if (dryRun) {
    console.log(
      `  ${spec.key}: would be PROMPTED for on stdin with echo off ` +
        `(set ${spec.key} in the environment to skip the prompt).`,
    );
    return null;
  }
  console.log(`\n  ${spec.prompt}`);
  if (spec.required === false) console.log('  Press Enter to leave it unset.');
  process.stdout.write(`  ${spec.key} (not echoed): `);
  const typed = await readHiddenLine(spec.key);
  const result = spec.validate(typed);
  if (!result.ok) abort(result.message);
  if (result.value === '') {
    console.log(`  ${spec.key}: left unset.`);
    return '';
  }
  console.log(`  ${spec.key}: captured, prefix accepted. Not echoed and not logged.`);
  return result.value;
}

/** The tenant id: flag, then env, then a visible prompt. Never a secret. */
async function resolveTenantId(flags, { dryRun }) {
  const supplied = flags.tenant ?? process.env.PHORMA_DEV_TENANT_ID ?? null;
  if (supplied) {
    if (!isClerkUserIdShape(supplied)) {
      abort(tenantIdRefusal(supplied, flags.tenant ? '--tenant' : 'PHORMA_DEV_TENANT_ID'));
    }
    return supplied;
  }
  if (dryRun) {
    console.log(
      '  Tenant id: would be PROMPTED for (pass --tenant user_... or set ' +
        'PHORMA_DEV_TENANT_ID to skip the prompt).',
    );
    return null;
  }
  console.log(
    '\n  Your DEVELOPMENT-instance Clerk user id. Clerk Dashboard, the\n' +
      '  `flowing-seahorse-72` DEVELOPMENT instance, Users. It has to be the\n' +
      '  development instance: that is the one the local build signs in against.',
  );
  const typed = await readVisibleLine('  Clerk user id (user_...): ');
  if (!isClerkUserIdShape(typed)) abort(tenantIdRefusal(typed, 'The id you typed'));
  return typed;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  console.log('Phorma Cloud local dev setup');
  console.log('============================');
  if (flags.dryRun) {
    console.log('\nDRY RUN: every check runs, nothing is written, nothing is prompted for.');
  }
  // Same reasoning as the `--tenant` check in `parseArgs`, for the env form.
  const tenantFromEnv = process.env.PHORMA_DEV_TENANT_ID;
  if (tenantFromEnv && !isClerkUserIdShape(tenantFromEnv)) {
    abort(tenantIdRefusal(tenantFromEnv, 'PHORMA_DEV_TENANT_ID'));
  }

  // ── 1. The safety net ─────────────────────────────────────────────────────
  console.log('\n[1/4] Checking that `cloud/.dev.vars*` is still gitignored');
  if (!existsSync(GITIGNORE_PATH)) {
    abort('`cloud/.gitignore` does not exist. Refusing to write secrets next to it.');
  }
  const gitignore = checkGitignore(readFileSync(GITIGNORE_PATH, 'utf8'));
  if (!gitignore.ok) {
    for (const problem of gitignore.problems) console.error(`  FAIL: ${problem}`);
    abort('`cloud/.gitignore` no longer protects a local secret file. Nothing was written.');
  }
  console.log('  OK: `.dev.vars*` is ignored and `!.dev.vars.example` is intact.');

  if (existsSync(DEV_VARS_HOSTED_PATH)) {
    note(
      '`cloud/.dev.vars.hosted` exists. With `--env hosted` wrangler loads THAT file and ' +
        'does not load `.dev.vars` at all (they do not merge), so the values written here ' +
        'will be ignored until you copy them across or delete it.',
    );
    console.log('  WARNING: `.dev.vars.hosted` exists and would shadow `.dev.vars`. See the notes below.');
  }

  // ── 2. `.dev.vars` ────────────────────────────────────────────────────────
  console.log('\n[2/4] Reconciling `cloud/.dev.vars`');
  const existingText = existsSync(DEV_VARS_PATH) ? readFileSync(DEV_VARS_PATH, 'utf8') : '';
  if (existingText === '') {
    console.log('  No `.dev.vars` yet, so this creates one.');
  } else {
    console.log('  `.dev.vars` exists. Existing values are kept; only gaps are filled.');
  }
  const existing = parseDevVars(existingText);

  // An existing value gets the same prefix check a pasted one does. A live key
  // already on disk is the very footgun this script exists to prevent, and
  // leaving it in place while reporting success would be worse than refusing.
  for (const spec of [
    { key: 'CLERK_SECRET_KEY', validate: validateClerkSecretKey },
    { key: 'STRIPE_SECRET_KEY', validate: validateStripeSecretKey },
    { key: 'OPENROUTER_PROVISIONING_KEY', validate: validateOpenRouterProvisioningKey },
  ]) {
    const found = existing.get(spec.key);
    if (!found?.active || found.value.trim() === '') continue;
    const result = spec.validate(found.value);
    if (!result.ok) {
      abort(
        `${result.message}\n  The offending value is already in \`cloud/.dev.vars\` on line ` +
          `${found.index + 1}. Replace that one line and re-run. Nothing was written.`,
      );
    }
  }

  const suppliedSpecs = [
    {
      key: 'CLERK_SECRET_KEY',
      required: true,
      validate: validateClerkSecretKey,
      prompt:
        'Clerk DEVELOPMENT backend key (`sk_test_...`). Clerk Dashboard, the\n' +
        '  `flowing-seahorse-72` DEVELOPMENT instance, API keys > Secret keys. It has\n' +
        '  to be that instance: it is the one `frontend/src/environments/clerk.ts`\n' +
        '  signs in against, and a token from another instance reads 401 here.',
      comment: [
        'Clerk DEVELOPMENT backend key, pairing with the `pk_test_` key in',
        '`frontend/src/environments/clerk.ts`. Never an `sk_live_` key locally.',
      ],
    },
    {
      key: 'STRIPE_SECRET_KEY',
      required: true,
      validate: validateStripeSecretKey,
      prompt:
        'Stripe SANDBOX secret key (`sk_test_...` or a restricted `rk_test_...`).\n' +
        '  Stripe Dashboard in test mode, Developers > API keys.',
      comment: ['Stripe SANDBOX key. The deployed hosted worker holds the live key as a secret.'],
    },
    {
      key: 'OPENROUTER_PROVISIONING_KEY',
      required: false,
      validate: validateOpenRouterProvisioningKey,
      prompt:
        'OpenRouter MANAGEMENT key (`sk-or-...`), OPTIONAL. It mints the\n' +
        '  per-tenant runtime keys `/api/infer` spends. Without it the billing and\n' +
        '  usage surfaces still work and hosted inference refuses with\n' +
        '  `no_runtime_key`.',
      comment: [
        'OpenRouter account-level MANAGEMENT key. Absent means a provisioned tenant has',
        'no runtime key and hosted inference refuses with `no_runtime_key`.',
      ],
    },
  ];

  const supplied = new Map();
  for (const spec of suppliedSpecs) {
    const found = existing.get(spec.key);
    if (found?.active && found.value.trim() !== '') {
      console.log(`  ${spec.key}: already set, kept.`);
      supplied.set(spec.key, null);
      continue;
    }
    // A commented entry means a previous run wrote the placeholder, which for an
    // optional key is a recorded decline rather than an unanswered question.
    supplied.set(
      spec.key,
      await resolveSuppliedSecret(spec, {
        dryRun: flags.dryRun,
        declined: found !== undefined && !found.active,
      }),
    );
  }
  if (supplied.get('OPENROUTER_PROVISIONING_KEY') === '') {
    note(
      'OPENROUTER_PROVISIONING_KEY was left unset. Billing, usage and every local surface ' +
        'still work; hosted inference will refuse with `no_runtime_key` until you set it and ' +
        'restart the worker.',
    );
  }

  const additions = [
    {
      key: 'PHORMA_MODE',
      value: 'hosted',
      comment: [
        'Multi-tenant hosted behaviour: fail-closed Clerk auth, tenant ownership checks.',
        'Already a `var` under `env.hosted`, so this only matters for a plain `wrangler dev`.',
      ],
    },
    {
      key: 'CLERK_AUTHORIZED_PARTIES',
      value: 'http://localhost:7322,http://localhost:7323',
      comment: [
        'JWT `azp` allowlist. 7322 is the studio dev server, 7323 the admin dashboard.',
        '`@clerk/backend` matches by exact string, so a missing origin is a hard 401.',
      ],
    },
    {
      key: 'KEY_ENC_SECRET',
      value: randomBytes(32).toString('base64'),
      comment: [
        'AES-GCM key (32 random bytes, base64) for stored tenant runtime keys and the',
        'SecretVault Durable Object. Generated locally; it decrypts local data only.',
      ],
    },
    {
      key: 'PHORMA_ADMIN_TOKEN',
      value: randomBytes(32).toString('hex'),
      comment: [
        'Static bearer for `POST /api/provision` and `POST /api/deactivate`. HEX rather',
        'than base64 on purpose: it goes into an `Authorization` header, where base64',
        "`+/=` invite quoting bugs in whatever shell or client carries it.",
      ],
    },
    ...suppliedSpecs.map((spec) => ({
      key: spec.key,
      value: supplied.get(spec.key),
      comment: spec.comment,
    })),
    {
      key: 'STRIPE_WEBHOOK_SECRET',
      value: null,
      placeholder: 'whsec_...',
      comment: [
        'PER ENDPOINT, not per account, so it cannot be generated or shared with the',
        'deployed worker. `stripe listen --forward-to',
        `${WORKER_URL}/api/stripe/webhook\` prints yours; paste it here and`,
        'restart the worker. A stale one reads as a 400 with `no_match` in the log.',
      ],
    },
  ].map((addition) =>
    // A supplied secret that is still unresolved (a dry run, or an empty answer to
    // the optional one) becomes a COMMENTED placeholder rather than an empty
    // assignment: wrangler treats `KEY=` as a set-but-empty var, and an empty
    // `CLERK_SECRET_KEY` fails differently from an absent one. The commented line
    // also leaves the key documented in place, so a later run that finds the value
    // in the environment appends the real assignment next to it.
    (addition.value === null || addition.value === '') && addition.placeholder === undefined
      ? { ...addition, value: null, placeholder: `<paste ${addition.key} here>` }
      : addition,
  );

  const merged = mergeDevVars(existingText, additions);
  const would = flags.dryRun ? 'would be ' : '';
  for (const key of merged.filled) {
    console.log(`  ${key}: present but empty, ${would}filled in place.`);
  }
  for (const key of merged.added) console.log(`  ${key}: ${would}added.`);
  for (const key of merged.kept) {
    if (!suppliedSpecs.some((spec) => spec.key === key)) console.log(`  ${key}: already set, kept.`);
  }
  for (const { key, reason } of merged.skipped) console.log(`  ${key}: skipped, ${reason}.`);

  if (flags.dryRun) {
    const changes = merged.added.length + merged.filled.length;
    console.log(
      changes === 0
        ? '  DRY RUN: nothing to change, every var this script manages is already set.'
        : `  DRY RUN: would ${existingText === '' ? 'create' : 'update'} \`cloud/.dev.vars\`` +
            ` (${changes} var${changes === 1 ? '' : 's'}). Nothing written.`,
    );
  } else if (!merged.changed) {
    console.log('  Nothing to change: every var this script manages is already set.');
  } else {
    // 0o600 is honoured on POSIX and ignored on Windows, where the file inherits
    // the directory ACL. Cheap either way.
    writeFileSync(DEV_VARS_PATH, merged.text, { encoding: 'utf8', mode: 0o600 });
    console.log('  Wrote `cloud/.dev.vars`.');
  }

  // The token the provisioning step needs: whatever is on disk, or what was just
  // generated for it. Read out of the merged text so both paths agree.
  const adminToken = parseDevVars(merged.text).get('PHORMA_ADMIN_TOKEN')?.value?.trim() ?? '';

  // ── 3. Local D1 ───────────────────────────────────────────────────────────
  const migrateArgs = ['d1', 'migrations', 'apply', D1_DATABASE, '--env', 'hosted', '--local'];
  console.log('\n[3/4] Applying migrations to the LOCAL D1');
  if (flags.dryRun) {
    console.log(`  DRY RUN: would run \`npx wrangler ${migrateArgs.join(' ')}\`.`);
  } else {
    const result = wrangler(migrateArgs);
    const output = `${result.stdout}${result.stderr}`.trim();
    for (const line of output.split(/\r?\n/)) {
      if (line.trim() !== '') console.log(`  | ${line.trim()}`);
    }
    if (result.status !== 0) {
      abort(
        `\`wrangler ${migrateArgs.join(' ')}\` failed (exit ${result.status}). ` +
          '`.dev.vars` is written, so fix the cause and re-run.',
      );
    }
    console.log('  Local D1 schema is up to date. Re-running applies nothing.');
  }

  // ── 4. Tenant row ─────────────────────────────────────────────────────────
  console.log(`\n[4/4] Provisioning a local tenant on ${WORKER_URL}`);
  let provisioned = false;
  const probe = await probeWorker();
  if (!probe.listening) {
    console.log('  No worker is listening, so this step is skipped.');
    note(
      `Nothing answered on ${WORKER_URL}, so no tenant row was provisioned. Start the worker ` +
        'with `npx wrangler dev --env hosted` and re-run `npm run dev:setup`.',
    );
  } else if (flags.dryRun) {
    if (!probe.phorma) {
      console.log(`  WARNING: something is listening on ${WORKER_URL} but it is not this worker.`);
    }
    console.log('  A worker is listening.');
    const tenantId = await resolveTenantId(flags, { dryRun: true });
    console.log(
      `  DRY RUN: would POST /api/provision {tenantId: ${tenantId ?? '<prompted>'}, ` +
        `tier: ${flags.tier}} with the PHORMA_ADMIN_TOKEN from \`.dev.vars\`.`,
    );
  } else if (adminToken === '') {
    console.log('  Skipped: `.dev.vars` carries no PHORMA_ADMIN_TOKEN to authenticate with.');
    note('PHORMA_ADMIN_TOKEN is empty in `.dev.vars`, so `/api/provision` cannot be called.');
  } else {
    if (!probe.phorma) {
      console.log(`  WARNING: something is listening on ${WORKER_URL} but it is not this worker.`);
    }
    const tenantId = await resolveTenantId(flags, { dryRun: false });
    const response = await provisionTenant({
      adminToken,
      tenantId,
      tier: flags.tier,
    });
    if (!response.ok) {
      const detail = response.body?.error ?? response.text.slice(0, 300);
      abort(
        `POST /api/provision answered ${response.status}: ${detail}\n` +
          '  A 401 here usually means the worker is running with a different ' +
          'PHORMA_ADMIN_TOKEN than `.dev.vars` now holds. Restart it and re-run.',
      );
    }
    provisioned = true;
    const body = response.body ?? {};
    console.log(`  Tenant ${tenantId} is active on tier ${body.tier ?? flags.tier}.`);
    console.log(`  runtimeKeyAction: ${body.runtimeKeyAction ?? 'unknown'}`);
    console.log(`  runtimeKeyProvisioned: ${body.runtimeKeyProvisioned ?? 'unknown'}`);
    if (body.runtimeKeyLimitUsd !== undefined) {
      console.log(`  runtimeKeyLimitUsd: ${body.runtimeKeyLimitUsd}`);
    }
    // Our own sentence, never a vendor body. See `/api/provision` in `api.ts`.
    if (body.runtimeKeyDetail) console.log(`  runtimeKeyDetail: ${body.runtimeKeyDetail}`);
    if (body.runtimeKeyProvisioned === false) {
      note(
        'The tenant row exists but has no runtime key, so hosted inference will refuse with ' +
          '`no_runtime_key`. Everything else, billing included, works.',
      );
    }
  }

  // Re-read rather than reuse the pre-merge map: this run may have just written
  // the value, and the summary should describe the file as it now stands.
  const finalVars = parseDevVars(
    existsSync(DEV_VARS_PATH) ? readFileSync(DEV_VARS_PATH, 'utf8') : '',
  );
  const webhook = finalVars.get('STRIPE_WEBHOOK_SECRET');
  console.log(
    closingSummary({
      provisioned,
      workerListening: probe.listening,
      webhookSecretSet: Boolean(webhook?.active && webhook.value.trim() !== ''),
    }),
  );

  if (notes.length > 0) {
    console.log('Notes\n=====\n');
    for (const line of notes) console.log(`  - ${line}\n`);
  }

  return 0;
}

/**
 * Only when RUN, never when imported. `cloud/test/setup-local-dev.test.mjs`
 * imports the merge, the validators and the id check, and importing a module that
 * immediately started writing secrets and shelling out to wrangler would be a
 * poor trade for that coverage.
 */
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  /**
   * `process.exitCode`, NOT `process.exit()`.
   *
   * `process.exit()` tears the process down immediately, and on Windows that
   * raced libuv's own teardown of the console handles this script has touched:
   * the run finished, printed its whole summary, and then died with
   * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c`
   * and exit code 0xC0000409. Every side effect had already landed, so the only
   * casualty was the exit status - which is exactly the thing a wrapper or a CI
   * step reads to decide whether setup worked.
   *
   * Setting the code and returning lets the loop drain on its own, which also
   * guarantees the buffered stdout is flushed. Nothing here holds the loop open:
   * both prompt helpers `pause()` stdin in their finish handlers, and on a run
   * with no prompt stdin is never resumed at all.
   */
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`\nSetup aborted: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
