"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Job, JobTimer } from "@/lib/types";
import { ST, daysFrom, fmtDate, svcLabel, todayISO, isSigned } from "@/lib/domain";

type SB = ReturnType<typeof createClient>;
const WEEK_TARGET = 6 * 8.25;
const hm = (h: number) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
const elapsed = (from: string, now: number) => { const m = Math.max(0, Math.floor((now - Date.parse(from)) / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monday = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
/** Working days (Mon to Sat) from the 1st of this month up to today. */
const workDaysSoFar = () => { const t = new Date(); let n = 0; for (let d = 1; d <= t.getDate(); d++) if (new Date(t.getFullYear(), t.getMonth(), d).getDay() !== 0) n++; return n; };

interface Note { id: string; job_id: string; severity: string; category: string; body: string; author_id: string | null; created_at: string }
interface Stats { firstIn: string | null; daysAt: number; week: number; notes: Note[] | null }
type Kind = "all" | "overdue" | "iq" | "review" | "sign" | "notes";

/** Staff home: today's log-in and suggested log-out, this month's numbers, and the task list, most urgent first. */
export default function StaffHome({ supabase, meId, firstName, jobs: allJobs, closedThisMonth, closedLastMonth, running, busy, clientLine, personName, wasStarted,
  onOpen, onStart, onStop, onApprove, onSendBack, onSentForSign, onSigned, onClientSigned, onReplied, onAnswer, onPayroll, statusEl, askedBy, top, children, unassigned = [], onTake, byStatus }: {
  supabase: SB; meId: string; firstName: string; jobs: Job[]; closedThisMonth: number; closedLastMonth: number; running: JobTimer | null; busy: boolean;
  clientLine: (j: Job) => [string, string]; personName: (id: string | null) => string; wasStarted: (j: Job) => boolean;
  onOpen: (j: Job) => void; onStart: (j: Job) => void; onStop: () => void; onApprove: (j: Job) => void; onSendBack: (j: Job) => void;
  onSentForSign: (j: Job) => void; onSigned: (j: Job) => void; onClientSigned?: (j: Job) => void; onReplied: (j: Job) => void; onAnswer: (j: Job) => void; onPayroll: () => void;
  statusEl: (j: Job) => ReactNode; children?: ReactNode;
  /** Shown above the task list (e.g. client email replies). */
  top?: ReactNode;
  /** Jobs with an internal query raised to me and not answered yet: job id → who asked. */
  askedBy?: Map<string, string | null>;
  /** Open jobs nobody (active) is assigned to, most urgent first, and how to take one. */
  unassigned?: Job[]; onTake?: (j: Job) => void;
  /** "My jobs by status" strip, shown under the number tiles. */
  byStatus?: ReactNode;
}) {
  // Pay runs live on the Payroll tab, not here.
  const jobs = allJobs.filter((j) => j.service !== "payroll");
  const [s, setS] = useState<Stats | null>(null);
  const [kind, setKind] = useState<Kind>("all");
  const [all, setAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  useEffect(() => {
    let live = true;
    (async () => {
      const month = `${todayISO().slice(0, 7)}-01`;
      const [a, e, rn] = await Promise.all([
        supabase.from("attendance").select("clock_in,work_date").eq("user_id", meId).gte("work_date", month).order("clock_in"),
        supabase.from("timesheet_entries").select("hours").eq("user_id", meId).gte("work_date", monday()).lte("work_date", todayISO()),
        supabase.from("review_notes").select("id,job_id,severity,category,body,author_id,created_at").eq("to_id", meId).eq("status", "open").order("created_at"),
      ]);
      const att = (a.data as { clock_in: string; work_date: string }[] | null) ?? [];
      const last = att[att.length - 1];
      // Today's shift: the first log-in on the latest work day, if that day started in the last 16 hours.
      const first = last && now - Date.parse(last.clock_in) < 16 * 3600e3 ? att.find((x) => x.work_date === last.work_date)?.clock_in ?? null : null;
      const week = ((e.data as { hours: number }[] | null) ?? []).reduce((t, r) => t + (Number(r.hours) || 0), 0);
      if (live) setS({ firstIn: first, daysAt: new Set(att.map((x) => x.work_date)).size, week, notes: rn.error ? null : (rn.data as Note[]) });
    })();
    return () => { live = false; };
    // Re-read when the running job changes: stopping a job adds time to the timesheet.
  }, [supabase, meId, running?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const signer = (j: Job) => (j.sign_owner ?? j.reviewer_id ?? j.assignee_id) === meId;
  const isReview = (j: Job) => j.status === "review" && (j.reviewer_id === meId || (!j.reviewer_id && j.assignee_id === meId));
  const isPay = (j: Job) => j.service === "payroll";
  const isSign = (j: Job) => !isPay(j) && j.status === "to_lodge" || j.status === "sent_for_sign" || j.status === "client_query";
  const over = (j: Job) => !!j.due_date && daysFrom(j.due_date) < 0;
  const asked = (j: Job) => !!askedBy?.has(j.id);
  const noteJobs = new Set((s?.notes ?? []).map((n) => n.job_id));
  const ordered = [...jobs].sort((a, b) => (a.id === running?.job_id ? -1 : b.id === running?.job_id ? 1 : 0)
    || Number(over(b)) - Number(over(a)) || Number(b.priority === "high") - Number(a.priority === "high") || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
  const rank = new Map(ordered.map((j, i) => [j.id, i + 1]));
  const PILLS: [Kind, string, (j: Job) => boolean, boolean][] = [
    ["all", "All", () => true, false],
    ["overdue", "Overdue", over, true],
    ["iq", "Internal queries to me", asked, true],
    ["review", "To review", isReview, false],
    ["sign", "Signing & client queries", isSign, false],
    ...(s?.notes ? [["notes", "Review notes", (j: Job) => noteJobs.has(j.id), true] as [Kind, string, (j: Job) => boolean, boolean]] : []),
  ];
  const f = PILLS.find((p) => p[0] === kind)?.[2] ?? (() => true);
  // Coming up later: not started yet and due more than 7 days away. On "All" they sit in their own box instead of the task list.
  const isLater = (j: Job) => j.status === "not_started" && !!j.due_date && daysFrom(j.due_date) > 7 && running?.job_id !== j.id && !asked(j) && !noteJobs.has(j.id);
  const later = ordered.filter(isLater).sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));
  const list = ordered.filter((j) => f(j) && !isPay(j) && !(kind === "all" && isLater(j)));
  const shown = all ? list : list.slice(0, 10);
  const payList = ordered.filter((j) => f(j) && isPay(j));

  const daysTarget = workDaysSoFar();
  const openNotes = s?.notes?.length ?? 0;

  const sub = (j: Job) => {
    if (running?.job_id === j.id) return <><span className="runtxt">● Running {elapsed(running.started_at, now)}</span> · {ST[j.status]?.label}</>;
    if (asked(j)) return `Internal query from ${personName(askedBy!.get(j.id) ?? null) || "someone"}: answer it on the job`;
    if (isReview(j)) return j.assignee_id && j.assignee_id !== meId ? `Prepared by ${personName(j.assignee_id)}` : "Review";
    if (j.status === "internal_query") return j.assignee_id !== meId ? `With ${personName(j.assignee_id)} for an internal query` : j.query_from ? `Internal query from ${personName(j.query_from)}` : "Internal query raised: waiting for the answer";
    if (isPay(j) && j.status === "to_lodge") return j.super_done_at ? "Super paid: lodge the STP pay event" : "Pay run approved: pay super, then confirm it";
    if (j.status === "with_auditor") return "With the auditor: log any auditor queries on the job, then Audit report received";
    if (j.status === "auditor_query") return `Auditor query open${j.audit_queries?.filter((q) => !q.done_at).length ? ` (${j.audit_queries.filter((q) => !q.done_at).length})` : ""}: answer it, then mark it answered on the job`;
    if (j.status === "to_lodge") return "Approved: send it to the client for signing";
    if (j.status === "sent_for_sign" || j.status === "client_query") {
      const d = j.sign_sent_at ? Math.floor((now - Date.parse(j.sign_sent_at)) / 864e5) : 0;
      return `${j.status === "client_query" ? "Query sent to the client" : "Sent for signing"} ${d ? `${d} day${d === 1 ? "" : "s"} ago` : "today"}${d >= 2 ? ": follow up" : ""}`;
    }
    const n = noteJobs.has(j.id) ? (s?.notes ?? []).filter((x) => x.job_id === j.id).length : 0;
    return `${wasStarted(j) ? ST[j.status]?.label ?? "" : "Not started yet"}${n ? ` · ${n} review note${n === 1 ? "" : "s"} to fix` : ""}`;
  };
  const due = (j: Job) => {
    if (!j.due_date) return <div className="tleft"><b className="muted">No due date</b></div>;
    const d = daysFrom(j.due_date);
    return <div className={`tleft ${d < 0 ? "danger" : d <= 2 ? "warn" : "ok"}`}><b>{d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : d === 0 ? "Due today" : `${d} day${d === 1 ? "" : "s"} left`}</b><small>{fmtDate(j.due_date)}</small></div>;
  };
  const timer = (j: Job, label = "Start") => running?.job_id === j.id
    ? <button type="button" disabled={busy} onClick={onStop}>Stop</button>
    : <button type="button" className="primary" disabled={busy} onClick={() => onStart(j)}>{label}</button>;
  const action = (j: Job) => {
    if (asked(j) && j.assignee_id !== meId && !isReview(j)) return <button type="button" className="primary" onClick={() => onOpen(j)}>Answer</button>;
    if (isReview(j)) return <>{timer(j, "Start review")}{j.service === "payroll" ? <button type="button" onClick={onPayroll}>Sign off in Payroll</button> : <>
      <button type="button" disabled={busy} onClick={() => onSendBack(j)}>Send back</button>
      <button type="button" className="primary" disabled={busy} onClick={() => onApprove(j)}>{j.needs_signature === false ? "Approve & complete" : "Approve"}</button></>}</>;
    if (isPay(j) && j.status === "to_lodge") return <>{timer(j)}<button type="button" className="primary" onClick={() => onOpen(j)}>{j.super_done_at ? "Lodge STP" : "Confirm super"}</button></>;
    if (j.status === "with_auditor" || j.status === "auditor_query") return <>{timer(j)}<button type="button" className={j.status === "auditor_query" ? "primary" : undefined} onClick={() => onOpen(j)}>Open audit</button></>;
    if (j.status === "to_lodge") return <>{timer(j)}<button type="button" className="primary" disabled={busy} onClick={() => onSentForSign(j)}>Sent for signing</button></>;
    if (j.status === "sent_for_sign") return isSigned(j) ? <button type="button" className="primary" disabled={busy} onClick={() => onSigned(j)}>Lodged</button>
      : <button type="button" className="primary" disabled={busy} onClick={() => (onClientSigned ?? onSigned)(j)}>Client signed</button>;
    if (j.status === "client_query") return <button type="button" className="primary" disabled={busy} onClick={() => onReplied(j)}>Client replied</button>;
    if (j.status === "internal_query" && j.assignee_id !== meId) return <span className="pill danger">Away</span>;
    if (j.status === "internal_query" && j.query_from) return <>{timer(j)}<button type="button" disabled={busy} onClick={() => onAnswer(j)}>Send back</button></>;
    return timer(j);
  };
  const table = (rows: Job[]) => (
          <div style={{ overflowX: "auto" }}>
            <table className="jobtable"><thead><tr><th>Client · practice</th><th>Task</th><th>Due / time left</th><th>Status</th><th>Priority</th><th></th></tr></thead>
              <tbody>{rows.map((j) => { const [cn, cl] = clientLine(j); const r = rank.get(j.id) ?? 0; return (
                <tr key={j.id} className={`${running?.job_id === j.id ? "running" : ""}${over(j) ? " over" : ""}`}>
                  <td className="client">{cn}<div className="note">{cl}</div></td>
                  <td><button type="button" className="link jobname" onClick={() => onOpen(j)}>{svcLabel(j.service)} {j.period}{isReview(j) ? " · Review" : ""}</button>
                    <div className="note">{sub(j)}</div></td>
                  <td>{due(j)}</td>
                  <td>{isPay(j) && j.status === "to_lodge" ? <span className="pill warn">{j.super_done_at ? "STP to lodge" : "Super to pay"}</span> : showStatus(j) ? statusEl(j) : <span className={`pill ${ST[j.status]?.cls ?? ""}`}>{ST[j.status]?.label ?? j.status}</span>}</td>
                  <td><span className={`rank${over(j) ? " hot" : ""}`} title={j.priority === "high" ? "High priority" : undefined}>{r}</span>{j.priority === "high" ? <span className="pill danger" style={{ marginLeft: 6 }}>High</span> : null}</td>
                  <td><div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>{action(j)}</div></td>
                </tr>); })}</tbody></table>
          </div>);
  const showStatus = (j: Job) => !isReview(j) && !isSign(j) && !(j.status === "internal_query");

  return (
    <>
      <div className="pagehead staffhead">
        <div><h1>My tasks <span className="pill info" style={{ fontSize: 13, verticalAlign: "middle" }}>{jobs.length}</span></h1><p>{greetingFor(now)} {firstName}. Your work for today, most urgent first.</p></div>
        <div className="quickpills" style={{ margin: 0 }}>{PILLS.map(([k, l, pf, hot]) => { const n = ordered.filter(pf).length; return (
          <button key={k} type="button" className={kind === k ? "on" : undefined} onClick={() => setKind(k)}>{l} <i className={hot && n && kind !== k ? "hot" : undefined}>{n}</i></button>); })}</div>
      </div>

      <div className="stattiles">
        <div className="panel"><span className="lbl">Days at work this month</span><span className="val">{s ? s.daysAt : "…"} <small>of {daysTarget} working day{daysTarget === 1 ? "" : "s"}</small></span>
          <i className="bar"><b style={{ width: `${s ? Math.min(100, (s.daysAt / Math.max(1, daysTarget)) * 100) : 0}%` }} /></i></div>
        <div className="panel"><span className="lbl">Hours logged this week</span><span className="val">{s ? `${Number(s.week.toFixed(1))}h` : "…"}</span>
          <span className="note">Target 49h 30m (Mon to Sat, 8h 15m a day){s ? ` · ${Math.round((s.week / WEEK_TARGET) * 100)}%` : ""}</span></div>
        <div className="panel"><span className="lbl">Jobs completed this month</span><span className="val">{closedThisMonth}</span><span className="note">Last month {closedLastMonth}</span></div>
        <div className="panel"><span className="lbl">Open review notes</span><span className={`val${openNotes ? " danger" : ""}`}>{s?.notes ? openNotes : "—"}</span>
          <span className="note">{s && !s.notes ? "Review notes aren't switched on yet" : openNotes ? "Fix them before you resubmit" : "Nothing to fix"}</span></div>
      </div>
      <div style={{ marginTop: 16 }}>{byStatus}</div>
      {top}
      <div className="panel tasklist">
        <div className="ph"><h2>Task list{payList.length || jobs.some(isPay) ? " · other jobs" : ""}</h2><span className="note">Time left turns amber within 2 days and red once overdue</span></div>
        {!list.length ? <div className="empty"><strong>{jobs.length ? (payList.length ? "No other jobs in this list." : "Nothing in this list.") : "No open jobs assigned to you."}</strong>{jobs.length ? "Pick another filter above." : "Jobs assigned to you show here, ready to start."}</div> : (
          table(shown))}
        <div className="count">Showing {shown.length} of {list.length}{list.length > shown.length ? <> · <button type="button" className="link" onClick={() => setAll(true)}>show all</button></> : null} · click a task to open its job page</div>
      </div>
      {s?.notes?.length ? <div className="panel tasklist" style={{ marginTop: 16 }}>
        <div className="ph"><h2>Review notes to fix <span className="pill danger">{s.notes.length}</span></h2><span className="note">Open the job, fix it, then mark the note fixed</span></div>
        <div style={{ overflowX: "auto" }}><table className="jobtable"><thead><tr><th>Client · job</th><th>From</th><th>Type</th><th>Note</th><th>Raised</th><th></th></tr></thead>
          <tbody>{s.notes.map((n) => { const j = jobs.find((x) => x.id === n.job_id); return (
            <tr key={n.id}><td className="client">{j ? clientLine(j)[0] : "A job"}<div className="note">{j ? `${svcLabel(j.service)} ${j.period}` : ""}</div></td>
              <td>{personName(n.author_id) || "—"}</td>
              <td><span className={`pill ${n.severity === "major" ? "danger" : "warn"}`}>{n.severity === "major" ? "Major" : "Minor"}</span><div className="note">{n.category}</div></td>
              <td style={{ whiteSpace: "pre-wrap", maxWidth: 420 }}>{n.body.length > 180 ? `${n.body.slice(0, 180)}…` : n.body}</td>
              <td className="note">{fmtDate(n.created_at.slice(0, 10))}</td>
              <td>{j ? <button type="button" className="primary" onClick={() => onOpen(j)}>Fix</button> : null}</td></tr>); })}</tbody></table></div>
      </div> : null}
      <div className="grid2" style={{ marginTop: 16 }}>
        <div className="panel tasklist">
          <div className="ph"><h2>Unassigned jobs I can take <span className="pill info">{unassigned.length}</span></h2></div>
          {unassigned.length ? <div style={{ overflowX: "auto" }}><table className="jobtable"><thead><tr><th>Client</th><th>Job</th><th>Due</th><th></th></tr></thead>
            <tbody>{unassigned.slice(0, 8).map((j) => (
              <tr key={j.id}><td className="client">{clientLine(j)[0]}</td><td><button type="button" className="link jobname" onClick={() => onOpen(j)}>{svcLabel(j.service)} {j.period}</button></td>
                <td>{due(j)}</td><td>{onTake ? <button type="button" className="primary" disabled={busy} onClick={() => onTake(j)}>Take it</button> : null}</td></tr>))}</tbody></table></div>
            : <div className="empty"><strong>No unassigned jobs right now.</strong>New jobs nobody has taken show here.</div>}
          {unassigned.length > 8 ? <div className="count">Showing 8 of {unassigned.length} · the rest are in Jobs (Assigned to: Unassigned)</div> : null}
        </div>
        <div className="panel tasklist">
          <div className="ph"><h2>Coming up later <span className="pill info">{later.length}</span></h2><span className="note">Not started, due after the next 7 days</span></div>
          {later.length ? <div style={{ overflowX: "auto" }}><table className="jobtable"><thead><tr><th>Client · job</th><th>Due</th><th></th></tr></thead>
            <tbody>{later.slice(0, 8).map((j) => (
              <tr key={j.id}><td className="client">{clientLine(j)[0]}<div className="note"><button type="button" className="link" onClick={() => onOpen(j)}>{svcLabel(j.service)} {j.period}</button></div></td>
                <td>{due(j)}</td><td>{timer(j)}</td></tr>))}</tbody></table></div>
            : <div className="empty"><strong>Nothing coming up later.</strong>Jobs due after the next 7 days show here.</div>}
          {later.length > 8 ? <div className="count">Showing 8 of {later.length} · the rest are in Jobs</div> : null}
        </div>
      </div>
      {jobs.some(isPay) ? <div className="panel tasklist paylist">
        <div className="ph"><h2>Payroll <span className="pill info">{payList.length}</span></h2><span className="note">Your pay runs: timesheets in, process, review, super paid, then STP lodged</span>
          <button type="button" onClick={onPayroll}>Open Payroll page</button></div>
        {payList.length ? table(payList) : <div className="empty"><strong>No pay runs in this list.</strong>Pick another filter above.</div>}
      </div> : null}
      {children}
    </>
  );
}

function greetingFor(now: number) { const h = new Date(now).getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; }
