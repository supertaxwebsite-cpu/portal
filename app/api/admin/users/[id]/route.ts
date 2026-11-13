import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMaster, tempPassword } from "@/lib/auth";
import { setTeam } from "@/lib/team";
import { ENTITIES, PRACTICES } from "@/lib/domain";

type Ctx = { params: Promise<{ id: string }> };

/** Change a team member's role, title or name, or switch their access off/on. */
export async function PATCH(req: Request, { params }: Ctx) {
  const me = await requireMaster();
  if (!me) return NextResponse.json({ error: "Only the master admin can change access." }, { status: 403 });
  const { id } = await params;
  if (id === me.id) return NextResponse.json({ error: "You can't change your own master admin access." }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const update: Record<string, unknown> = {};
  if (body.role === "master" || body.role === "manager" || body.role === "staff") update.role = body.role;
  if (typeof body.title === "string") update.title = body.title.trim();
  if (typeof body.fullName === "string" && body.fullName.trim()) update.full_name = body.fullName.trim();
  if (typeof body.active === "boolean") update.active = body.active;
  if (body.reportsTo === null || body.reportsTo === "") update.reports_to = null;
  else if (typeof body.reportsTo === "string") update.reports_to = body.reportsTo;
  if (update.role === "manager" || update.role === "master") update.reports_to = null;
  if (typeof body.canDelete === "boolean") update.can_delete = body.canDelete;
  if (typeof body.canSeeWorkload === "boolean") update.can_see_workload = body.canSeeWorkload;
  if (typeof body.canPickReviewer === "boolean") update.can_pick_reviewer = body.canPickReviewer;
  if (typeof body.canSeeMgmt === "boolean") update.can_see_mgmt_notes = body.canSeeMgmt;
  if (Array.isArray(body.clientTypes)) update.client_types = body.clientTypes.filter((x: unknown) => typeof x === "string" && ENTITIES.includes(x));
  if (Array.isArray(body.practices)) update.practices = body.practices.filter((x: unknown) => typeof x === "string" && (PRACTICES as readonly string[]).includes(x));
  if (update.role === "master") { update.can_delete = false; update.can_see_workload = false; }
  if (update.role === "master" || update.role === "manager") { update.can_pick_reviewer = false; update.can_see_mgmt_notes = false; update.client_types = []; update.practices = []; }
  if (!Object.keys(update).length && !Array.isArray(body.team)) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("role").eq("id", id).maybeSingle();
  if (!target) return NextResponse.json({ error: "That person no longer exists." }, { status: 404 });
  if (typeof update.reports_to === "string") {
    if (update.reports_to === id) return NextResponse.json({ error: "Someone can't report to themselves." }, { status: 400 });
    const { data: mgr } = await admin.from("profiles").select("role").eq("id", update.reports_to).maybeSingle();
    if (!mgr || mgr.role !== "manager") return NextResponse.json({ error: "Choose a manager from the list." }, { status: 400 });
  }

  if (typeof body.active === "boolean") {
    // Banning also signs them out everywhere within the hour (token expiry).
    const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: body.active ? "none" : "876000h" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (Object.keys(update).length) {
    let { error } = await admin.from("profiles").update(update).eq("id", id);
    if (error && /can_see_mgmt_notes|client_types|practices/.test(error.message) && !update.can_see_mgmt_notes && !(update.client_types as string[] | undefined)?.length && !(update.practices as string[] | undefined)?.length) {
      // A database update for these permissions isn't run yet: save everything else.
      delete update.can_see_mgmt_notes; delete update.client_types; delete update.practices;
      ({ error } = await admin.from("profiles").update(update).eq("id", id));
    }
    if (error) return NextResponse.json({ error: /can_see_workload|can_pick_reviewer|can_see_mgmt_notes|client_types|practices/.test(error.message) ? "Run the latest database update first." : error.message }, { status: 500 });
  }
  const role = (update.role as string | undefined) ?? target.role;
  if (role === "manager" && Array.isArray(body.team)) {
    const err = await setTeam(admin, id, body.team);
    if (err) return NextResponse.json({ error: err }, { status: 500 });
  } else if (role !== "manager" && target.role === "manager") {
    // No longer a team leader: their staff are left unallocated.
    await admin.from("profiles").update({ reports_to: null }).eq("reports_to", id);
  }
  return NextResponse.json({ ok: true });
}

/** Reset someone's password to a new temporary one. */
export async function POST(_req: Request, { params }: Ctx) {
  const me = await requireMaster();
  if (!me) return NextResponse.json({ error: "Only the master admin can reset passwords." }, { status: 403 });
  const { id } = await params;
  if (id === me.id) return NextResponse.json({ error: "Change your own password from your account menu." }, { status: 400 });
  const admin = createAdminClient();
  const password = tempPassword();
  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await admin.from("profiles").update({ must_change_password: true }).eq("id", id);
  return NextResponse.json({ ok: true, tempPassword: password });
}
