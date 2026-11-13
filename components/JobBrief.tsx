"use client";
import { useCallback, useEffect, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Job, Person } from "@/lib/types";
import { svcLabel, ST, fmtDate, daysFrom } from "@/lib/domain";
import { checklistFor, STEPS } from "@/lib/checklists";
import type { JobFile } from "./JobFiles";

type SB = ReturnType<typeof createClient>;
interface Query { id: string; job_id: string; parent_id: string | null; author_id: string | null; to_id: string | null; body: string; file_id: string | null; answered_at: string | null; created_at: string }
interface Check { item: string; done_by: string | null; done_at: string }
const when = (s: string) => (s && !isNaN(Date.parse(s)) ? new Date(s) : new Date()).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const MAX = 25 * 1024 * 1024;
const safe = (name: string) => name.normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-120) || "file";

/** The job at a glance (for team members, instead of the edit form), its checklist,
 *  and internal queries: question on the left, the manager's reply beside it. */
export default function JobBrief({ job, clientName, showInfo, meId, canAnswerAll, team, defaultTo, readOnly, supabase, personName, say, onQueries, onNewClient }: {
  job: Job; clientName: string; showInfo: boolean; meId: string; canAnswerAll: boolean; team: Person[]; defaultTo: string | null; readOnly?: boolean;
  supabase: SB; personName: (id: string | null) => string; say: (m: string, err?: boolean) => void; onQueries?: (open: number) => void; onNewClient?: () => void;
}) {
  const [qs, setQs] = useState<Query[] | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [files, setFiles] = useState<Record<string, JobFile>>({});
  const [missing, setMissing] = useState(false);
  const [ask, setAsk] = useState({ to: defaultTo ?? "", body: "" });
  const [askFile, setAskFile] = useState<File | null>(null);
  const [reply, setReply] = useState<Record<string, string>>({});
  const [replyFile, setReplyFile] = useState<Record<string, File | null>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [q, c, f] = await Promise.all([
      supabase.from("job_queries").select("*").eq("job_id", job.id).order("created_at"),
      supabase.from("job_checks").select("item, done_by, done_at").eq("job_id", job.id),
      supabase.from("job_files").select("*").eq("job_id", job.id),
    ]);
    if (q.error) { setMissing(true); setQs([]); return; }
    const list = q.data as Query[];
    setQs(list); setChecks((c.data as Check[] | null) ?? []);
    setFiles(Object.fromEntries(((f.data as JobFile[] | null) ?? []).map((x) => [x.id, x])));
    onQueries?.(list.filter((x) => !x.parent_id && !x.answered_at && !list.some((r) => r.parent_id === x.id)).length);
  }, [supabase, job.id, onQueries]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`job-brief-${job.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "job_queries", filter: `job_id=eq.${job.id}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "job_checks", filter: `job_id=eq.${job.id}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, job.id, load]);

  async function upload(f: File): Promise<string | null | false> {
    if (f.size > MAX) { say(`${f.name} is over 25 MB`, true); return false; }
    const path = `${job.id}/${crypto.randomUUID()}-${safe(f.name)}`;
    const up = await supabase.storage.from("job-files").upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
    if (up.error) { say(`${f.name} wasn't uploaded: ${up.error.message}`, true); return false; }
    const { data, error } = await supabase.from("job_files").insert({ job_id: job.id, path, name: f.name.slice(0, 255), size: f.size, mime: f.type, kind: "query_sheet", uploaded_by: meId }).select("id").single();
    if (error) { await supabase.storage.from("job-files").remove([path]); say(`${f.name} wasn't saved: ${error.message}`, true); return false; }
    return (data as { id: string }).id;
  }
  async function post(row: { body: string; to_id?: string | null; parent_id?: string }, file: File | null) {
    if (!row.body.trim()) { say("Type your message first.", true); return false; }
    setBusy(true);
    const fileId = file ? await upload(file) : null;
    if (fileId === false) { setBusy(false); return false; }
    const { error } = await supabase.from("job_queries").insert({ job_id: job.id, author_id: meId, ...row, body: row.body.trim(), file_id: fileId });
    setBusy(false);
    if (error) { say(`Not sent: ${error.message}`, true); return false; }
    await load(); return true;
  }
  async function toggle(item: string, on: boolean) {
    const { error } = on
      ? await supabase.from("job_checks").delete().eq("job_id", job.id).eq("item", item)
      : await supabase.from("job_checks").insert({ job_id: job.id, item, done_by: meId });
    if (error) { say(`Not saved: ${error.message}`, true); return; }
    load();
  }
  async function openFile(id: string | null) {
    const f = id ? files[id] : undefined;
    if (!f) { say("That file has been deleted.", true); return; }
    const { data } = await supabase.storage.from("job-files").createSignedUrl(f.path, 120);
    if (data) window.open(data.signedUrl, "_blank", "noopener");
  }
  const fileChip = (id: string | null) => id ? <button type="button" className="link qfile" onClick={() => openFile(id)}>📎 {files[id]?.name ?? "Attachment"}</button> : null;
  const pickFile = (onPick: (f: File | null) => void, f: File | null, id: string) => <>
    <input id={id} type="file" hidden onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
    <button type="button" onClick={() => (document.getElementById(id) as HTMLInputElement | null)?.click()}>{f ? `📎 ${f.name}` : "Attach query sheet"}</button>
    {f ? <button type="button" className="link" onClick={() => onPick(null)}>Remove</button> : null}</>;

  const items = checklistFor(job.service);
  const done = new Map(checks.map((c) => [c.item, c]));
  const questions = (qs ?? []).filter((q) => !q.parent_id);
  const replies = (qs ?? []).filter((q) => q.parent_id);
  const d = job.due_date ? daysFrom(job.due_date) : null;

  return (
    <div className="jobbrief" onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault(); }}>
      {showInfo ? <div className="briefline">
        <strong>{clientName}</strong><span>{svcLabel(job.service)} {job.period}</span>
        <span className={d !== null && d < 0 ? "danger" : ""}>Due {job.due_date ? fmtDate(job.due_date) : "not set"}{d !== null && d < 0 ? ` (${-d} days overdue)` : ""}</span>
        {job.priority === "high" ? <span className="pill danger">High priority</span> : null}
        <span className={`pill ${ST[job.status]?.cls ?? ""}`}>{ST[job.status]?.label ?? job.status}</span>
        <span className="note">Assigned {personName(job.assignee_id) || "nobody"} · Reviewer {personName(job.reviewer_id ?? null) || "none"}{job.needs_signature === false ? " · No client signature needed" : ""}</span>
      </div> : null}
      {showInfo && job.notes?.trim() ? <div className="briefnotes"><span className="lbl2">Notes from your manager</span><div>{job.notes}</div></div> : null}

      {STEPS[job.service] ? (() => {
        const steps = STEPS[job.service];
        const nowIdx = steps.findIndex((s) => s.items.some((i) => !done.has(i)));
        const allDone = items.filter((i) => done.has(i)).length;
        return <section className="briefsec">
          <h3>Steps <span className="note">{allDone} of {items.length} done</span></h3>
          <div className="stepbar"><i style={{ width: `${(allDone / Math.max(1, items.length)) * 100}%` }} /></div>
          <ol className="steps">{steps.map((s, n) => { const d = s.items.filter((i) => done.has(i)).length; const state = d === s.items.length ? "done" : n === nowIdx ? "now" : "";
            return (
              <li key={s.title} className={state}>
                <div className="stephead"><span className="dot">{state === "done" ? "✓" : n + 1}</span><strong>{s.title}</strong><span className="note">{d} of {s.items.length}</span></div>
                {state !== "done" || n === steps.length - 1 ? <ul className="checklist">{s.items.map((i) => { const c = done.get(i); return (
                  <li key={i}><label className={c ? "done" : ""}><input type="checkbox" checked={!!c} disabled={readOnly || missing} onChange={() => toggle(i, !!c)} /> {i}</label>
                    {c ? <span className="note">{personName(c.done_by) || "someone"} · {when(c.done_at)}</span> : null}</li>); })}</ul> : null}
                {n === steps.length - 1 && job.service === "company_formation" && onNewClient && !readOnly ? <button type="button" className="primary" style={{ marginTop: 8 }} onClick={onNewClient}>Create the new company as a client</button> : null}
              </li>); })}</ol>
        </section>;
      })() : items.length ? <section className="briefsec">
        <h3>Checklist <span className="note">{items.filter((i) => done.has(i)).length} of {items.length} done</span></h3>
        <ul className="checklist">{items.map((i) => { const c = done.get(i); return (
          <li key={i}><label className={c ? "done" : ""}><input type="checkbox" checked={!!c} disabled={readOnly || missing} onChange={() => toggle(i, !!c)} /> {i}</label>
            {c ? <span className="note">{personName(c.done_by) || "someone"} · {when(c.done_at)}</span> : null}</li>); })}</ul>
      </section> : null}

      <section className="briefsec">
        <h3>Internal queries{questions.length ? ` (${questions.length})` : ""}</h3>
        {missing ? <p className="note">Run the database update for job queries in Supabase to switch these on.</p> : <>
          {questions.length ? <ul className="qthread">{questions.map((q) => {
            const rs = replies.filter((r) => r.parent_id === q.id);
            const mine = q.to_id === meId || canAnswerAll || (!q.to_id && q.author_id !== meId);
            return (
              <li key={q.id}>
                <div className="qcol ask"><div className="qhead"><span className="pill danger">Query</span> {personName(q.author_id) || "Someone"}{q.to_id ? ` → ${personName(q.to_id)}` : ""} · {when(q.created_at)}</div>
                  <div className="qbody">{q.body}</div>{fileChip(q.file_id)}</div>
                <div className="qcol ans">{rs.length ? rs.map((r) => (
                  <div key={r.id}><div className="qhead"><span className="pill ok">Response</span> {personName(r.author_id) || "Someone"} · {when(r.created_at)}</div>
                    <div className="qbody">{r.body}</div>{fileChip(r.file_id)}</div>))
                  : mine && !readOnly ? <div className="qreply">
                    <textarea aria-label="Your response" placeholder="Type the response…" value={reply[q.id] ?? ""} onChange={(e) => setReply({ ...reply, [q.id]: e.target.value })} />
                    <div className="row">{pickFile((f) => setReplyFile({ ...replyFile, [q.id]: f }), replyFile[q.id] ?? null, `qr-file-${q.id}`)}<span style={{ flex: 1 }} />
                      <button type="button" className="primary" disabled={busy || !(reply[q.id] ?? "").trim()} onClick={async () => { if (await post({ body: reply[q.id] ?? "", parent_id: q.id }, replyFile[q.id] ?? null)) { setReply({ ...reply, [q.id]: "" }); setReplyFile({ ...replyFile, [q.id]: null }); say("Response sent"); } }}>Send response</button></div>
                  </div> : <div className="note qwait">Waiting for {personName(q.to_id) || "a manager"} to respond.</div>}</div>
              </li>); })}</ul> : <p className="note" style={{ margin: "0 0 10px" }}>No queries on this job yet.</p>}
          {!readOnly ? <div className="qnew">
            <div className="row" style={{ gap: 8 }}><label className="f" style={{ minWidth: 220 }}>Ask<select id="q-ask-to" value={ask.to} onChange={(e) => setAsk({ ...ask, to: e.target.value })}>
              <option value="">Choose who answers…</option>{team.filter((p) => p.id !== meId).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label></div>
            <textarea id="q-ask-body" placeholder="What's the query? e.g. Client has fuel receipts without tax invoices, can we claim the GST?" value={ask.body} onChange={(e) => setAsk({ ...ask, body: e.target.value })} />
            <div className="row">{pickFile(setAskFile, askFile, "q-ask-file")}<span style={{ flex: 1 }} />
              <button type="button" className="primary" disabled={busy || !ask.body.trim() || !ask.to} onClick={async () => { if (await post({ body: ask.body, to_id: ask.to }, askFile)) { setAsk({ ...ask, body: "" }); setAskFile(null); say(`Query sent to ${personName(ask.to)}`); } }}>Send query</button></div>
            <span className="note">{showInfo ? "The job stays with you. " : ""}{ask.to ? `${personName(ask.to)} gets a notification and answers here.` : "They get a notification and answer here."}</span>
          </div> : null}
        </>}
      </section>
    </div>
  );
}
