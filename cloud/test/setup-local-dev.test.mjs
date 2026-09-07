/**
 * The local dev setup script's pure pieces (`cloud/scripts/setup-local-dev.mjs`).
 *
 * The script itself writes secrets, shells out to wrangler and talks to a local
 * worker, none of which is worth testing here. What IS worth pinning is the four
 * decisions it makes before any of that happens, because each one fails silently
 * in the direction of a real incident:
 *
 *  - the `.dev.vars` merge. It must never clobber a value already on disk, must
 *    fill an empty one in place rather than appending a duplicate, and must leave
 *    key ORDER alone. A merge that reordered or duplicated keys would be read as
 *    the operator's own file being rewritten by a tool they ran once.
 *  - the prefix validators. `sk_live_` is the whole reason the script exists, so
 *    "rejects a live key" is the assertion, not a nicety. The message must also
 *    never carry the value.
 *  - the Clerk user id check. `tenants.id` IS the Clerk user id, so a typo makes
 *    an orphan row `/api/me` can never find.
 *  - the gitignore guard, in BOTH directions. It is the refusal that stops the
 *    script writing a committable secret file, and a guard that cannot fail is
 *    not a guard.
 *
 * Plus one behavioural assertion that needs no terminal: the hidden reader writes
 * NOTHING to its output stream, not even a mask character. A fake TTY is enough
 * to prove the reader itself never echoes.
 *
 * Cheap on purpose: no Miniflare, no network, no D1, no wrangler.
 *
 * Run: node cloud/test/setup-local-dev.test.mjs
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';

// Imported, not executed: the script runs `main()` only when it is `process.argv[1]`.
const {
  checkGitignore,
  closingSummary,
  isClerkUserIdShape,
  mergeDevVars,
  parseArgs,
  parseDevVars,
  readHiddenLine,
  validateClerkSecretKey,
  validateOpenRouterProvisioningKey,
  validateStripeSecretKey,
} = await import('../scripts/setup-local-dev.mjs');

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// --- The `.dev.vars` merge -------------------------------------------------

console.log('\n.dev.vars merge');

{
  const additions = [
    { key: 'PHORMA_MODE', value: 'hosted' },
    { key: 'KEY_ENC_SECRET', value: 'generated-base64' },
    { key: 'PHORMA_ADMIN_TOKEN', value: 'generated-hex' },
  ];

  const fresh = mergeDevVars('', additions);
  const freshParsed = parseDevVars(fresh.text);
  check(
    'a fresh file gets every addition',
    freshParsed.get('PHORMA_MODE')?.value === 'hosted' &&
      freshParsed.get('KEY_ENC_SECRET')?.value === 'generated-base64' &&
      freshParsed.get('PHORMA_ADMIN_TOKEN')?.value === 'generated-hex',
    fresh.text,
  );
  check('a fresh file reports all three as added', fresh.added.length === 3, fresh.added.join(','));
  check('a fresh file ends with exactly one newline', /[^\n]\n$/.test(fresh.text));

  const existing = [
    '# my own header',
    'PHORMA_MODE=hosted',
    'CLERK_SECRET_KEY=sk_test_mine',
    '',
    'KEY_ENC_SECRET=',
    '',
  ].join('\n');
  const second = mergeDevVars(existing, additions);
  const secondParsed = parseDevVars(second.text);
  check(
    'an existing non-empty value is kept verbatim',
    secondParsed.get('CLERK_SECRET_KEY')?.value === 'sk_test_mine' &&
      second.kept.includes('PHORMA_MODE'),
    second.text,
  );
  check(
    'an existing EMPTY value is filled in place, not appended',
    second.filled.includes('KEY_ENC_SECRET') &&
      secondParsed.get('KEY_ENC_SECRET')?.value === 'generated-base64' &&
      (second.text.match(/^KEY_ENC_SECRET=/gm) ?? []).length === 1,
    second.text,
  );
  check(
    'filling in place does not move the key',
    second.text.split(/\r?\n/).indexOf('KEY_ENC_SECRET=generated-base64') === 4,
    second.text,
  );
  check(
    'only the genuinely missing key is appended',
    second.added.length === 1 && second.added[0] === 'PHORMA_ADMIN_TOKEN',
    second.added.join(','),
  );
  check('the operator comment survives', second.text.includes('# my own header'));

  // Idempotence: the second merge's output merged again must be a no-op.
  const third = mergeDevVars(second.text, additions);
  check(
    're-merging changes nothing',
    third.changed === false && third.text === second.text && third.kept.length === 3,
    JSON.stringify({ changed: third.changed, kept: third.kept }),
  );
}

{
  // Key order is stable across a merge: existing keys keep their relative order,
  // appended ones follow in `additions` order.
  const existing = ['C=3', 'A=1', 'B=2', ''].join('\n');
  const merged = mergeDevVars(existing, [
    { key: 'A', value: 'x' },
    { key: 'Z', value: '26' },
    { key: 'Y', value: '25' },
  ]);
  const order = [...parseDevVars(merged.text).keys()];
  check(
    'existing key order is preserved and additions follow in order',
    order.join(',') === 'C,A,B,Z,Y',
    order.join(','),
  );
}

{
  // A placeholder addition writes a COMMENTED line, and never stacks on a re-run.
  const first = mergeDevVars('', [
    { key: 'STRIPE_WEBHOOK_SECRET', value: null, placeholder: 'whsec_...' },
  ]);
  check(
    'a placeholder is written commented out',
    first.text.includes('# STRIPE_WEBHOOK_SECRET=whsec_...') &&
      parseDevVars(first.text).get('STRIPE_WEBHOOK_SECRET')?.active === false,
    first.text,
  );
  const again = mergeDevVars(first.text, [
    { key: 'STRIPE_WEBHOOK_SECRET', value: null, placeholder: 'whsec_...' },
  ]);
  check(
    'a placeholder is not stacked on a re-run',
    again.text === first.text && again.skipped[0]?.key === 'STRIPE_WEBHOOK_SECRET',
    again.text,
  );
  // A real value later supplied for a key that exists only as a comment is added.
  const supplied = mergeDevVars(first.text, [
    { key: 'STRIPE_WEBHOOK_SECRET', value: 'whsec_real' },
  ]);
  check(
    'a commented key does not count as set',
    supplied.added.includes('STRIPE_WEBHOOK_SECRET') &&
      parseDevVars(supplied.text).get('STRIPE_WEBHOOK_SECRET')?.value === 'whsec_real',
    supplied.text,
  );
}

{
  // CRLF in, CRLF out. Rejoining with LF would rewrite every line of a file the
  // operator also edits by hand, which shows up as a whole-file diff.
  const merged = mergeDevVars('PHORMA_MODE=hosted\r\n', [{ key: 'NEW_KEY', value: 'v' }]);
  check(
    'CRLF line endings are preserved',
    merged.text.includes('\r\n') && !/[^\r]\n/.test(merged.text),
    JSON.stringify(merged.text),
  );
}

// --- Property: a value on disk is never changed ---------------------------

console.log('\n.dev.vars merge property');

{
  const KEYS = ['PHORMA_MODE', 'KEY_ENC_SECRET', 'PHORMA_ADMIN_TOKEN', 'CLERK_SECRET_KEY'];
  // Values a `.dev.vars` line can actually hold: no newline, no `=` ambiguity to
  // worry about (everything after the first `=` is the value), never blank.
  const value = fc.stringMatching(/^[A-Za-z0-9+/=_.:-]{1,24}$/);

  const property = fc.property(
    fc.uniqueArray(fc.constantFrom(...KEYS), { minLength: 0, maxLength: KEYS.length }),
    fc.array(value, { minLength: KEYS.length, maxLength: KEYS.length }),
    fc.array(value, { minLength: KEYS.length, maxLength: KEYS.length }),
    (present, onDisk, offered) => {
      const existing = present.map((key, index) => `${key}=${onDisk[index]}`).join('\n');
      const additions = KEYS.map((key, index) => ({ key, value: offered[index] }));
      const merged = mergeDevVars(existing, additions);
      const parsed = parseDevVars(merged.text);
      // 1. Every value that was on disk is still exactly that value.
      present.forEach((key, index) => {
        if (parsed.get(key)?.value !== onDisk[index]) {
          throw new Error(`${key} changed from ${onDisk[index]} to ${parsed.get(key)?.value}`);
        }
      });
      // 2. Every key ends up present, so a gap is always filled.
      for (const key of KEYS) {
        if (!parsed.get(key)?.active) throw new Error(`${key} is missing after the merge`);
      }
      // 3. No key is ever duplicated.
      const active = merged.text
        .split(/\r?\n/)
        .filter((line) => KEYS.some((key) => line.startsWith(`${key}=`)));
      if (active.length !== KEYS.length) throw new Error(`duplicate assignment: ${active.join(' | ')}`);
      // 4. Reported kept + filled + added accounts for every key exactly once.
      const reported = [...merged.kept, ...merged.filled, ...merged.added];
      if (new Set(reported).size !== KEYS.length) throw new Error(`report mismatch: ${reported}`);
      return true;
    },
  );

  try {
    fc.assert(property, { numRuns: 200 });
    check('an existing value is never changed, a gap is always filled, no duplicates', true);
  } catch (error) {
    check(
      'an existing value is never changed, a gap is always filled, no duplicates',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

// --- Prefix validators -----------------------------------------------------

console.log('\nprefix and length validators');

/**
 * A body long enough to clear the 32-character placeholder floor.
 *
 * The fixtures below used to be things like `sk_test_abc`, which read fine and
 * were WRONG: they are exactly the shape of a stub, and asserting that a stub is
 * accepted pinned the bug. This machine's own environment carried
 * `STRIPE_SECRET_KEY=rk_test_...` at 16 characters, a prefix-only check waved it
 * through, and the value reached `.dev.vars` to fail later as an opaque Stripe
 * 400. So a fixture that stands for a REAL key has to be real-ish in length.
 */
