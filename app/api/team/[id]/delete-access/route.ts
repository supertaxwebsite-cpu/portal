import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentProfile } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/** Give a staff member permission to delete clients and jobs, or take it away.
 *  The master admin can do this for any staff member; a manager only for staff who report to them. */
export async function PATCH(req: Request, { params }: Ctx) {
  const me = await currentProfile();
  if (!me || (me.role !== "master" && me.role !== "manager")) {
    return NextResponse.json({ error: "Only the master admin or a manager can change delete access." }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.allow !== "boolean") return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("role, reports_to, active").eq("id", id).maybeSingle();
  if (!target) return NextResponse.json({ error: "That person no longer exists." }, { status: 404 });
  if (target.role !== "staff") return NextResponse.json({ error: "Managers and the master admin can always delete." }, { status: 400 });
  if (me.role === "manager" && target.reports_to !== me.id) {
    return NextResponse.json({ error: "You can only change access for people in your own team." }, { status: 403 });
  }
  const { error } = await admin.from("profiles").update({ can_delete: body.allow }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
