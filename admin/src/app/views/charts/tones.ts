/**
 * The chart palette. Each tone is an `--admin-tone-*` custom property holding a
 * space-separated RGB triple, so markup writes `rgb(var(--tone) / <alpha>)` and
 * the SVG stays theme-driven with no hex in TypeScript.
 */
export type Tone =
  | 'iris'
  | 'azure'
  | 'teal'
  | 'amber'
  | 'rose'
  | 'violet'
  | 'emerald'
  | 'lime'
  | 'muted'
  | 'good'
  | 'warn'
  | 'bad';

/** Categorical order for series and slices: adjacent entries never share a hue family. */
export const CATEGORICAL: readonly Tone[] = [
  'iris',
  'azure',
  'amber',
  'emerald',
  'rose',
  'violet',
  'teal',
  'lime',
];

export function toneVar(tone: Tone): string {
  return `var(--admin-tone-${tone})`;
}

export function categorical(index: number): Tone {
  return CATEGORICAL[((index % CATEGORICAL.length) + CATEGORICAL.length) % CATEGORICAL.length];
}

/** A stable tone for an arbitrary token, so a new tier gets a colour with no code change. */
export function hashTone(token: string): Tone {
  let hash = 0;
  for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return categorical(Math.abs(hash));
}

let nextChartId = 0;

/** A document-unique id for SVG defs (gradients) owned by one chart instance. */
export function chartId(prefix: string): string {
  nextChartId += 1;
  return `admin-${prefix}-${nextChartId}`;
}