const BODY = 'x'.repeat(40);

{
  const live = validateClerkSecretKey('sk_live_AbCdEf123456');
  check('a live Clerk key is refused', live.ok === false);
  check(
    'the refusal explains the production-instance risk',
    live.message.includes('PRODUCTION Clerk instance'),
    live.message,
  );
  check(
    'the refusal does not echo the value',
    !live.message.includes('sk_live_AbCdEf123456') && !live.message.includes('AbCdEf123456'),
    live.message,
  );
  check('a test Clerk key is accepted', validateClerkSecretKey(`sk_test_${BODY}`).ok === true);
  check(
    'a test Clerk key is trimmed',
    validateClerkSecretKey(`  sk_test_${BODY} \n`).value === `sk_test_${BODY}`,
  );
  check('an empty Clerk key is refused', validateClerkSecretKey('').ok === false);
  check(
    'a publishable Clerk key is refused',
    validateClerkSecretKey(`pk_test_${BODY}`).ok === false,
  );
  check('a non-string Clerk key is refused', validateClerkSecretKey(undefined).ok === false);

  // The placeholder floor. A right-prefix, too-short value is the one case a
  // prefix check cannot see, and it is the case that actually occurred.
  const stub = validateClerkSecretKey('sk_test_abc');
  check('a right-prefix stub is refused on length', stub.ok === false, stub.message);
  check(
    'the length refusal says PLACEHOLDER rather than blaming the prefix',
    stub.message.includes('PLACEHOLDER') && stub.message.includes('too short'),
    stub.message,
  );
  check(
    'the length refusal reports the length but not the value',
    stub.message.includes('11 characters') && !stub.message.includes('sk_test_abc'),
    stub.message,
  );
  check(
    'the length refusal names the environment escape hatch, since env beats the prompt',
    stub.message.includes('Remove-Item Env:\\CLERK_SECRET_KEY'),
    stub.message,
  );
  // Exactly at the floor passes, one under does not. Pinned so the boundary
  // cannot drift silently.
  check(
    'the floor is inclusive at 32 and exclusive at 31',
    validateClerkSecretKey(`sk_test_${'y'.repeat(24)}`).ok === true &&
      validateClerkSecretKey(`sk_test_${'y'.repeat(23)}`).ok === false,
  );
}

