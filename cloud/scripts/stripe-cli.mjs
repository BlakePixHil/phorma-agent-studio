#!/usr/bin/env node
/**
 * stripe-cli.mjs - runs the Stripe CLI PINNED to the same Stripe account the
 * local worker uses, instead of whichever account `stripe login` happened to
 * authenticate last.
 *
 *   cd cloud
 *   node scripts/stripe-cli.mjs listen --forward-to http://localhost:8787/api/stripe/webhook
 *   node scripts/stripe-cli.mjs trigger customer.subscription.updated
 *
 * ## Why this exists
 *
 * There is more than one Phorma sandbox. The billing catalogue (the six
 * `phorma_*` lookup keys, the `inclusive` tax behaviour, the AU GST
 * registration) lives on ONE of them, and `cloud/.dev.vars`'
 * `STRIPE_SECRET_KEY` points at that one. The Stripe CLI keeps its own,
 * SEPARATE credential from `stripe login`, and on this machine it was
 * authenticated to a DIFFERENT sandbox entirely.
 *
 * That mismatch is close to undetectable by looking at it. `stripe listen`
 * starts happily and prints a perfectly valid `whsec_`, the worker accepts that
 * secret and verifies signatures against it without complaint - and then no
 * event ever arrives, because the listener is subscribed to an account nothing
 * is happening on. Meanwhile a real checkout on the worker's account completes
 * and its webhook goes nowhere. Two healthy-looking halves, wired to different
 * accounts.
 *
 * So the CLI is given the key EXPLICITLY, from the same file the worker reads.
 * One source of truth for "which account is this", and the failure mode above
 * becomes impossible rather than merely unlikely.
 *
 * The key travels in the `STRIPE_API_KEY` environment variable of the child
 * process, never on the command line: an argv is visible to other processes and
 * lands in shell history, and this is a credential.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CLOUD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_VARS = resolve(CLOUD_DIR, '.dev.vars');

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(
    'Usage: node scripts/stripe-cli.mjs <stripe args...>\n\n' +
      'Runs the Stripe CLI against the account named by STRIPE_SECRET_KEY in\n' +
      '`cloud/.dev.vars`, rather than whichever account `stripe login` last used.\n\n' +
      'Examples:\n' +
      '  node scripts/stripe-cli.mjs listen --forward-to http://localhost:8787/api/stripe/webhook\n' +
      '  node scripts/stripe-cli.mjs trigger customer.subscription.updated\n',
  );
  process.exit(args.length === 0 ? 1 : 0);
}

/** The one value this script reads, and the only reason it touches the file. */
function stripeSecretKey() {
  let text;
  try {
    text = readFileSync(DEV_VARS, 'utf8');
  } catch {
    console.error(
      'No `cloud/.dev.vars`. Run `npm run dev:setup` first - it writes the file and\n' +
        'validates that the Stripe key is a SANDBOX key.',
    );
    process.exit(1);
  }
  // Commented lines are deliberately not matched: a `#`-prefixed key is not set.
  const match = /^\s*STRIPE_SECRET_KEY\s*=\s*(.+)$/m.exec(text);
  const value = match?.[1]?.trim();
  if (!value) {
    console.error(
      'STRIPE_SECRET_KEY is not set in `cloud/.dev.vars`. Run `npm run dev:setup`.',
    );
    process.exit(1);
  }
  // Refused rather than passed through. A live key here would point the CLI at
  // the production account, where `trigger` fabricates real objects and `listen`
  // would forward real customers' events into a local worker.
  if (value.startsWith('sk_live_') || value.startsWith('rk_live_')) {
    console.error(
      'STRIPE_SECRET_KEY in `cloud/.dev.vars` is a LIVE key. Refusing to run the Stripe\n' +
        'CLI against the production account from a local dev script.',
    );
    process.exit(1);
  }
  return value;
}

/**
 * Windows needs a shell here, because `stripe` is a `.cmd` shim and `spawn`
 * cannot exec a batch file directly.
 *
 * The command is assembled into ONE pre-quoted string rather than passed as an
 * args array alongside `shell: true`. That combination is what Node 22 deprecates
 * in DEP0190, and the reason is real: with a shell, an args array is concatenated
 * rather than escaped, so a value containing a shell metacharacter would be
 * interpreted instead of passed. Quoting here, once, is the fix. Every argument
 * is wrapped and any embedded quote doubled, per `cmd.exe` rules.
 */
function windowsCommand(argv) {
  return ['stripe', ...argv].map((arg) => `"${String(arg).replace(/"/g, '""')}"`).join(' ');
}

const onWindows = process.platform === 'win32';
const child = spawn(onWindows ? windowsCommand(args) : 'stripe', onWindows ? [] : args, {
  cwd: CLOUD_DIR,
  // Inherited so `listen` streams its output and its `whsec_` straight through,
  // and so Ctrl+C reaches the CLI rather than only this wrapper.
  stdio: 'inherit',
  env: { ...process.env, STRIPE_API_KEY: stripeSecretKey() },
  shell: onWindows,
});

child.on('error', (error) => {
  console.error(
    `Could not run the Stripe CLI (${error.message}). Install it from ` +
      'https://docs.stripe.com/stripe-cli and make sure `stripe` is on PATH.',
  );
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
