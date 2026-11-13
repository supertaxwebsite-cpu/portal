"use client";
import { useCallback, useEffect, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Job } from "@/lib/types";

type SB = ReturnType<typeof createClient>;
export interface ReviewNote {
  id: string; job_id: string; author_id: string | null; to_id: string | null; severity: "major" | "minor"; category: string; body: string;
  status: "open" | "fixed" | "cleared"; fix_body: string; fixed_by: string | null; fixed_at: string | null; cleared_by: string | null; cleared_at: string | null; created_at: string;
}
export const REVIEW_TYPES = ["GST coding", "Missed income", "Wrong figures", "Process / checklist", "Missing documents", "Other"];
const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const STATUS: Record<ReviewNote["status"], [string, string]> = { open: ["Open: to fix", "danger"], fixed: ["Fixed: ready to check", "warn"], cleared: ["Cleared", "ok"] };

/** Review notes on a job: the reviewer raises a mistake, the preparer fixes it, the reviewer clears it. */
export default function ReviewNotes({ job, meId, canAnswerAll, readOnly, supabase, personName, say, asTasks }: {
  asTasks?: boolean; job: Job; meId: string; canAnswerAll: boolean; readOnly?: boolean; supabase: SB; personName: (id: string | null) => string; say: (m: string, e?: boolean) => void;
}) {
  const [notes, setNotes] = useState<ReviewNote[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [v, setV] = useState({ severity: "minor" as ReviewNote["severity"], category: REVIEW_TYPES[0], body: "" });
  const [fix, setFix] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("review_notes").select("*").eq("job_id", job.id).order("created_at");
    setMissing(!!error && /does not exist|schema cache|review_notes/i.test(error.message));
    setNotes((data as ReviewNote[] | null) ?? []);
  }, [supabase, job.id]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`review-notes-${job.id}`).on("postgres_changes", { event: "*", schema: "public", table: "review_notes", filter: `job_id=eq.${job.id}` }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, job.id, load]);

  const canRaise = !readOnly && (canAnswerAll || job.reviewer_id === meId) && job.assignee_id !== meId;
  async function run(p: PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true);
    const { error } = await p;
    setBusy(false);
    if (error) { say(`Not saved: ${error.message}`, true); return false; }
    say(ok); load(); return true;
  }
  async function raise() {
    if (await run(supabase.from("review_notes").insert({ job_id: job.id, author_id: meId, to_id: job.assignee_id, severity: v.severity, category: v.category, body: v.body.trim(), status: "open" }), `Review note sent to ${personName(job.assignee_id) || "the preparer"}`)) setV({ ...v, body: "" });
  }

  if (missing) return <section className="briefsec"><h3>Review notes</h3><p className="note">Run the review notes database update in Supabase to switch these on.</p></section>;
  const open = (notes ?? []).filter((n) => n.status !== "cleared").length;
  const form = canRaise ? <div className="qnew">
        <div className="row" style={{ gap: 8 }}>
          <label className="f">How serious<select id="rn-sev" value={v.severity} onChange={(e) => setV({ ...v, severity: e.target.value as ReviewNote["severity"] })}><option value="minor">Minor</option><option value="major">Major</option></select></label>
          <label className="f">Type<select id="rn-type" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>{REVIEW_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        </div>
        <textarea id="rn-body" placeholder="What's wrong? e.g. Fuel receipts without tax invoices claimed in full (G11 overstated by $1,240)" value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} />
        <div className="row"><span className="note">{job.assignee_id ? `${personName(job.assignee_id)} gets a notification, fixes it here, and you clear it.` : "Assign the job first so someone can fix it."}</span><span style={{ flex: 1 }} />
          <button type="button" className="primary" disabled={busy || !v.body.trim()} onClick={raise}>Add review note</button></div>
      </div> : null;
  const actions = (n: ReviewNote) => {
    const mineToFix = n.status === "open" && !readOnly && (n.to_id === meId || job.assignee_id === meId);
    const mineToCheck = n.status === "fixed" && !readOnly && (n.author_id === meId || canAnswerAll);
    return <>
      {mineToFix ? <div className="qreply">
        <textarea aria-label="What you fixed" placeholder="What did you fix? e.g. Reversed GST on 6 receipts, G11 now $18,410" value={fix[n.id] ?? ""} onChange={(e) => setFix({ ...fix, [n.id]: e.target.value })} />
        <div className="row"><span style={{ flex: 1 }} /><button type="button" className="primary" disabled={busy || !(fix[n.id] ?? "").trim()} onClick={async () => { if (await run(supabase.from("review_notes").update({ status: "fixed", fix_body: (fix[n.id] ?? "").trim(), fixed_by: meId, fixed_at: new Date().toISOString() }).eq("id", n.id), "Marked as fixed. The reviewer will check it.")) setFix({ ...fix, [n.id]: "" }); }}>Mark fixed</button></div>
      </div> : n.status === "open" ? <div className="note qwait">Waiting for {personName(n.to_id) || "the preparer"} to fix it.</div> : null}
      {mineToCheck ? <div className="row" style={{ marginTop: 6 }}>
        <button type="button" className="primary" disabled={busy} onClick={() => run(supabase.from("review_notes").update({ status: "cleared", cleared_by: meId, cleared_at: new Date().toISOString() }).eq("id", n.id), "Review note cleared")}>Clear</button>
        <button type="button" disabled={busy} onClick={() => run(supabase.from("review_notes").update({ status: "open" }).eq("id", n.id), "Sent back to fix again")}>Not fixed, send back</button>
      </div> : null}</>;
  };
  if (asTasks) return (
    <>
      {(notes ?? []).map((n) => { const [lbl, cls] = STATUS[n.status]; return (
        <li key={n.id} className={`task rn ${n.status}`} id={`rn-${n.id}`}>
          <div className="taskhead"><span className="tdot">{n.status === "cleared" ? "✓" : "!"}</span>
            <div style={{ minWidth: 0, flex: 1 }}><div className="tkt">Review note · {personName(n.author_id) || "Reviewer"} → {personName(n.to_id) || "preparer"}</div>
              <div className="tks">Raised {when(n.created_at)} · <span className={n.severity === "major" ? "danger" : "warn"}>● {n.severity === "major" ? "Major" : "Minor"}</span> {n.category}</div></div>
            <span className={`pill ${cls}`}>{lbl}</span></div>
          <div className="qpair">
            <div className="qcol ask"><div className="qhead"><span className="pill warn">Mistake</span> {personName(n.author_id)}</div><div className="qbody">{n.body}</div></div>
            <div className="qcol ans">{n.fix_body ? <><div className="qhead"><span className="pill ok">Fix</span> {personName(n.fixed_by)} · {when(n.fixed_at)}</div><div className="qbody">{n.fix_body}</div></> : null}
              {n.cleared_at ? <div className="note">Cleared by {personName(n.cleared_by)} · {when(n.cleared_at)}</div> : null}
              {actions(n)}</div>
          </div>
        </li>); })}
      {canRaise ? <li className="task add" id="review-notes">{formOpen ? form : <button type="button" onClick={() => setFormOpen(true)}>⚠ Add review note</button>}</li> : null}
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
              <div className="qbody">{n.body}</div></div>
            <div className="qcol ans">
              <div className="qhead"><span className={`pill ${cls}`}>{lbl}</span>{n.cleared_at ? ` by ${personName(n.cleared_by)} · ${when(n.cleared_at)}` : ""}</div>
              {n.fix_body ? <div><div className="qhead">Fix · {personName(n.fixed_by)} · {when(n.fixed_at)}</div><div className="qbody">{n.fix_body}</div></div> : null}
              {mineToFix ? <div className="qreply">
                <textarea aria-label="What you fixed" placeholder="What did you fix? e.g. Reversed GST on 6 receipts, G11 now $18,410" value={fix[n.id] ?? ""} onChange={(e) => setFix({ ...fix, [n.id]: e.target.value })} />
                <div className="row"><span style={{ flex: 1 }} /><button type="button" className="primary" disabled={busy || !(fix[n.id] ?? "").trim()} onClick={async () => { if (await run(supabase.from("review_notes").update({ status: "fixed", fix_body: (fix[n.id] ?? "").trim(), fixed_by: meId, fixed_at: new Date().toISOString() }).eq("id", n.id), "Marked as fixed. The reviewer will check it.")) setFix({ ...fix, [n.id]: "" }); }}>Mark fixed</button></div>
              </div> : n.status === "open" ? <div className="note qwait">Waiting for {personName(n.to_id) || "the preparer"} to fix it.</div> : null}
              {mineToCheck ? <div className="row" style={{ marginTop: 6 }}>
                <button type="button" className="primary" disabled={busy} onClick={() => run(supabase.from("review_notes").update({ status: "cleared", cleared_by: meId, cleared_at: new Date().toISOString() }).eq("id", n.id), "Review note cleared")}>Clear</button>
                <button type="button" disabled={busy} onClick={() => run(supabase.from("review_notes").update({ status: "open" }).eq("id", n.id), "Sent back to fix again")}>Not fixed, send back</button>
              </div> : null}
            </div>
          </li>); })}</ul> : <p className="note" style={{ margin: "0 0 10px" }}>No review notes on this job.</p>}
      {canRaise ? <div className="qnew">
        <div className="row" style={{ gap: 8 }}>
          <label className="f">How serious<select id="rn-sev" value={v.severity} onChange={(e) => setV({ ...v, severity: e.target.value as ReviewNote["severity"] })}><option value="minor">Minor</option><option value="major">Major</option></select></label>
          <label className="f">Type<select id="rn-type" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>{REVIEW_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        </div>
        <textarea id="rn-body" placeholder="What's wrong? e.g. Fuel receipts without tax invoices claimed in full (G11 overstated by $1,240)" value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} />
        <div className="row"><span className="note">{job.assignee_id ? `${personName(job.assignee_id)} gets a notification, fixes it here, and you clear it.` : "Assign the job first so someone can fix it."}</span><span style={{ flex: 1 }} />
          <button type="button" className="primary" disabled={busy || !v.body.trim()} onClick={raise}>Add review note</button></div>
      </div> : null}
    </section>
  );
}