{
  const live = validateStripeSecretKey('sk_live_stripe999');
  check('a live Stripe key is refused', live.ok === false);
  check(
    'the Stripe refusal does not echo the value',
    !live.message.includes('sk_live_stripe999'),
    live.message,
  );
  check('rk_live_ is refused too', validateStripeSecretKey('rk_live_x').ok === false);
  check('sk_test_ is accepted', validateStripeSecretKey(`sk_test_${BODY}`).ok === true);
  check('rk_test_ is accepted', validateStripeSecretKey(`rk_test_${BODY}`).ok === true);
  check('an empty Stripe key is refused', validateStripeSecretKey('   ').ok === false);
  check(
    'a whsec_ value in the Stripe slot is refused',
    validateStripeSecretKey(`whsec_${BODY}`).ok === false,
  );
  // The exact value this machine's environment held, which a prefix-only check
  // accepted. Kept as a literal regression fixture rather than a generated one.
  check(
    'the 16-character rk_test_ stub from the real environment is refused',
    validateStripeSecretKey('rk_test_stub1234').ok === false,
  );
}

{
  check(
    'an empty OpenRouter key is accepted as a decision',
    validateOpenRouterProvisioningKey('').ok === true &&
      validateOpenRouterProvisioningKey('').value === '',
  );
  check(
    'sk-or- is accepted',
    validateOpenRouterProvisioningKey(`sk-or-v1-${BODY}`).ok === true,
  );
  const wrong = validateOpenRouterProvisioningKey(`sk_test_notopenrouter${BODY}`);
  check('a non-OpenRouter key is refused', wrong.ok === false);
  check(
    'the OpenRouter refusal does not echo the value',
    !wrong.message.includes('notopenrouter'),
    wrong.message,
  );
  // An empty value stays a legitimate decision, so the floor must NOT turn the
  // optional key into a required one.
  check(
    'the length floor does not make the optional key required',
    validateOpenRouterProvisioningKey('').ok === true,
  );
  const stub = validateOpenRouterProvisioningKey('sk-or-stub');
  check('a right-prefix OpenRouter stub is refused', stub.ok === false, stub.message);
  check(
    'that refusal still offers the leave-it-empty route',
    stub.message.includes('optional'),
    stub.message,
  );
}

