import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentProfile } from "@/lib/auth";

/** Ids of the active master admins, so team leaders can send work to them for review. */
export async function GET() {
  const me = await currentProfile();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data, error } = await createAdminClient().from("profiles").select("id").eq("role", "master").eq("active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ids: (data ?? []).map((r) => r.id) });
}
