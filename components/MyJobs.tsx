"use client";
import { useEffect, useState } from "react";
import type { Job, JobTimer, StatusId } from "@/lib/types";
import { STATUSES, ST, STAFF_CANT_PICK, SUBMITTED_LOCK_MSG, staffSubmittedLock, daysFrom, fmtDate, svcLabel } from "@/lib/domain";
import { dateOf, isLink, timeOf, type Meeting } from "./Meetings";

export const fmtHours = (h: number) => { const m = Math.max(1, Math.round(h * 60)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`; };
const elapsed = (from: string, now: number) => { const m = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };

function Due({ date }: { date: string | null }) {
  if (!date) return <span className="duechip none">No due date</span>;
  const d = daysFrom(date);
  const when = d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
  return <span className={`duechip ${d < 0 ? "over" : d <= 7 ? "soon" : ""}`} title={`Due ${fmtDate(date)}`}><b>Due {fmtDate(date)}</b><span>{when}</span></span>;
}

/** The signed-in person's open jobs, with Start / Stop, status and Submit for review. */
export default function MyJobs({ jobs, meetings = [], onOpenMeeting, onMeetingDone, myId, personName, running, clientName, reviewerName, busy, onStart, onStop, onStatus, onSubmit, wasStarted, onApprove, onSendBack, onPayroll, isStaff, onOpenClient, onSigned, onSentForSign, onFollowedUp, onHandSign, onComplete, onAnswer, onOpen, onSeeAll }: {
  jobs: Job[];
  meetings?: Meeting[];
  onOpenMeeting?: (m: Meeting) => void;
  onMeetingDone?: (m: Meeting) => void;
  myId: string;
  personName: (id: string | null) => string;
  onAnswer: (j: Job) => void;
  running: JobTimer | null;
  clientName: (id: string) => string;
  reviewerName: string;
  busy: boolean;
  onStart: (j: Job) => void;
  onHandSign?: (j: Job) => void;
  onComplete?: (j: Job) => void;
  onStop: () => void;
  onStatus: (j: Job, s: StatusId) => void;
  onSubmit: (j: Job) => void;
  wasStarted?: (j: Job) => boolean;
  onApprove?: (j: Job) => void;
  onSendBack?: (j: Job) => void;
  onPayroll?: () => void;
  isStaff?: boolean;
  onFollowedUp?: (j: Job) => void;
  onOpenClient?: (id: string) => void;
  onSigned?: (j: Job) => void;
  onSentForSign?: (j: Job) => void;
  onOpen: (j: Job) => void;
  onSeeAll: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!running && !meetings.length) return; const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, [running, meetings.length]);
  const list = [...jobs].sort((a, b) => (a.id === running?.job_id ? -1 : b.id === running?.job_id ? 1 : (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999")));
  const shown = list.slice(0, 10);
  return (
    <div className="panel myjobs">
      <div className="ph"><h2>My jobs</h2>{jobs.length ? <button className="link" onClick={onSeeAll}>See all {jobs.length}</button> : null}</div>
      {meetings.length ? <ul className="list">{meetings.map((m) => { const at = new Date(m.starts_at).getTime(); const nowOn = at <= now && now < at + m.duration_min * 60000; return (
        <li key={m.id} className={`meetrow${nowOn ? " running" : ""}`}><span className="num">{meetings.indexOf(m) + 1}</span><div style={{ minWidth: 0 }}>
          <div className="t"><span className="pill accent">Meeting</span><button className="link" style={{ color: "var(--fg)", fontWeight: 600 }} onClick={() => onOpenMeeting?.(m)}>{m.title}</button></div>
          <div className="s">{nowOn ? "Now" : at + m.duration_min * 60000 < now ? <span className="danger">Was {dateOf(m.starts_at)}</span> : dateOf(m.starts_at)} · {timeOf(m.starts_at)} · {m.duration_min} min{m.location && !isLink(m.location) ? ` · ${m.location}` : ""}</div></div>
          <div className="row actions">{isLink(m.location) ? <a className="btnlink" href={m.location} target="_blank" rel="noreferrer">Join</a> : null}
            {m.owner_id === myId ? <button onClick={() => onMeetingDone?.(m)}>Done</button> : null}</div></li>); })}</ul> : null}
      {!jobs.length && meetings.length ? null : !jobs.length ? <div className="empty"><strong>No open jobs assigned to you.</strong>Jobs assigned to you show here, ready to start.</div> : (
        <ul className="list">{shown.map((j, i) => {
          const on = running?.job_id === j.id;
          const d = j.due_date ? daysFrom(j.due_date) : null;
          const canSubmit = j.status !== "review" && j.status !== "to_lodge";
          const away = j.assignee_id !== myId; // I sent it for an internal query
          const incoming = !away && j.status === "internal_query" && !!j.query_from;
          const readySign = j.status === "to_lodge" && (j.sign_owner ?? j.reviewer_id ?? j.assignee_id) === myId;
          const signing = j.status === "sent_for_sign";
          const signDays = signing && j.sign_sent_at ? Math.floor((now - new Date(j.sign_sent_at).getTime()) / 864e5) : 0;
          const cq = j.status === "client_query";
          const cqDays = cq && j.sign_sent_at ? Math.floor((now - new Date(j.sign_sent_at).getTime()) / 864e5) : 0;
          const reviewing = j.status === "review" && (j.reviewer_id === myId || (!j.reviewer_id && j.assignee_id === myId));
          return (
            <li key={j.id} className={`${readySign ? "readysign " : ""}${signing ? (signDays >= 2 ? "signtask chase " : "signtask ") : ""}${cq ? "signtask chase " : ""}${on ? "running" : away ? "away" : d !== null && d < 0 ? "overdue" : ""}${reviewing ? " reviewtask" : ""}`}>
              <span className="num">{meetings.length + i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <div className="t jobtask">{reviewing ? <span className="pill accent">Review</span> : null}{signing ? <span className="pill warn">Sent for sign</span> : null}{cq ? <span className="pill warn">Query with client</span> : null}{readySign ? <span className="pill accent">Ready for signing</span> : null}<button className="link" onClick={() => onOpen(j)}>{svcLabel(j.service)} <span className="per">{j.period}</span></button>{j.priority === "high" ? <span className="pill danger">High priority</span> : null}</div>
                <div className="jobclient">{onOpenClient ? <button className="link clientlink" title="Open client profile" onClick={() => onOpenClient(j.client_id)}>{clientName(j.client_id)}</button> : clientName(j.client_id)}{reviewing && j.assignee_id && j.assignee_id !== myId ? <span className="prep"> · Prepared by {personName(j.assignee_id)}</span> : null}</div>
                {j.notes?.trim() ? <div className="jobnote" title={j.notes}>{j.notes.trim().split("\n")[0]}</div> : null}
                {readySign ? <div className="signnote ready">Approved. Send it to the client for signing, then click the button.</div> : null}
                {signing ? <div className={`signnote${signDays >= 2 ? " chase" : ""}`}>{signDays >= 2 ? `Sent ${signDays} days ago. Contact the client and ask them to sign.` : signDays === 1 ? "Sent yesterday. Waiting for the client's signature." : "Sent today. Waiting for the client's signature."}</div> : null}
                {cq ? <div className="signnote chase">{cqDays >= 2 ? `Query sent ${cqDays} days ago and no reply yet. Follow up with the client.` : "Query sent to the client. Waiting for their reply."}</div> : null}
                <div className="duerow"><Due date={j.due_date} /></div>
                {incoming ? <div className="s"><span className="pill danger">Internal query from {personName(j.query_from ?? null)}</span></div> : null}
              </div>
              {readySign ? <div className="row actions">
                {on ? <>
                  <span className="timer mono">● {elapsed(running!.started_at, now)}</span>
                  <button disabled={busy} onClick={onStop}>Stop</button>
                </> : <button disabled={busy} onClick={() => onStart(j)} title="Time goes to your timesheet">Start</button>}
                {onHandSign ? <button disabled={busy} onClick={() => onHandSign(j)} title="Give this job to a team member to send for signing">Hand to…</button> : null}
                {onComplete && j.needs_signature === false ? <button disabled={busy} onClick={() => onComplete(j)} title="Nothing to sign: close the job as Completed">No signing needed, complete</button> : null}
                <button className="primary" disabled={busy} onClick={() => onSentForSign?.(j)}>Sent to client for signing</button>
              </div> : signing ? <div className="row actions">
                {on ? <>
                  <span className="timer mono">● {elapsed(running!.started_at, now)}</span>
                  <button disabled={busy} onClick={onStop}>Stop</button>
                </> : <button disabled={busy} onClick={() => onStart(j)} title="Time goes to your timesheet">Start</button>}
                {onHandSign ? <button disabled={busy} onClick={() => onHandSign(j)} title="Give the signing follow-up to a team member">Hand to…</button> : null}
                <button className="primary" disabled={busy} onClick={() => onSigned?.(j)}>Client signed, mark lodged</button>
              </div> : cq ? <div className="row actions">
                {cqDays >= 2 && onFollowedUp ? <button disabled={busy} onClick={() => onFollowedUp(j)}>Followed up, remind me in 2 days</button> : null}
                <button className="primary" disabled={busy} onClick={() => onStatus(j, "in_progress")}>Client replied, back to work</button>
              </div> : reviewing ? <div className="row actions">
                {on ? <>
                  <span className="timer mono">● {elapsed(running!.started_at, now)}</span>
                  <button disabled={busy} onClick={onStop}>Stop</button>
                </> : <button disabled={busy} onClick={() => onStart(j)}>Start review</button>}
                {j.service === "payroll" ? <button className="primary" onClick={() => onPayroll?.()}>Sign off in Payroll</button> : <>
                  <button disabled={busy} onClick={() => onSendBack?.(j)}>Send back</button>
                  <button className="primary" disabled={busy} onClick={() => onApprove?.(j)} title={j.needs_signature === false ? "Nothing to sign: approving completes the job" : "Approve: it moves to Ready for signing"}>{j.needs_signature === false ? "Approve & complete" : "Approve"}</button>
                </>}
              </div> : away ? <div className="row actions"><span className="pill danger">With {personName(j.assignee_id)} for internal query</span></div> : <div className="row actions">
                {on ? <>
                  <span className="timer mono" title={`Started ${new Date(running!.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}>● {elapsed(running!.started_at, now)}</span>
                  <button disabled={busy} onClick={onStop}>Stop</button>
                </> : <button className="primary" disabled={busy} onClick={() => onStart(j)}>Start</button>}
                {incoming ? <button disabled={busy} onClick={() => onAnswer(j)}>Send back</button> : <>
                <select aria-label="Status" className={`statussel ${ST[j.status]?.cls ?? ""}`} value={j.status} disabled={busy || (isStaff && staffSubmittedLock(j, myId)) || (isStaff && !!wasStarted && !wasStarted(j))} title={isStaff && staffSubmittedLock(j, myId) ? SUBMITTED_LOCK_MSG : isStaff && wasStarted && !wasStarted(j) ? "Press Start first, then you can change the status" : undefined} onChange={(e) => onStatus(j, e.target.value as StatusId)}>
                  {STATUSES.map((s) => <option key={s.id} value={s.id} disabled={isStaff && STAFF_CANT_PICK.has(s.id) && s.id !== j.status && j.reviewer_id !== myId}>{s.label}</option>)}
                </select>
                {canSubmit ? (wasStarted && !wasStarted(j)
                  ? <button disabled title="Press Start first. A job can only be submitted once it has been started.">Submit for review</button>
                  : <button disabled={busy} onClick={() => onSubmit(j)} title={reviewerName ? `Send to ${reviewerName} for review` : "Mark ready for review"}>Submit for review</button>) : null}
                </>}
              </div>}
            </li>);
        })}</ul>)}
      {running && !jobs.some((j) => j.id === running.job_id) ? (
        <div className="note" style={{ padding: "8px 14px" }}>A job is running ({elapsed(running.started_at, now)}). <button className="link" onClick={onStop}>Stop it</button></div>) : null}
      <div className="note" style={{ padding: "8px 14px 12px" }}>Start a job when you begin; Stop or Submit for review adds the time to your timesheet.</div>
    </div>
  );
}

