// Feature: telemetry-phone-home, Property 34: Each view is in exactly one state
//
// For any sequence of request outcomes per view, the view is in exactly one of
// loading, loaded, empty or failed at all times, is loading exactly between
// issuing a request and its settlement, renders empty exactly when the response
// carries no rows, renders failed exactly when the request failed, and a retry
// from the failed state issues exactly one further request.
//
// Validates: Requirements 10.11, 10.12, 10.13
//
// The interesting inputs are the CONTRADICTORY ones: loading with an error
// pending, an error alongside a resolved value, a resolved value that is also
// empty. `viewStateOf` has a fixed total precedence (loading > failed > empty >
// loaded, with "nothing in flight, no error, no value yet" resolving to
// loading), so those combinations must still collapse to a single state rather
// than lighting up two branches of a template at once. The property enumerates
// `VIEW_STATE_KINDS` and asserts the guard set has exactly one member true.

import fc from 'fast-check';

import {
  VIEW_FAILURE_FALLBACK,
  VIEW_STATE_KINDS,
  describeFailure,
  emptyState,
  failedState,
  isEmpty,
  isFailed,
  isLoaded,
  isLoading,
  loadedState,
  loadedValue,
  loadingState,
  viewStateOf,
  type ViewState,
  type ViewStateInput,
  type ViewStateKind,
} from './view-state';

/** Minimum iterations mandated for every property test in this feature. */
const RUNS = 200;

/** A stand-in for any Admin_API aggregate: a row list is all the views hold. */
type Rows = readonly number[];

/**
 * The guards, keyed by the discriminant they claim. Indexing this by
 * `VIEW_STATE_KINDS` is what makes "exactly one" checkable instead of a
 * hand-written four-way assertion that could silently omit a kind.
 */
const GUARDS: Readonly<Record<ViewStateKind, (state: ViewState<Rows>) => boolean>> = {
  loading: isLoading,
  loaded: isLoaded,
  empty: isEmpty,
  failed: isFailed,
};

/** Every kind whose guard answers true for `state`. Should always be one. */
function holdingKinds(state: ViewState<Rows>): ViewStateKind[] {
  return VIEW_STATE_KINDS.filter((kind) => GUARDS[kind](state));
}

/**
 * The single-state claim, asserted the same way everywhere: the guard set has
 * exactly one member, and that member is the discriminant the state carries.
 */
function expectExactlyOneState(state: ViewState<Rows>, expected: ViewStateKind): void {
  expect(holdingKinds(state)).toEqual([expected]);
  expect(state.kind).toBe(expected);
  // `loadedValue` is the only payload accessor, and it must agree with the guard
  // set rather than being a fifth, independently reachable state.
  if (expected !== 'loaded') expect(loadedValue(state)).toBeNull();
}

/** How a generated input decides emptiness, including "it never says". */
type EmptinessRule = 'absent' | 'byLength' | 'alwaysEmpty' | 'neverEmpty';

const EMPTINESS_PREDICATE: Readonly<
  Record<EmptinessRule, ((value: Rows) => boolean) | undefined>
> = {
  absent: undefined,
  byLength: (value) => value.length === 0,
  alwaysEmpty: () => true,
  neverEmpty: () => false,
};

/**
 * Rejections a real view can receive. Deliberately includes the degenerate ones
 * -`null`, `undefined`, a blank string, a bare object - because `viewStateOf`
 * treats "no error" as `undefined` or `null` only, and `describeFailure` has to
 * turn the rest into readable copy.
 */
const errorArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.string().map((message) => new Error(message)),
  fc.string(),
  fc.integer(),
  fc.constant({}),
  fc.constant({ status: 500 }),
);

const inputArb: fc.Arbitrary<ViewStateInput<Rows>> = fc.record({
  loading: fc.boolean(),
  error: errorArb,
  value: fc.option(fc.array(fc.integer(), { maxLength: 8 }), { nil: undefined }),
  emptiness: fc.constantFrom<EmptinessRule>('absent', 'byLength', 'alwaysEmpty', 'neverEmpty'),
}).map(({ loading, error, value, emptiness }) => ({
  loading,
  error,
  value: value ?? undefined,
  isEmpty: EMPTINESS_PREDICATE[emptiness],
}));

/**
 * The documented precedence, written out independently of the implementation so
 * the property compares two derivations rather than restating one.
 */
