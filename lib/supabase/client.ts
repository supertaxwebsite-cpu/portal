import { supabaseUrl, supabaseAnonKey } from "@/lib/supabase/env";
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    supabaseUrl(),
    supabaseAnonKey()
  );
}
