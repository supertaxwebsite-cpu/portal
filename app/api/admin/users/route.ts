import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMaster, tempPassword } from "@/lib/auth";
import { setTeam } from "@/lib/team";
import { ENTITIES, PRACTICES } from "@/lib/domain";

/** Master admin adds a team member. Returns a temporary password to hand over;
 *  they must choose their own password at first sign-in. */
export async function POST(req: Request) {
  const me = await requireMaster();
  if (!me) return NextResponse.json({ error: "Only the master admin can add team members." }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const fullName = String(body.fullName ?? "").trim();
  const title = String(body.title ?? "").trim();
  const role = body.role === "master" || body.role === "manager" ? body.role : "staff";
  if (!email || !fullName) return NextResponse.json({ error: "Enter their name and email." }, { status: 400 });

  const admin = createAdminClient();
  let reportsTo: string | null = null;
  if (role === "staff" && typeof body.reportsTo === "string" && body.reportsTo) {
    const { data: mgr } = await admin.from("profiles").select("role").eq("id", body.reportsTo).maybeSingle();
    if (!mgr || (mgr.role !== "manager" && mgr.role !== "master")) return NextResponse.json({ error: "Choose a manager from the list." }, { status: 400 });
    reportsTo = body.reportsTo;
  }
  let managerId: string | null = null;
  if (role !== "master" && typeof body.managerId === "string" && body.managerId) {
    const { data: boss } = await admin.from("profiles").select("role").eq("id", body.managerId).maybeSingle();
    if (!boss || (boss.role !== "manager" && boss.role !== "master")) return NextResponse.json({ error: "Choose a manager from the list." }, { status: 400 });
    managerId = body.managerId;
  }
  const password = tempPassword();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (error || !data.user) {
    const msg = /already/i.test(error?.message ?? "") ? "Someone with that email already has an account." : error?.message ?? "Could not add them.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  const perms: Record<string, boolean | string[] | string> = {};
  if (role === "staff" && typeof body.canDelete === "boolean") perms.can_delete = body.canDelete;
  if (role !== "master" && body.canSeeWorkload === true) perms.can_see_workload = true;
  if (role === "staff" && body.canPickReviewer === true) perms.can_pick_reviewer = true;
  if (role === "staff" && body.canSeeMgmt === true) perms.can_see_mgmt_notes = true;
  if (role !== "master" && body.signReminders === true) perms.gets_sign_reminders = true;
  if (role === "staff" && body.canCreateClients === false) perms.can_create_clients = false;
  if (managerId) perms.manager_id = managerId;
  if (role === "staff" && Array.isArray(body.clientTypes) && body.clientTypes.length) perms.client_types = body.clientTypes.filter((x: unknown) => typeof x === "string" && ENTITIES.includes(x));
  if (role === "staff" && Array.isArray(body.practices) && body.practices.length) perms.practices = body.practices.filter((x: unknown) => typeof x === "string" && (PRACTICES as readonly string[]).includes(x));
  let { error: pErr } = await admin.from("profiles").insert({ id: data.user.id, email, full_name: fullName, title, role, active: true, must_change_password: true, ...perms, ...(reportsTo ? { reports_to: reportsTo } : {}) });
  if (pErr && /can_see_workload|can_pick_reviewer|can_see_mgmt_notes|client_types|practices|gets_sign_reminders|can_create_clients|manager_id/.test(pErr.message)) {
    // Database update for a permission not run yet: add them without it.
    if (perms.can_create_clients === false) return NextResponse.json({ error: "Run database-update-client-permissions.sql in Supabase first, then try again." }, { status: 500 });
    delete perms.manager_id; delete perms.gets_sign_reminders; delete perms.can_see_workload; delete perms.can_pick_reviewer; delete perms.can_see_mgmt_notes;
    if (!(perms.practices as string[] | undefined)?.length) delete perms.practices;
    ({ error: pErr } = await admin.from("profiles").insert({ id: data.user.id, email, full_name: fullName, title, role, active: true, must_change_password: true, ...perms, ...(reportsTo ? { reports_to: reportsTo } : {}) }));
  }
  if (pErr) {
    await admin.auth.admin.deleteUser(data.user.id);
    return NextResponse.json({ error: pErr.message }, { status: 500 });
  }
  if (role === "manager") {
    const err = await setTeam(admin, data.user.id, body.team);
    if (err) return NextResponse.json({ ok: true, tempPassword: password, warning: err });
  }
  return NextResponse.json({ ok: true, tempPassword: password });
}