// --- Clerk user id ---------------------------------------------------------

console.log('\nClerk user id shape');

check('a plain user id passes', isClerkUserIdShape('user_2abcDEF_-123') === true);
check('a bare id is refused', isClerkUserIdShape('2abcDEF') === false);
check('the wrong prefix is refused', isClerkUserIdShape('org_2abc') === false);
check('an email is refused', isClerkUserIdShape('user@example.com') === false);
check('the prefix alone is refused', isClerkUserIdShape('user_') === false);
check('an empty string is refused', isClerkUserIdShape('') === false);
check('a non-string is refused', isClerkUserIdShape(null) === false);
check('markup is refused', isClerkUserIdShape('user_<script>') === false);
check(
  'an over-long id is refused',
  isClerkUserIdShape(`user_${'a'.repeat(121)}`) === false,
);

{
  // The copy in this script and `isClerkUserId` in `cloud/src/tenants.ts` must
  // agree, because a value this script accepts and that route refuses is a
  // confusing 400 at the end of a setup that reported success. Compared as source
  // text rather than by importing TypeScript, which would need `tsx`.
  const tenantsSource = readFileSync(join(here, '..', 'src', 'tenants.ts'), 'utf8');
  check(
    'the id pattern still matches the one in `cloud/src/tenants.ts`',
    tenantsSource.includes('/^user_[A-Za-z0-9_-]{1,120}$/'),
    'the pattern in tenants.ts changed; update CLERK_USER_ID in setup-local-dev.mjs',
  );
}

// --- The gitignore guard ---------------------------------------------------

console.log('\ngitignore guard');

