"use client";
import { useCallback, useEffect, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Job } from "@/lib/types";

type SB = ReturnType<typeof createClient>;
export interface ReviewNote {
  id: string; job_id: string; author_id: string | null; to_id: string | null; severity: "major" | "minor"; category: string; body: string;
  status: "open" | "fixed" | "cleared"; fix_body: string; fixed_by: string | null; fixed_at: string | null; cleared_by: string | null; cleared_at: string | null; created_at: string;
  file_id?: string | null; fix_file_id?: string | null;
}
export const REVIEW_TYPES = ["GST coding", "Missed income", "Wrong figures", "Process / checklist", "Missing documents", "Other"];
const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const STATUS: Record<ReviewNote["status"], [string, string]> = { open: ["Open: to fix", "danger"], fixed: ["Fixed: ready to check", "warn"], cleared: ["Cleared", "ok"] };

const MAX = 25 * 1024 * 1024;
const safe = (n: string) => n.replace(/[^\w.\-]+/g, "_").slice(-120);
const changed = (jobId: string) => window.dispatchEvent(new Event(`review-notes:${jobId}`));
const MISSING_COL = /file_id|schema cache|column/i;

/** Uploads a mistake screenshot or file to the job's files. Returns its id, null for none, false on failure. */
async function uploadFile(supabase: SB, jobId: string, meId: string, f: File | null, say: (m: string, e?: boolean) => void): Promise<string | null | false> {
  if (!f) return null;
  if (f.size > MAX) { say(`${f.name} is over 25 MB`, true); return false; }
  const path = `${jobId}/${crypto.randomUUID()}-${safe(f.name)}`;
  const up = await supabase.storage.from("job-files").upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
  if (up.error) { say(`${f.name} wasn't uploaded: ${up.error.message}`, true); return false; }
  const { data, error } = await supabase.from("job_files").insert({ job_id: jobId, path, name: f.name.slice(0, 255), size: f.size, mime: f.type, kind: "workpaper", uploaded_by: meId }).select("id").single();
  if (error) { await supabase.storage.from("job-files").remove([path]); say(`${f.name} wasn't saved: ${error.message}`, true); return false; }
  return (data as { id: string }).id;
}
/** A pasted screenshot arrives with a generic name; give it a readable one. */
const pastedFile = (e: React.ClipboardEvent): File | null => {
  const it = Array.from(e.clipboardData.items).find((x) => x.kind === "file");
  const f = it?.getAsFile();
  if (!f) return null;
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return new File([f], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.${ext}`, { type: f.type });
};
function Attach({ id, file, onPick, label }: { id: string; file: File | null; onPick: (f: File | null) => void; label: string }) {
  return <>
    <input id={id} type="file" hidden accept="image/*,.pdf,.xlsx,.xls,.csv,.doc,.docx" onChange={(e) => { onPick(e.target.files?.[0] ?? null); e.target.value = ""; }} />
    <button type="button" onClick={() => (document.getElementById(id) as HTMLInputElement | null)?.click()}>{file ? `📎 ${file.name}` : label}</button>
    {file ? <button type="button" className="link" onClick={() => onPick(null)}>Remove</button> : null}</>;
}

/** The reviewer's form inside the Review task: what's wrong, how serious, and a screenshot or file of the mistake. */
export function ReviewNoteForm({ job, meId, supabase, personName, say }: { job: Job; meId: string; supabase: SB; personName: (id: string | null) => string; say: (m: string, e?: boolean) => void }) {
  const [v, setV] = useState({ severity: "minor" as ReviewNote["severity"], category: REVIEW_TYPES[0], body: "" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  if (job.assignee_id === meId) return <p className="note" style={{ margin: "0 0 8px" }}>You prepared this job, so someone else should review it.</p>;
  async function add() {
    if (!v.body.trim()) return;
    setBusy(true);
    const fileId = await uploadFile(supabase, job.id, meId, file, say);
    if (fileId === false) { setBusy(false); return; }
    const row: Record<string, unknown> = { job_id: job.id, author_id: meId, to_id: job.assignee_id, severity: v.severity, category: v.category, body: v.body.trim(), status: "open" };
    if (fileId) row.file_id = fileId;
    const { error } = await supabase.from("review_notes").insert(row);
    setBusy(false);
    if (error) { say(fileId && MISSING_COL.test(error.message) ? "Attachments on review notes need a quick database update first (database-update-review-attachments.sql)." : `Not saved: ${error.message}`, true); return; }
    say(`Review note sent to ${personName(job.assignee_id) || "the preparer"}`);
    setV({ ...v, body: "" }); setFile(null); setOpen(false); changed(job.id);
  }
  if (!open) return <div className="row" style={{ marginBottom: 8 }}><button type="button" className="rnadd" onClick={() => setOpen(true)}>⚠ Add review note</button></div>;
  return <div className="qnew rnform">
    <div className="row" style={{ gap: 8 }}>
      <label className="f">How serious<select id="rn-sev" value={v.severity} onChange={(e) => setV({ ...v, severity: e.target.value as ReviewNote["severity"] })}><option value="minor">Minor</option><option value="major">Major</option></select></label>
      <label className="f">Type<select id="rn-type" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>{REVIEW_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
    </div>
    <textarea id="rn-body" placeholder="What's wrong? e.g. Fuel receipts without tax invoices claimed in full (G11 overstated by $1,240). You can paste a screenshot here." value={v.body}
      onChange={(e) => setV({ ...v, body: e.target.value })} onPaste={(e) => { const f = pastedFile(e); if (f) { e.preventDefault(); setFile(f); say("Screenshot attached"); } }} />
    <div className="row"><Attach id="rn-file" file={file} onPick={setFile} label="Attach screenshot or file" /><span style={{ flex: 1 }} />
      <button type="button" className="link" onClick={() => { setOpen(false); setFile(null); }}>Cancel</button>
      <button type="button" className="primary" disabled={busy || !v.body.trim() || !job.assignee_id} onClick={add}>{busy ? "Sending…" : "Send review note"}</button></div>
    <span className="note">{job.assignee_id ? `${personName(job.assignee_id)} gets a notification, fixes it and marks it fixed. You then clear it or send it back.` : "Assign the job first so someone can fix it."}</span>
  </div>;
}

/** Review notes on a job: the reviewer raises a mistake, the preparer fixes it, the reviewer clears it. */
export default function ReviewNotes({ job, meId, canAnswerAll, readOnly, supabase, personName, say, asTasks }: {
  asTasks?: boolean; job: Job; meId: string; canAnswerAll: boolean; readOnly?: boolean; supabase: SB; personName: (id: string | null) => string; say: (m: string, e?: boolean) => void;
}) {
  const [notes, setNotes] = useState<ReviewNote[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [fix, setFix] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [fixFile, setFixFile] = useState<Record<string, File | null>>({});
  const [fileNames, setFileNames] = useState<Record<string, { name: string; path: string }>>({});

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("review_notes").select("*").eq("job_id", job.id).order("created_at");
    setMissing(!!error && /does not exist|schema cache|review_notes/i.test(error.message));
    const list = (data as ReviewNote[] | null) ?? [];
    setNotes(list);
    const ids = list.flatMap((n) => [n.file_id, n.fix_file_id]).filter((x): x is string => !!x);
    if (ids.length) {
      const f = await supabase.from("job_files").select("id,name,path").in("id", ids);
      setFileNames(Object.fromEntries(((f.data as { id: string; name: string; path: string }[] | null) ?? []).map((x) => [x.id, { name: x.name, path: x.path }])));
    }
  }, [supabase, job.id]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`review-notes-${job.id}-${Math.random().toString(36).slice(2)}`).on("postgres_changes", { event: "*", schema: "public", table: "review_notes", filter: `job_id=eq.${job.id}` }, () => load()).subscribe();
    const ev = `review-notes:${job.id}`; const on = () => load();
    window.addEventListener(ev, on);
    return () => { supabase.removeChannel(ch); window.removeEventListener(ev, on); };
  }, [supabase, job.id, load]);
  async function openFile(id: string) {
    const f = fileNames[id];
    if (!f) { say("That file has been deleted.", true); return; }
    const { data } = await supabase.storage.from("job-files").createSignedUrl(f.path, 120);
    if (data) window.open(data.signedUrl, "_blank", "noopener");
  }
  const chip = (id?: string | null) => id ? <button type="button" className="link qfile" onClick={() => openFile(id)}>📎 {fileNames[id]?.name ?? "Attachment"}</button> : null;
  async function markFixed(n: ReviewNote) {
    setBusy(true);
    const fid = await uploadFile(supabase, job.id, meId, fixFile[n.id] ?? null, say);
    if (fid === false) { setBusy(false); return; }
    const upd: Record<string, unknown> = { status: "fixed", fix_body: (fix[n.id] ?? "").trim(), fixed_by: meId, fixed_at: new Date().toISOString() };
    if (fid) upd.fix_file_id = fid;
    const { error } = await supabase.from("review_notes").update(upd).eq("id", n.id);
    setBusy(false);
    if (error) { say(fid && MISSING_COL.test(error.message) ? "Attachments on review notes need a quick database update first (database-update-review-attachments.sql)." : `Not saved: ${error.message}`, true); return; }
    say("Marked as fixed. The reviewer will check it."); setFix({ ...fix, [n.id]: "" }); setFixFile({ ...fixFile, [n.id]: null }); load();
  }
  const fixBox = (n: ReviewNote) => <div className="qreply">
    <textarea aria-label="What you fixed" placeholder="What did you fix? e.g. Reversed GST on 6 receipts, G11 now $18,410" value={fix[n.id] ?? ""} onChange={(e) => setFix({ ...fix, [n.id]: e.target.value })}
      onPaste={(e) => { const f = pastedFile(e); if (f) { e.preventDefault(); setFixFile({ ...fixFile, [n.id]: f }); say("Screenshot attached"); } }} />
    <div className="row"><Attach id={`rn-fix-file-${n.id}`} file={fixFile[n.id] ?? null} onPick={(f) => setFixFile({ ...fixFile, [n.id]: f })} label="Attach screenshot" /><span style={{ flex: 1 }} />
      <button type="button" className="primary" disabled={busy || !(fix[n.id] ?? "").trim()} onClick={() => markFixed(n)}>Mark fixed</button></div>
  </div>;

  const canRaise = !readOnly && (canAnswerAll || job.reviewer_id === meId) && job.assignee_id !== meId;
  async function run(p: PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true);
    const { error } = await p;
    setBusy(false);
    if (error) { say(`Not saved: ${error.message}`, true); return false; }
    say(ok); load(); return true;
  }

  if (missing) return <section className="briefsec"><h3>Review notes</h3><p className="note">Run the review notes database update in Supabase to switch these on.</p></section>;
  const open = (notes ?? []).filter((n) => n.status !== "cleared").length;
  const form = canRaise ? <ReviewNoteForm job={job} meId={meId} supabase={supabase} personName={personName} say={say} /> : null;
  const actions = (n: ReviewNote) => {
    const mineToFix = n.status === "open" && !readOnly && (n.to_id === meId || job.assignee_id === meId);
    const mineToCheck = n.status === "fixed" && !readOnly && (n.author_id === meId || canAnswerAll);
    return <>
      {mineToFix ? fixBox(n) : n.status === "open" ? <div className="note qwait">Waiting for {personName(n.to_id) || "the preparer"} to fix it.</div> : null}
      {mineToCheck ? <div className="row" style={{ marginTop: 6 }}>
        <button type="button" className="primary" disabled={busy} onClick={() => run(supabase.from("review_notes").update({ status: "cleared", cleared_by: meId, cleared_at: new Date().toISOString() }).eq("id", n.id), "Review note cleared")}>Clear</button>
        <button type="button" disabled={busy} onClick={() => run(supabase.from("review_notes").update({ status: "open" }).eq("id", n.id), "Sent back to fix again")}>Not fixed, send back</button>
      </div> : null}</>;
  };
  const all = notes ?? [];
  const summary = all.length ? <li className="task rnsum"><span className="note"><strong>Review notes on this job: {all.length}</strong>
    {` · ${all.filter((n) => n.severity === "major").length} major · ${open} still open · ${all.length - open} cleared. Cleared notes stay here and still count towards the preparer's mistakes.`}</span></li> : null;
  if (asTasks) return (
    <>
      {summary}
      {(notes ?? []).map((n) => { const [lbl, cls] = STATUS[n.status]; return (
        <li key={n.id} className={`task rn ${n.status}`} id={`rn-${n.id}`}>
          <div className="taskhead"><span className="tdot">{n.status === "cleared" ? "✓" : "!"}</span>
            <div style={{ minWidth: 0, flex: 1 }}><div className="tkt">Review note · {personName(n.author_id) || "Reviewer"} → {personName(n.to_id) || "preparer"}</div>
              <div className="tks">Raised {when(n.created_at)} · <span className={n.severity === "major" ? "danger" : "warn"}>● {n.severity === "major" ? "Major" : "Minor"}</span> {n.category}</div></div>
            <span className={`pill ${cls}`}>{lbl}</span></div>
          <div className="qpair">
            <div className="qcol ask"><div className="qhead"><span className="pill warn">Mistake</span> {personName(n.author_id)}</div><div className="qbody">{n.body}</div>{chip(n.file_id)}</div>
            <div className="qcol ans">{n.fix_body ? <><div className="qhead"><span className="pill ok">Fix</span> {personName(n.fixed_by)} · {when(n.fixed_at)}</div><div className="qbody">{n.fix_body}</div>{chip(n.fix_file_id)}</> : null}
              {n.cleared_at ? <div className="note">Cleared by {personName(n.cleared_by)} · {when(n.cleared_at)}</div> : null}
              {actions(n)}</div>
          </div>
        </li>); })}
      {canRaise && job.status !== "review" ? <li className="task add" id="review-notes">{form}</li> : null}
    </>
  );
  return (
    <section className="briefsec" id="review-notes">
      <h3>Review notes{notes?.length ? ` (${open} open of ${notes.length})` : ""}</h3>
      {notes?.length ? <ul className="qthread">{notes.map((n) => {
        const [lbl, cls] = STATUS[n.status];
        const mineToFix = n.status === "open" && !readOnly && (n.to_id === meId || job.assignee_id === meId);
        const mineToCheck = n.status === "fixed" && !readOnly && (n.author_id === meId || canAnswerAll);
        return (
          <li key={n.id} className={`rnote ${n.status}`}>
            <div className="qcol ask"><div className="qhead"><span className={`pill ${n.severity === "major" ? "danger" : "warn"}`}>{n.severity === "major" ? "Major" : "Minor"}</span> <span className="pill">{n.category}</span> {personName(n.author_id) || "Reviewer"} → {personName(n.to_id) || "preparer"} · {when(n.created_at)}</div>
              <div className="qbody">{n.body}</div>{chip(n.file_id)}</div>
            <div className="qcol ans">
              <div className="qhead"><span className={`pill ${cls}`}>{lbl}</span>{n.cleared_at ? ` by ${personName(n.cleared_by)} · ${when(n.cleared_at)}` : ""}</div>
              {n.fix_body ? <div><div className="qhead">Fix · {personName(n.fixed_by)} · {when(n.fixed_at)}</div><div className="qbody">{n.fix_body}</div>{chip(n.fix_file_id)}</div> : null}
              {mineToFix ? fixBox(n) : n.status === "open" ? <div className="note qwait">Waiting for {personName(n.to_id) || "the preparer"} to fix it.</div> : null}
              {mineToCheck ? <div className="row" style={{ marginTop: 6 }}>
                <button type="button" className="primary" disabled={busy} onClick={() => run(supabase.from("review_notes").update({ status: "cleared", cleared_by: meId, cleared_at: new Date().toISOString() }).eq("id", n.id), "Review note cleared")}>Clear</button>
                <button type="button" disabled={busy} onClick={() => run(supabase.from("review_notes").update({ status: "open" }).eq("id", n.id), "Sent back to fix again")}>Not fixed, send back</button>
              </div> : null}
            </div>
          </li>); })}</ul> : <p className="note" style={{ margin: "0 0 10px" }}>No review notes on this job.</p>}
      {form}
    </section>
  );
}
