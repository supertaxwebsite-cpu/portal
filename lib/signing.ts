import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImapFlow } from "imapflow";
import { SIGNED_MARK, svcLabel } from "@/lib/domain";
import { completedDoc, parseDoc, candidates, type MatchJob, type MatchClient } from "@/lib/signParse";
import type { Box } from "@/lib/mailboxes";

type Admin = SupabaseClient;
interface Att { filename?: string; contentType?: string; content: Buffer; size: number; related?: boolean }

/** Client signed: the job stays "Sent for signing" but is marked signed, which is what Ready to lodge means.
 *  Saves the signed PDFs to the job's Files and tells the person doing the signing. */
export async function markSignedFromZoho(admin: Admin, jobId: string, doc: string, files: Att[], by: string | null): Promise<{ ok: boolean; prev: string | null; note: string }> {
  const { data: job } = await admin.from("jobs").select("id, client_id, service, period, status, sign_reminded_at, sign_owner, reviewer_id, assignee_id").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, prev: null, note: "The job no longer exists" };
  if (job.status !== "sent_for_sign" || job.sign_reminded_at === SIGNED_MARK) return { ok: false, prev: null, note: "The job isn't waiting for a signature any more" };
  const prev = job.sign_reminded_at as string | null;
  const up = await admin.from("jobs").update({ sign_reminded_at: SIGNED_MARK }).eq("id", jobId).eq("status", "sent_for_sign");
  if (up.error) return { ok: false, prev: null, note: up.error.message };
  const saved: string[] = [];
  for (const f of files) {
    if (f.related || !f.content || f.size > 25 * 1024 * 1024 || !/pdf/i.test(f.contentType ?? "") && !/\.pdf$/i.test(f.filename ?? "")) continue;
    const name = `Signed – ${(f.filename || `${doc}.pdf`).replace(/[^\w.\- ]+/g, "_")}`.slice(0, 200);
    const path = `${jobId}/${crypto.randomUUID()}-${name.replace(/[^\w.\-]+/g, "_")}`;
    const r = await admin.storage.from("job-files").upload(path, f.content, { contentType: "application/pdf", upsert: false });
    if (r.error) continue;
    const fr = await admin.from("job_files").insert({ job_id: jobId, path, name, size: f.size, mime: "application/pdf", kind: "document", uploaded_by: by });
    if (fr.error) await admin.storage.from("job-files").remove([path]); else saved.push(name);
  }
  await admin.from("job_activity").insert({ job_id: jobId, actor_id: by, kind: "comment",
    body: `Client signed in Zoho Sign (${doc}). Moved to Ready to lodge ${by ? "from the Inbox" : "automatically"}${saved.length ? ` · signed PDF saved in Files` : ""}` });
  const { data: c } = await admin.from("clients").select("name").eq("id", job.client_id).maybeSingle();
  const who = (job.sign_owner ?? job.reviewer_id ?? job.assignee_id) as string | null;
  if (who && who !== by) await admin.from("notifications").insert({ user_id: who, actor_id: by, kind: "client_email", job_id: jobId, service: job.service,
    body: `Signed in Zoho Sign: ${c?.name ?? ""} · ${svcLabel(job.service)} ${job.period}. Ready to lodge` });
  return { ok: true, prev, note: saved.length ? "Signed PDF saved in Files" : "" };
}

/** Looks through new emails in one mailbox for Zoho Sign completions and handles each once. */
export async function scanBox(admin: Admin, b: Box, c: ImapFlow): Promise<number> {
  const { simpleParser } = await import("mailparser");
  const { data: st } = await admin.from("mail_box_state").select("*").eq("box", b.user).maybeSingle();
  const lock = await c.getMailboxLock("INBOX");
  let handled = 0;
  try {
    const mb = c.mailbox && typeof c.mailbox !== "boolean" ? c.mailbox : null;
    const validity = mb ? Number(mb.uidValidity) : 0;
    const top = mb ? Number(mb.uidNext) - 1 : 0;
    const known = st && Number(st.uidvalidity) === validity && st.last_uid != null;
    const uids: number[] = known
      ? (((await c.search({ uid: `${Number(st!.last_uid) + 1}:*`, from: "zoho" }, { uid: true })) || []) as number[]).filter((u) => u > Number(st!.last_uid))
      : (((await c.search({ since: new Date(Date.now() - 14 * 864e5), from: "zoho" }, { uid: true })) || []) as number[]);
    let jobs: MatchJob[] | null = null, clients: MatchClient[] | null = null;
    for (const uid of uids.sort((x, y) => x - y)) {
      const m = await c.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
      if (!m || !m.envelope) continue;
      const from = `${m.envelope.from?.[0]?.name ?? ""} <${m.envelope.from?.[0]?.address ?? ""}>`;
      const doc = completedDoc(from, m.envelope.subject ?? "");
      if (!doc) continue;
      const { data: seen } = await admin.from("sign_log").select("id").eq("box", b.user).eq("uidvalidity", validity).eq("uid", uid).limit(1);
      if (seen?.length) continue;
      if (!jobs) {
        jobs = ((await admin.from("jobs").select("id, client_id, service, period, status, sign_reminded_at").neq("status", "not_started")).data ?? []) as MatchJob[];
        clients = ((await admin.from("clients").select("id, name")).data ?? []) as MatchClient[];
      }
      const parts = parseDoc(doc);
      const { open, done } = candidates(parts, clients!, jobs, SIGNED_MARK);
      const row = { box: b.user, uidvalidity: validity, uid, subject: (m.envelope.subject ?? "").slice(0, 300), doc_name: doc, received_at: new Date(m.envelope.date ?? Date.now()).toISOString() };
      if (open.length === 1) {
        const full = await c.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        const mail = full && full.source ? await simpleParser(full.source) : null;
        const r = await markSignedFromZoho(admin, open[0].id, doc, (mail?.attachments ?? []) as Att[], null);
        await admin.from("sign_log").insert({ ...row, result: r.ok ? "moved" : "needs", job_id: open[0].id, candidates: [open[0].id], prev_reminded_at: r.prev, note: r.ok ? r.note : r.note });
      } else if (open.length > 1) {
        await admin.from("sign_log").insert({ ...row, result: "needs", candidates: open.map((j) => j.id), note: `${open.length} jobs out for signing could be this document` });
      } else if (done.length) {
        await admin.from("sign_log").insert({ ...row, result: "skipped", job_id: done[0].id, note: done[0].sign_reminded_at === SIGNED_MARK ? "Already marked signed" : `The job is ${done[0].status.replace(/_/g, " ")}, not out for signing` });
      } else {
        await admin.from("sign_log").insert({ ...row, result: "none", note: "No job out for signing matches this document name" });
      }
      handled++;
    }
    await admin.from("mail_box_state").upsert({ box: b.user, uidvalidity: validity, last_uid: Math.max(top, known ? Number(st!.last_uid) : 0), last_run: new Date().toISOString() });
  } finally { lock.release(); }
  return handled;
}
