import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { codeStepOn, hashCode, makeCookie, sessionIdOf, CODE_COOKIE, CODE_MAX_TRIES } from "@/lib/loginCode";

export const dynamic = "force-dynamic";

/** Checks the emailed code; the right one unlocks the portal for this sign-in. */
export async function POST(req: Request) {
  if (!codeStepOn()) return NextResponse.json({ ok: true });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { data: { session } } = await supabase.auth.getSession();
  const sid = sessionIdOf(session?.access_token);
  if (!sid) return NextResponse.json({ error: "Sign in again." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const code = String(body.code ?? "").replace(/\D/g, "");
  if (code.length !== 6) return NextResponse.json({ error: "Type the 6-digit code from the email." }, { status: 400 });

  const admin = createAdminClient();
  const { data: row } = await admin.from("login_codes").select("code_hash, attempts, expires_at").eq("user_id", user.id).maybeSingle();
  if (!row || Date.parse(row.expires_at) < Date.now()) return NextResponse.json({ error: "That code has expired. Press Send a new code." }, { status: 400 });
  if (row.attempts >= CODE_MAX_TRIES) return NextResponse.json({ error: "Too many wrong tries. Press Send a new code." }, { status: 429 });

  if ((await hashCode(user.id, code)) !== row.code_hash) {
    await admin.from("login_codes").update({ attempts: row.attempts + 1 }).eq("user_id", user.id);
    const left = CODE_MAX_TRIES - row.attempts - 1;
    return NextResponse.json({ error: left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong tries. Press Send a new code." }, { status: 400 });
  }
  await admin.from("login_codes").delete().eq("user_id", user.id);
  const c = await makeCookie(user.id, sid);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(CODE_COOKIE, c.value, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: c.maxAge });
  return res;
}
