"use client";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { useAskClient } from "@/lib/askClient";
import type { createClient } from "@/lib/supabase/client";
import type { AuditQuery, Client, Job, JobTimer, Person } from "@/lib/types";
import { ST, daysFrom, fmtDate, isOpen, practiceOf, svcLabel, isSigned, industryLabel, AUDIT_STATUSES, copyDropboxPath, DROPBOX_ROOT } from "@/lib/domain";
import { STEPS, checklistFor, NO_CHECKLIST } from "@/lib/checklists";
import JobBrief, { type PrepRow, type StageLists } from "./JobBrief";
import JobFiles from "./JobFiles";
import JobHistory from "./JobHistory";
import { ReviewNoteForm } from "./ReviewNotes";
import { fmtHours } from "./MyJobs";
import NotesPopup, { type NotesKind } from "./NotesPopup";

type SB = ReturnType<typeof createClient>;
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("").toUpperCase() || "—";

/** A job on its own page: the stages it goes through, its checklist, review notes and queries, files and history. */
/** Hours as "1h 20m". */
export const hm = (h: number) => { const m = Math.round(h * 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`; };

export default function JobPage({ job, client, meId, team, canAnswerAll, canDelete, readOnly, supabase, personName, say, statusEl, hours, running, busy,
  onStart, onStop, wasStarted, onBack, onEdit, onEditClient, onOpenClient, onNewClient, flag, related = 0, onApprove, onSendBack, onHandSign, onTakeSign, onRaised, onAnswered, onComplete, onSentForSign, onSigned, onReplied, onClientChanges, onClientSigned, onPayStep, onAudit, onPassed, onDone, canMarkSigned = false }: {
  flag?: { q: number; rn: number; f: number }; related?: number; onApprove?: (j: Job) => void; onSendBack?: (j: Job) => void; onHandSign?: (j: Job) => void; onTakeSign?: (j: Job) => Promise<unknown>;
  onRaised?: (j: Job, kind: "internal" | "client") => void; onAnswered?: (j: Job, stillOpen: number) => void; onPassed?: () => void;
  /** Task flow: finish preparation (to review), sent to the client for signing, client signed, client replied to a query. */
  /** One-step jobs (ATO payment, ATO communication, Other): close the job, with an optional note of what was done. */
  onDone?: (j: Job, note: string) => Promise<void> | void;
  onComplete?: (j: Job) => void; onSentForSign?: (j: Job) => void; onSigned?: (j: Job) => void; onReplied?: (j: Job) => void; onClientChanges?: (j: Job) => void; onClientSigned?: (j: Job) => void;
  /** SMSF audit: move between Sent to auditor and Auditor query, or on to Client signature, saving the auditor queries. */
  onAudit?: (j: Job, status: "with_auditor" | "auditor_query" | "to_lodge", queries?: AuditQuery[]) => Promise<unknown> | void;
  /** May mark any job in Sent for sign as Client signed (Ready to lodge). */
  canMarkSigned?: boolean;
  /** Payroll pay runs: confirm super paid, then STP lodged (finishes the pay run). */
  onPayStep?: (j: Job, step: "super" | "stp") => void;
  job: Job; client?: Client; meId: string; team: Person[]; canAnswerAll: boolean; canDelete: boolean; readOnly: boolean; supabase: SB;
  personName: (id: string | null) => string; say: (m: string, e?: boolean) => void; statusEl: ReactNode; hours: number;
  running: JobTimer | null; busy: boolean; onStart: (j: Job) => void; onStop: () => void; wasStarted: (j: Job) => boolean;
  onBack: () => void; onEdit: (tab?: "email") => void; onEditClient?: (c: Client) => void; onOpenClient: (id: string) => void; onNewClient: () => void;
}) {
  const askClient = useAskClient(supabase, meId);
  const st = ST[job.status];
  const total = checklistFor(job.service).length;
  // Checklist progress from the task list: items marked Checked or N/A.
  const [prog, setProg] = useState({ marked: 0, total });
  const onProgress = useCallback((marked: number, t: number) => setProg({ marked, total: t }), []);
  const checklistDone = prog.total === 0 || prog.marked >= prog.total;

  const d = job.due_date ? daysFrom(job.due_date) : null;
  const open = isOpen(job.status);
  const signed = isSigned(job);
  // Nothing to sign: once approved, the job skips Client signature and goes straight to Complete.
  const skipSign = job.needs_signature === false && job.status === "to_lodge";
  // Pay runs with nothing to approve: after Review come Super paid, then STP lodged.
  const payFlow = job.service === "payroll" && job.needs_signature === false;
  // SMSF: an Audit step between Review and Client signature (stage 1.5 while the job is with the auditor).
  const audit = job.service === "smsf" && job.needs_signature !== false;
  const inAudit = audit && AUDIT_STATUSES.has(job.status);
  const stage = !open ? 4 : inAudit ? 1.5 : payFlow && job.status === "to_lodge" ? (job.super_done_at ? 3 : 2) : signed || skipSign ? 3 : job.status === "review" ? 1 : job.status === "to_lodge" || job.status === "sent_for_sign" ? 2 : 0;
  const on = running?.job_id === job.id;
  // ATO payment, ATO communication and Other: one Action step, then done. No review, signing or lodge stages.
  const simple = NO_CHECKLIST.includes(job.service);
  const [doneNote, setDoneNote] = useState("");
  // Tick every 15 seconds while the timer runs here, so the clock and the totals stay live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!on) return; setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, [on]);
  const runMins = on && running ? Math.max(0, Math.floor((now - Date.parse(running.started_at)) / 60000)) : 0;
  const clock = `${Math.floor(runMins / 60)}:${String(runMins % 60).padStart(2, "0")}`;
  const signer = job.sign_owner ?? job.reviewer_id ?? job.assignee_id;
  const [takingSign, setTakingSign] = useState(false);
  // The Review, signature and Lodge checklists, handed over by the task list as it draws.
  let stageL: StageLists | null = null;
  const rows: { t: string; who: string | null; s: string }[] = [
    { t: "Preparation", who: job.assignee_id, s: stage > 0 ? "Done and sent to review"
      : job.status === "internal_query" ? "Internal query raised: waiting for the answer"
      : job.status === "client_query" ? "Query with the client: press Client replied when they answer"
      : !wasStarted(job) ? "Not started yet: press Start processing"
      : `In progress · checklist ${prog.marked} of ${prog.total}${checklistDone ? ": ready to complete" : ""}` },
    { t: "Review", who: job.reviewer_id, s: stage > 1 ? "Approved" : stage === 1 ? "Reviewing now" : "Opens when preparation is sent to review" },
    ...(payFlow ? [
      { t: "Super paid", who: null, s: job.super_done_at ? `Confirmed ${fmtDate(job.super_done_at.slice(0, 10))}` : stage === 2 ? "Pay the super, tick the checklist, then press Confirm super paid" : "Opens when the pay run is approved" },
      { t: "STP lodged", who: null, s: job.stp_done_at ? `Lodged ${fmtDate(job.stp_done_at.slice(0, 10))}` : !open ? "Finished" : stage === 3 ? "Lodge STP, tick the checklist, then press STP lodged, finish" : "Opens when super is confirmed" },
    ] : [
    { t: "Client signature", who: job.needs_signature === false ? null : signer, s: job.needs_signature === false ? "Not needed for this job" : signed ? "Client signed" : job.status === "sent_for_sign" ? `Sent for signing${job.sign_sent_at ? ` ${fmtDate(job.sign_sent_at.slice(0, 10))}` : ""}` : stage > 2 ? "Signed" : "Send for signing, then mark signed" },
    { t: job.needs_signature === false ? "Complete" : "Lodge", who: signed ? signer : null, s: signed ? "Ready to lodge: tick the checklist, then press Lodged" : !open ? `${job.status === "done" ? "Completed" : "Lodged"}${job.lodged_on ? ` ${fmtDate(job.lodged_on)}` : ""}` : "Lodgment date and receipt" },
    ]),
  ];
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  // Small counts for the chips and the summary panel.
  const [notesPop, setNotesPop] = useState<NotesKind | null>(null);
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
  // Time on the job by person (logged plus the timer running now), and the job total.
  const byPerson = (() => {
    const m = new Map<string, number>();
    for (const e of ents) m.set(e.user_id, (m.get(e.user_id) ?? 0) + e.hours);
    if (on && running && runMins) m.set(running.user_id, (m.get(running.user_id) ?? 0) + runMins / 60);
    return [...m.entries()].filter(([, h]) => h > 0).sort((a, b) => b[1] - a[1]);
  })();
  const jobTotal = byPerson.reduce((t, [, h]) => t + h, 0);
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
  const reviewing = job.status === "review" && (job.reviewer_id === meId || canAnswerAll) && !readOnly;
  // What you can do on the current task. Status moves on its own: nobody changes it by hand.
  const mineRow = (i: number) => (i === 0 ? job.assignee_id === meId : i === 1 ? job.reviewer_id === meId : i === 2 ? signer === meId : false);
  const timerBtn = (label: string) => on ? <><span className="timer mono" title="Time on this run, hours:minutes">● {clock}</span><button type="button" disabled={busy} onClick={onStop}>Stop</button></>
    : <button type="button" className="primary" disabled={busy} onClick={() => onStart(job)}>{label}</button>;
  const actions = (i: number) => {
    const me = mineRow(i);
    if (i === 0) {
      if (job.status === "client_query") return <>{(me || canAnswerAll) && onReplied ? <button type="button" className="primary" disabled={busy} onClick={() => onReplied(job)}>Client replied</button> : null}</>;
      if (job.status === "internal_query") return me ? timerBtn("Start") : null;
      if (!me && !canAnswerAll) return null;
      return <>{me ? timerBtn(wasStarted(job) ? "Start" : "Start processing") : null}
        {onComplete && (wasStarted(job) || !me) ? <button type="button" className={on ? "primary" : undefined} disabled={busy || !checklistDone}
          title={checklistDone ? "Stops the timer and sends it to review" : `Mark every checklist item Checked or N/A first (${prog.marked} of ${prog.total})`}
          onClick={async () => { if (on) await onStop(); onComplete(job); }}>Complete preparation</button> : null}</>;
    }
    if (i === 1) return me ? timerBtn("Start review") : null;
    if (payFlow && i === 2 && stage === 2) {
      const ok = !stageL || stageL.sign.done;
      return onPayStep ? <button type="button" className="primary" disabled={busy || !ok} title={ok ? "Super is paid: open the STP step" : "Tick every Super paid checklist item first"} onClick={() => onPayStep(job, "super")}>Confirm super paid</button> : null;
    }
    if (payFlow && i === 3 && stage === 3) {
      const ok = !stageL || stageL.lodge.done;
      return onPayStep ? <button type="button" className="primary" disabled={busy || !ok} title={ok ? "STP lodged: finish the pay run" : "Tick every STP lodged checklist item first"} onClick={() => onPayStep(job, "stp")}>STP lodged, finish</button> : null;
    }
    if (payFlow) return null;
    if (i === 2) {
      if (!me && !canAnswerAll) {
        if (!(canMarkSigned && job.status === "sent_for_sign" && !signed)) return null;
        const ok = !stageL || stageL.sign.done;
        return onClientSigned ? <button type="button" className="primary" disabled={busy || !ok} title={ok ? "The client has signed: move it to Ready to lodge" : "Tick every Client signature checklist item first"} onClick={() => onClientSigned(job)}>Client signed → Ready to lodge</button> : null;
      }
      const changes = onClientChanges ? <button type="button" disabled={busy} title="The client wants changes: reopen the job and send it back to processing" onClick={() => onClientChanges(job)}>↺ Client needs changes</button> : null;
      if (job.status === "to_lodge") return <>{me ? timerBtn("Start") : null}{changes}{onSentForSign ? <button type="button" disabled={busy} onClick={() => onSentForSign(job)}>Sent for signing</button> : null}</>;
      if (job.status === "sent_for_sign" && !signed) { const ok = !stageL || stageL.sign.done;
        return <>{changes}{onClientSigned ? <button type="button" className="primary" disabled={busy || !ok} title={ok ? "The client has signed: open the Lodge step" : "Tick every Client signature checklist item first"} onClick={() => onClientSigned(job)}>Client signed</button> : null}</>; }
    }
    if (i === 3 && (signed || skipSign)) {
      if (!mineRow(2) && !canAnswerAll) return null;
      const ok = !stageL || stageL.lodge.done;
      return onSigned ? <button type="button" className="primary" disabled={busy || !ok} title={ok ? "Lodged: close the job" : "Tick every Lodge checklist item first"} onClick={() => onSigned(job)}>Lodged</button> : null;
    }
    return null;
  };
  // Preparation time in a window (Initial review, or one Processing step), by the timesheet line's time.
  const prepTime = useCallback((from: string | null, to: string | null) => ents
    .filter((e) => !isAnswer(e) && stageOf(e) === 0 && (!from || e.created_at >= from) && (!to || e.created_at < to))
    .reduce((t, e) => t + e.hours, 0), [ents]); // eslint-disable-line react-hooks/exhaustive-deps
  const prepHead = (r: PrepRow) => {
    const me = job.assignee_id === meId;
    const title = r.kind === "ir" ? "Initial review" : r.afterChanges ? "Processing (client changes)" : r.afterReview ? "Processing (after internal review)" : r.afterQuery ? "Processing (after query)" : "Processing";
    const sub = r.current
      ? (!wasStarted(job) && r.kind === "ir" ? "Not started yet: press Start" : `${on ? "" : "Press Start to work on it · "}checklist ${r.marked} of ${r.total}${r.marked >= r.total ? ": ready to complete" : ""}`)
      : r.kind === "ir" ? "Documents checked and data in the software" : "Done";
    const canDo = r.current && open && !readOnly && (me || canAnswerAll);
    const ready = r.total === 0 || r.marked >= r.total;
    return <div className={`taskhead ${r.done ? "done" : r.current ? "now" : ""}`}>
      <span className="tdot">{r.done ? "✓" : r.n}</span>
      <div style={{ minWidth: 0, flex: 1 }}><div className="tkt">{title}{job.assignee_id ? ` · ${personName(job.assignee_id)}${me ? " (you)" : ""}` : ""}</div>
        <div className="tks">{r.current && on ? <span className="runtxt">● Running · </span> : null}{sub}</div></div>
      {r.hours ? <span className="tasktime mono" title="Time logged on this task">{hm(r.hours)}</span> : null}
      <div className="row jsact">
        {canDo ? <>{me ? timerBtn("Start") : null}
          {r.kind === "ir"
            ? <button type="button" className={on ? "primary" : undefined} disabled={busy || !ready} title={ready ? "Stops the timer. Processing opens next." : `Mark every item Checked or N/A first (${r.marked} of ${r.total})`} onClick={() => r.complete?.()}>Complete initial review</button>
            : onComplete ? <button type="button" className={on ? "primary" : undefined} disabled={busy || !ready} title={ready ? "Stops the timer and sends it to review" : `Mark every item Checked or N/A first (${r.marked} of ${r.total})`}
              onClick={async () => { if (on) await onStop(); onComplete(job); }}>Complete processing</button> : null}</> : null}
        {job.assignee_id ? <span className="av" title={personName(job.assignee_id)}>{initials(personName(job.assignee_id))}</span> : <span className="av">—</span>}
      </div></div>;
  };
  const head = (i: number) => { const r = rows[i]; const cls = i < stage ? "done" : i === stage ? "now" : "";
    return <div className={`taskhead ${cls}`}>
      <span className="tdot">{i < stage ? "✓" : ""}</span>
      <div style={{ minWidth: 0, flex: 1 }}><div className="tkt">{r.t}{r.who ? ` · ${personName(r.who)}${r.who === meId ? " (you)" : ""}` : ""}</div>
        <div className="tks">{i === stage && on ? <span className="runtxt">● Running · </span> : null}{r.s}</div></div>
      {stageHrs[i] ? <span className="tasktime mono" title="Time logged on this task">{hm(stageHrs[i])}</span> : null}
      <div className="row jsact">
        {i === stage && open && !readOnly ? actions(i) : null}
        {r.who ? <span className="av" title={personName(r.who)}>{initials(personName(r.who))}</span> : <span className="av">—</span>}
      </div></div>; };

  // SMSF Audit step: checklist, the auditor's queries, and the buttons that move it on.
  const [aq, setAq] = useState("");
  const queries: AuditQuery[] = Array.isArray(job.audit_queries) ? job.audit_queries : [];
  const openQ = queries.filter((q) => !q.done_at);
  const canAudit = open && !readOnly && !!onAudit && (job.assignee_id === meId || job.reviewer_id === meId || canAnswerAll);
  const auditLi = (L: StageLists) => {
    const cls = inAudit ? "now" : stage >= 2 ? "done" : "later";
    const who = job.assignee_id;
    const sub = inAudit ? (job.status === "auditor_query" ? `Auditor query: ${openQ.length} open. Answer it, then mark it answered` : `With the auditor${queries.length ? ` · ${queries.length - openQ.length} of ${queries.length} queries answered` : ""}`)
      : stage >= 2 ? "Audit report received" : "Opens when the reviewer approves it";
    const ready = L.audit.done && !openQ.length;
    const saveQ = async (list: AuditQuery[]) => { await onAudit?.(job, list.some((q) => !q.done_at) ? "auditor_query" : "with_auditor", list); };
    return <li className={`task${cls === "later" ? " later" : ` ${cls}`}`}>
      <div className={`taskhead ${cls === "later" ? "" : cls}`}>
        <span className="tdot">{cls === "done" ? "✓" : ""}</span>
        <div style={{ minWidth: 0, flex: 1 }}><div className="tkt">Audit{who ? ` · ${personName(who)}${who === meId ? " (you)" : ""}` : ""}</div>
          <div className="tks">{inAudit && on ? <span className="runtxt">● Running · </span> : null}{sub}</div></div>
        <div className="row jsact">
          {inAudit && canAudit ? <>{job.assignee_id === meId ? timerBtn("Start") : null}
            <button type="button" className="primary" disabled={busy || !ready} title={ready ? "The audit report is in: move on to Client signature" : openQ.length ? "Mark every auditor query answered first" : "Tick every Audit checklist item first"}
              onClick={async () => { if (on) await onStop(); await onAudit?.(job, "to_lodge"); }}>Audit report received</button></> : null}
          {who ? <span className="av" title={personName(who)}>{initials(personName(who))}</span> : <span className="av">—</span>}
        </div></div>
      {stage >= 1.5 ? <div className="taskbody">{L.audit.el}
        <section className="briefsec"><h3>Auditor queries <span className="note">{queries.length ? `${openQ.length} open · ${queries.length - openQ.length} answered` : "None yet"}</span></h3>
          {queries.map((q) => <div key={q.id} className={`auditq${q.done_at ? " done" : ""}`}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap", gap: 10 }}>
              <span><b>{q.done_at ? `✓ Answered ${fmtDate(q.done_at.slice(0, 10))}` : `Open · received ${fmtDate(q.at.slice(0, 10))}`}</b>{q.by ? <span className="note"> · logged by {personName(q.by)}</span> : null}</span>
              {!q.done_at && inAudit && canAudit ? <button type="button" disabled={busy} onClick={() => saveQ(queries.map((x) => x.id === q.id ? { ...x, done_at: new Date().toISOString() } : x))}>Mark answered</button> : null}</div>
            <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{q.body}</div></div>)}
          {inAudit && canAudit ? <div className="qnew" style={{ marginTop: 8 }}>
            <textarea id="aq-body" placeholder="What did the auditor ask? e.g. Please provide the market valuation for the property at 30 June." value={aq} onChange={(e) => setAq(e.target.value)} />
            <div className="row"><span className="note">The job shows Auditor query until every query is marked answered.</span><span style={{ flex: 1 }} />
              <button type="button" disabled={busy || !aq.trim()} onClick={async () => { const body = aq.trim().slice(0, 2000); await saveQ([...queries, { id: crypto.randomUUID(), body, at: new Date().toISOString(), by: meId }]); setAq(""); }}>+ Add auditor query</button></div>
          </div> : null}</section></div> : null}
    </li>;
  };

  return (
    <>
      {notesPop ? <NotesPopup kind={notesPop} jobId={job.id} clientId={job.client_id} clientName={client?.name ?? ""} supabase={supabase} personName={personName}
        onClose={() => setNotesPop(null)} onOpenClient={client ? () => onOpenClient(client.id) : undefined} /> : null}
      <div className="crumb"><button type="button" className="link" onClick={onBack}>← Jobs</button> / Job page</div>
      <div className="jobhero">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <h1>{client?.name ?? "Deleted client"} <span>· {svcLabel(job.service)} {job.period}</span></h1>
          <div className="row"><span className={`pill ${st?.cls ?? ""}`}>{st?.label ?? job.status}</span>{!readOnly ? <button type="button" onClick={() => onEdit()}>✎ Edit job</button> : null}</div>
        </div>
        <div className="facts">
          <span>Practice <b>{practiceOf(client)}</b></span><span>Entity <b>{client?.entity ?? "—"}</b></span><span>{industryLabel(client?.entity)} <b>{client?.industry || <span className="note">not set</span>}</b></span>
          <span>Due <b>{job.due_date ? fmtDate(job.due_date) : "not set"}</b>{open && d !== null && d < 0 ? <> <span className="pill danger">{-d} day{d === -1 ? "" : "s"} overdue</span></> : open && d !== null && d <= 7 ? <> <span className="pill warn">{d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"} left`}</span></> : null}</span>
          <span>Priority <b>{job.priority === "high" ? "High" : "Normal"}</b></span>
          <span>Client signature <b>{job.needs_signature === false ? "Not needed" : "Needed"}</b></span>
        </div>
        <div className="counts">
          <button type="button" className="count" onClick={() => go("jp-work")}>Internal queries <i className={flag?.q ? "red" : ""}>{flag?.q ?? 0}</i></button>
          <span className="count">Client queries <i className={c.cq ? "warn" : ""}>{c.cq}</i></span>
          <button type="button" className="count" onClick={() => setNotesPop("review")}>Review notes <i className={flag?.rn ? "red" : ""}>{flag?.rn ?? 0}</i></button>
          <button type="button" className="count" onClick={() => go("jp-files")}>Files <i className="blue">{flag?.f ?? 0}</i></button>
          {prog.total ? <button type="button" className="count" onClick={() => go("jp-work")}>{STEPS[job.service] ? "Steps" : "Checklist"} <i className={prog.total && prog.marked >= prog.total ? "green" : undefined}>{Math.min(prog.marked, prog.total)}/{prog.total}</i></button> : null}
          {simple ? <span className="count">Step <i className={open ? "blue" : "green"}>{open ? "1 of 1" : "Done"}</i></span>
          : <span className="count">Stage <i className="blue">{audit ? (inAudit ? 3 : stage <= 1 ? stage + 1 : Math.min(stage + 2, 5)) : Math.min(stage + 1, 4)} of {audit ? 5 : 4}</i></span>}
          <button type="button" className="count" onClick={() => go("jp-history")}>Time logged <i className="dark">{fmtHours(Math.max(hours, jobTotal))}</i></button>
          {related && client ? <button type="button" className="count" onClick={() => onOpenClient(client.id)}>🔗 Related clients ({related})</button> : null}
          <span style={{ flex: 1 }} />
          {client?.dropbox_path ? <button type="button" className="dbxbtn" title={`${DROPBOX_ROOT}\\${client.dropbox_path}`} onClick={() => copyDropboxPath(client.dropbox_path ?? "", say)}>📂 Copy folder path</button>
            : client && !readOnly && onEditClient ? <button type="button" title="Save this client's Dropbox folder path, so anyone can open it from their jobs" onClick={() => onEditClient(client)}>📂 Add folder path</button> : null}
          {!readOnly && askClient.ok ? <button type="button" onClick={() => onEdit("email")}>✉ Email client</button> : null}
          <button type="button" onClick={() => go("jp-files")}>📎 Files</button>
        </div>
      </div>

      <div className="jobgrid">
        <div className="jobmain">
          <div className={`panel tasksp${simple ? " simple" : ""}`} id="jp-work">
            <div className="ph"><h2>Tasks</h2><span className="note">{simple ? "One step: do it, then mark it done. No review or signing stages for this job type." : "Press Start on the current task. Finish it and the next task opens on its own."}</span></div>
            {simple ? (() => { const me = job.assignee_id === meId; const canDo = open && !readOnly && (me || canAnswerAll);
              const what = job.service === "ato_payment" ? "make the payment" : job.service === "ato_comm" ? "deal with the ATO" : "do the work";
              const sub = !open ? "Done" : job.status === "internal_query" ? "Internal query raised: waiting for the answer" : job.status === "client_query" ? "Query with the client: press Client replied when they answer"
                : wasStarted(job) || on ? `${what[0].toUpperCase()}${what.slice(1)}, then mark the job done` : "Not started yet: press Start";
              return <div className={`simplestep${open ? "" : " done"}`}>
                <div className={`taskhead ${open ? "now" : "done"}`}><span className="tdot">{open ? 1 : "✓"}</span>
                  <div style={{ minWidth: 0, flex: 1 }}><div className="tkt">Action{job.assignee_id ? ` · ${personName(job.assignee_id)}${me ? " (you)" : ""}` : ""}</div>
                    <div className="tks">{on ? <span className="runtxt">● Running · </span> : null}{sub}</div></div>
                  {hours ? <span className="tasktime mono" title="Time logged on this job">{hm(hours)}</span> : null}
                  <div className="row jsact">{canDo ? <>
                    {job.status === "client_query" ? (onReplied ? <button type="button" disabled={busy} onClick={() => onReplied(job)}>Client replied</button> : null) : me ? timerBtn("Start") : null}
                    {onDone && job.status !== "client_query" && job.status !== "internal_query" ? <button type="button" className="donebtn" disabled={busy} title="Stops the timer and closes the job as Done"
                      onClick={async () => { await onDone(job, doneNote.trim()); setDoneNote(""); }}>✓ Mark done &amp; complete job</button> : null}</> : null}</div></div>
                {canDo && job.status !== "client_query" && job.status !== "internal_query" ? <div className="taskbody">
                  <label className="f" style={{ display: "block" }}><span>What was done <span className="note">(optional, saved in the job history)</span></span>
                    <textarea id="jp-donenote" value={doneNote} onChange={(e) => setDoneNote(e.target.value)} maxLength={2000} rows={3}
                      placeholder={job.service === "ato_payment" ? "e.g. Paid $4,210 to the ATO by BPAY on 26 Nov, ref 1234 5678 9012" : job.service === "ato_comm" ? "e.g. Called the ATO, payment plan set up, ref 123456" : "e.g. What you did and anything the next person should know"} /></label>
                  <div className="row" style={{ marginTop: 8 }}><button type="button" onClick={() => go("jp-files")}>📎 Attach {job.service === "ato_payment" ? "receipt" : "a file"}</button>
                    <span className="note">Need to ask someone? Raise a query below.</span></div></div> : null}
              </div>; })() : null}
            <JobBrief job={job} clientName={client?.name ?? ""} showInfo={false} meId={meId} canAnswerAll={canAnswerAll} team={team} defaultTo={job.reviewer_id} readOnly={readOnly}
              supabase={supabase} personName={personName} say={say} onNewClient={onNewClient} onRaised={onRaised} onAnswered={onAnswered} onPassed={onPassed} timer={{ runningHere: running?.job_id === job.id, busy, start: onStart, stop: onStop }} queryHours={queryHours} onProgress={onProgress}
              tasks={simple ? undefined : { head: prepHead, active: stage === 0 && open && job.status !== "internal_query" && job.status !== "client_query", prepTime, onClientReplied: onReplied && !readOnly ? () => onReplied(job) : undefined, after: (L: StageLists) => { stageL = L; const noSign = job.needs_signature === false; const pay = job.service === "payroll" && noSign;
                // Payroll: approving hands the pay run to the Payroll page (super, then STP), so only the Review list is needed here.
                const approveReady = L.review.done && (!noSign || pay || L.lodge.done); return <>
                <li className={`task${stage === 1 ? " now" : stage > 1 ? " done" : " later"}`}>{head(1)}
                  {stage >= 1 ? <div className="taskbody">{L.review.el}</div> : null}
                  {reviewing ? <div className="taskbody"><p className="note" style={{ margin: "0 0 8px" }}>Found a mistake? Add a review note with a screenshot or file. It goes back to {personName(job.assignee_id) || "the preparer"} to fix, and you clear it. When everything is cleared, approve it.</p>
                    <ReviewNoteForm job={job} meId={meId} supabase={supabase} personName={personName} say={say} />
                    <div className="row">{onSendBack ? <button type="button" disabled={busy} onClick={() => onSendBack(job)}>↩ Send back to {personName(job.assignee_id).split(" ")[0] || "the preparer"}</button> : null}
                      {onApprove ? <button type="button" className="primary" disabled={busy || !approveReady} title={approveReady ? undefined : `Mark every Review checklist item first${noSign && !pay ? ", and the Complete checklist" : ""}`} onClick={() => onApprove(job)}>{pay ? "Approve pay run" : job.needs_signature === false ? "Approve and complete" : audit ? "Approve → Send to auditor" : "Approve → Client signature"}</button> : null}</div>
                    {!approveReady ? <p className="note" style={{ margin: "6px 0 0" }}>{!L.review.done ? "Tick every Review checklist item to approve." : "This job has nothing to sign, so approving finishes it: tick the Complete checklist below first."}</p>
                      : pay ? <p className="note" style={{ margin: "6px 0 0" }}>Approving opens the next two steps: Super paid, then STP lodged.</p> : null}</div> : null}</li>
                {audit ? auditLi(L) : null}
                <li className={`task${stage === 2 ? " now" : stage > 2 ? " done" : " later"}`}>{head(2)}
                                    {stage === 2 && open && !pay && !readOnly && onHandSign && (signer === meId || canAnswerAll) ? <div className="taskbody signwho">
                    <span className="note">{job.status === "sent_for_sign" ? "Who follows up with the client?" : "Who sends it for signing?"}</span>
                    <div className="seg" role="radiogroup" aria-label="Who does the signing">
                      <button type="button" role="radio" aria-checked={signer === meId} className={signer === meId ? "on" : undefined} disabled={busy || takingSign}
                        onClick={async () => { if (signer === meId || !onTakeSign) return; setTakingSign(true); await onTakeSign(job); setTakingSign(false); }}>I'll do it myself</button>
                      <button type="button" role="radio" aria-checked={false} disabled={busy} onClick={() => onHandSign(job)}>🤝 Hand to a team member…</button>
                    </div>
                    <span className="note">{signer === meId ? (job.status === "sent_for_sign" ? "It's with you: you get the reminders and mark it Client signed." : "It's with you: press Start, then Sent for signing.")
                      : `It's with ${personName(signer)}${job.status === "sent_for_sign" ? ", who gets the reminders." : ". It's in their My tasks."}`}</span>
                  </div> : null}
                  {(!noSign || pay) && stage >= 2 ? <div className="taskbody">{L.sign.el}</div> : null}</li>
                <li className={`task${stage > 3 ? " done" : stage === 3 ? " now" : " later"}`}>{head(3)}
                  {pay ? (stage >= 3 ? <div className="taskbody">{L.lodge.el}</div> : null) : stage >= 2 || (noSign && stage === 1) ? <div className="taskbody">{L.lodge.el}</div> : null}</li>
              </>; } }} />
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
              <li><button type="button" className="link" onClick={() => setNotesPop("review")}>⚠️ Review notes</button><b className={flag?.rn ? "red" : ""}>{flag?.rn ?? 0}</b></li>
              {c.cnotes !== null && client ? <li><button type="button" className="link" onClick={() => setNotesPop("client")}>📝 Client notes</button><b>{c.cnotes}</b></li> : null}
              {c.mnotes !== null && client ? <li><button type="button" className="link" onClick={() => setNotesPop("mgmt")}>🔒 Management notes</button><b>{c.mnotes}</b></li> : null}
              <li><button type="button" className="link" onClick={() => go("jp-history")}>🕘 Job history and time</button><b>{fmtHours(hours)}</b></li>
              {client ? <li><button type="button" className="link" onClick={() => onOpenClient(client.id)}>👤 Client summary</button></li> : null}
            </ul></div>
          <div className="panel"><div className="ph"><h2>People</h2></div>
            <dl className="people"><dt>Assigned</dt><dd>{personName(job.assignee_id) || "Nobody"}</dd><dt>Reviewer</dt><dd>{personName(job.reviewer_id) || "None"}</dd><dt>Signing</dt><dd>{job.needs_signature === false ? "Not needed" : personName(signer) || "—"}</dd></dl></div>
          <div className="panel"><div className="ph"><h2>Time on this job</h2></div>
            <dl className="people">{byPerson.length ? <>{byPerson.map(([id, h]) => <Fragment key={id}><dt>{personName(id) || "Former staff"}{on && running?.user_id === id ? <span className="timer"> ●</span> : null}</dt><dd className="mono">{hm(h)}</dd></Fragment>)}
              <dt style={{ color: "var(--fg)", fontWeight: 700, borderTop: "1px solid var(--line)", paddingTop: 6 }}>Total job time</dt><dd className="mono" style={{ borderTop: "1px solid var(--line)", paddingTop: 6, fontWeight: 800 }}>{hm(jobTotal)}</dd></>
              : <dd style={{ gridColumn: "1 / -1", textAlign: "left", fontWeight: 400 }} className="note">No time logged yet.</dd>}</dl></div>
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
