import { NextResponse } from "next/server";
import { currentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { mailCc, mailConfigured, mailFrom, sendMail, type MailFile } from "@/lib/graphMail";
import { jobRef, REF_RE, signatureFile, signatureHtml } from "@/lib/signature";

export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const list = (v: unknown) => [...new Set(String(v ?? "").split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Send an email about a job (e.g. a query to the client), with the job's files attached. */
export async function POST(req: Request, { params }: Ctx) {
  const me = await currentProfile();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!mailConfigured()) return NextResponse.json({ error: "Email isn't set up yet. Ask the master admin to add the email settings in Vercel." }, { status: 503 });
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const to = list(b.to);
  // info@ is always copied in, whatever the form sends.
  const cc = [...new Set([...list(b.cc), ...list(mailCc())])].filter((a) => !to.includes(a));
  const subject = String(b.subject ?? "").trim().slice(0, 250);
  const text = String(b.body ?? "").slice(0, 20000);
  const fileIds: string[] = Array.isArray(b.fileIds) ? b.fileIds.map(String).slice(0, 20) : [];
  if (!to.length) return NextResponse.json({ error: "Enter the client's email address." }, { status: 400 });
  const bad = [...to, ...cc].filter((a) => !EMAIL.test(a));
  if (bad.length) return NextResponse.json({ error: `Check these email addresses: ${bad.join(", ")}` }, { status: 400 });
  if (to.length + cc.length > 15) return NextResponse.json({ error: "Send to at most 15 addresses at a time." }, { status: 400 });
  if (!subject) return NextResponse.json({ error: "Add a subject." }, { status: 400 });
  if (!text.trim()) return NextResponse.json({ error: "Write the message." }, { status: 400 });

  // The caller's own access decides which job and files they can use.
  const sb = await createClient();
  const { data: job } = await sb.from("jobs").select("id, status").eq("id", id).maybeSingle();
  if (!job) return NextResponse.json({ error: "You can't see that job." }, { status: 404 });
  let rows: { id: string; path: string; name: string; mime: string; size: number }[] = [];
  if (fileIds.length) {
    const { data } = await sb.from("job_files").select("id, path, name, mime, size").eq("job_id", id).in("id", fileIds);
    rows = data ?? [];
    if (rows.length !== fileIds.length) return NextResponse.json({ error: "Some of the files are no longer on this job. Refresh and try again." }, { status: 400 });
    const total = rows.reduce((s, r) => s + Number(r.size), 0);
    if (total > 30 * 1024 * 1024) return NextResponse.json({ error: "The attachments add up to more than 30 MB. Send fewer files at once." }, { status: 400 });
  }
  const admin = createAdminClient();
  const files: MailFile[] = [];
  for (const r of rows) {
    const { data, error } = await admin.storage.from("job-files").download(r.path);
    if (error || !data) return NextResponse.json({ error: `Couldn't read ${r.name}.` }, { status: 500 });
    files.push({ name: r.name, type: r.mime, bytes: new Uint8Array(await data.arrayBuffer()) });
  }

  // A reference on the subject and our own Message-ID let a reply find this job again.
  const ref = jobRef(id);
  const fullSubject = REF_RE.test(subject) ? subject : `${subject} [${ref}]`;
  const domain = (mailFrom().split("@")[1] || "supertax.com.au").trim();
  const messageId = `<${crypto.randomUUID()}.${ref.toLowerCase()}@${domain}>`;
  const html = `<div style="font-family:Calibri,Carlito,Arial,sans-serif;font-size:12pt;line-height:1.4;color:#000000">${esc(text).replace(/\r?\n/g, "<br>")}</div>${b.signature === false ? "" : signatureHtml()}`;
  try {
    await sendMail({ to, cc, replyTo: mailFrom(), subject: fullSubject, html, files: b.signature === false ? files : [...files, signatureFile()], messageId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  const row = { job_id: id, sent_by: me.id, to_addr: to, cc_addr: cc, subject: fullSubject, body: text, files: rows.map((r) => r.name) };
  const ins = await admin.from("job_emails").insert({ ...row, message_id: messageId, direction: "out" });
  if (ins.error) await admin.from("job_emails").insert(row); // reply-tracking columns not added yet
  if (b.clientQuery) await admin.from("job_activity").insert({ job_id: id, actor_id: me.id, kind: "comment", body: `Client query: ${text.trim()}`.slice(0, 8000) });
  await admin.from("job_activity").insert({ job_id: id, actor_id: me.id, kind: "comment",
    body: `Emailed ${to.join(", ")}${cc.length ? ` (cc ${cc.join(", ")})` : ""}: ${fullSubject}${rows.length ? ` · ${rows.length} file${rows.length === 1 ? "" : "s"} attached` : ""}` });
  let status = "";
  if (b.markQuery && job.status !== "client_query") {
    const { error } = await sb.from("jobs").update({ status: "client_query" }).eq("id", id);
    status = error ? `Sent, but the status wasn't changed: ${error.message}` : "client_query";
  }
  return NextResponse.json({ ok: true, status });
}
