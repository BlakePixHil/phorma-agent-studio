/**
 * Public release/download routes served by the same Worker that hosts the
 * workflow runtime. These routes are unauthenticated (they serve installers
 * and update manifests) and backed by the `phorma-releases` R2 bucket.
 *
 *   GET /update/stable/{target}/{arch}/{current_version}
 *       → 204 (no update) or the Tauri updater JSON for the latest version.
 *   GET /download/stable/latest/{platform}
 *       → 302 redirect to the newest installer for that platform.
 *   GET /download/stable/{version}/{filename}
 *       → streams the installer from R2 (used by the 302 redirect target).
 *   GET /releases.json
 *       → version list + notes for the download website changelog.
 *
 * The bucket layout (written by scripts/publish-r2.mjs in CI):
 *   stable/{version}/{filename}   — installers + .sig files
 *   stable/latest.json            — merged Tauri updater manifest
 *   stable/releases.json          — version history for the website
 *
 * CORS is open (`*`) for these routes since they serve public artifacts.
 */

export interface ReleaseEnv {
  /** R2 bucket holding installer artifacts and update manifests. */
  RELEASES?: R2Bucket;
}

const PUBLIC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Maps Tauri updater target+arch to the platform key in latest.json. */
function updaterPlatformKey(target: string, arch: string): string | null {
  // Tauri target strings: e.g. "windows", "darwin", "linux".
  // Arch: "x86_64", "aarch64", etc.
  const map: Record<string, string> = {
    'windows-x86_64': 'windows-x64',
    'darwin-aarch64': 'darwin-aarch64',
    'darwin-x86_64': 'darwin-x64',
    'linux-x86_64': 'linux-x64',
  };
  return map[`${target}-${arch}`] ?? null;
}

/** Maps a friendly platform slug (used by the website) to the latest.json key. */
const DOWNLOAD_PLATFORM_MAP: Record<string, string> = {
  'windows-x64': 'windows-x64',
  'macos-arm64': 'darwin-aarch64',
  'macos-intel': 'darwin-x64',
  'linux-appimage': 'linux-x64',
  'linux-deb': 'linux-x64-deb',
};

/**
 * Handles release/download routes. Returns null when the path is not a
 * release route, so the caller can fall through to agent routing.
 */
