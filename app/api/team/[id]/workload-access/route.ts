import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentProfile } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/** Let someone see Team workload and Working now, or take it away. Master admin only. */
export async function PATCH(req: Request, { params }: Ctx) {
  const me = await currentProfile();
  if (!me || me.role !== "master") {
    return NextResponse.json({ error: "Only the master admin can change who sees the team workload." }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.allow !== "boolean") return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("role").eq("id", id).maybeSingle();
  if (!target) return NextResponse.json({ error: "That person no longer exists." }, { status: 404 });
  if (target.role === "master") return NextResponse.json({ error: "Master admins always see the team workload." }, { status: 400 });
  const { error } = await admin.from("profiles").update({ can_see_workload: body.allow }).eq("id", id);
  if (error) return NextResponse.json({ error: /can_see_workload/.test(error.message) ? "Run the latest database update first." : error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
