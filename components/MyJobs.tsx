"use client";
import { useEffect, useState } from "react";
import type { Job, JobTimer, StatusId } from "@/lib/types";
import { STATUSES, ST, daysFrom, fmtDate, svcLabel } from "@/lib/domain";

export const fmtHours = (h: number) => { const m = Math.max(1, Math.round(h * 60)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`; };
const elapsed = (from: string, now: number) => { const m = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };

/** The signed-in person's open jobs, with Start / Stop, status and Submit for review. */
export default function MyJobs({ jobs, running, clientName, reviewerName, busy, onStart, onStop, onStatus, onSubmit, onOpen, onSeeAll }: {
  jobs: Job[];
  running: JobTimer | null;
  clientName: (id: string) => string;
  reviewerName: string;
  busy: boolean;
  onStart: (j: Job) => void;
  onStop: () => void;
  onStatus: (j: Job, s: StatusId) => void;
  onSubmit: (j: Job) => void;
  onOpen: (j: Job) => void;
  onSeeAll: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, [running]);
  const list = [...jobs].sort((a, b) => (a.id === running?.job_id ? -1 : b.id === running?.job_id ? 1 : (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999")));
  const shown = list.slice(0, 10);
  return (
    <div className="panel myjobs">
      <div className="ph"><h2>My jobs</h2>{jobs.length ? <button className="link" onClick={onSeeAll}>See all {jobs.length}</button> : null}</div>
      {!jobs.length ? <div className="empty"><strong>No open jobs assigned to you.</strong>Jobs assigned to you show here, ready to start.</div> : (
        <ul className="list">{shown.map((j) => {
          const on = running?.job_id === j.id;
          const d = j.due_date ? daysFrom(j.due_date) : null;
          const canSubmit = j.status !== "review" && j.status !== "to_lodge";
          return (
            <li key={j.id} className={on ? "running" : ""}>
              <div style={{ minWidth: 0 }}>
                <div className="t"><button className="link" style={{ color: "var(--fg)", fontWeight: 600 }} onClick={() => onOpen(j)}>{clientName(j.client_id)}</button></div>
                <div className="s">{svcLabel(j.service)} · {j.period}{j.due_date ? <> · <span className={d! < 0 ? "danger" : d! <= 7 ? "warn" : ""}>{d! < 0 ? `${-d!}d overdue` : `due ${fmtDate(j.due_date)}`}</span></> : null}</div>
              </div>
              <div className="row actions">
                {on ? <>
                  <span className="timer mono" title={`Started ${new Date(running!.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}>● {elapsed(running!.started_at, now)}</span>
                  <button disabled={busy} onClick={onStop}>Stop</button>
                </> : <button className="primary" disabled={busy} onClick={() => onStart(j)}>Start</button>}
                <select aria-label="Status" className={`statussel ${ST[j.status]?.cls ?? ""}`} value={j.status} disabled={busy} onChange={(e) => onStatus(j, e.target.value as StatusId)}>
                  {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                {canSubmit ? <button disabled={busy} onClick={() => onSubmit(j)} title={reviewerName ? `Send to ${reviewerName} for review` : "Mark ready for review"}>Submit for review</button> : null}
              </div>
            </li>);
        })}</ul>)}
      {running && !jobs.some((j) => j.id === running.job_id) ? (
        <div className="note" style={{ padding: "8px 14px" }}>A job is running ({elapsed(running.started_at, now)}). <button className="link" onClick={onStop}>Stop it</button></div>) : null}
      <div className="note" style={{ padding: "8px 14px 12px" }}>Start a job when you begin; Stop or Submit for review adds the time to your timesheet.</div>
    </div>
  );
}
