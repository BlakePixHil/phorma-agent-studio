/**
 * Updater manifest route tests (`cloud/src/releases.ts`).
 *
 * Why this file exists: `releases.ts` had NO tests, and it is the code that
 * decides whether an installed app is offered an update. The `cloud-worker`
 * steering records a bug that already shipped from exactly here - a plain
 * string comparison made `beta.10 < beta.9`, so every install silently stopped
 * updating at the tenth beta. Reintroducing that bug passed the whole suite.
 *
 * Tested through the real route with a fake R2 bucket rather than by exporting
 * the comparator: the thing that matters is the 204-vs-200 the updater sees.
 *
 * Run: tsx test/releases.test.mjs
 */
import { handleReleaseRequest } from '../src/releases.ts';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

const CORS = {};

/** A minimal R2 stand-in serving one manifest under `stable/latest.json`. */
function releasesBucket(manifest) {
  return {
    async get(key) {
      if (key !== 'stable/latest.json') return null;
      return { async json() { return manifest; } };
    },
  };
}

function manifestFor(version) {
  return {
    version,
    pub_date: '2026-08-01T00:00:00Z',
    notes: 'notes',
    platforms: {
      'windows-x64': { url: `https://r2.test/${version}/app.msi.zip`, signature: 'sig-win' },
      'darwin-aarch64': {
        url: `https://r2.test/${version}/app.app.tar.gz`,
        signature: 'sig-mac',
        installerUrl: `https://r2.test/${version}/app.dmg`,
      },
      'linux-x64': { url: `https://r2.test/${version}/app.AppImage`, signature: 'sig-lin' },
      'linux-x64-deb': { url: `https://r2.test/${version}/app.deb`, signature: 'sig-deb' },
    },
  };
}

