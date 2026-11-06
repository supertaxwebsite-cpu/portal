import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** True while nobody has signed up yet: the first account becomes the master admin. */
async function needsSetup() {
  const admin = createAdminClient();
  const { count, error } = await admin.from("profiles").select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return (count ?? 0) === 0;
}

export async function GET() {
  try {
    return NextResponse.json({ needsSetup: await needsSetup() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    if (!(await needsSetup())) {
      return NextResponse.json({ error: "Setup is already done. Sign in instead." }, { status: 409 });
    }
    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const fullName = String(body.fullName ?? "").trim();
    if (!email || !fullName) return NextResponse.json({ error: "Enter your name and email." }, { status: 400 });
    if (password.length < 10) return NextResponse.json({ error: "Use a password of at least 10 characters." }, { status: 400 });

    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (error || !data.user) return NextResponse.json({ error: error?.message ?? "Could not create the account." }, { status: 400 });

    // Re-check in case two people ran setup at the same moment.
    if (!(await needsSetup())) {
      await admin.auth.admin.deleteUser(data.user.id);
      return NextResponse.json({ error: "Setup was completed by someone else. Sign in instead." }, { status: 409 });
    }
    const { error: pErr } = await admin.from("profiles").insert({ id: data.user.id, email, full_name: fullName, title: "Principal", role: "master", active: true });
    if (pErr) {
      await admin.auth.admin.deleteUser(data.user.id);
      return NextResponse.json({ error: pErr.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