export async function handleReleaseRequest(
  request: Request,
  env: ReleaseEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Only GET / OPTIONS on release routes.
  if (request.method === 'OPTIONS') {
    if (path.startsWith('/update/') || path.startsWith('/download/') || path === '/releases.json') {
      return new Response(null, { headers: PUBLIC_CORS });
    }
    return null;
  }
  if (request.method !== 'GET') return null;

  // ── GET /releases.json ──────────────────────────────────────────────────
  if (path === '/releases.json') {
    return await serveR2Json(env, 'stable/releases.json', PUBLIC_CORS);
  }

  // ── GET /update/stable/{target}/{arch}/{current_version} ────────────────
  const updateMatch = path.match(/^\/update\/stable\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (updateMatch) {
    const [, target, arch, currentVersion] = updateMatch;
    return await handleUpdateCheck(env, target, arch, currentVersion);
  }

  // ── GET /download/stable/latest/{platform} ─────────────────────────────
  const latestMatch = path.match(/^\/download\/stable\/latest\/([^/]+)$/);
  if (latestMatch) {
    const [, platform] = latestMatch;
    return await handleDownloadLatest(env, platform);
  }

  // ── GET /download/stable/{version}/{filename} ───────────────────────────
  const fileMatch = path.match(/^\/download\/stable\/([^/]+)\/(.+)$/);
  if (fileMatch) {
    const [, version, filename] = fileMatch;
    return await serveR2Object(env, `stable/${version}/${filename}`, PUBLIC_CORS);
  }

  return null;
}

/** Compares the client version against the latest published version. */
async function handleUpdateCheck(
  env: ReleaseEnv,
  target: string,
  arch: string,
  currentVersion: string,
): Promise<Response> {
  if (!env.RELEASES) {
    return json({ error: 'Releases not configured.' }, 503, PUBLIC_CORS);
  }

  const manifestRaw = await env.RELEASES.get('stable/latest.json');
  if (!manifestRaw) {
    return new Response(null, { status: 204, headers: PUBLIC_CORS });
  }

  let manifest: any;
  try {
    manifest = await manifestRaw.json();
  } catch {
    return json({ error: 'Invalid manifest.' }, 500, PUBLIC_CORS);
  }

  // No update if the client is already at or above the latest version.
  if (compareVersions(currentVersion, manifest.version) >= 0) {
    return new Response(null, { status: 204, headers: PUBLIC_CORS });
  }

  const platformKey = updaterPlatformKey(target, arch);
  if (!platformKey) {
    return json({ error: `Unsupported target: ${target}-${arch}` }, 404, PUBLIC_CORS);
  }

  const entry = manifest.platforms?.[platformKey];
  if (!entry?.url || !entry.signature) {
    return json({ error: `No update available for ${platformKey}.` }, 404, PUBLIC_CORS);
  }

  // Tauri updater expects this exact shape.
  return json(
    {
      version: manifest.version,
      pub_date: manifest.pub_date,
      url: entry.url,
      signature: entry.signature,
      notes: manifest.notes ?? '',
    },
    200,
    { ...PUBLIC_CORS, 'Cache-Control': 'public, max-age=60' },
  );
}

/** 302-redirects to the newest installer for the given platform slug. */
async function handleDownloadLatest(env: ReleaseEnv, platform: string): Promise<Response> {
  if (!env.RELEASES) {
    return json({ error: 'Releases not configured.' }, 503, PUBLIC_CORS);
  }

  const manifestRaw = await env.RELEASES.get('stable/latest.json');
  if (!manifestRaw) {
    return json({ error: 'No releases published.' }, 404, PUBLIC_CORS);
  }

  let manifest: any;
  try {
    manifest = await manifestRaw.json();
  } catch {
    return json({ error: 'Invalid manifest.' }, 500, PUBLIC_CORS);
  }

  const platformKey = DOWNLOAD_PLATFORM_MAP[platform];
  if (!platformKey) {
    return json({ error: `Unknown platform: ${platform}` }, 404, PUBLIC_CORS);
  }

  const entry = manifest.platforms?.[platformKey];
  if (!entry?.url) {
    return json({ error: `No installer for ${platform}.` }, 404, PUBLIC_CORS);
  }

  return Response.redirect(entry.url, 302);
}

/** Streams a JSON object from R2, or 404. */
async function serveR2Json(
  env: ReleaseEnv,
  key: string,
  cors: Record<string, string>,
): Promise<Response> {
  if (!env.RELEASES) {
    return json({ error: 'Releases not configured.' }, 503, cors);
  }
  const obj = await env.RELEASES.get(key);
  if (!obj) return json({ error: 'Not found.' }, 404, cors);
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      ...cors,
    },
  });
}

/** Streams a binary object from R2, or 404. */
async function serveR2Object(
  env: ReleaseEnv,
  key: string,
  cors: Record<string, string>,
): Promise<Response> {
  if (!env.RELEASES) {
    return json({ error: 'Releases not configured.' }, 503, cors);
  }
  const obj = await env.RELEASES.get(key);
  if (!obj) return json({ error: 'Not found.' }, 404, cors);
  const headers: Record<string, string> = {
    'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600',
    ...cors,
  };
  if (obj.size) headers['Content-Length'] = String(obj.size);
  return new Response(obj.body, { headers });
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

/**
 * Semantic version comparison. Returns negative, zero, or positive.
 * Handles pre-release suffixes loosely (pre-release < release).
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('-', 2);
    const parts = core.split('.').map(n => parseInt(n, 10) || 0);
    return { parts, pre: pre ?? '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A pre-release version is less than the same core without pre-release.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}