/** Asks the route what it would tell a client sitting on `current`. */
async function updateCheck(current, latest, target = 'windows', arch = 'x86_64') {
  const response = await handleReleaseRequest(
    new Request(`https://cloud.test/update/stable/${target}/${arch}/${current}`),
    { RELEASES: releasesBucket(manifestFor(latest)) },
    CORS,
  );
  if (!response) return { status: 0, body: null };
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// ── 1. Prerelease ordering: the bug that already shipped ────────────────────
console.log('\nreleases: prerelease ordering');
{
  // The regression: dot-segment identifiers compare NUMERICALLY, so beta.10 is
  // newer than beta.9. A plain string compare says '10' < '9' and answers 204.
  const tenth = await updateCheck('0.2.0-beta.9', '0.2.0-beta.10');
  check('beta.9 is offered beta.10', tenth.status === 200, `status ${tenth.status}`);
  check('the offer names the new version', tenth.body?.version === '0.2.0-beta.10');

  const backwards = await updateCheck('0.2.0-beta.10', '0.2.0-beta.9');
  check('beta.10 is NOT offered beta.9', backwards.status === 204, `status ${backwards.status}`);

  const across = await updateCheck('0.2.0-beta.9', '0.2.0-beta.100');
  check('beta.9 is offered beta.100', across.status === 200, `status ${across.status}`);

  const twoDigit = await updateCheck('0.2.0-beta.19', '0.2.0-beta.20');
  check('beta.19 is offered beta.20', twoDigit.status === 200, `status ${twoDigit.status}`);
}

// ── 2. Same version, and prerelease vs release ──────────────────────────────
console.log('\nreleases: version equality and prerelease vs release');
{
  const same = await updateCheck('0.2.0-beta.9', '0.2.0-beta.9');
  check('an identical version yields no update', same.status === 204, `status ${same.status}`);

  const toRelease = await updateCheck('0.2.0-beta.9', '0.2.0');
  check('a prerelease is offered the final release', toRelease.status === 200);

  const fromRelease = await updateCheck('0.2.0', '0.2.0-beta.9');
  check('a release is NOT offered a prerelease of itself', fromRelease.status === 204);

  const fewerIds = await updateCheck('0.2.0-beta', '0.2.0-beta.1');
  check('beta is offered beta.1 (fewer identifiers sort first)', fewerIds.status === 200);

  const ahead = await updateCheck('0.3.0', '0.2.0-beta.9');
  check('a client ahead on minor gets no update', ahead.status === 204);

  const behind = await updateCheck('0.1.9', '0.2.0');
  check('a client behind on minor gets the update', behind.status === 200);
}

// ── 3. Platform keys ────────────────────────────────────────────────────────
console.log('\nreleases: updater platform keys');
{
  const cases = [
    ['windows', 'x86_64', 'sig-win'],
    ['darwin', 'aarch64', 'sig-mac'],
    ['darwin', 'x86_64', null],
    ['linux', 'x86_64', 'sig-lin'],
  ];
  for (const [target, arch, expectedSig] of cases) {
    const result = await updateCheck('0.1.0', '0.2.0', target, arch);
    if (expectedSig === null) {
      // darwin-x64 is a declared key but this manifest has no entry for it, so
      // the route must 404 rather than hand the updater an unsigned payload.
      check(`${target}-${arch} without a manifest entry 404s`, result.status === 404, `status ${result.status}`);
    } else {
      check(`${target}-${arch} resolves to its own artifact`, result.body?.signature === expectedSig, JSON.stringify(result.body));
    }
  }

  const unknown = await updateCheck('0.1.0', '0.2.0', 'freebsd', 'x86_64');
  check('an unknown target 404s', unknown.status === 404, `status ${unknown.status}`);
  check('the 404 names the target', String(unknown.body?.error ?? '').includes('freebsd'));
}

// ── 4. The updater response shape Tauri requires ────────────────────────────
console.log('\nreleases: updater response shape');
{
  const offered = await updateCheck('0.1.0', '0.2.0');
  const body = offered.body ?? {};
  for (const key of ['version', 'pub_date', 'url', 'signature', 'notes']) {
    check(`carries ${key}`, Object.prototype.hasOwnProperty.call(body, key));
  }
  check('url points at the published artifact', body.url === 'https://r2.test/0.2.0/app.msi.zip', body.url);
  // A missing signature is worse than a missing update: Tauri would reject it
  // anyway, and a blank one hides the packaging failure that caused it.
  check('signature is non-empty', typeof body.signature === 'string' && body.signature.length > 0);
}

// ── 5. Download slugs ───────────────────────────────────────────────────────
console.log('\nreleases: download slugs');
{
  async function download(platform) {
    const response = await handleReleaseRequest(
      new Request(`https://cloud.test/download/stable/latest/${platform}`),
      { RELEASES: releasesBucket(manifestFor('0.2.0')) },
      CORS,
    );
    return response;
  }

  const mac = await download('macos-arm64');
  check('macos-arm64 redirects', mac.status === 302, `status ${mac.status}`);
  // The human download must be the installer, not the updater archive.
  check(
    'macos-arm64 prefers the .dmg over the update archive',
    mac.headers.get('location') === 'https://r2.test/0.2.0/app.dmg',
    mac.headers.get('location'),
  );

  const deb = await download('linux-deb');
  check(
    'linux-deb and linux-appimage resolve to different artifacts',
    deb.headers.get('location') === 'https://r2.test/0.2.0/app.deb',
    deb.headers.get('location'),
  );

  const bogus = await download('haiku');
  check('an unknown slug 404s', bogus.status === 404, `status ${bogus.status}`);
}

// ── 6. Missing configuration and missing manifest ───────────────────────────
console.log('\nreleases: degraded states');
{
  const unconfigured = await handleReleaseRequest(
    new Request('https://cloud.test/update/stable/windows/x86_64/0.1.0'),
    {},
    CORS,
  );
  check('no bucket bound yields 503, not a crash', unconfigured?.status === 503, `status ${unconfigured?.status}`);

  const emptyBucket = await handleReleaseRequest(
    new Request('https://cloud.test/update/stable/windows/x86_64/0.1.0'),
    { RELEASES: { async get() { return null; } } },
    CORS,
  );
  check('no published manifest yields 204', emptyBucket?.status === 204, `status ${emptyBucket?.status}`);

  const badJson = await handleReleaseRequest(
    new Request('https://cloud.test/update/stable/windows/x86_64/0.1.0'),
    { RELEASES: { async get() { return { async json() { throw new Error('bad'); } }; } } },
    CORS,
  );
  check('an unparseable manifest yields 500', badJson?.status === 500, `status ${badJson?.status}`);

  // A non-release path must fall through so agent routing still gets a chance.
  const unrelated = await handleReleaseRequest(
    new Request('https://cloud.test/api/whatever'),
    { RELEASES: releasesBucket(manifestFor('0.2.0')) },
    CORS,
  );
  check('a non-release path returns null to fall through', unrelated === null);

  const posted = await handleReleaseRequest(
    new Request('https://cloud.test/update/stable/windows/x86_64/0.1.0', { method: 'POST' }),
    { RELEASES: releasesBucket(manifestFor('0.2.0')) },
    CORS,
  );
  check('a POST to a release route falls through', posted === null);
}

console.log(
  failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
