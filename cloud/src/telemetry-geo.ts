/**
 * Coarse geography for anonymous usage telemetry.
 *
 * The ONLY request metadata this feature is allowed to derive: a two letter
 * country code and a continent-level region. Nothing here reads `cf.city`,
 * `cf.postalCode`, `cf.latitude`, `cf.longitude`, `cf.asn`, `CF-Connecting-IP`
 * or `X-Forwarded-For`, and the Telemetry_Store has no column for any of them
 * (7.4, 7.5).
 *
 * This module is a LEAF: no bindings, no storage, no imports. `COUNTRY_REGION`
 * is a module constant rather than a runtime lookup, so `resolveCoarseGeo` is
 * total, synchronous, allocation-light and testable without a real request.
 */

/**
 * Continent-level grouping. `unknown` covers an absent country code, a
 * Cloudflare pseudo-country, and any code the map does not carry yet.
 */
export type TelemetryRegion =
  | 'africa'
  | 'antarctica'
  | 'asia'
  | 'europe'
  | 'north-america'
  | 'oceania'
  | 'south-america'
  | 'unknown';

/** Every region value, in a stable order for admin grouping and tests. */
export const TELEMETRY_REGIONS: readonly TelemetryRegion[] = [
  'africa',
  'antarctica',
  'asia',
  'europe',
  'north-america',
  'oceania',
  'south-america',
  'unknown',
];

/** The pair stored per rollup row. */
export interface CoarseGeo {
  countryCode: string;
  region: TelemetryRegion;
}

/** The country code stored when no usable country is available. */
export const UNKNOWN_COUNTRY_CODE = 'XX';

/**
 * Hand-written map over the ISO 3166-1 alpha-2 officially assigned set (249
 * codes), exactly one region per code, plus the user-assigned `XK` that
 * Cloudflare emits for Kosovo.
 *
 * Where a dependency is geographically remote from its administering state the
 * grouping follows the territory, not the flag (for example `GF` is
 * south-america, `RE` is africa, `GL` is north-america). Sub-antarctic
 * territories with no permanent civilian population are grouped as antarctica.
 * Cyprus follows the UN M49 placement in asia.
 */
