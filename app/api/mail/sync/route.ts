import { NextResponse } from "next/server";
import { currentProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { boxes, withImap } from "@/lib/mailboxes";
import { scanBox, scanGraph } from "@/lib/signing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const GAP_MS = 2 * 60 * 1000;

/** Checks the practice mailboxes for Zoho Sign "has been completed" emails and moves the matching jobs to Ready to lodge.
 *  Any signed-in member's portal calls this every minute; each mailbox is checked at most once every 2 minutes. */
export async function POST(req: Request) {
  const me = await currentProfile();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const list = boxes();
  if (!list.length) return NextResponse.json({ off: true });
  const force = new URL(req.url).searchParams.get("now") === "1" && me.role === "master";
  const admin = createAdminClient();
  const { data: st, error } = await admin.from("mail_box_state").select("box, last_run");
  if (error) return NextResponse.json({ off: true, why: "Run database-update-inbox-signing.sql" });
  const last = new Map((st ?? []).map((r) => [r.box as string, r.last_run as string | null]));
  let handled = 0; const errors: string[] = [];
  for (const b of list) {
    const lr = last.get(b.user);
    if (!force && lr && Date.now() - Date.parse(lr) < GAP_MS) continue;
    // Claim this run first so two tabs don't both check.
    await admin.from("mail_box_state").upsert({ box: b.user, last_run: new Date().toISOString() }, { onConflict: "box", ignoreDuplicates: false });
    try { handled += b.kind === "graph" ? await scanGraph(admin, b) : await withImap(b, (c) => scanBox(admin, b, c)); } catch (e) { errors.push((e as Error).message); }
  }
  return NextResponse.json({ ok: true, handled, errors });
}
