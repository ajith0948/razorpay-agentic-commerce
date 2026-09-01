import { createClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client, authenticated with the service role key.
 *
 * This bypasses Row Level Security and must never be imported from
 * client-side code. Use it only from Next.js server-side code (route
 * handlers, server actions, server components) -- consistent with
 * AGENTS.md section 6: all payment and data operations must pass through
 * backend-controlled server-side functions, never the client directly.
 *
 * A factory function (rather than a module-level client instance) so a
 * missing environment variable only throws when actually invoked, not at
 * import time.
 */
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing Supabase server environment variables. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
