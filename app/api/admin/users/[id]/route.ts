import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMaster, tempPassword } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/** Change a team member's role, title or name, or switch their access off/on. */
export async function PATCH(req: Request, { params }: Ctx) {
  const me = await requireMaster();
  if (!me) return NextResponse.json({ error: "Only the master admin can change access." }, { status: 403 });
  const { id } = await params;
  if (id === me.id) return NextResponse.json({ error: "You can't change your own master admin access." }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const update: Record<string, unknown> = {};
  if (body.role === "manager" || body.role === "staff") update.role = body.role;
  if (typeof body.title === "string") update.title = body.title.trim();
  if (typeof body.fullName === "string" && body.fullName.trim()) update.full_name = body.fullName.trim();
  if (typeof body.active === "boolean") update.active = body.active;
  if (!Object.keys(update).length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("role").eq("id", id).maybeSingle();
  if (!target) return NextResponse.json({ error: "That person no longer exists." }, { status: 404 });
  if (target.role === "master") return NextResponse.json({ error: "The master admin can't be changed here." }, { status: 400 });

  if (typeof body.active === "boolean") {
    // Banning also signs them out everywhere within the hour (token expiry).
    const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: body.active ? "none" : "876000h" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const { error } = await admin.from("profiles").update(update).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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
