"use client";
import { useCallback, useEffect, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Client, Job } from "@/lib/types";
import { svcLabel } from "@/lib/domain";
import type { JobFile } from "./JobFiles";

type SB = ReturnType<typeof createClient>;
interface Sent { id: string; sent_by: string | null; to_addr: string[]; cc_addr: string[]; subject: string; body: string; files: string[]; created_at: string }
const when = (s: string) => new Date(s).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? "";

/** Email the client about this job (e.g. a query), from the practice mailbox, with the job's files attached. */
export default function JobEmail({ job, client, meName, readOnly, supabase, personName, say, onSent }: {
  job: Job; client?: Client; meName: string; readOnly?: boolean; supabase: SB;
  personName: (id: string | null) => string; say: (m: string, err?: boolean) => void; onSent: () => void;
}) {
  const [cfg, setCfg] = useState<{ configured: boolean; from: string; cc: string } | null>(null);
  const [files, setFiles] = useState<JobFile[]>([]);
  const [sent, setSent] = useState<Sent[]>([]);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [markQuery, setMarkQuery] = useState(job.status !== "client_query");
  const [busy, setBusy] = useState(false);
  const greet = client?.contact ? firstName(client.contact) : client?.entity === "Individual" ? firstName(client?.name ?? "") : "";
  const what = `${svcLabel(job.service)} ${job.period}`.trim();
  const [v, setV] = useState({
    to: client?.email ?? "",
    cc: "",
    subject: `Query: ${client?.name ?? ""} – ${what}`,
    body: `Hi ${greet ? greet.charAt(0) + greet.slice(1).toLowerCase() : "there"},\n\nWe're working on your ${what} and need the following from you:\n\n1. \n2. \n3. \n\nPlease reply to this email with the information, or let us know if you have any questions.\n\nKind regards,\n${meName}\n${client?.practice || "Supertax"}`,
  });

  const load = useCallback(async () => {
    const [f, e] = await Promise.all([
      supabase.from("job_files").select("*").eq("job_id", job.id).order("created_at", { ascending: false }),
      supabase.from("job_emails").select("*").eq("job_id", job.id).order("created_at", { ascending: false }),
    ]);
    const fl = (f.data as JobFile[] | null) ?? [];
    setFiles(fl); setSent((e.data as Sent[] | null) ?? []);
    // Tick query sheets by default.
    setPick((p) => (p.size ? p : new Set(fl.filter((x) => x.kind === "query_sheet").map((x) => x.id))));
  }, [supabase, job.id]);
  useEffect(() => {
    load();
    fetch("/api/email").then((r) => r.json()).then((d) => { setCfg({ configured: !!d.configured, from: d.from ?? "", cc: d.cc ?? "" }); setV((x) => (x.cc ? x : { ...x, cc: d.cc ?? "" })); }).catch(() => setCfg({ configured: false, from: "", cc: "" }));
  }, [load]);

  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const unfinished = /\n\d\.\s*\n/.test(v.body + "\n");

  // This sits inside the job window's form, so it can't be a form of its own: check the fields here.
  async function send() {
    if (!v.to.trim() || !v.subject.trim() || !v.body.trim()) { say("Fill in To, Subject and Message first.", true); return; }
    if (unfinished && !window.confirm("Some numbered lines in the message are still empty. Send anyway?")) return;
    setBusy(true);
    const r = await fetch(`/api/jobs/${job.id}/email`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...v, fileIds: [...pick], markQuery }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { say(d.error ?? "The email wasn't sent. Try again.", true); return; }
    say(d.status && d.status !== "client_query" ? d.status : `Email sent to ${v.to}${markQuery ? ". Job moved to Query with client" : ""}`);
    load(); onSent();
  }
  function openInEmailApp() {
    const q = new URLSearchParams({ cc: v.cc, subject: v.subject, body: v.body }).toString().replace(/\+/g, "%20");
    window.location.href = `mailto:${encodeURIComponent(v.to).replace(/%40/g, "@").replace(/%2C/g, ",")}?${q}`;
    if (markQuery && job.status !== "client_query") {
      supabase.from("jobs").update({ status: "client_query" }).eq("id", job.id).then(({ error }) => {
        if (error) say(`Status not changed: ${error.message}`, true); else { say("Job moved to Query with client. Send the email from your email app."); onSent(); }
      });
    }
  }
  async function download(f: JobFile) {
    const { data } = await supabase.storage.from("job-files").createSignedUrl(f.path, 120, { download: f.name });
    if (data) window.open(data.signedUrl, "_blank", "noopener");
  }

  return (
    <div className="jobemail" onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault(); }}>
      {cfg && !cfg.configured ? <div className="hint lockednote" style={{ marginBottom: 12 }}>
        Sending straight from the portal isn&apos;t switched on yet. Until it is, <strong>Open in my email app</strong> starts the email in Outlook with everything filled in. Attach the files there yourself; the Download links are below.</div> : null}
      {readOnly ? null : <div className="body" style={{ padding: 0 }}>
        <label className="f full">To<input id="em-to" value={v.to} onChange={set("to")} placeholder="client@example.com (separate several with commas)" /></label>
        <label className="f full">CC<input id="em-cc" value={v.cc} onChange={set("cc")} placeholder="info@supertax.com.au" /></label>
        <label className="f full">Subject<input id="em-subject" value={v.subject} onChange={set("subject")} /></label>
        <label className="f full">Message<textarea id="em-body" rows={11} value={v.body} onChange={set("body")} /></label>
        <div className="f full"><span className="lbl2">Attach files from this job</span>
          {files.length ? <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 4 }}>{files.map((f) => { const on = pick.has(f.id); return (
            <label key={f.id} className={`chip${on ? " on" : ""}`} title={f.name}><input type="checkbox" checked={on} onChange={() => { const n = new Set(pick); if (on) n.delete(f.id); else n.add(f.id); setPick(n); }} /> {f.name}
              {cfg && !cfg.configured ? <button type="button" className="link" onClick={(e) => { e.preventDefault(); download(f); }}>Download</button> : null}</label>); })}</div>
            : <span className="note">No files on this job yet. Add the query sheet in the Files tab first if you want to send it.</span>}</div>
        <label className="full row" style={{ gap: 8 }}><input id="em-mark" type="checkbox" checked={markQuery} onChange={(e) => setMarkQuery(e.target.checked)} /> Move the job to <strong>Query with client</strong> (reminder in 2 days if they don&apos;t reply)</label>
        <div className="full row" style={{ justifyContent: "space-between" }}>
          <span className="note">{cfg?.configured ? <>Sends from <strong>{cfg.from}</strong>. Replies go to that mailbox and a copy is saved in its Sent Items.</> : ""}</span>
          <div className="row">
            <button type="button" onClick={openInEmailApp}>Open in my email app</button>
            {cfg?.configured ? <button type="button" className="primary" disabled={busy} onClick={send}>{busy ? "Sending…" : "Send email"}</button> : null}
          </div>
        </div>
      </div>}
      <h3 style={{ margin: "18px 0 8px", fontSize: 15 }}>Emails sent from the portal ({sent.length})</h3>
      {!sent.length ? <p className="note" style={{ margin: 0 }}>None yet.</p> : <ul className="sentlist">{sent.map((s) => (
        <li key={s.id}><div><strong>{s.subject}</strong> <span className="note">· {when(s.created_at)} by {personName(s.sent_by) || "someone"}</span></div>
          <div className="note">To {s.to_addr.join(", ")}{s.cc_addr.length ? ` · CC ${s.cc_addr.join(", ")}` : ""}{s.files.length ? ` · 📎 ${s.files.join(", ")}` : ""}</div>
          <details><summary className="note">Show message</summary><div style={{ whiteSpace: "pre-wrap", fontSize: 13, marginTop: 6 }}>{s.body}</div></details></li>))}</ul>}
    </div>
  );
}
