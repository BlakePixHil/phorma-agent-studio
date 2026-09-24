import { resource, type ResourceRef } from '@angular/core';

import type { DateRange } from '../core/models';
import type { AdminResult } from '../core/telemetry-api.service';
import { isOk } from '../core/telemetry-api.service';

/**
 * A request that only ENRICHES a view (a previous-period comparison, a sparkline
 * series). It never throws, so its failure cannot move the view out of `loaded`:
 * the view just renders without the extra.
 */
export function enrichment<T>(
  params: () => DateRange,
  fetch: (range: DateRange) => Promise<AdminResult<T>>,
): ResourceRef<T | null | undefined> {
  return resource({
    params,
    loader: ({ params: range }) =>
      fetch(range).then(
        (result) => (isOk(result) ? result.value : null),
        () => null,
      ),
  });
}

/** The loaded value of an enrichment, or null while loading or after a failure. */
export function enriched<T>(ref: ResourceRef<T | null | undefined>): T | null {
  return ref.hasValue() ? (ref.value() ?? null) : null;
}
