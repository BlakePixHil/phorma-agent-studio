/**
 * Desktop sign-in credentials - the token the studio carries instead of a Clerk
 * session, and the hashing for the one-time device code that mints it.
 *
 * ## Why this exists at all
 *
 * A Clerk PRODUCTION instance cannot authenticate the studio's webview. It
 * identifies a browser client with `__client`, a `SameSite=Lax` cookie scoped to
 * `clerk.phorma-labs.com`, and the webview origin (`http://tauri.localhost` on
 * Windows, `tauri://localhost` on macOS and Linux) is a different registrable
 * domain - so Chromium refuses both to store that cookie and to send it. clerk-js
 * gets a fresh anonymous client on every call and sign-in can never complete.
 * Full measurements and the two non-fixes are in
 * `.kiro/specs/desktop-signin-handoff/requirements.md`.
 *
 * So Clerk stays the only thing that ever authenticates a human, and it does that
 * in the user's real browser where cookies work. This module issues the credential
 * the desktop app holds afterwards.
 *
 * ## Shape, and the deliberate lean-v1 tradeoffs
 *
 * One long-lived token, HMAC-SHA256 signed, carrying the Clerk `sub`. Signed
 * rather than opaque because `verifyBearer` sits on the hot path for `/api/infer`
 * AND for every Durable Object request - a storage read there is exactly what
 * `CLERK_JWT_KEY` exists to avoid on a DO cold start. Verification is therefore
 * pure crypto with no I/O.
 *
 * The cost, stated plainly rather than buried: **a minted token cannot be revoked
 * before it expires.** There is no server-side record of it. Sign-out deletes the
 * copy in the OS keychain, which stops that machine, but a copy exfiltrated from a
 * compromised machine keeps working until `DEVICE_TOKEN_TTL_SECONDS` elapses.
 * Rotating `PHORMA_AUTH_SECRET` is the only global kill switch, and it signs every
 * install out at once. That trade was accepted knowingly to ship working sign-in;
 * the revocable design (short access token + opaque refresh token in D1) is task 1
 * of the full spec and is the upgrade path.
 *
 * Everything here is pure and takes its clock as an argument, so the expiry and
 * tamper properties are testable without a worker.
 */

/**
 * Marks a Phorma device token, and is checked BEFORE any crypto.
 *
 * The prefix is not decoration: `verifyBearer` tries Clerk first and this second,
 * against the same `Authorization` header. Without an unambiguous marker a
 * malformed Clerk JWT and a device token are both "three base64url-ish segments"
 * and each verifier would be handed the other's input. `phd` = PHorma Device.
 */
export const DEVICE_TOKEN_PREFIX = 'phd_';

/** Token lifetime. Long, because lean v1 has no refresh round trip. */
export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** How long an unclaimed device code stays redeemable. */
export const DEVICE_CODE_TTL_SECONDS = 600;

/**
 * Minimum device-code length this module will hash or accept.
 *
 * The studio mints 32 CSPRNG bytes, which is 43 base64url characters. The floor
 * is what stops a caller "starting" a handoff against a guessable code: the code
 * is the ONLY thing `/auth/device/redeem` requires, so its entropy is the entire
 * security of the exchange.
 */
export const DEVICE_CODE_MIN_CHARS = 32;

