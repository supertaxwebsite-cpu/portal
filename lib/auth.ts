import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

/** The signed-in person's active profile, or null. */
export async function currentProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (!data || !data.active) return null;
  return data as Profile;
}

export async function requireMaster(): Promise<Profile | null> {
  const p = await currentProfile();
  return p && p.role === "master" ? p : null;
}

export function tempPassword(): string {
  const words = ["Wattle", "Harbour", "Gum", "Koala", "Coral", "Banksia", "Reef", "Emu", "Opal", "Kelpie"];
  const bytes = new Uint32Array(3);
  crypto.getRandomValues(bytes);
  const w = (i: number) => words[bytes[i] % words.length];
  return `${w(0)}-${w(1)}-${(bytes[2] % 9000) + 1000}`;
}
