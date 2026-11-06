import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/** Service-role client. Bypasses row level security: use only on the server,
 *  and only after checking the caller is allowed to do the action. */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
