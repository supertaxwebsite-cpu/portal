import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/graphMail";
import { codeStepOn, hashCode, newCode, CODE_TTL_MIN, CODE_RESEND_SEC } from "@/lib/loginCode";

export const dynamic = "force-dynamic";

/** Emails a 6-digit sign-in code to the signed-in person. */
export async function POST(req: Request) {
  if (!codeStepOn()) return NextResponse.json({ off: true });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const admin = createAdminClient();
  const { data: prof } = await admin.from("profiles").select("full_name, active").eq("id", user.id).maybeSingle();
  if (!prof?.active) return NextResponse.json({ error: "Your account isn't active. Speak to your manager." }, { status: 403 });

  const force = new URL(req.url).searchParams.get("resend") === "1";
  const { data: last, error: readErr } = await admin.from("login_codes").select("sent_at, expires_at").eq("user_id", user.id).maybeSingle();
  if (readErr) return NextResponse.json({ error: "The sign-in code table is missing. Run the database update for email codes in Supabase." }, { status: 500 });
  const since = last ? (Date.now() - Date.parse(last.sent_at)) / 1000 : Infinity;
  // A code sent a moment ago is still on its way: don't send another (page reloads, double clicks).
  if (last && Date.parse(last.expires_at) > Date.now() && (since < CODE_RESEND_SEC || !force)) {
    return NextResponse.json({ ok: true, to: mask(user.email), wait: Math.max(0, Math.ceil(CODE_RESEND_SEC - since)) });
  }

  const code = newCode();
  const now = new Date();
  const { error } = await admin.from("login_codes").upsert({
    user_id: user.id, code_hash: await hashCode(user.id, code), attempts: 0,
    sent_at: now.toISOString(), expires_at: new Date(now.getTime() + CODE_TTL_MIN * 60000).toISOString(),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  try {
    await sendMail({
      to: [user.email], cc: [], files: [],
      subject: `${code} is your Practice Desk sign-in code`,
      html: `<p>Hi ${esc(prof.full_name || "")},</p><p>Your Practice Desk sign-in code is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${code}</p>
<p>It works for ${CODE_TTL_MIN} minutes. If you didn't just sign in, tell your manager straight away and change your password.</p>`,
    });
  } catch (e) {
    await admin.from("login_codes").delete().eq("user_id", user.id);
    return NextResponse.json({ error: `The code email couldn't be sent: ${(e as Error).message}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, to: mask(user.email), wait: CODE_RESEND_SEC });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function mask(email: string) {
  const [u, d] = email.split("@");
  return `${u.slice(0, 2)}${"•".repeat(Math.max(1, u.length - 2))}@${d}`;
}
