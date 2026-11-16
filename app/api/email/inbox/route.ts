import { NextResponse } from "next/server";
import { currentProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { REF_RE } from "@/lib/signature";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const imapHost = () => (process.env.IMAP_HOST || (process.env.SMTP_HOST || "").replace(/^smtp/i, "imap")).trim();
const ready = () => !!(imapHost() && process.env.SMTP_USER && process.env.SMTP_PASS);
const MIN_GAP_MS = 50 * 1000;

/** Strip the quoted earlier message from a reply, so only the client's new text shows. */
function newPart(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const cut = lines.findIndex((l) => /^\s*>/.test(l) || /^On .+wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From:\s.+/i.test(l) || /^-{5,}\s*On /i.test(l));
  return (cut > 0 ? lines.slice(0, cut) : lines).join("\n").trim().slice(0, 20000);
}

/** Checks the team@ mailbox for client replies to portal emails and files them on their jobs.
 *  Any signed-in member's portal calls this every few minutes; it runs at most once every 2 minutes. */
export async function POST() {
  const me = await currentProfile();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!ready()) return NextResponse.json({ off: true });
  const admin = createAdminClient();
  const { data: st, error: stErr } = await admin.from("mail_sync").select("*").eq("id", 1).maybeSingle();
  if (stErr) return NextResponse.json({ off: true, why: "Run database-update-client-email-replies.sql" });
  if (st?.last_run && Date.now() - Date.parse(st.last_run) < MIN_GAP_MS) return NextResponse.json({ skipped: true });
  // Claim this run first so two tabs don't both check.
  await admin.from("mail_sync").upsert({ id: 1, last_run: new Date().toISOString(), uidvalidity: st?.uidvalidity ?? null, last_uid: st?.last_uid ?? null });

  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = new ImapFlow({ host: imapHost(), port: Number(process.env.IMAP_PORT || 993), secure: true,
    auth: { user: process.env.SMTP_USER!.trim(), pass: process.env.SMTP_PASS!.trim() }, logger: false, socketTimeout: 30000 });
  let filed = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const box = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox : null;
      const validity = box ? Number(box.uidValidity) : null;
      let from = st?.last_uid && st?.uidvalidity === validity ? Number(st.last_uid) + 1 : null;
      if (from === null) {
        // First run (or the mailbox was rebuilt): start from the last 3 days.
        const since = new Date(Date.now() - 3 * 864e5);
        const uids = (await client.search({ since }, { uid: true })) || [];
        from = uids.length ? Math.min(...uids) : (box ? Number(box.uidNext) : 1);
      }
      let maxUid = (st?.last_uid && st?.uidvalidity === validity ? Number(st.last_uid) : 0);
      for await (const msg of client.fetch(`${from}:*`, { uid: true, source: true }, { uid: true })) {
        if (msg.uid < from) continue;
        maxUid = Math.max(maxUid, msg.uid);
        if (!msg.source) continue;
        const mail = await simpleParser(msg.source);
        const fromAddr = (mail.from?.value?.[0]?.address || "").toLowerCase();
        if (!fromAddr || fromAddr === (process.env.SMTP_USER || "").trim().toLowerCase()) continue;
        const refs = [mail.inReplyTo, ...(Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [])].filter(Boolean) as string[];
        let jobId: string | null = null;
        if (refs.length) {
          const { data } = await admin.from("job_emails").select("job_id").in("message_id", refs).limit(1);
          jobId = data?.[0]?.job_id ?? null;
        }
        const m = (mail.subject || "").match(REF_RE);
        if (!jobId && m) {
          const hex = m[1].toLowerCase();
          const { data } = await admin.from("jobs").select("id").gte("id", `${hex}-0000-0000-0000-000000000000`).lte("id", `${hex}-ffff-ffff-ffff-ffffffffffff`).limit(1);
          jobId = data?.[0]?.id ?? null;
        }
        if (!jobId) continue;
        const mid = mail.messageId || `<uid-${validity}-${msg.uid}@inbox>`;
        const { data: dup } = await admin.from("job_emails").select("id").eq("message_id", mid).limit(1);
        if (dup?.length) continue;
        // Attachments the client sent go into the job's files.
        const saved: string[] = [];
        for (const at of mail.attachments || []) {
          if (at.related || !at.content || at.size > 20 * 1024 * 1024) continue;
          const name = (at.filename || "attachment").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
          const path = `${jobId}/${crypto.randomUUID()}-${name}`;
          const up = await admin.storage.from("job-files").upload(path, at.content, { contentType: at.contentType || "application/octet-stream", upsert: false });
          if (up.error) continue;
          const fr = await admin.from("job_files").insert({ job_id: jobId, path, name, size: at.size, mime: at.contentType || "", kind: "document", uploaded_by: null });
          if (!fr.error) saved.push(name);
        }
        const body = newPart(mail.text || (typeof mail.html === "string" ? mail.html.replace(/<[^>]+>/g, " ") : ""));
        await admin.from("job_emails").insert({ job_id: jobId, sent_by: null, direction: "in", from_addr: fromAddr, to_addr: [], cc_addr: [],
          subject: (mail.subject || "").slice(0, 250), body, files: saved, message_id: mid, created_at: (mail.date ?? new Date()).toISOString() });
        await admin.from("job_activity").insert({ job_id: jobId, actor_id: null, kind: "comment",
          body: `Client replied by email (${fromAddr}): ${(mail.subject || "").slice(0, 200)}${saved.length ? ` · ${saved.length} file${saved.length === 1 ? "" : "s"} added to Files` : ""}` });
        const { data: job } = await admin.from("jobs").select("id, assignee_id, sign_owner, service, period, client_id").eq("id", jobId).maybeSingle();
        if (job) {
          const { data: c } = await admin.from("clients").select("name").eq("id", job.client_id).maybeSingle();
          const who = [...new Set([job.assignee_id, job.sign_owner].filter(Boolean))] as string[];
          if (!who.length) {
            const { data: ms } = await admin.from("profiles").select("id").eq("role", "master").eq("active", true);
            who.push(...(ms ?? []).map((x) => x.id));
          }
          if (who.length) await admin.from("notifications").insert(who.map((u) => ({ user_id: u, actor_id: null, kind: "client_email", job_id: job.id, service: job.service, body: `${c?.name ?? ""} · ${job.period}` })));
        }
        filed++;
      }
      await admin.from("mail_sync").upsert({ id: 1, last_run: new Date().toISOString(), uidvalidity: validity, last_uid: maxUid || (from ? from - 1 : null) });
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    try { await client.logout(); } catch { /* already closed */ }
    return NextResponse.json({ error: `Couldn't check the mailbox: ${(e as Error).message}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, filed });
}
