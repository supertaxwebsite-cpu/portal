import { NextResponse } from "next/server";
import { requireMaster } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { mailConfigured, mailFrom, sendMail } from "@/lib/graphMail";
import { codeStepOn } from "@/lib/loginCode";

export const dynamic = "force-dynamic";

/** Master admins: is everything ready for the email sign-in code? */
export async function GET() {
  const me = await requireMaster();
  if (!me) return NextResponse.json({ error: "Only a master admin can check this." }, { status: 403 });
  const { error } = await createAdminClient().from("login_codes").select("user_id").limit(1);
  return NextResponse.json({ mail: mailConfigured(), from: mailConfigured() ? mailFrom() : "", table: !error, envOn: process.env.LOGIN_CODE === "on", on: codeStepOn() });
}

/** Master admins: send a test email to yourself, to prove sending works before switching the code on. */
export async function POST() {
  const me = await requireMaster();
  if (!me) return NextResponse.json({ error: "Only a master admin can do this." }, { status: 403 });
  if (!mailConfigured()) return NextResponse.json({ error: "Email sending isn't set up in Vercel yet (SMTP settings)." }, { status: 400 });
  try {
    await sendMail({ to: [me.email], cc: [], files: [], subject: "Practice Desk test email",
      html: "<p>This is a test from Practice Desk. Email sending works, so the sign-in code can be switched on.</p>" });
  } catch (e) {
    return NextResponse.json({ error: `Couldn't send: ${(e as Error).message}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, to: me.email });
}