{
  const real = checkGitignore(readFileSync(join(here, '..', '.gitignore'), 'utf8'));
  check('the real `cloud/.gitignore` passes', real.ok === true, real.problems.join(' | '));

  const noGlob = checkGitignore(['node_modules/', '.dev.vars', '!.dev.vars.example'].join('\n'));
  check(
    'a bare `.dev.vars` pattern is refused',
    noGlob.ok === false && noGlob.problems.some((problem) => problem.includes('.dev.vars*')),
    noGlob.problems.join(' | '),
  );

  const noNegation = checkGitignore(['.dev.vars*'].join('\n'));
  check(
    'a missing `!.dev.vars.example` negation is refused',
    noNegation.ok === false &&
      noNegation.problems.some((problem) => problem.includes('.dev.vars.example')),
    noNegation.problems.join(' | '),
  );

  check('an empty gitignore is refused', checkGitignore('').ok === false);
  check('a nonexistent gitignore text is refused', checkGitignore(undefined).ok === false);
  check(
    'a COMMENTED pattern does not count',
    checkGitignore(['# .dev.vars*', '!.dev.vars.example'].join('\n')).ok === false,
  );
}

// --- Arguments -------------------------------------------------------------

console.log('\narguments');

{
  const defaults = parseArgs([]);
  check(
    'the default is a real run on tier team',
    defaults.dryRun === false && defaults.tier === 'team' && defaults.tenant === null,
    JSON.stringify(defaults),
  );
  check('--dry-run parses', parseArgs(['--dry-run']).dryRun === true);
  check(
    '--tenant and --tier parse',
    parseArgs(['--tenant', 'user_1', '--tier', 'pro']).tenant === 'user_1',
  );
  let threw = false;
  try {
    parseArgs(['--tier', 'enterprise']);
  } catch {
    threw = true;
  }
  check('an unknown tier is refused', threw);
  let message = '';
  try {
    parseArgs(['--tenant', 'nope']);
  } catch (error) {
    message = error.message;
  }
  check(
    'a non-user_ tenant id is refused up front, before any write',
    /not a Clerk user id/.test(message) && /orphan row/.test(message),
    message,
  );
  threw = false;
  try {
    parseArgs(['--nope']);
  } catch {
    threw = true;
  }
  check('an unknown flag is refused', threw);
  threw = false;
  try {
    parseArgs(['--tenant']);
  } catch {
    threw = true;
  }
  check('a flag with no value is refused', threw);
}

// --- Hidden input writes nothing ------------------------------------------

console.log('\nhidden input');

/** The smallest thing `readHiddenLine` accepts as a raw-mode TTY. */
function fakeTty() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.rawModeCalls = [];
  input.setRawMode = (value) => {
    input.isRaw = value;
    input.rawModeCalls.push(value);
  };
  input.resume = () => undefined;
  input.pause = () => undefined;
  input.setEncoding = () => undefined;
  const written = [];
  const output = { write: (chunk) => written.push(String(chunk)) };
  return { input, output, written };
}

{
  const { input, output, written } = fakeTty();
  const pending = readHiddenLine('CLERK_SECRET_KEY', { input, output });
  for (const char of 'sk_test_secret') input.emit('data', char);
  input.emit('data', '\r');
  const value = await pending;
  check('the typed value is returned intact', value === 'sk_test_secret', value);
  check(
    'nothing but the closing newline reaches the output stream',
    written.join('') === '\n',
    JSON.stringify(written),
  );
  check(
    'no fragment of the value is echoed',
    !written.join('').includes('sk_') && !written.join('').includes('secret'),
    JSON.stringify(written),
  );
  check('no mask character is written either', !written.join('').includes('*'));
  check(
    'raw mode is switched on and then restored',
    input.rawModeCalls.join(',') === 'true,false' && input.isRaw === false,
    input.rawModeCalls.join(','),
  );
}