/** Payload wire format. Single letters because this rides in a header. */
interface DeviceTokenPayload {
  /** Clerk user id (the JWT `sub`), which is also `tenants.id`. */
  s: string;
  /** Issued-at, epoch seconds. */
  i: number;
  /** Expiry, epoch seconds. */
  e: number;
  /** Format version, so a future change can be told apart rather than guessed. */
  v: 1;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  // Reject anything outside the alphabet rather than let `atob` coerce it: a
  // token is attacker-supplied and "mostly base64" must not verify.
  if (!/^[A-Za-z0-9\-_]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();

// `KeyUsage` is a DOM lib type the workers types do not re-export, so the usages
// are spelled out rather than pulled from a global that is not there.
type HmacUsage = 'sign' | 'verify';

async function hmacKey(secret: string, usages: HmacUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

/** True for anything shaped like one of our tokens. Cheap, and no crypto. */
export function isDeviceToken(token: string): boolean {
  return token.startsWith(DEVICE_TOKEN_PREFIX);
}

/**
 * Mints a token for `sub`. `nowSeconds` is injected so expiry is testable.
 *
 * The signature covers the ENCODED payload string, not the decoded object, so
 * verification never has to re-serialize and cannot disagree with signing about
 * key order or whitespace.
 */
export async function mintDeviceToken(
  secret: string,
  sub: string,
  nowSeconds: number,
  ttlSeconds: number = DEVICE_TOKEN_TTL_SECONDS,
): Promise<string> {
  const payload: DeviceTokenPayload = {
    s: sub,
    i: Math.floor(nowSeconds),
    e: Math.floor(nowSeconds) + ttlSeconds,
    v: 1,
  };
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret, ['sign']),
    encoder.encode(encoded),
  );
  return `${DEVICE_TOKEN_PREFIX}${encoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verifies a token and returns the Clerk `sub`, or null for anything that is not
 * a currently-valid token of ours.
 *
 * Null covers every failure on purpose - wrong prefix, malformed, bad signature,
 * expired, unknown version. A caller that could tell those apart would leak which
 * half of a forgery attempt was correct, and no caller has a use for the
 * distinction: all of them answer 401.
 *
 * `crypto.subtle.verify` does the comparison, so it is constant-time by
 * implementation rather than by a hand-rolled loop.
 *
 * `secrets` accepts more than one so a `PHORMA_AUTH_SECRET` rotation can overlap
 * instead of signing every install out at once. Order is irrelevant; any match
 * wins.
 */
export async function verifyDeviceToken(
  secrets: readonly (string | undefined)[],
  token: string,
  nowSeconds: number,
): Promise<{ sub: string } | null> {
  if (!isDeviceToken(token)) return null;

  const body = token.slice(DEVICE_TOKEN_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) return null;
  const encoded = body.slice(0, dot);
  const signatureRaw = body.slice(dot + 1);

  const signature = base64UrlDecode(signatureRaw);
  if (!signature || signature.length !== 32) return null; // SHA-256 is 32 bytes.

  let verified = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, ['verify']),
      signature as unknown as ArrayBuffer,
      encoder.encode(encoded),
    );
    if (ok) {
      verified = true;
      break;
    }
  }
  if (!verified) return null;

  // Only decoded AFTER the signature holds, so malformed-payload handling is
  // never reachable with attacker-controlled bytes.
  const payloadBytes = base64UrlDecode(encoded);
  if (!payloadBytes) return null;
  let payload: DeviceTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as DeviceTokenPayload;
  } catch {
    return null;
  }
  if (payload?.v !== 1) return null;
  if (typeof payload.s !== 'string' || payload.s.length === 0) return null;
  if (typeof payload.e !== 'number' || !Number.isFinite(payload.e)) return null;
  if (nowSeconds >= payload.e) return null;

  return { sub: payload.s };
}

/**
 * SHA-256 of a device code, lowercase hex.
 *
 * `/auth/device/start` registers only this, never the code, so a dump of KV
 * yields nothing redeemable - the code itself lives only in the studio's memory
 * and in the URL it hands to the browser.
 */
export async function hashDeviceCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(code));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** True for a code with enough entropy to be worth registering. */
export function isPlausibleDeviceCode(code: unknown): code is string {
  return (
    typeof code === 'string' &&
    code.length >= DEVICE_CODE_MIN_CHARS &&
    code.length <= 256 &&
    /^[A-Za-z0-9\-_]+$/.test(code)
  );
}

/** KV key for a pending handoff. Namespaced so it cannot collide with a tenant. */
export function deviceCodeKey(codeHash: string): string {
  return `authdev:${codeHash}`;
}

/** What `/auth/device/start` writes and `/auth/device/claim` completes. */
export interface PendingHandoff {
  /** Clerk `sub`, present once a browser has claimed it. */
  sub?: string;
  /**
   * The signed-in user's email address, for DISPLAY ONLY.
   *
   * Supplied by the sign-in page from its own Clerk user object rather than read
   * back from Clerk's Backend API, because the alternative is a vendor call on
   * every `/api/me` (a tenant row only exists once someone has subscribed, so D1
   * cannot supply it for a new account). It is never used for identity, lookup or
   * authorization - the token is bound to the VERIFIED `sub` and nothing else - so
   * the worst a caller can do by lying here is mislabel their own account card.
   * Do not start trusting it for anything else.
   */
  email?: string;
  /**
   * The signed-in user's avatar URL, for DISPLAY ONLY.
   *
   * Travels the same way as {@link email} and for the same reason - see that
   * comment - and is subject to the extra restriction in
   * {@link sanitizeClaimedImageUrl}: a URL the studio will put in an `<img src>`
   * is an outbound request from the webview, so unlike the email it cannot be
   * merely size-checked.
   */
  imageUrl?: string;
  /** Epoch ms the handoff was registered, for debugging only. */
  at: number;
}

/**
 * Trims a claimed email down to something safe to store and render, or undefined.
 *
 * Deliberately permissive about what an address looks like (Clerk already
 * validated it) and strict about SIZE and control characters, which are the only
 * properties that matter for a value being put in KV and later into a DOM text
 * node.
 */
export function sanitizeClaimedEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return undefined;
  if (!trimmed.includes('@')) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Hosts a claimed avatar URL may point at. Clerk serves every `user.imageUrl`
 * from its own image CDN regardless of which provider the photo came from (a
 * Google avatar included), so this is one host and not a provider list.
 */
const AVATAR_HOST_SUFFIX = '.clerk.com';

/**
 * Trims a claimed avatar URL down to something safe to render, or undefined.
 *
 * STRICTER than {@link sanitizeClaimedEmail}, and the difference is the point.
 * An email is text; this value ends up in an `<img src>` inside the studio's
 * webview, so an unconstrained string would let anything that can reach
 * `/claim` - the value is client-supplied and unverified - aim a request out of
 * the desktop app at a host of its choosing, complete with the IP and
 * User-Agent that request carries. So: `https:` only, no credentials, no port,
 * and the host must be Clerk's image CDN.
 *
 * A URL that fails any of these is DROPPED, not repaired. The avatar then falls
 * back to the account initial, which is the pre-existing behaviour and reads as
 * normal rather than as a failure.
 */
export function sanitizeClaimedImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.username.length > 0 || url.password.length > 0) return undefined;
  if (url.port.length > 0) return undefined;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(AVATAR_HOST_SUFFIX)) return undefined;
  return url.toString();
}
