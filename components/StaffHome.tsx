"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Job, JobTimer } from "@/lib/types";
import { ST, daysFrom, fmtDate, svcLabel, todayISO } from "@/lib/domain";
import { START, officeMinutes, suggestedOut } from "./Timesheet";

type SB = ReturnType<typeof createClient>;
const WEEK_TARGET = 6 * 8.25;
const hm = (h: number) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
const clock = (ts: string) => new Date(ts).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
const elapsed = (from: string, now: number) => { const m = Math.max(0, Math.floor((now - Date.parse(from)) / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monday = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
/** Working days (Mon to Sat) from the 1st of this month up to today. */
const workDaysSoFar = () => { const t = new Date(); let n = 0; for (let d = 1; d <= t.getDate(); d++) if (new Date(t.getFullYear(), t.getMonth(), d).getDay() !== 0) n++; return n; };

interface Stats { firstIn: string | null; daysAt: number; week: number; notes: { job_id: string }[] | null }
type Kind = "all" | "overdue" | "review" | "sign" | "notes";

/** Staff home: today's log-in and suggested log-out, this month's numbers, and the task list, most urgent first. */
export default function StaffHome({ supabase, meId, firstName, jobs, closedThisMonth, closedLastMonth, running, busy, clientLine, personName, wasStarted,
  onOpen, onStart, onStop, onApprove, onSendBack, onSentForSign, onSigned, onReplied, onAnswer, onPayroll, statusEl, children }: {
  supabase: SB; meId: string; firstName: string; jobs: Job[]; closedThisMonth: number; closedLastMonth: number; running: JobTimer | null; busy: boolean;
  clientLine: (j: Job) => [string, string]; personName: (id: string | null) => string; wasStarted: (j: Job) => boolean;
  onOpen: (j: Job) => void; onStart: (j: Job) => void; onStop: () => void; onApprove: (j: Job) => void; onSendBack: (j: Job) => void;
  onSentForSign: (j: Job) => void; onSigned: (j: Job) => void; onReplied: (j: Job) => void; onAnswer: (j: Job) => void; onPayroll: () => void;
  statusEl: (j: Job) => ReactNode; children?: ReactNode;
}) {
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
        supabase.from("review_notes").select("job_id").eq("to_id", meId).eq("status", "open"),
      ]);
      const att = (a.data as { clock_in: string; work_date: string }[] | null) ?? [];
      const last = att[att.length - 1];
      // Today's shift: the first log-in on the latest work day, if that day started in the last 16 hours.
      const first = last && now - Date.parse(last.clock_in) < 16 * 3600e3 ? att.find((x) => x.work_date === last.work_date)?.clock_in ?? null : null;
      const week = ((e.data as { hours: number }[] | null) ?? []).reduce((t, r) => t + (Number(r.hours) || 0), 0);
      if (live) setS({ firstIn: first, daysAt: new Set(att.map((x) => x.work_date)).size, week, notes: rn.error ? null : (rn.data as { job_id: string }[]) });
    })();
    return () => { live = false; };
    // Re-read when the running job changes: stopping a job adds time to the timesheet.
  }, [supabase, meId, running?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const signer = (j: Job) => (j.sign_owner ?? j.reviewer_id ?? j.assignee_id) === meId;
  const isReview = (j: Job) => j.status === "review" && (j.reviewer_id === meId || (!j.reviewer_id && j.assignee_id === meId));
  const isSign = (j: Job) => j.status === "to_lodge" || j.status === "sent_for_sign" || j.status === "client_query";
  const over = (j: Job) => !!j.due_date && daysFrom(j.due_date) < 0;
  const noteJobs = new Set((s?.notes ?? []).map((n) => n.job_id));
  const ordered = [...jobs].sort((a, b) => (a.id === running?.job_id ? -1 : b.id === running?.job_id ? 1 : 0)
    || Number(over(b)) - Number(over(a)) || Number(b.priority === "high") - Number(a.priority === "high") || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
  const rank = new Map(ordered.map((j, i) => [j.id, i + 1]));
  const PILLS: [Kind, string, (j: Job) => boolean, boolean][] = [
    ["all", "My tasks", () => true, false],
    ["overdue", "Overdue", over, true],
    ["review", "To review", isReview, false],
    ["sign", "Signing & client queries", isSign, false],
    ...(s?.notes ? [["notes", "Review notes", (j: Job) => noteJobs.has(j.id), true] as [Kind, string, (j: Job) => boolean, boolean]] : []),
  ];
  const f = PILLS.find((p) => p[0] === kind)?.[2] ?? (() => true);
  const list = ordered.filter(f);
  const shown = all ? list : list.slice(0, 10);

  const late = s?.firstIn ? officeMinutes(s.firstIn) - START : 0;
  const daysTarget = workDaysSoFar();
  const openNotes = s?.notes?.length ?? 0;

  const sub = (j: Job) => {
    if (running?.job_id === j.id) return <><span className="runtxt">● Running {elapsed(running.started_at, now)}</span> · {ST[j.status]?.label}</>;
    if (isReview(j)) return j.assignee_id && j.assignee_id !== meId ? `Prepared by ${personName(j.assignee_id)}` : "Review";
    if (j.status === "internal_query") return j.assignee_id !== meId ? `With ${personName(j.assignee_id)} for an internal query` : `Internal query from ${personName(j.query_from ?? null)}`;
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
    if (isReview(j)) return <>{timer(j, "Start review")}{j.service === "payroll" ? <button type="button" onClick={onPayroll}>Sign off in Payroll</button> : <>
      <button type="button" disabled={busy} onClick={() => onSendBack(j)}>Send back</button>
      <button type="button" className="primary" disabled={busy} onClick={() => onApprove(j)}>{j.needs_signature === false ? "Approve & complete" : "Approve"}</button></>}</>;
    if (j.status === "to_lodge") return <>{timer(j)}<button type="button" className="primary" disabled={busy} onClick={() => onSentForSign(j)}>Sent for signing</button></>;
    if (j.status === "sent_for_sign") return <button type="button" className="primary" disabled={busy} onClick={() => onSigned(j)}>Client signed</button>;
    if (j.status === "client_query") return <button type="button" className="primary" disabled={busy} onClick={() => onReplied(j)}>Client replied</button>;
    if (j.status === "internal_query" && j.assignee_id !== meId) return <span className="pill danger">Away</span>;
    if (j.status === "internal_query" && j.query_from) return <>{timer(j)}<button type="button" disabled={busy} onClick={() => onAnswer(j)}>Send back</button></>;
    return timer(j);
  };
  const showStatus = (j: Job) => !isReview(j) && !isSign(j) && !(j.status === "internal_query");

  return (
    <>
      <div className="pagehead staffhead">
        <div><h1>My tasks <span className="pill info" style={{ fontSize: 13, verticalAlign: "middle" }}>{jobs.length}</span></h1><p>{greetingFor(now)} {firstName}. Your work for today, most urgent first.</p></div>
        <div className="quickpills" style={{ margin: 0 }}>{PILLS.map(([k, l, pf, hot]) => { const n = ordered.filter(pf).length; return (
          <button key={k} type="button" className={kind === k ? "on" : undefined} onClick={() => setKind(k)}>{l} <i className={hot && n && kind !== k ? "hot" : undefined}>{n}</i></button>); })}</div>
      </div>
      {s?.firstIn ? <div className={`loginbar${late > 0 ? " late" : ""}`}>🕘 Logged in <b>{clock(s.firstIn)}</b>{late > 0 ? <> · {late < 60 ? `${late} min` : hm(late / 60)} after 7:30, so your suggested log-out time today is <b>{clock(suggestedOut(s.firstIn))}</b></> : <> · your suggested log-out time today is <b>{clock(suggestedOut(s.firstIn))}</b></>} (8h 15m of work plus the 45 min break).</div> : null}
      <div className="stattiles">
        <div className="panel"><span className="lbl">Days at work this month</span><span className="val">{s ? s.daysAt : "…"} <small>of {daysTarget} working day{daysTarget === 1 ? "" : "s"}</small></span>
          <i className="bar"><b style={{ width: `${s ? Math.min(100, (s.daysAt / Math.max(1, daysTarget)) * 100) : 0}%` }} /></i></div>
        <div className="panel"><span className="lbl">Hours logged this week</span><span className="val">{s ? `${Number(s.week.toFixed(1))}h` : "…"}</span>
          <span className="note">Target 49h 30m (Mon to Sat, 8h 15m a day){s ? ` · ${Math.round((s.week / WEEK_TARGET) * 100)}%` : ""}</span></div>
        <div className="panel"><span className="lbl">Jobs completed this month</span><span className="val">{closedThisMonth}</span><span className="note">Last month {closedLastMonth}</span></div>
        <div className="panel"><span className="lbl">Open review notes</span><span className={`val${openNotes ? " danger" : ""}`}>{s?.notes ? openNotes : "—"}</span>
          <span className="note">{s && !s.notes ? "Review notes aren't switched on yet" : openNotes ? "Fix them before you resubmit" : "Nothing to fix"}</span></div>
      </div>
      <div className="panel tasklist">
        <div className="ph"><h2>Task list</h2><span className="note">Time left turns amber within 2 days and red once overdue</span></div>
        {!list.length ? <div className="empty"><strong>{jobs.length ? "Nothing in this list." : "No open jobs assigned to you."}</strong>{jobs.length ? "Pick another filter above." : "Jobs assigned to you show here, ready to start."}</div> : (
          <div style={{ overflowX: "auto" }}>
            <table className="jobtable"><thead><tr><th>Client · practice</th><th>Task</th><th>Due / time left</th><th>Status</th><th>Priority</th><th></th></tr></thead>
              <tbody>{shown.map((j) => { const [cn, cl] = clientLine(j); const r = rank.get(j.id) ?? 0; return (
                <tr key={j.id} className={`${running?.job_id === j.id ? "running" : ""}${over(j) ? " over" : ""}`}>
                  <td className="client">{cn}<div className="note">{cl}</div></td>
                  <td><button type="button" className="link jobname" onClick={() => onOpen(j)}>{svcLabel(j.service)} {j.period}{isReview(j) ? " · Review" : ""}</button>
                    <div className="note">{sub(j)}</div></td>
                  <td>{due(j)}</td>
                  <td>{showStatus(j) ? statusEl(j) : <span className={`pill ${ST[j.status]?.cls ?? ""}`}>{ST[j.status]?.label ?? j.status}</span>}</td>
                  <td><span className={`rank${over(j) ? " hot" : ""}`} title={j.priority === "high" ? "High priority" : undefined}>{r}</span>{j.priority === "high" ? <span className="pill danger" style={{ marginLeft: 6 }}>High</span> : null}</td>
                  <td><div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>{action(j)}</div></td>
                </tr>); })}</tbody></table>
          </div>)}
        <div className="count">Showing {shown.length} of {list.length}{list.length > shown.length ? <> · <button type="button" className="link" onClick={() => setAll(true)}>show all</button></> : null} · click a task to open its job page</div>
      </div>
      {children}
    </>
  );
}

function greetingFor(now: number) { const h = new Date(now).getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; }
