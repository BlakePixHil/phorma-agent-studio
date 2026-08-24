/**
 * The four states a dashboard view can be in, as ONE discriminated union.
 *
 * Modelled as a union rather than a bag of independent booleans on purpose:
 * "loading and failed at the same time" is unrepresentable, so mutual
 * exclusivity is a type-level fact and not a runtime convention every template
 * has to re-establish (Requirements 10.11, 10.12, 10.13).
 *
 * A view template never reconstructs the discriminant. It switches on
 * `state.kind`, or uses the guards below, and reads the payload the matching
 * branch carries.
 */
export type ViewState<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly value: T }
  | { readonly kind: 'empty' }
  | { readonly kind: 'failed'; readonly reason: string };

/** Every discriminant, for exhaustiveness checks and for tests. */
export const VIEW_STATE_KINDS = ['loading', 'loaded', 'empty', 'failed'] as const;

export type ViewStateKind = (typeof VIEW_STATE_KINDS)[number];

/**
 * The single message a failure without a usable one falls back to. Static text:
 * a view is read by a human who can retry, not by a debugger, and an Admin_API
 * failure body is already a fixed static reason.
 */
export const VIEW_FAILURE_FALLBACK = 'Could not load this view.';

// --- Constructors ----------------------------------------------------------
//
// The only way the rest of the package builds a state. Each one returns a frozen
// value so a state cannot be mutated into a second state after the fact.

/** An Admin_API request is in flight (10.11). */
export function loadingState<T>(): ViewState<T> {
  return LOADING;
}

/** The request succeeded and carries rows (10.13 does not apply). */
export function loadedState<T>(value: T): ViewState<T> {
  return Object.freeze({ kind: 'loaded', value } as const);
}

/** The request succeeded and the range holds no rows (10.13). */
export function emptyState<T>(): ViewState<T> {
  return EMPTY;
}

/**
 * The request failed (10.12). `reason` is display copy for the error state,
 * which also carries the retry control.
 */
export function failedState<T>(reason?: unknown): ViewState<T> {
  return Object.freeze({ kind: 'failed', reason: describeFailure(reason) } as const);
}

const LOADING = Object.freeze({ kind: 'loading' } as const);
const EMPTY = Object.freeze({ kind: 'empty' } as const);

// --- Guards ----------------------------------------------------------------
//
// Narrowing helpers so a template reads `isLoaded(state)` instead of comparing
// string literals, and so `state.value` is only reachable when it exists.

export function isLoading<T>(state: ViewState<T>): state is { readonly kind: 'loading' } {
  return state.kind === 'loading';
}

export function isLoaded<T>(
  state: ViewState<T>,
): state is { readonly kind: 'loaded'; readonly value: T } {
  return state.kind === 'loaded';
}

export function isEmpty<T>(state: ViewState<T>): state is { readonly kind: 'empty' } {
  return state.kind === 'empty';
}

export function isFailed<T>(
  state: ViewState<T>,
): state is { readonly kind: 'failed'; readonly reason: string } {
  return state.kind === 'failed';
}

/** The value a `loaded` state carries, or `null` in every other state. */
export function loadedValue<T>(state: ViewState<T>): T | null {
  return state.kind === 'loaded' ? state.value : null;
}

// --- Derivation ------------------------------------------------------------

/** What a view knows about its own request, before it becomes a `ViewState`. */
export interface ViewStateInput<T> {
  /** True while an Admin_API request is in flight. */
  loading: boolean;
  /** The rejection, if the latest request failed. `null` or `undefined` when it did not. */
  error?: unknown;
  /** The resolved response, absent until one has resolved. */
  value?: T | undefined;
  /** Whether a resolved response holds no rows. Defaults to "it holds rows". */
  isEmpty?: (value: T) => boolean;
}

/**
 * Collapses what a view knows into exactly one state.
 *
 * The precedence is fixed and total, which is what makes the four states
 * mutually exclusive at runtime as well as in the type:
 *
 * 1. `loading` wins outright, so a retry after a failure shows the loading
 *    state rather than the stale error (10.11).
 * 2. then `failed` (10.12),
 * 3. then, for a resolved response, `empty` when `isEmpty` says so (10.13),
 * 4. otherwise `loaded`.
 * 5. Nothing in flight, no error and no value yet is still `loading` - the
 *    request has not been issued, so there is nothing else honest to render.
 */
export function viewStateOf<T>(input: ViewStateInput<T>): ViewState<T> {
  if (input.loading) return loadingState<T>();
  if (input.error !== undefined && input.error !== null) return failedState<T>(input.error);
  if (input.value === undefined) return loadingState<T>();
  return input.isEmpty?.(input.value) ? emptyState<T>() : loadedState(input.value);
}

/**
 * Turns a rejection into display copy. An `Error` with a non-blank message keeps
 * it, a non-blank string is used as is, and everything else - including `null`,
 * a number, or an object with no message - falls back to the static reason, so
 * the failed state never renders `[object Object]` or an empty line.
 */
export function describeFailure(reason: unknown): string {
  if (typeof reason === 'string' && reason.trim() !== '') return reason.trim();
  if (reason instanceof Error && reason.message.trim() !== '') return reason.message.trim();
  return VIEW_FAILURE_FALLBACK;
}
