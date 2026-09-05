/**
 * The single place that knows how to read a status column and how to write
 * one back with an atomic compare-and-swap. Every entity module composes
 * its transition function from this plus its own transition table -- no
 * entity module writes its own UPDATE/SELECT.
 */

import { StaleTransitionError, TransitionPersistenceError } from "./errors.ts";

/**
 * The minimal query-builder surface this module depends on. Deliberately
 * narrower than @supabase/supabase-js's `SupabaseClient` type: a real
 * SupabaseClient satisfies this interface structurally (nothing here is
 * more than what PostgREST already returns), but depending on this
 * narrower shape lets the state machine be unit tested against a small
 * in-memory fake (see test-support.ts) instead of a live database --
 * matching this phase's "unit tests", as distinct from the database
 * integration tests IMPLEMENTATION_PLAN.md section 24 schedules for a
 * later phase.
 *
 * Return types use PromiseLike (only requires `.then`) rather than
 * `Promise` so that supabase-js's real (thenable, but not spec-exact
 * `Promise`) query builders satisfy this interface without a cast.
 */
export interface PostgrestResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface StatusDbFilterBuilder {
  eq(column: string, value: unknown): StatusDbFilterBuilder;
  limit(count: number): StatusDbFilterBuilder;
  select(columns?: string): StatusDbFilterBuilder;
  maybeSingle(): PromiseLike<PostgrestResult<Record<string, unknown>>>;
}

export interface StatusDbTableClient {
  select(columns?: string): StatusDbFilterBuilder;
  update(patch: Record<string, unknown>): StatusDbFilterBuilder;
  insert(row: Record<string, unknown>): PromiseLike<PostgrestResult<null>>;
}

export interface StatusDbClient {
  from(table: string): StatusDbTableClient;
}

export interface ApplyStatusTransitionParams<S extends string> {
  client: StatusDbClient;
  table: string;
  id: string;
  from: S;
  to: S;
  /** Extra columns to set in the same UPDATE (e.g. ended_at, approved_at). */
  extraPatch?: Record<string, unknown>;
}

/**
 * Applies `status = to` to the row `id` in `table`, but only if its current
 * status is still `from` -- an atomic compare-and-swap, so two concurrent
 * callers racing to transition the same row can never both succeed silently
 * past each other. Throws StaleTransitionError if no row matched (missing
 * id, or the row's real status had already moved) and
 * TransitionPersistenceError if the database itself reports an error.
 *
 * Callers must call assertValidTransition() before this -- this function
 * does not consult a transition table, it only performs the write.
 */
export async function applyStatusTransition<S extends string>(
  params: ApplyStatusTransitionParams<S>,
): Promise<void> {
  const { client, table, id, from, to, extraPatch } = params;

  const { data, error } = await client
    .from(table)
    .update({ status: to, ...extraPatch })
    .eq("id", id)
    .eq("status", from)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new TransitionPersistenceError(table, id, error.message);
  }
  if (!data) {
    throw new StaleTransitionError(table, id, from, to);
  }
}
