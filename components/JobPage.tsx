"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Client, Job, JobTimer, Person } from "@/lib/types";
import { ST, daysFrom, fmtDate, isOpen, practiceOf, svcLabel } from "@/lib/domain";
import { STEPS, checklistFor } from "@/lib/checklists";
import JobBrief from "./JobBrief";
import JobFiles from "./JobFiles";
import JobHistory from "./JobHistory";
import { fmtHours } from "./MyJobs";

type SB = ReturnType<typeof createClient>;
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("").toUpperCase() || "—";

/** A job on its own page: the stages it goes through, its checklist, review notes and queries, files and history. */
/** Hours as "1h 20m". */
export const hm = (h: number) => { const m = Math.round(h * 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`; };

export default function JobPage({ job, client, meId, team, canAnswerAll, canDelete, readOnly, supabase, personName, say, statusEl, hours, running, busy,
  onStart, onStop, wasStarted, onBack, onEdit, onOpenClient, onNewClient, flag, related = 0, onApprove, onSendBack, onHandSign, onRaised, onAnswered }: {
  flag?: { q: number; rn: number; f: number }; related?: number; onApprove?: (j: Job) => void; onSendBack?: (j: Job) => void; onHandSign?: (j: Job) => void;
  onRaised?: (j: Job, kind: "internal" | "client") => void; onAnswered?: (j: Job, stillOpen: number) => void;
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
    { t: "Preparation", who: job.assignee_id, s: stage > 0 ? "Done and sent to review" : `${st?.label ?? ""}${wasStarted(job) ? "" : " · not started yet"}` },
    { t: "Review", who: job.reviewer_id, s: stage > 1 ? "Approved" : stage === 1 ? "Reviewing now" : "Opens when preparation is sent to review" },
    { t: "Client signature", who: job.needs_signature === false ? null : signer, s: job.needs_signature === false ? "Not needed for this job" : job.status === "sent_for_sign" ? `Sent for signing${job.sign_sent_at ? ` ${fmtDate(job.sign_sent_at.slice(0, 10))}` : ""}` : stage > 2 ? "Signed" : "Send for signing, then mark signed" },
    { t: job.needs_signature === false ? "Complete" : "Lodge", who: null, s: !open ? `${job.status === "done" ? "Completed" : "Lodged"}${job.lodged_on ? ` ${fmtDate(job.lodged_on)}` : ""}` : "Lodgment date and receipt" },
  ];
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  // Small counts for the chips and the summary panel.
  const [c, setC] = useState<{ checks: number; cnotes: number | null; mnotes: number | null; cq: number }>({ checks: 0, cnotes: null, mnotes: null, cq: 0 });
  useEffect(() => {
    let live = true;
    (async () => {
      const [ch, cn, mn] = await Promise.all([
        supabase.from("job_checks").select("item").eq("job_id", job.id),
        supabase.from("client_notes").select("id").eq("client_id", job.client_id),
        supabase.from("client_mgmt_notes").select("id").eq("client_id", job.client_id),
      ]);
      if (live) setC({ checks: ch.data?.length ?? 0, cnotes: cn.error ? null : cn.data?.length ?? 0, mnotes: mn.error ? null : mn.data?.length ?? 0, cq: job.status === "client_query" ? 1 : 0 });
    })();
    return () => { live = false; };
  }, [supabase, job.id, job.client_id, job.status]);
  // Time logged on this job, split by task: preparation, review, signing, and each internal query answer.
  const [ents, setEnts] = useState<{ user_id: string; hours: number; description: string; created_at: string }[]>([]);
  useEffect(() => {
    let live = true;
    supabase.from("timesheet_entries").select("user_id,hours,description,created_at").eq("job_id", job.id)
      .then(({ data }) => { if (live) setEnts(((data as typeof ents | null) ?? []).map((e) => ({ ...e, hours: Number(e.hours) || 0 }))); });
    return () => { live = false; };
  }, [supabase, job.id, hours]); // eslint-disable-line react-hooks/exhaustive-deps
  const isAnswer = (e: { description: string }) => e.description.startsWith("Answering internal query");
  const stageOf = (e: { user_id: string; description: string }) => {
    if (/^(Preparing for signing|Signing follow-up)/.test(e.description)) return 2;
    if (e.user_id === job.reviewer_id && e.user_id !== job.assignee_id) return 1;
    return 0;
  };
  const stageHrs = [0, 1, 2, 3].map((i) => ents.filter((e) => !isAnswer(e) && stageOf(e) === i).reduce((t, e) => t + e.hours, 0));
  const queryHours = (q: { to_id: string | null; created_at: string; answered_at: string | null }) => ents
    .filter((e) => isAnswer(e) && e.user_id === q.to_id && e.created_at >= q.created_at && (!q.answered_at || Date.parse(e.created_at) <= Date.parse(q.answered_at) + 5 * 60e3))
    .reduce((t, e) => t + e.hours, 0);
  const total = checklistFor(job.service).length;
  const reviewing = job.status === "review" && (job.reviewer_id === meId || canAnswerAll) && !readOnly;
  const head = (i: number) => { const r = rows[i]; const cls = i < stage ? "done" : i === stage ? "now" : "";
    return <div className={`taskhead ${cls}`}>
      <span className="tdot">{i < stage ? "✓" : i + 1}</span>
      <div style={{ minWidth: 0, flex: 1 }}><div className="tkt">{r.t}{r.who ? ` · ${personName(r.who)}${r.who === meId ? " (you)" : ""}` : ""}</div>
        <div className="tks">{i === stage && on ? <span className="runtxt">● Running · </span> : null}{r.s}</div></div>
      {stageHrs[i] ? <span className="tasktime mono" title="Time logged on this task">{hm(stageHrs[i])}</span> : null}
      <div className="row jsact">
        {i === stage && open ? <>
          {(i === 0 && job.assignee_id === meId || i === 1 && job.reviewer_id === meId) && !readOnly ? (on ? <><span className="timer mono">● running</span><button type="button" disabled={busy} onClick={onStop}>Stop</button></> : <button type="button" disabled={busy} onClick={() => onStart(job)}>{i === 1 ? "Start review" : "Start"}</button>) : null}
          {statusEl}
        </> : null}
        {r.who ? <span className="av" title={personName(r.who)}>{initials(personName(r.who))}</span> : <span className="av">—</span>}
      </div></div>; };

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
          <button type="button" className="count" onClick={() => go("jp-work")}>Internal queries <i className={flag?.q ? "red" : ""}>{flag?.q ?? 0}</i></button>
          <span className="count">Client queries <i className={c.cq ? "warn" : ""}>{c.cq}</i></span>
          <button type="button" className="count" onClick={() => go("jp-work")}>Review notes <i className={flag?.rn ? "red" : ""}>{flag?.rn ?? 0}</i></button>
          <button type="button" className="count" onClick={() => go("jp-files")}>Files <i className="blue">{flag?.f ?? 0}</i></button>
          {total ? <button type="button" className="count" onClick={() => go("jp-work")}>{STEPS[job.service] ? "Steps" : "Checklist"} <i className="green">{c.checks}/{total}</i></button> : null}
          <span className="count">Stage <i className="blue">{Math.min(stage + 1, 4)} of 4</i></span>
          <button type="button" className="count" onClick={() => go("jp-history")}>Time logged <i className="dark">{fmtHours(hours)}</i></button>
          {related && client ? <button type="button" className="count" onClick={() => onOpenClient(client.id)}>🔗 Related clients ({related})</button> : null}
          <span style={{ flex: 1 }} />
          {!readOnly ? <button type="button" onClick={() => onEdit("email")}>✉ Email client</button> : null}
          <button type="button" onClick={() => go("jp-files")}>📎 Files</button>
        </div>
      </div>

      <div className="jobgrid">
        <div className="jobmain">
          <div className="panel tasksp" id="jp-work">
            <div className="ph"><h2>Tasks</h2><span className="note">Each task has its own stage and person. Change the stage from the list on the current row.</span></div>
            <JobBrief job={job} clientName={client?.name ?? ""} showInfo={false} meId={meId} canAnswerAll={canAnswerAll} team={team} defaultTo={job.reviewer_id} readOnly={readOnly}
              supabase={supabase} personName={personName} say={say} onNewClient={onNewClient} onRaised={onRaised} onAnswered={onAnswered} timer={{ runningHere: running?.job_id === job.id, busy, start: onStart, stop: onStop }} queryHours={queryHours}
              tasks={{ prep: head(0), after: <>
                <li className={`task${stage === 1 ? " now" : stage > 1 ? " done" : " later"}`}>{head(1)}
                  {reviewing ? <div className="taskbody"><p className="note" style={{ margin: "0 0 8px" }}>Found a mistake? Add a review note above. When everything is cleared, approve it.</p>
                    <div className="row">{onSendBack ? <button type="button" disabled={busy} onClick={() => onSendBack(job)}>↩ Send back to {personName(job.assignee_id).split(" ")[0] || "the preparer"}</button> : null}
                      {onApprove ? <button type="button" className="primary" disabled={busy} onClick={() => onApprove(job)}>{job.needs_signature === false ? "Approve and complete" : "Approve → Client signature"}</button> : null}</div></div> : null}</li>
                <li className={`task${stage === 2 ? " now" : stage > 2 ? " done" : " later"}`}>{head(2)}</li>
                <li className={`task${stage > 3 ? " done" : " later"}`}>{head(3)}</li>
              </> }} />
          </div>
          <div className="panel" id="jp-files" style={{ padding: "12px 16px" }}><h2>Files</h2>
            <JobFiles jobId={job.id} meId={meId} canDelete={canDelete} readOnly={readOnly} supabase={supabase} personName={personName} say={say} /></div>
          <div className="panel" id="jp-history" style={{ padding: "12px 16px" }}><h2>Job history and time</h2>
            <JobHistory jobId={job.id} readOnly={readOnly} meId={meId} canDelete={canDelete} supabase={supabase} personName={personName} say={say} /></div>
        </div>
        <aside className="jobside">
          <div className="panel"><div className="ph"><h2>Job notes</h2></div><div style={{ padding: "0 14px 14px", whiteSpace: "pre-wrap" }}>{job.notes?.trim() || <span className="note">No notes on this job.</span>}</div></div>
          <div className="panel"><div className="ph"><h2>Summary</h2></div>
            <ul className="actions summary">
              <li><button type="button" className="link" onClick={() => go("jp-work")}>⚠️ Review notes</button><b className={flag?.rn ? "red" : ""}>{flag?.rn ?? 0}</b></li>
              {c.cnotes !== null && client ? <li><button type="button" className="link" onClick={() => onOpenClient(client.id)}>📝 Client notes</button><b>{c.cnotes}</b></li> : null}
              {c.mnotes !== null && client ? <li><button type="button" className="link" onClick={() => onOpenClient(client.id)}>🔒 Management notes</button><b>{c.mnotes}</b></li> : null}
              <li><button type="button" className="link" onClick={() => go("jp-history")}>🕘 Job history and time</button><b>{fmtHours(hours)}</b></li>
              {client ? <li><button type="button" className="link" onClick={() => onOpenClient(client.id)}>👤 Client summary</button></li> : null}
            </ul></div>
          <div className="panel"><div className="ph"><h2>People</h2></div>
            <dl className="people"><dt>Assigned</dt><dd>{personName(job.assignee_id) || "Nobody"}</dd><dt>Reviewer</dt><dd>{personName(job.reviewer_id) || "None"}</dd><dt>Signing</dt><dd>{job.needs_signature === false ? "Not needed" : personName(signer) || "—"}</dd></dl></div>
          <div className="panel"><div className="ph"><h2>Other actions</h2></div>
            <ul className="actions">
              {!readOnly ? <li><button type="button" className="link" onClick={() => onEdit()}>✎ Edit job details</button></li> : null}
              {!readOnly && onHandSign && open ? <li><button type="button" className="link" onClick={() => onHandSign(job)}>🤝 Hand to a team member</button></li> : null}
              {client ? <li><button type="button" className="link" onClick={() => onOpenClient(client.id)}>👤 Open the client page</button></li> : null}
            </ul></div>
        </aside>
      </div>
    </>
  );
}
