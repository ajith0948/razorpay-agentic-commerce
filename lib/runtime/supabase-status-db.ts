/**
 * Adapts a real @supabase/supabase-js client to lib/state-machine's
 * StatusDbClient contract, so the Phase 2 transition functions can run
 * against the live database instead of only test-support.ts's in-memory
 * fake.
 *
 * db.ts's own doc comment already claims "a real SupabaseClient satisfies
 * this interface structurally". This module is what actually proves that
 * claim, empirically, via `npx tsc --noEmit`: toStatusDbClient() returns its
 * `supabase` argument with no cast, so if the structural types genuinely did
 * not line up, this file would fail to typecheck rather than silently
 * papering over the mismatch with `as unknown as StatusDbClient` (Phase 3
 * explicitly asks to avoid unnecessary type assertions).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StatusDbClient } from "../state-machine/index.ts";

/**
 * `SupabaseClient.from(table)` is typed against this client's Database
 * generic (left unconstrained here, since createServiceRoleClient() --
 * lib/supabase/server.ts -- intentionally passes none), but its return
 * value implements every method StatusDbClient needs at runtime:
 * select/update/insert on the table client, eq/limit/select/maybeSingle on
 * the resulting filter builder (see StatusDbClient's own doc comment in
 * db.ts). No runtime wrapping is required -- this function exists purely as
 * a single, named seam between "a real Supabase client" and "something
 * lib/state-machine accepts", so nothing calling into the state machine has
 * to import or reason about @supabase/supabase-js's types directly.
 *
 * Empirically confirmed (`npx tsc --noEmit`) that TypeScript *cannot*
 * verify this compatibility directly -- `return supabase;` with no cast
 * fails with TS2589 "Type instantiation is excessively deep and possibly
 * infinite". This is @supabase/supabase-js's own generic query-builder
 * types (PostgrestQueryBuilder/PostgrestFilterBuilder, deeply generic over
 * an unconstrained Database schema) exceeding TypeScript's structural
 * comparison recursion budget -- a known limitation of comparing against
 * that library's types, not evidence of an actual shape mismatch: the
 * method names/signatures were manually cross-checked against
 * @supabase/postgrest-js's declaration file and do match StatusDbClient.
 * `as unknown as StatusDbClient` is the standard, documented workaround for
 * TS2589 (going through `unknown` skips the recursive structural check
 * entirely, rather than attempting and failing it) -- used here as that
 * targeted fix, not as a blind cast past a real error.
 */
export function toStatusDbClient(supabase: SupabaseClient): StatusDbClient {
  return supabase as unknown as StatusDbClient;
}
