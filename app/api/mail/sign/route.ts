import { NextResponse } from "next/server";
import { currentProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { boxes, withImap } from "@/lib/mailboxes";
import { markSignedFromZoho } from "@/lib/signing";
import { SIGNED_MARK } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Master admins fix what the signing automation did: move an email's job by hand, undo a move, or ignore an email. */
export async function POST(req: Request) {
  const me = await currentProfile();
  if (!me || me.role !== "master") return NextResponse.json({ error: "Only master admins can do this." }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { a?: string; id?: string; job?: string };
  const admin = createAdminClient();
  const { data: log } = await admin.from("sign_log").select("*").eq("id", body.id ?? "").maybeSingle();
  if (!log) return NextResponse.json({ error: "That signing email couldn't be found." }, { status: 404 });

  if (body.a === "undo") {
    if (log.result !== "moved" || !log.job_id) return NextResponse.json({ error: "There's nothing to undo." }, { status: 400 });
    const { data: job } = await admin.from("jobs").select("status, sign_reminded_at").eq("id", log.job_id).maybeSingle();
    if (!job || job.status !== "sent_for_sign" || job.sign_reminded_at !== SIGNED_MARK) return NextResponse.json({ error: "The job has moved on since (for example it was lodged), so it can't be undone here." }, { status: 409 });
    await admin.from("jobs").update({ sign_reminded_at: log.prev_reminded_at }).eq("id", log.job_id);
    await admin.from("job_activity").insert({ job_id: log.job_id, actor_id: me.id, kind: "comment", body: `Undone: back to Sent for signing (the Zoho Sign email ${log.doc_name} wasn't for this job)` });
    await admin.from("sign_log").update({ result: "undone", handled_by: me.id, note: "Undone" }).eq("id", log.id);
    return NextResponse.json({ ok: true });
  }
  if (body.a === "ignore") {
    await admin.from("sign_log").update({ result: "skipped", handled_by: me.id, note: "Ignored" }).eq("id", log.id);
    return NextResponse.json({ ok: true });
  }
  if (body.a === "move") {
    if (!body.job) return NextResponse.json({ error: "Choose the job." }, { status: 400 });
    if (log.result === "moved") return NextResponse.json({ error: "This email already moved a job. Undo it first." }, { status: 409 });
    // The signed PDF from the email, if the mailbox can still be read.
    const b = boxes().find((x) => x.user === log.box);
    let files: { filename?: string; contentType?: string; content: Buffer; size: number }[] = [];
    if (b) {
      try {
        const { simpleParser } = await import("mailparser");
        files = await withImap(b, async (c) => {
          const lock = await c.getMailboxLock("INBOX");
          try {
            const mb = c.mailbox && typeof c.mailbox !== "boolean" ? c.mailbox : null;
            if (mb && Number(mb.uidValidity) !== Number(log.uidvalidity)) return [];
            const m = await c.fetchOne(String(log.uid), { uid: true, source: true }, { uid: true });
            return m && m.source ? (await simpleParser(m.source)).attachments : [];
          } finally { lock.release(); }
        });
      } catch { files = []; }
    }
    const r = await markSignedFromZoho(admin, body.job, log.doc_name, files, me.id);
    if (!r.ok) return NextResponse.json({ error: r.note }, { status: 409 });
    await admin.from("sign_log").update({ result: "moved", job_id: body.job, prev_reminded_at: r.prev, handled_by: me.id, note: r.note || "Moved by hand" }).eq("id", log.id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown request." }, { status: 400 });
}
