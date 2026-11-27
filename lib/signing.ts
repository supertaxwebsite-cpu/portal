import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImapFlow } from "imapflow";
import { SIGNED_MARK, svcLabel, STATUSES } from "@/lib/domain";

const statusLabel = (id: string) => STATUSES.find((x) => x.id === id)?.label ?? id;
/** The stage a moved job was at, read back from its note ("Was at In progress · …"). */
export const prevStatusFrom = (note: string) => STATUSES.find((x) => note.startsWith(`Was at ${x.label}`))?.id ?? "sent_for_sign";
import { completedDoc, parseDoc, candidates, norm, type MatchJob, type MatchClient } from "@/lib/signParse";
import type { Box } from "@/lib/mailboxes";
import { pages, mimeOf, uidOf } from "@/lib/graph";

type Admin = SupabaseClient;
interface Att { filename?: string; contentType?: string; content: Buffer; size: number; related?: boolean }

/** Client signed: the job stays "Sent for signing" but is marked signed, which is what Ready to lodge means.
 *  Saves the signed PDFs to the job's Files and tells the person doing the signing. */
export async function markSignedFromZoho(admin: Admin, jobId: string, doc: string, files: Att[], by: string | null): Promise<{ ok: boolean; prev: string | null; note: string }> {
  const { data: job } = await admin.from("jobs").select("id, client_id, service, period, status, sign_reminded_at, sign_owner, reviewer_id, assignee_id").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, prev: null, note: "The job no longer exists" };
  if (job.status === "lodged" || job.status === "done") return { ok: false, prev: null, note: `The job is already ${statusLabel(job.status).toLowerCase()}` };
  if (job.status === "sent_for_sign" && job.sign_reminded_at === SIGNED_MARK) return { ok: false, prev: null, note: "The job is already Ready to lodge" };
  const prev = job.sign_reminded_at as string | null;
  // From any stage: Ready to lodge is "Sent for sign" marked signed.
  // Two steps: moving a job into "Sent for sign" clears the signed mark (a database rule), so the mark goes on after.
  if (job.status !== "sent_for_sign") {
    const st = await admin.from("jobs").update({ status: "sent_for_sign" }).eq("id", jobId).eq("status", job.status);
    if (st.error) return { ok: false, prev: null, note: st.error.message };
  }
  const up = await admin.from("jobs").update({ sign_reminded_at: SIGNED_MARK }).eq("id", jobId).eq("status", "sent_for_sign");
  if (up.error) return { ok: false, prev: null, note: up.error.message };
  const saved: string[] = [];
  // Only the signed document and Zoho's completion certificate (both carry the document name), not other PDFs such as an invoice.
  const isPdf = (f: Att) => /pdf/i.test(f.contentType ?? "") || /\.pdf$/i.test(f.filename ?? "");
  const named = files.filter((f) => isPdf(f) && norm(f.filename ?? "").includes(norm(doc)));
  for (const f of named.length ? named : files) {
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
  // The stage it was at goes in the note, so Undo can put it back.
  return { ok: true, prev, note: [job.status !== "sent_for_sign" ? `Was at ${statusLabel(job.status)}` : "", saved.length ? "Signed PDF saved in Files" : ""].filter(Boolean).join(" · ") };
}

/** Every row, past the database's 1000-rows-per-request limit. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function all<T>(admin: Admin, table: string, cols: string, f: (q: any) => any = (q) => q): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await f(admin.from(table).select(cols)).order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

interface Ctx { jobs: MatchJob[] | null; clients: MatchClient[] | null }

/** One email: if it's a Zoho Sign completion not seen before, match it to a job and log what was done. */
async function handleOne(admin: Admin, b: Box, ctx: Ctx, validity: number, uid: number, from: string, subject: string, date: string | Date, atts: () => Promise<Att[]>): Promise<boolean> {
  const doc = completedDoc(from, subject);
  if (!doc) return false;
  // Once per email: skip it if this check already logged it, or if any earlier check moved a job for it (or someone handled it).
  const { data: seen } = await admin.from("sign_log").select("uidvalidity, result, handled_by").eq("box", b.user).eq("uid", uid);
  if ((seen ?? []).some((r) => Number(r.uidvalidity) === validity || r.result === "moved" || r.result === "undone" || r.handled_by)) return false;
  if (!ctx.jobs) {
    ctx.jobs = await all<MatchJob>(admin, "jobs", "id, client_id, service, period, status, sign_reminded_at", (q) => q.not("status", "in", "(lodged,done)"));
    ctx.clients = await all<MatchClient>(admin, "clients", "id, name");
  }
  const { open, done } = candidates(parseDoc(doc), ctx.clients!, ctx.jobs, SIGNED_MARK);
  const row = { box: b.user, uidvalidity: validity, uid, subject: subject.slice(0, 300), doc_name: doc, received_at: new Date(date).toISOString() };
  if (open.length === 1) {
    const r = await markSignedFromZoho(admin, open[0].id, doc, await atts().catch(() => []), null);
    await admin.from("sign_log").insert({ ...row, result: r.ok ? "moved" : "needs", job_id: open[0].id, candidates: [open[0].id], prev_reminded_at: r.prev, note: r.note });
  } else if (open.length > 1) {
    await admin.from("sign_log").insert({ ...row, result: "needs", candidates: open.map((j) => j.id), note: `${open.length} jobs out for signing could be this document` });
  } else if (done.length) {
    await admin.from("sign_log").insert({ ...row, result: "skipped", job_id: done[0].id, note: done[0].sign_reminded_at === SIGNED_MARK ? "Already marked signed" : `The job is ${done[0].status.replace(/_/g, " ")}, not out for signing` });
  } else {
    await admin.from("sign_log").insert({ ...row, result: "none", note: "No job out for signing matches this document name" });
  }
  return true;
}