{
  const { input, output } = fakeTty();
  const pending = readHiddenLine('X', { input, output });
  input.emit('data', 'ab');
  input.emit('data', '\u007f'); // DEL
  input.emit('data', 'c');
  input.emit('data', '\u001b[A'); // an arrow key, which must not land in the value
  input.emit('data', '\u001b[1;5D'); // Ctrl+Left, a parameterized sequence
  input.emit('data', '\u001bO'); // an SS3 prefix split from its final byte
  input.emit('data', 'P');
  input.emit('data', 'd');
  input.emit('data', '\n');
  const typed = await pending;
  check('backspace deletes and escape sequences are dropped whole', typed === 'acd', typed);
}

{
  const { input, output } = fakeTty();
  const pending = readHiddenLine('X', { input, output });
  input.emit('data', 'partial');
  input.emit('data', '\u0003'); // Ctrl+C
  let interrupted = false;
  await pending.catch((error) => {
    interrupted = error instanceof Error && error.message === 'Interrupted.';
  });
  check('Ctrl+C aborts instead of returning a partial value', interrupted);
  check('raw mode is restored after an abort', input.isRaw === false);
}

{
  // A pipe has no raw mode, so there is no way to suppress the echo. The reader
  // refuses rather than falling back to a visible prompt.
  const notATty = new EventEmitter();
  notATty.isTTY = false;
  let refused = false;
  await readHiddenLine('CLERK_SECRET_KEY', { input: notATty, output: { write: () => undefined } })
    .catch((error) => {
      refused = /not a TTY/.test(error.message) && /environment variable/.test(error.message);
    });
  check('a non-TTY stdin is refused, never echoed', refused);
}

// --- The closing summary ---------------------------------------------------

console.log('\nclosing summary');

{
  const done = closingSummary({ provisioned: true, workerListening: true });
  // A worker that just answered a provisioning POST must NOT be reported as
  // something still to start: it reads as though the script did not notice its
  // own success, and it invites a second `wrangler dev` that fails on the port.
  check(
    'a listening worker is not listed as still to be started',
    !done.includes('npx wrangler dev --env hosted'),
    done,
  );
  const cold = closingSummary({ provisioned: false, workerListening: false });
  check(
    'but a cold run does tell the operator to start it',
    cold.includes('npx wrangler dev --env hosted'),
  );

  // The PINNED wrapper, not a bare `stripe listen`. The CLI's own `stripe login`
  // credential can name a different sandbox than `.dev.vars` does, and that
  // mismatch presents as a healthy listener that simply never receives anything.
  check('it gives the pinned webhook command', done.includes('npm run dev:webhooks'));

  // The webhook step describes the file as it actually stands, so a re-run does
  // not tell the operator to paste a secret that is already in place.
  check(
    'with the secret already set, it says there is nothing to paste',
    closingSummary({ provisioned: true, workerListening: true, webhookSecretSet: true }).includes(
      'nothing to paste',
    ),
  );
  check(
    'and without it, it asks for the whsec_',
    done.includes('STRIPE_WEBHOOK_SECRET=whsec_...') && !done.includes('nothing to paste'),
  );
  check(
    'and it warns against the bare stripe listen that caused the mismatch',
    done.includes('NOT a bare `stripe listen`'),
  );
  check(
    'it gives the localStorage one-liner with the exact key',
    done.includes(
      "localStorage.setItem('phorma.layout.phormaCloudUrl', JSON.stringify('http://localhost:8787'))",
    ),
    done,
  );
  check('a provisioned run does not ask for a re-run', !done.includes('Re-run this script'));

  const pending = closingSummary({ provisioned: false, workerListening: false });
  check('an unprovisioned run asks for a re-run', pending.includes('Re-run this script'));
  check(
    'the steps stay numbered in order',
    pending.indexOf(' 1. ') < pending.indexOf(' 2. ') &&
      pending.indexOf(' 2. ') < pending.indexOf(' 3. ') &&
      pending.indexOf(' 3. ') < pending.indexOf(' 4. '),
  );
}

// --- No em dash anywhere in the script ------------------------------------

{
  const source = readFileSync(join(here, '..', 'scripts', 'setup-local-dev.mjs'), 'utf8');
  check('the script carries no em dash', !source.includes('\u2014'));
}

console.log(
  `\nsetup-local-dev: ${failures === 0 ? 'all checks passed' : `${failures} failure(s)`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