export const COUNTRY_REGION: Readonly<Record<string, TelemetryRegion>> = {
  AD: 'europe',
  AE: 'asia',
  AF: 'asia',
  AG: 'north-america',
  AI: 'north-america',
  AL: 'europe',
  AM: 'asia',
  AO: 'africa',
  AQ: 'antarctica',
  AR: 'south-america',
  AS: 'oceania',
  AT: 'europe',
  AU: 'oceania',
  AW: 'north-america',
  AX: 'europe',
  AZ: 'asia',
  BA: 'europe',
  BB: 'north-america',
  BD: 'asia',
  BE: 'europe',
  BF: 'africa',
  BG: 'europe',
  BH: 'asia',
  BI: 'africa',
  BJ: 'africa',
  BL: 'north-america',
  BM: 'north-america',
  BN: 'asia',
  BO: 'south-america',
  BQ: 'north-america',
  BR: 'south-america',
  BS: 'north-america',
  BT: 'asia',
  BV: 'antarctica',
  BW: 'africa',
  BY: 'europe',
  BZ: 'north-america',
  CA: 'north-america',
  CC: 'oceania',
  CD: 'africa',
  CF: 'africa',
  CG: 'africa',
  CH: 'europe',
  CI: 'africa',
  CK: 'oceania',
  CL: 'south-america',
  CM: 'africa',
  CN: 'asia',
  CO: 'south-america',
  CR: 'north-america',
  CU: 'north-america',
  CV: 'africa',
  CW: 'north-america',
  CX: 'oceania',
  CY: 'asia',
  CZ: 'europe',
  DE: 'europe',
  DJ: 'africa',
  DK: 'europe',
  DM: 'north-america',
  DO: 'north-america',
  DZ: 'africa',
  EC: 'south-america',
  EE: 'europe',
  EG: 'africa',
  EH: 'africa',
  ER: 'africa',
  ES: 'europe',
  ET: 'africa',
  FI: 'europe',
  FJ: 'oceania',
  FK: 'south-america',
  FM: 'oceania',
  FO: 'europe',
  FR: 'europe',
  GA: 'africa',
  GB: 'europe',
  GD: 'north-america',
  GE: 'asia',
  GF: 'south-america',
  GG: 'europe',
  GH: 'africa',
  GI: 'europe',
  GL: 'north-america',
  GM: 'africa',
  GN: 'africa',
  GP: 'north-america',
  GQ: 'africa',
  GR: 'europe',
  GS: 'antarctica',
  GT: 'north-america',
  GU: 'oceania',
  GW: 'africa',
  GY: 'south-america',
  HK: 'asia',
  HM: 'antarctica',
  HN: 'north-america',
  HR: 'europe',
  HT: 'north-america',
  HU: 'europe',
  ID: 'asia',
  IE: 'europe',
  IL: 'asia',
  IM: 'europe',
  IN: 'asia',
  IO: 'asia',
  IQ: 'asia',
  IR: 'asia',
  IS: 'europe',
  IT: 'europe',
  JE: 'europe',
  JM: 'north-america',
  JO: 'asia',
  JP: 'asia',
  KE: 'africa',
  KG: 'asia',
  KH: 'asia',
  KI: 'oceania',
  KM: 'africa',
  KN: 'north-america',
  KP: 'asia',
  KR: 'asia',
  KW: 'asia',
  KY: 'north-america',
  KZ: 'asia',
  LA: 'asia',
  LB: 'asia',
  LC: 'north-america',
  LI: 'europe',
  LK: 'asia',
  LR: 'africa',
  LS: 'africa',
  LT: 'europe',
  LU: 'europe',
  LV: 'europe',
  LY: 'africa',
  MA: 'africa',
  MC: 'europe',
  MD: 'europe',
  ME: 'europe',
  MF: 'north-america',
  MG: 'africa',
  MH: 'oceania',
  MK: 'europe',
  ML: 'africa',
  MM: 'asia',
  MN: 'asia',
  MO: 'asia',
  MP: 'oceania',
  MQ: 'north-america',
  MR: 'africa',
  MS: 'north-america',
  MT: 'europe',
  MU: 'africa',
  MV: 'asia',
  MW: 'africa',
  MX: 'north-america',
  MY: 'asia',
  MZ: 'africa',
  NA: 'africa',
  NC: 'oceania',
  NE: 'africa',
  NF: 'oceania',
  NG: 'africa',
  NI: 'north-america',
  NL: 'europe',
  NO: 'europe',
  NP: 'asia',
  NR: 'oceania',
  NU: 'oceania',
  NZ: 'oceania',
  OM: 'asia',
  PA: 'north-america',
  PE: 'south-america',
  PF: 'oceania',
  PG: 'oceania',
  PH: 'asia',
  PK: 'asia',
  PL: 'europe',
  PM: 'north-america',
  PN: 'oceania',
  PR: 'north-america',
  PS: 'asia',
  PT: 'europe',
  PW: 'oceania',
  PY: 'south-america',
  QA: 'asia',
  RE: 'africa',
  RO: 'europe',
  RS: 'europe',
  RU: 'europe',
  RW: 'africa',
  SA: 'asia',
  SB: 'oceania',
  SC: 'africa',
  SD: 'africa',
  SE: 'europe',
  SG: 'asia',
  SH: 'africa',
  SI: 'europe',
  SJ: 'europe',
  SK: 'europe',
  SL: 'africa',
  SM: 'europe',
  SN: 'africa',
  SO: 'africa',
  SR: 'south-america',
  SS: 'africa',
  ST: 'africa',
  SV: 'north-america',
  SX: 'north-america',
  SY: 'asia',
  SZ: 'africa',
  TC: 'north-america',
  TD: 'africa',
  TF: 'antarctica',
  TG: 'africa',
  TH: 'asia',
  TJ: 'asia',
  TK: 'oceania',
  TL: 'asia',
  TM: 'asia',
  TN: 'africa',
  TO: 'oceania',
  TR: 'asia',
  TT: 'north-america',
  TV: 'oceania',
  TW: 'asia',
  TZ: 'africa',
  UA: 'europe',
  UG: 'africa',
  UM: 'oceania',
  US: 'north-america',
  UY: 'south-america',
  UZ: 'asia',
  VA: 'europe',
  VC: 'north-america',
  VE: 'south-america',
  VG: 'north-america',
  VI: 'north-america',
  VN: 'asia',
  VU: 'oceania',
  WF: 'oceania',
  WS: 'oceania',
  // User-assigned, not part of the ISO official set. Cloudflare reports it for
  // Kosovo, so mapping it here keeps those requests out of `unknown`.
  XK: 'europe',
  YE: 'asia',
  YT: 'africa',
  ZA: 'africa',
  ZM: 'africa',
  ZW: 'africa',
};

/**
 * Derive Coarse_Geo from the Cloudflare request properties (7.1).
 *
 * Reads `cf.country` and nothing else. An absent, non-string, malformed, `XX`
 * or `T1` country yields `{ XX, unknown }` (7.2) - `T1` is Cloudflare's Tor
 * pseudo-country and is treated as unknown rather than invented into a region.
 * A well-formed code that the map does not carry keeps its country and degrades
 * to `region: 'unknown'`, so a new ISO assignment loses the region grouping and
 * nothing else (7.3).
 */
export function resolveCoarseGeo(request: Request): CoarseGeo {
  const raw = (request as { cf?: { country?: unknown } }).cf?.country;
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') {
    return { countryCode: UNKNOWN_COUNTRY_CODE, region: 'unknown' };
  }
  return { countryCode: code, region: COUNTRY_REGION[code] ?? 'unknown' };
}
