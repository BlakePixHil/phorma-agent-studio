import type { DateRange } from '../core/models';

/**
 * Display formatting shared by the views. Every day is a UTC Metric_Day, so every
 * date formatter here pins `timeZone: 'UTC'` - a local-time format would shift a
 * day across midnight for anyone west of Greenwich.
 */

const SHORT_DAY = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const LONG_DAY = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const WHOLE = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

function utc(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** `Sep 3`. */
export function shortDay(day: string): string {
  const date = utc(day);
  return Number.isNaN(date.getTime()) ? day : SHORT_DAY.format(date);
}

/** `Wed, Sep 3, 2026`. */
export function longDay(day: string): string {
  const date = utc(day);
  return Number.isNaN(date.getTime()) ? day : LONG_DAY.format(date);
}

/** `Aug 26 - Sep 24`, with the year only when the two ends straddle one. */
export function formatRange(range: DateRange): string {
  const fromYear = range.from.slice(0, 4);
  const toYear = range.to.slice(0, 4);
  if (fromYear !== toYear) return `${longDayNoWeekday(range.from)} - ${longDayNoWeekday(range.to)}`;
  return `${shortDay(range.from)} - ${shortDay(range.to)}`;
}

function longDayNoWeekday(day: string): string {
  return `${shortDay(day)}, ${day.slice(0, 4)}`;
}

/** `1.2K`, `34`, `5.6M`. */
export function compact(value: number): string {
  return Number.isFinite(value) ? COMPACT.format(value) : '-';
}

/** `1,234`. */
export function whole(value: number): string {
  return Number.isFinite(value) ? WHOLE.format(value) : '-';
}

/** A percentage with one decimal under 10 and none above, or a dash. */
export function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-';
  const digits = Math.abs(value) < 10 && value !== 0 ? 1 : 0;
  return `${value.toFixed(digits)}%`;
}

/** A ratio such as sessions per install, to one decimal. */
export function ratio(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return '-';
  return (numerator / denominator).toFixed(1);
}

/** Display name and Tabler brand icon for a platform string. */
export function platformDisplay(label: string): { name: string; icon: string } {
  const key = label.toLowerCase();
  if (/^win|windows/.test(key)) return { name: 'Windows', icon: 'ti-brand-windows' };
  if (/mac|darwin|os x/.test(key)) return { name: 'macOS', icon: 'ti-brand-apple' };
  if (/linux|ubuntu|debian|fedora/.test(key)) return { name: 'Linux', icon: 'ti-brand-ubuntu' };
  if (/android/.test(key)) return { name: 'Android', icon: 'ti-brand-android' };
  if (/ios|iphone|ipad/.test(key)) return { name: 'iOS', icon: 'ti-brand-apple' };
  if (key === '' || key === 'unknown') return { name: 'Unknown', icon: 'ti-help-circle' };
  return { name: label, icon: 'ti-device-desktop' };
}

/** Title for a runtime mode. */
export function runtimeDisplay(label: string): { name: string; icon: string } {
  if (label === 'desktop') return { name: 'Desktop app', icon: 'ti-device-desktop' };
  if (label === 'browser') return { name: 'Browser', icon: 'ti-world-www' };
  return { name: label, icon: 'ti-app-window' };
}

let languageNames: Intl.DisplayNames | null | undefined;

/** `en-US` -> `English (United States)`, falling back to the tag itself. */
export function localeDisplay(tag: string): string {
  if (tag === '') return 'Unknown';
  if (languageNames === undefined) {
    try {
      languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      languageNames = null;
    }
  }
  try {
    return languageNames?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const CONTINENTS: Readonly<Record<string, string>> = {
  africa: 'Africa',
  antarctica: 'Antarctica',
  asia: 'Asia',
  europe: 'Europe',
  'north-america': 'North America',
  oceania: 'Oceania',
  'south-america': 'South America',
  unknown: 'Unknown',
};

export function continentName(region: string): string {
  return CONTINENTS[region] ?? region;
}

const ACRONYMS = new Set(['http', 'mcp', 'sql', 'aws', 'api', 'ai', 'url', 'id']);

/** `http-tool` -> `HTTP tool`; `session.started` -> `Session started`. */
export function humanize(token: string): string {
  const words = token.replace(/[._:-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return token;
  return words
    .map((word, index) => {
      if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(' ');
}

/** A completion rate as a percentage. Completions can include runs started before the range, so it is capped. */
export function completionRate(completed: number, started: number): number | null {
  return started > 0 ? Math.min(100, (completed / started) * 100) : null;
}

/**
 * Semver-ish comparison, newest first when used as a sort. Pre-release tags sort
 * below their release, and numeric pre-release parts compare numerically so
 * `beta.10` is newer than `beta.9`.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core, pre] = value.replace(/^v/, '').split('-', 2);
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre: pre ?? null };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i += 1) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  const lp = left.pre.split('.');
  const rp = right.pre.split('.');
  for (let i = 0; i < Math.max(lp.length, rp.length); i += 1) {
    const l = lp[i];
    const r = rp[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = Number(l);
    const rn = Number(r);
    const diff = Number.isFinite(ln) && Number.isFinite(rn) ? ln - rn : l.localeCompare(r);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True for a label that parses as a version, so `other` and blanks are not ranked. */
export function isVersion(label: string): boolean {
  return /^v?\d+(\.\d+)*(-[\w.]+)?$/.test(label);
}