function expectedKind(input: ViewStateInput<Rows>): ViewStateKind {
  if (input.loading) return 'loading';
  if (input.error !== undefined && input.error !== null) return 'failed';
  if (input.value === undefined) return 'loading';
  return input.isEmpty?.(input.value) ? 'empty' : 'loaded';
}

describe('Property 34: Each view is in exactly one state', () => {
  it('collapses any ViewStateInput, contradictory ones included, to exactly one state', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const state = viewStateOf(input);
        expectExactlyOneState(state, expectedKind(input));
      }),
      { numRuns: RUNS },
    );
  });

  it('holds for every state a constructor can build', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(loadingState<Rows>()),
          fc.array(fc.integer(), { maxLength: 8 }).map((rows) => loadedState<Rows>(rows)),
          fc.constant(emptyState<Rows>()),
          errorArb.map((reason) => failedState<Rows>(reason)),
        ),
        (state) => {
          expect(holdingKinds(state).length).toBe(1);
          expect(holdingKinds(state)[0]).toBe(state.kind);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('is loading exactly between issuing a request and its settlement, and a retry issues exactly one further request', () => {
    type Outcome =
      | { readonly kind: 'rows'; readonly rows: readonly number[] }
      | { readonly kind: 'empty' }
      | { readonly kind: 'reject'; readonly error: unknown };

    const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
      fc
        .array(fc.integer(), { minLength: 1, maxLength: 6 })
        .map((rows) => ({ kind: 'rows', rows }) as const),
      fc.constant({ kind: 'empty' } as const),
      errorArb
        .filter((error) => error !== undefined && error !== null)
        .map((error) => ({ kind: 'reject', error }) as const),
    );

    fc.assert(
      fc.property(fc.array(outcomeArb, { minLength: 1, maxLength: 12 }), (outcomes) => {
        // A view keeps its last resolved value across a later rejection, so the
        // "error plus value" contradiction is exercised by the fold itself.
        let input: ViewStateInput<Rows> = {
          loading: false,
          isEmpty: (value) => value.length === 0,
        };
        let requests = 0;

        // Before anything is issued the view is still loading: rule 5 of the
        // precedence, and the honest thing to render.
        expectExactlyOneState(viewStateOf(input), 'loading');

        const issue = (): void => {
          requests += 1;
          input = { ...input, loading: true };
          expectExactlyOneState(viewStateOf(input), 'loading');
        };

        for (const outcome of outcomes) {
          const before = requests;
          issue();
          // Every issue is exactly one request, including a retry from failed.
          expect(requests).toBe(before + 1);

          if (outcome.kind === 'reject') {
            input = { ...input, loading: false, error: outcome.error };
            const state = viewStateOf(input);
            expectExactlyOneState(state, 'failed');
            // The failed state carries the retry control, so its copy must be
            // readable rather than blank.
            if (state.kind === 'failed') expect(state.reason.trim()).not.toBe('');
            continue;
          }

          const rows = outcome.kind === 'empty' ? [] : outcome.rows;
          input = { ...input, loading: false, error: undefined, value: rows };
          const state = viewStateOf(input);
          expectExactlyOneState(state, rows.length === 0 ? 'empty' : 'loaded');
          if (rows.length > 0) expect(loadedValue(state)).toEqual(rows);
        }

        expect(requests).toBe(outcomes.length);
      }),
      { numRuns: RUNS },
    );
  });

  it('degrades a failure with no usable message to the static fallback', () => {
    // `[object Object]` and an empty line are both rendering bugs, so every
    // reason that is not a non-blank string or a non-blank Error message must
    // land on exactly one static sentence.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant({}),
          fc.constant({ status: 500 }),
          fc.constant([]),
          fc.integer(),
          fc.boolean(),
          fc.stringMatching(/^[ \t\n]*$/),
          fc.stringMatching(/^[ \t\n]*$/).map((blank) => new Error(blank)),
        ),
        (reason) => {
          expect(describeFailure(reason)).toBe(VIEW_FAILURE_FALLBACK);
          const state = failedState<Rows>(reason);
          expectExactlyOneState(state, 'failed');
          if (state.kind === 'failed') expect(state.reason).toBe(VIEW_FAILURE_FALLBACK);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('keeps a usable message, trimmed', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((raw) => raw.trim() !== ''),
        fc.constantFrom<'string' | 'error'>('string', 'error'),
        (raw, shape) => {
          const reason: unknown = shape === 'string' ? raw : new Error(raw);
          expect(describeFailure(reason)).toBe(raw.trim());
        },
      ),
      { numRuns: RUNS },
    );
  });
});