/** Looks through new emails in one IMAP mailbox for Zoho Sign completions and handles each once. */
export async function scanBox(admin: Admin, b: Box, c: ImapFlow): Promise<number> {
  const { simpleParser } = await import("mailparser");
  const { data: st } = await admin.from("mail_box_state").select("*").eq("box", b.user).maybeSingle();
  const lock = await c.getMailboxLock("INBOX");
  let handled = 0;
  const ctx: Ctx = { jobs: null, clients: null };
  try {
    const mb = c.mailbox && typeof c.mailbox !== "boolean" ? c.mailbox : null;
    const validity = mb ? Number(mb.uidValidity) : 0;
    const top = mb ? Number(mb.uidNext) - 1 : 0;
    const known = st && Number(st.uidvalidity) === validity && st.last_uid != null;
    const uids: number[] = known
      ? (((await c.search({ uid: `${Number(st!.last_uid) + 1}:*`, from: "zoho" }, { uid: true })) || []) as number[]).filter((u) => u > Number(st!.last_uid))
      : (((await c.search({ since: new Date(Date.now() - 14 * 864e5), from: "zoho" }, { uid: true })) || []) as number[]);
    for (const uid of uids.sort((x, y) => x - y)) {
      const m = await c.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
      if (!m || !m.envelope) continue;
      const from = `${m.envelope.from?.[0]?.name ?? ""} <${m.envelope.from?.[0]?.address ?? ""}>`;
      if (await handleOne(admin, b, ctx, validity, uid, from, m.envelope.subject ?? "", m.envelope.date ?? new Date(), async () => {
        const full = await c.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        return full && full.source ? ((await simpleParser(full.source)).attachments as Att[]) : [];
      })) handled++;
    }
    await admin.from("mail_box_state").upsert({ box: b.user, uidvalidity: validity, last_uid: Math.max(top, known ? Number(st!.last_uid) : 0), last_run: new Date().toISOString() });
  } finally { lock.release(); }
  return handled;
}

/** The same for a Microsoft 365 mailbox, in every folder (Outlook rules often move Zoho emails out of the Inbox). Its place is kept as the uid (arrival time) of the newest email seen. */
export async function scanGraph(admin: Admin, b: Box): Promise<number> {
  const { simpleParser } = await import("mailparser");
  const { data: st } = await admin.from("mail_box_state").select("*").eq("box", b.user).maybeSingle();
  const known = st && Number(st.uidvalidity) === GRAPH_VALIDITY && st.last_uid != null;
  // From the second of the last email seen (emails already handled are skipped), or the last 14 days the first time.
  const since = new Date(known ? Math.floor(Number(st!.last_uid) / 1000) * 1000 : Date.now() - 14 * 864e5).toISOString();
  const list = await pages(b.user, `/messages?$select=id,subject,from,receivedDateTime&$top=100&$orderby=receivedDateTime%20asc&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`, 2000);
  const ctx: Ctx = { jobs: null, clients: null };
  let handled = 0, top = known ? Number(st!.last_uid) : 0;
  const started = Date.now();
  for (const m of list) {
    // Stop in time to save the place; the next check carries on from here.
    if (Date.now() - started > 40_000) break;
    const uid = uidOf(m.receivedDateTime, m.id);
    top = Math.max(top, uid);
    const f = m.from?.emailAddress;
    if (await handleOne(admin, b, ctx, GRAPH_VALIDITY, uid, `${f?.name ?? ""} <${f?.address ?? ""}>`, m.subject ?? "", m.receivedDateTime,
      async () => (await simpleParser(await mimeOf(b.user, m.id))).attachments as Att[])) handled++;
  }
  await admin.from("mail_box_state").upsert({ box: b.user, uidvalidity: GRAPH_VALIDITY, last_uid: top || null, last_run: new Date().toISOString() });
  return handled;
}
// Raised when the matching rules change, so the next check looks back 14 days again (3: any stage moves).
export const GRAPH_VALIDITY = 3;
