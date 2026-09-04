#!/usr/bin/env node
/**
 * A drain barrier between the socket-heavy suites in `test:unit`.
 *
 * `miniflare-loopback.mjs` explains the cost: one loopback socket per
 * `dispatchFetch` AND one per statement through a `getD1Database` handle, each
 * parked in TIME_WAIT for two minutes on Windows against a 16,384-port ephemeral
 * range. `withLoopbackRetryD1` survives a transient shortage; it cannot survive a
 * range that is genuinely empty for longer than its backoff ladder, and the
 * billing block now spends more sockets in one TIME_WAIT window than the range
 * holds. Measured on Windows: `stripe-webhook` alone spends ~7,050 and passes,
 * and the SAME suite fails on `connect EADDRINUSE` around iteration 60 of 120
 * when it starts behind `tenant-billing`, `entitlement` and `billing-routes`.
 *
 * So the fix is to stop the wall forming rather than to retry through it. Suite
 * ORDER was the first half of that; this is the second: before a heavy suite,
 * wait until the range has drained back to a headroom the suite is known to fit
 * in. Nothing about any property changes, and no iteration count moves.
 *
 * NOT NEEDED IN CI, and deliberately free there: `ci.yml` runs on
 * `ubuntu-22.04`, where the default range is 28,232 ports held for 60s - roughly
 * four times the budget - and the chain has never exhausted it. On any
 * non-Windows platform this exits immediately without spawning anything.
 *
 * The wait is CAPPED and then proceeds anyway. A barrier that blocks forever
 * would turn a slow machine into a hung CI job, and the suite behind it may well
 * pass regardless - the retry wrappers are still in place underneath.
 *
 * Run: node test/await-port-drain.mjs [freePortsNeeded] [--timeout=<seconds>]
 */
import { execFileSync } from 'node:child_process';

/** Ports the suite behind this barrier needs, with margin. */
const DEFAULT_FREE_PORTS_NEEDED = 10_000;

/** Never block longer than this, whatever the range looks like. */
const DEFAULT_TIMEOUT_SECONDS = 180;

/** Windows TIME_WAIT is 120s and drains continuously, so poll rather than sleep it out. */
const POLL_MS = 3_000;

if (process.platform !== 'win32') process.exit(0);

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const needed = Number.parseInt(positional[0] ?? '', 10) || DEFAULT_FREE_PORTS_NEEDED;
const timeoutArg = process.argv.find((a) => a.startsWith('--timeout='));
const timeoutSeconds =
  Number.parseInt(timeoutArg?.slice('--timeout='.length) ?? '', 10) || DEFAULT_TIMEOUT_SECONDS;

/**
 * The configured dynamic range, read rather than hardcoded - it is machine
 * policy and `netsh int ipv4 set dynamicport` can widen it. A parse failure
 * falls back to the Windows default so the barrier still functions.
 */
function rangeSize() {
  try {
    const out = execFileSync('netsh', ['int', 'ipv4', 'show', 'dynamicport', 'tcp'], {
      encoding: 'utf-8',
      windowsHide: true,
    });
    const match = out.match(/Number of Ports\s*:\s*(\d+)/i);
    if (match) return Number.parseInt(match[1], 10);
  } catch {
    /* fall through to the documented default */
  }
  return 16_384;
}

/**
 * TIME_WAIT is what the loopback traffic leaves behind and is the only consumer
 * large enough to matter here, so it stands in for "ports not currently
 * available". `netstat -ano -p tcp` is the cheapest source that does not need a
 * dependency; `-n` keeps it from resolving names, which is what makes it slow.
 */
function timeWaitCount() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    let count = 0;
    for (const line of out.split('\n')) if (line.includes('TIME_WAIT')) count += 1;
    return count;
  } catch {
    return 0;
  }
}

const total = rangeSize();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + timeoutSeconds * 1000;

let waited = false;
for (;;) {
  const free = total - timeWaitCount();
  if (free >= needed) {
    if (waited) console.log(`  (port drain barrier: ${free} of ${total} free, continuing)`);
    break;
  }
  if (Date.now() >= deadline) {
    console.warn(
      `  WARN: port drain barrier timed out after ${timeoutSeconds}s with only ${free} of ` +
        `${total} ephemeral ports free (wanted ${needed}). Continuing anyway - the loopback ` +
        'retry wrappers may still carry the suite. A repeat means the chain needs a wider ' +
        'range (`netsh int ipv4 set dynamicport tcp start=10000 num=55000`) or a suite that ' +
        'spends fewer sockets.',
    );
    break;
  }
  if (!waited) {
    console.log(
      `  (port drain barrier: ${free} of ${total} ephemeral ports free, waiting for ${needed})`,
    );
    waited = true;
  }
  await sleep(POLL_MS);
}
