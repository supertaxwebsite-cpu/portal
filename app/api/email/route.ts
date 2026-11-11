import { NextResponse } from "next/server";
import { currentProfile } from "@/lib/auth";
import { mailConfigured, mailFrom, mailCc } from "@/lib/graphMail";

/** Whether sending from the portal is set up, and which mailbox it sends from. */
export async function GET() {
  const me = await currentProfile();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json({ configured: mailConfigured(), from: mailConfigured() ? mailFrom() : "", cc: mailCc() });
}