/** Managers and master admins: who is working on what right now, and the total time on each job. */
export function TeamRunning({ timers, jobHours, jobById, clientName, personName, onOpen }: {
  timers: JobTimer[];
  jobHours: Record<string, number>;
  jobById: (id: string) => Job | undefined;
  clientName: (id: string) => string;
  personName: (id: string | null) => string;
  onOpen: (j: Job) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!timers.length) return; const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, [timers.length]);
  return (
    <div className="panel workingnow">
      <div className="ph"><h2>Working now</h2><span className="note">{timers.length ? `${timers.length} running` : "Live"}</span></div>
      {!timers.length ? <div className="empty"><strong>Nobody has a job running.</strong>When your team presses Start on a job, it shows here.</div> : (
        <ul className="list">{timers.map((t) => {
          const j = jobById(t.job_id as string);
          const runH = Math.max(0, (now - new Date(t.started_at).getTime()) / 3600000);
          const total = (jobHours[t.job_id as string] ?? 0) + runH;
          return (
            <li key={t.id}>
              <div style={{ minWidth: 0 }}>
                <div className="t">{personName(t.user_id)}</div>
                <div className="s">{j ? <button className="link" onClick={() => onOpen(j)}>{clientName(j.client_id)}</button> : "A job"}{j ? ` · ${svcLabel(j.service)} · ${j.period}` : ""}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="timer mono" title={`Started ${new Date(t.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}>● {elapsed(t.started_at, now)}</div>
                <div className="note">Total on job {fmtHours(total)}</div>
              </div>
            </li>);
        })}</ul>)}
    </div>
  );
}
