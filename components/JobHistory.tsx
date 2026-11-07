"use client";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ST, fmtDate } from "@/lib/domain";
import { fmtHours } from "./MyJobs";

type SB = ReturnType<typeof createClient>;
interface Activity { id: string; job_id: string; actor_id: string | null; kind: string; from_value: string | null; to_value: string | null; body: string; created_at: string }
interface Entry { id: string; user_id: string; work_date: string; hours: number; description: string; created_at: string }
interface Timer { id: string; user_id: string; started_at: string }
export interface JobSummary { hours: number; people: number; comments: number }

const when = (s: string) => new Date(s).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const stLabel = (s: string | null) => (s ? ST[s]?.label ?? s : "—");

/** Everything that happened on one job: time per person, comments, and a full timeline. */
export default function JobHistory({ jobId, readOnly, meId, canDelete, supabase, personName, say, onSummary }: {
  jobId: string; readOnly?: boolean; meId: string; canDelete: boolean; supabase: SB;
  personName: (id: string | null) => string; say: (m: string, err?: boolean) => void; onSummary?: (s: JobSummary) => void;
}) {
  const [acts, setActs] = useState<Activity[] | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [timers, setTimers] = useState<Timer[]>([]);
  const [missing, setMissing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState<"all" | "comment" | "time" | "change">("all");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const [a, e, t] = await Promise.all([
      supabase.from("job_activity").select("*").eq("job_id", jobId).order("created_at", { ascending: false }),
      supabase.from("timesheet_entries").select("id,user_id,work_date,hours,description,created_at").eq("job_id", jobId).order("created_at", { ascending: false }),
      supabase.from("job_timers").select("id,user_id,started_at").eq("job_id", jobId).is("ended_at", null),
    ]);
    setMissing(!!a.error);
    setActs((a.data as Activity[] | null) ?? []);
    setEntries(((e.data as Entry[] | null) ?? []).map((x) => ({ ...x, hours: Number(x.hours) })));
    setTimers((t.data as Timer[] | null) ?? []);
  }, [supabase, jobId]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`job-history-${jobId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "job_activity", filter: `job_id=eq.${jobId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "timesheet_entries", filter: `job_id=eq.${jobId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "job_timers", filter: `job_id=eq.${jobId}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, jobId, load]);
  useEffect(() => { if (!timers.length) return; const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, [timers.length]);

  // Time per person (logged + anything running now).
  const per = new Map<string, { logged: number; running: number }>();
  for (const e of entries) { const p = per.get(e.user_id) ?? { logged: 0, running: 0 }; p.logged += e.hours; per.set(e.user_id, p); }
  for (const t of timers) { const p = per.get(t.user_id) ?? { logged: 0, running: 0 }; p.running += Math.max(0, (now - new Date(t.started_at).getTime()) / 3600000); per.set(t.user_id, p); }
  const rows = [...per.entries()].map(([id, v]) => ({ id, ...v, total: v.logged + v.running })).sort((a, b) => b.total - a.total);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const max = Math.max(0.01, ...rows.map((r) => r.total));
  const comments = (acts ?? []).filter((a) => a.kind === "comment");
  useEffect(() => { onSummary?.({ hours: total, people: rows.length, comments: comments.length }); }, [total, rows.length, comments.length, onSummary]);

  async function addComment() {
    if (!text.trim()) return;
    setBusy(true);
    const { error } = await supabase.from("job_activity").insert({ job_id: jobId, actor_id: meId, kind: "comment", body: text.trim() });
    setBusy(false);
    if (error) { say(`Comment not saved: ${error.message}`, true); return; }
    setText(""); load();
  }
  async function delComment(id: string) {
    if (!window.confirm("Delete this comment?")) return;
    const { error } = await supabase.from("job_activity").delete().eq("id", id);
    if (error) say(`Not deleted: ${error.message}`, true); else load();
  }

  const describe = (a: Activity): React.ReactNode => {
    switch (a.kind) {
      case "created": return <>created the job{a.to_value ? <> as <b>{stLabel(a.to_value)}</b></> : null}</>;
      case "status": return <>changed status <span className="muted">{stLabel(a.from_value)}</span> → <b>{stLabel(a.to_value)}</b></>;
      case "assignee": return <>assigned it to <b>{personName(a.to_value) || "nobody"}</b>{a.from_value ? <span className="muted"> (was {personName(a.from_value)})</span> : null}</>;
      case "reviewer": return <>set the reviewer to <b>{personName(a.to_value) || "nobody"}</b></>;
      case "due": return <>changed the due date to <b>{a.to_value ? fmtDate(a.to_value) : "none"}</b>{a.from_value ? <span className="muted"> (was {fmtDate(a.from_value)})</span> : null}</>;
      default: return null;
    }
  };
  type Item = { key: string; at: string; type: "comment" | "time" | "change"; node: React.ReactNode };
  const items: Item[] = [
    ...(acts ?? []).map((a): Item => a.kind === "comment"
      ? { key: a.id, at: a.created_at, type: "comment", node: <><div className="hwho"><b>{personName(a.actor_id) || "Former staff"}</b> commented <span className="note">{when(a.created_at)}</span>
          {!readOnly && (a.actor_id === meId || canDelete) ? <button type="button" className="link danger" onClick={() => delComment(a.id)}>Delete</button> : null}</div><div className="hcomment">{a.body}</div></> }
      : { key: a.id, at: a.created_at, type: "change", node: <div className="hwho"><b>{a.actor_id ? personName(a.actor_id) || "Former staff" : "Automatic"}</b> {describe(a)} <span className="note">{when(a.created_at)}</span></div> }),
    ...entries.map((e): Item => ({ key: e.id, at: e.created_at, type: "time", node: <div className="hwho"><b>{personName(e.user_id) || "Former staff"}</b> logged <b>{fmtHours(e.hours)}</b> for {fmtDate(e.work_date)}{e.description ? <span className="muted"> · {e.description}</span> : null} <span className="note">{when(e.created_at)}</span></div> })),
    ...timers.map((t): Item => ({ key: t.id, at: t.started_at, type: "time", node: <div className="hwho"><b>{personName(t.user_id)}</b> is working on it now <span className="timer mono">● {fmtHours(Math.max(1 / 60, (now - new Date(t.started_at).getTime()) / 3600000))}</span> <span className="note">started {when(t.started_at)}</span></div> })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const shown = show === "all" ? items : items.filter((i) => i.type === show);

  if (missing) return <div className="empty">Job history isn&apos;t set up in the database yet.</div>;
  return (
    <div className="jobhistory">
      <section>
        <h3>Time spent {total ? <span className="mono">{fmtHours(total)}</span> : null}</h3>
        {rows.length ? <table className="workload"><tbody>{rows.map((r) => (
          <tr key={r.id}><td style={{ width: "38%" }}>{personName(r.id) || "Former staff"}{r.running ? <div className="note timer">● working now</div> : null}</td>
            <td><div className="bar"><i className="o" style={{ width: `${(r.total / max) * 100}%` }} /></div></td>
            <td className="mono" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{fmtHours(r.total)}</td></tr>))}
          <tr><td><b>Total</b></td><td /><td className="mono" style={{ textAlign: "right" }}><b>{fmtHours(total)}</b></td></tr></tbody></table>
          : <p className="note" style={{ margin: 0 }}>No time logged on this job yet. Time from Start/Stop and from timesheets shows here.</p>}
      </section>
      {readOnly ? null : <section>
        <h3>Add a comment</h3>
        <textarea id="jh-comment" placeholder="What you did, what's outstanding, questions for the team…" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}><button type="button" className="primary" disabled={busy || !text.trim()} onClick={addComment}>Add comment</button></div>
      </section>}
      <section>
        <div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>History</h3>
          <div className="row">{([["all", "All"], ["comment", `Comments (${comments.length})`], ["time", "Time"], ["change", "Changes"]] as const).map(([k, l]) =>
            <button type="button" key={k} className={`chip ${show === k ? "on" : ""}`} onClick={() => setShow(k)}>{l}</button>)}</div></div>
        {acts === null ? <p className="note">Loading…</p> : !shown.length ? <p className="note">Nothing here yet.</p> :
          <ul className="timeline">{shown.map((i) => <li key={i.key} className={i.type}>{i.node}</li>)}</ul>}
      </section>
    </div>
  );
}
