import { createClient } from "@supabase/supabase-js";

/**
 * Browser-safe Supabase client, authenticated with the public anon key.
 *
 * Only for client-side code. Never pass the service role key to this
 * client, and never use it for privileged operations -- those must go
 * through server-side code (see lib/supabase/server.ts).
 *
 * A factory function (rather than a module-level client instance) so a
 * missing environment variable only throws when actually invoked, not at
 * import time.
 */
export function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase browser environment variables. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  return createClient(url, anonKey);
}
