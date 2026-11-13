"use client";
import type { ReactNode } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Client, Job, JobTimer, Person } from "@/lib/types";
import { ST, daysFrom, fmtDate, isOpen, practiceOf, svcLabel } from "@/lib/domain";
import { STEPS } from "@/lib/checklists";
import JobBrief from "./JobBrief";
import JobFiles from "./JobFiles";
import JobHistory from "./JobHistory";
import { fmtHours } from "./MyJobs";

type SB = ReturnType<typeof createClient>;
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("").toUpperCase() || "—";

/** A job on its own page: the stages it goes through, its checklist, review notes and queries, files and history. */
export default function JobPage({ job, client, meId, team, canAnswerAll, canDelete, readOnly, supabase, personName, say, statusEl, hours, running, busy,
  onStart, onStop, wasStarted, onBack, onEdit, onOpenClient, onNewClient }: {
  job: Job; client?: Client; meId: string; team: Person[]; canAnswerAll: boolean; canDelete: boolean; readOnly: boolean; supabase: SB;
  personName: (id: string | null) => string; say: (m: string, e?: boolean) => void; statusEl: ReactNode; hours: number;
  running: JobTimer | null; busy: boolean; onStart: (j: Job) => void; onStop: () => void; wasStarted: (j: Job) => boolean;
  onBack: () => void; onEdit: (tab?: "email") => void; onOpenClient: (id: string) => void; onNewClient: () => void;
}) {
  const st = ST[job.status];
  const d = job.due_date ? daysFrom(job.due_date) : null;
  const open = isOpen(job.status);
  const stage = !open ? 4 : job.status === "review" ? 1 : job.status === "to_lodge" || job.status === "sent_for_sign" ? 2 : 0;
  const on = running?.job_id === job.id;
  const signer = job.sign_owner ?? job.reviewer_id ?? job.assignee_id;
  const rows: { t: string; who: string | null; s: string }[] = [
    { t: "Preparation", who: job.assignee_id, s: stage > 0 ? "Done and sent on" : `${st?.label ?? ""}${wasStarted(job) ? "" : " · not started yet"}` },
    { t: "Review", who: job.reviewer_id, s: stage > 1 ? "Approved" : stage === 1 ? "Reviewing now" : "Opens when preparation is sent to review" },
    { t: "Client signature", who: job.needs_signature === false ? null : signer, s: job.needs_signature === false ? "Not needed for this job" : job.status === "sent_for_sign" ? `Sent for signing${job.sign_sent_at ? ` ${fmtDate(job.sign_sent_at.slice(0, 10))}` : ""}` : stage > 2 ? "Signed" : "Send for signing, then mark signed" },
    { t: job.needs_signature === false ? "Complete" : "Lodge", who: null, s: !open ? `${job.status === "done" ? "Completed" : "Lodged"}${job.lodged_on ? ` ${fmtDate(job.lodged_on)}` : ""}` : "Lodgment date and receipt" },
  ];
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <>
      <div className="crumb"><button type="button" className="link" onClick={onBack}>← Jobs</button> / Job page</div>
      <div className="jobhero">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <h1>{client?.name ?? "Deleted client"} <span>· {svcLabel(job.service)} {job.period}</span></h1>
          <div className="row"><span className={`pill ${st?.cls ?? ""}`}>{st?.label ?? job.status}</span>{!readOnly ? <button type="button" onClick={() => onEdit()}>✎ Edit job</button> : null}</div>
        </div>
        <div className="facts">
          <span>Practice <b>{practiceOf(client)}</b></span><span>Entity <b>{client?.entity ?? "—"}</b></span>
          <span>Due <b>{job.due_date ? fmtDate(job.due_date) : "not set"}</b>{open && d !== null && d < 0 ? <> <span className="pill danger">{-d} day{d === -1 ? "" : "s"} overdue</span></> : open && d !== null && d <= 7 ? <> <span className="pill warn">{d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"} left`}</span></> : null}</span>
          <span>Priority <b>{job.priority === "high" ? "High" : "Normal"}</b></span>
          <span>Client signature <b>{job.needs_signature === false ? "Not needed" : "Needed"}</b></span>
        </div>
        <div className="counts">
          <button type="button" className="count" onClick={() => go("jp-work")}>{STEPS[job.service] ? "Steps" : "Checklist"}</button>
          <button type="button" className="count" onClick={() => go("review-notes")}>Review notes</button>
          <button type="button" className="count" onClick={() => go("jp-work")}>Internal queries</button>
          <button type="button" className="count" onClick={() => go("jp-files")}>Files</button>
          <span className="count blue">Stage <i>{Math.min(stage + 1, 4)} of 4</i></span>
          <button type="button" className="count" onClick={() => go("jp-history")}>Time logged <i className="dark">{fmtHours(hours)}</i></button>
          <span style={{ flex: 1 }} />
          {!readOnly ? <button type="button" onClick={() => onEdit("email")}>✉ Email client</button> : null}
        </div>
      </div>

      <div className="jobgrid">
        <div className="jobmain">
          <div className="panel">
            <div className="ph"><h2>Stages</h2><span className="note">Change the status from the list on the current stage</span></div>
            <ol className="jstages">{rows.map((r, i) => { const cls = i < stage ? "done" : i === stage ? "now" : ""; return (
              <li key={r.t} className={cls}>
                <span className="dot">{i < stage ? "✓" : i + 1}</span>
                <div style={{ minWidth: 0 }}><div className="t">{r.t}{r.who ? ` · ${personName(r.who)}` : ""}</div><div className="s">{r.s}</div></div>
                <div className="row jsact">
                  {i === stage && open ? <>
                    {i === 0 && job.assignee_id === meId && !readOnly ? (on ? <><span className="timer mono">● running</span><button type="button" disabled={busy} onClick={onStop}>Stop</button></> : <button type="button" disabled={busy} onClick={() => onStart(job)}>Start</button>) : null}
                    {statusEl}
                  </> : null}
                  {r.who ? <span className="av" title={personName(r.who)}>{initials(personName(r.who))}</span> : null}
                </div>
              </li>); })}</ol>
          </div>
          <div className="panel" id="jp-work" style={{ padding: "4px 16px 12px" }}>
            <JobBrief job={job} clientName={client?.name ?? ""} showInfo={false} meId={meId} canAnswerAll={canAnswerAll} team={team} defaultTo={job.reviewer_id} readOnly={readOnly}
              supabase={supabase} personName={personName} say={say} onNewClient={onNewClient} />
          </div>
          <div className="panel" id="jp-files" style={{ padding: "12px 16px" }}><h2>Files</h2>
            <JobFiles jobId={job.id} meId={meId} canDelete={canDelete} readOnly={readOnly} supabase={supabase} personName={personName} say={say} /></div>
          <div className="panel" id="jp-history" style={{ padding: "12px 16px" }}><h2>Job history and time</h2>
            <JobHistory jobId={job.id} readOnly={readOnly} meId={meId} canDelete={canDelete} supabase={supabase} personName={personName} say={say} /></div>
        </div>
        <aside className="jobside">
          <div className="panel"><div className="ph"><h2>Job notes</h2></div><div style={{ padding: "0 14px 14px", whiteSpace: "pre-wrap" }}>{job.notes?.trim() || <span className="note">No notes on this job.</span>}</div></div>
          <div className="panel"><div className="ph"><h2>People</h2></div>
            <dl className="people"><dt>Assigned</dt><dd>{personName(job.assignee_id) || "Nobody"}</dd><dt>Reviewer</dt><dd>{personName(job.reviewer_id) || "None"}</dd><dt>Signing</dt><dd>{job.needs_signature === false ? "Not needed" : personName(signer) || "—"}</dd></dl></div>
          <div className="panel"><div className="ph"><h2>Other actions</h2></div>
            <ul className="actions">
              {!readOnly ? <li><button type="button" className="link" onClick={() => onEdit()}>✎ Edit job details</button></li> : null}
              {client ? <li><button type="button" className="link" onClick={() => onOpenClient(client.id)}>👤 Open the client page</button></li> : null}
              <li><button type="button" className="link" onClick={() => go("jp-history")}>🕘 Job history and time</button></li>
            </ul></div>
        </aside>
      </div>
    </>
  );
}
