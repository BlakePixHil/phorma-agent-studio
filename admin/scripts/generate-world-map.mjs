#!/usr/bin/env node
// Regenerates admin/src/app/views/geography/world-map.data.ts from Natural
// Earth's public-domain 110m country geometry (shipped by `world-atlas`).
//
// Run from `admin/`: `npm run generate:world-map`. Deterministic - re-running
// against the same package versions produces byte-identical output.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { geoNaturalEarth1, geoPath } from 'd3-geo';
import iso from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const outFile = join(scriptDir, '../src/app/views/geography/world-map.data.ts');

/** Fixed drawing surface for the generated paths; the component sets this as the SVG viewBox. */
const WIDTH = 960;
const HEIGHT = 500;

/** Not paintable: no per-install telemetry is meaningfully "in" Antarctica. */
const EXCLUDED_CODES = new Set(['AQ']);

iso.registerLocale(en);

const topology = JSON.parse(
  readFileSync(require.resolve('world-atlas/countries-110m.json'), 'utf8'),
);
const collection = feature(topology, topology.objects.countries);

const projection = geoNaturalEarth1();
projection.fitSize([WIDTH, HEIGHT], collection);
const path = geoPath(projection).digits(1);

const shapes = [];
const dropped = [];
for (const geometry of collection.features) {
  const code = iso.numericToAlpha2(geometry.id);
  if (!code || EXCLUDED_CODES.has(code)) {
    dropped.push(geometry.properties?.name ?? geometry.id);
    continue;
  }
  const d = path(geometry);
  if (!d) continue;
  shapes.push({ code, name: iso.getName(code, 'en') ?? geometry.properties?.name ?? code, d });
}
shapes.sort((a, b) => a.code.localeCompare(b.code));

if (dropped.length > 0) {
  console.log(`world-map: dropped ${dropped.length} unmapped territories: ${dropped.join(', ')}`);
}

const body = shapes
  .map((shape) => `  { code: ${json(shape.code)}, name: ${json(shape.name)}, d: ${json(shape.d)} },`)
  .join('\n');

const output = `/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate with \`npm run generate:world-map\` (admin/scripts/generate-world-map.mjs).
 * Geometry: Natural Earth 1:110m admin-0 countries (public domain,
 * https://www.naturalearthdata.com), via the \`world-atlas\` package, projected
 * with d3-geo's Natural Earth projection and fitted to ${WIDTH}x${HEIGHT}.
 * Codes are ISO 3166-1 alpha-2, matching the country_code the Admin_API returns.
 */

/** One country's outline in the shared ${WIDTH}x${HEIGHT} viewBox. */
export interface WorldShape {
  readonly code: string;
  readonly name: string;
  readonly d: string;
}

export const WORLD_VIEWBOX = '0 0 ${WIDTH} ${HEIGHT}';

export const WORLD_SHAPES: readonly WorldShape[] = [
${body}
];
`;

writeFileSync(outFile, output);
console.log(`world-map: wrote ${shapes.length} country shapes to ${outFile}`);

function json(value) {
  return JSON.stringify(value);
}
