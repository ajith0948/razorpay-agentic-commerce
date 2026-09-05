/**
 * The single generic engine behind every entity's transition rules.
 *
 * Each entity module (rfq.ts, quote.ts, order.ts, payment.ts, approval.ts,
 * agent-session.ts) defines its own TransitionTable data -- copied from the
 * relevant DATABASE.md lifecycle section -- and calls assertValidTransition
 * against it. The "is this edge allowed" check itself lives here exactly
 * once, so it is impossible for one entity's transition logic to
 * accidentally diverge from another's.
 */

import { InvalidTransitionError } from "./errors.ts";

/**
 * A transition table maps every possible status of S to the set of
 * statuses it may move to. `Record<S, ...>` (rather than `Partial<Record<S,
 * ...>>`) deliberately forces every entity module to list *all* of its
 * states, including terminal ones (mapped to an empty array) -- so
 * forgetting a state is a compile error, not a silently-permissive gap.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

/** Pure predicate: is `from -> to` an edge in `table`? No I/O, no throw. */
export function isValidTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}

/**
 * Throws InvalidTransitionError unless `from -> to` is an edge in `table`.
 * This is the only place that decides whether a transition is allowed;
 * every entity's transition function calls this before touching the
 * database.
 */
export function assertValidTransition<S extends string>(
  entity: string,
  table: TransitionTable<S>,
  from: S,
  to: S,
): void {
  if (!isValidTransition(table, from, to)) {
    throw new InvalidTransitionError(entity, from, to);
  }
}
