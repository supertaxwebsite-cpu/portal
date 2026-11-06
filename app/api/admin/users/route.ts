import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMaster, tempPassword } from "@/lib/auth";

/** Master admin adds a team member. Returns a temporary password to hand over;
 *  they must choose their own password at first sign-in. */
export async function POST(req: Request) {
  const me = await requireMaster();
  if (!me) return NextResponse.json({ error: "Only the master admin can add team members." }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const fullName = String(body.fullName ?? "").trim();
  const title = String(body.title ?? "").trim();
  const role = body.role === "manager" ? "manager" : "staff";
  if (!email || !fullName) return NextResponse.json({ error: "Enter their name and email." }, { status: 400 });

  const admin = createAdminClient();
  const password = tempPassword();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (error || !data.user) {
    const msg = /already/i.test(error?.message ?? "") ? "Someone with that email already has an account." : error?.message ?? "Could not add them.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  const { error: pErr } = await admin.from("profiles").insert({ id: data.user.id, email, full_name: fullName, title, role, active: true, must_change_password: true });
  if (pErr) {
    await admin.auth.admin.deleteUser(data.user.id);
    return NextResponse.json({ error: pErr.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, tempPassword: password });
}
