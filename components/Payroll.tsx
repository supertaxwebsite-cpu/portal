"use client";
import { useEffect, useMemo, useState } from "react";
import type { Client, Job, JobTimer } from "@/lib/types";
import { clientUpcoming, daysFrom, fmtDate } from "@/lib/domain";

const elapsed = (from: string, now: number) => { const m = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
const at = (s?: string | null) => (s ? new Date(s).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

/** Where a pay run is: 0 processing, 1 waiting for super sign-off, 2 waiting for STP, 3 finished. */
export function payStage(j: Job) {
  if (j.stp_done_at || j.status === "lodged" || j.status === "done") return 3;
  if (j.super_done_at) return 2;
  if (["review", "to_lodge", "sent_for_sign"].includes(j.status)) return 1;
  return 0;
}
const STAGE = ["Processing", "Super to confirm", "STP to lodge", "Finished"];

export default function PayrollView({ jobs, clients, meId, canSignOff, clientName, personName, running, busy, onStart, onStop, onSubmit, onStep, onOpen, onNew }: {
  jobs: Job[]; clients: Client[]; meId: string; canSignOff: boolean;
  clientName: (id: string) => string; personName: (id: string | null) => string;
  running: JobTimer | null; busy: boolean;
  onStart: (j: Job) => void; onStop: () => void; onSubmit: (j: Job) => void;
  onStep: (j: Job, step: "super" | "stp" | "undo_super") => void; onOpen: (j: Job) => void; onNew: () => void;
}) {
  const [scope, setScope] = useState<"mine" | "signoff" | "all">(canSignOff ? "all" : "mine");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, [running]);

  const pay = useMemo(() => jobs.filter((j) => j.service === "payroll"), [jobs]);
  const mine = (j: Job) => j.assignee_id === meId || j.reviewer_id === meId;
  const scoped = pay.filter((j) => scope === "all" ? true : scope === "mine" ? mine(j) : payStage(j) === 1 || payStage(j) === 2);
  const open = scoped.filter((j) => payStage(j) < 3);
  const due = (j: Job) => (j.due_date ? daysFrom(j.due_date) : 9999);
  const byDue = (a: Job, b: Job) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || clientName(a.client_id).localeCompare(clientName(b.client_id));
  const groups: [string, string, Job[]][] = [
    ["Overdue", "danger", open.filter((j) => due(j) < 0).sort(byDue)],
    ["Today", "accent", open.filter((j) => due(j) === 0).sort(byDue)],
    ["Next 14 days", "", open.filter((j) => due(j) > 0 && due(j) <= 14).sort(byDue)],
    ["Later", "", open.filter((j) => due(j) > 14).sort(byDue)],
    ["Finished in the last 7 days", "ok", scoped.filter((j) => payStage(j) === 3 && (j.stp_done_at ? (now - new Date(j.stp_done_at).getTime()) / 864e5 <= 7 : j.lodged_on ? daysFrom(j.lodged_on) >= -7 : false))
      .sort((a, b) => (b.stp_done_at ?? b.lodged_on ?? "").localeCompare(a.stp_done_at ?? a.lodged_on ?? ""))],
  ];
  // Pay runs in the next 30 days that will be created automatically on the pay day.
  const coming = useMemo(() => clients.filter((c) => c.services.includes("payroll") && c.payroll_freq && c.payroll_anchor).flatMap((c) =>
    clientUpcoming(c, pay.filter((j) => j.client_id === c.id), 30).filter((u) => u.service === "payroll")
      .map((u) => ({ ...u, client: c, who: c.payroll_assignee || c.manager_id || null })))
    .filter((u) => scope !== "mine" || u.who === meId)
    .sort((a, b) => a.due.localeCompare(b.due) || a.client.name.localeCompare(b.client.name)), [clients, pay, scope, meId]);
  const counts = [0, 1, 2].map((s) => scoped.filter((j) => payStage(j) === s && due(j) <= 0).length);
  let n = 0;

  return (
    <>
      <div className="pagehead">
        <div><h1>Payroll</h1><p>Each pay run goes: processed by the preparer → super confirmed by a team leader or master admin → STP lodged. Finish it on the pay day.</p></div>
        <div className="row"><button className="primary" onClick={onNew}>New payroll job</button></div>
      </div>
      <div className="paysum">
        {STAGE.slice(0, 3).map((s, i) => <div key={s} className={`paystat s${i}`}><span className="lbl">{s}</span><span className="val">{counts[i]}</span><span className="note">due today or overdue</span></div>)}
      </div>
      <div className="row payscope" role="tablist">
        {([["mine", "My pay runs"], ...(canSignOff ? [["signoff", "Waiting for sign-off"]] : []), ["all", "All pay runs"]] as [typeof scope, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={scope === k} className={`chip ${scope === k ? "on" : ""}`} onClick={() => setScope(k)}>{l}</button>))}
      </div>
      {groups.every(([, , js]) => !js.length) && !coming.length ? <div className="panel empty"><strong>No payroll jobs here.</strong>Payroll jobs are created automatically on each client&apos;s pay day (set the pay frequency on the client), or add one with New payroll job.</div> : null}
      {groups.map(([title, cls, js]) => js.length ? (
        <div key={title} className="panel paygroup">
          <div className="ph"><h2><span className={`dot ${cls}`} />{title}</h2><span className="note">{js.length} pay run{js.length === 1 ? "" : "s"}</span></div>
          <ul className="paylist">{js.map((j) => {
            n += 1;
            const st = payStage(j);
            const on = running?.job_id === j.id;
            const prep = j.assignee_id === meId;
            const signer = canSignOff || j.reviewer_id === meId;
            return (
              <li key={j.id} className={`payrow st${st}${on ? " running" : ""}`}>
                <span className="num">{n}</span>
                <div className="paymain">
                  <div className="t"><button className="link" onClick={() => onOpen(j)}>{clientName(j.client_id)}</button></div>
                  <div className="s">{j.period} · Prepared by {personName(j.assignee_id) || "nobody yet"}{j.reviewer_id ? ` · Sign-off ${personName(j.reviewer_id)}` : ""}</div>
                  <div className="duerow">{j.due_date ? <span className={`duechip ${due(j) < 0 && st < 3 ? "over" : due(j) === 0 && st < 3 ? "soon" : ""}`}><b>Pay day {fmtDate(j.due_date)}</b>{st < 3 ? <span>{due(j) < 0 ? `${-due(j)} day${due(j) === -1 ? "" : "s"} overdue` : due(j) === 0 ? "today" : due(j) === 1 ? "tomorrow" : `in ${due(j)} days`}</span> : null}</span> : null}</div>
                </div>
                <ol className="paysteps" aria-label={`Stage: ${STAGE[st]}`}>
                  <li className={st >= 1 ? "done" : "now"}><i>{st >= 1 ? "✓" : "1"}</i><span>Processed</span></li>
                  <li className={st >= 2 ? "done" : st === 1 ? "now" : ""} title={j.super_done_at ? `Confirmed by ${personName(j.super_done_by ?? null)}, ${at(j.super_done_at)}` : undefined}><i>{st >= 2 ? "✓" : "2"}</i><span>Super paid</span></li>
                  <li className={st >= 3 ? "done" : st === 2 ? "now" : ""} title={j.stp_done_at ? `Lodged by ${personName(j.stp_done_by ?? null)}, ${at(j.stp_done_at)}` : undefined}><i>{st >= 3 ? "✓" : "3"}</i><span>STP lodged</span></li>
                </ol>
                <div className="row payact">
                  {st === 0 && prep ? <>
                    {on ? <><span className="timer mono">● {elapsed(running!.started_at, now)}</span><button disabled={busy} onClick={onStop}>Stop</button></>
                      : <button disabled={busy} onClick={() => onStart(j)}>Start</button>}
                    <button className="primary" disabled={busy} onClick={() => onSubmit(j)}>Processed, send for sign-off</button>
                  </> : null}
                  {st === 0 && !prep ? <span className="note">Waiting for {personName(j.assignee_id) || "someone to process it"}</span> : null}
                  {st === 1 ? signer ? <button className="primary" disabled={busy} onClick={() => onStep(j, "super")}>Confirm super paid</button> : <span className="note">Waiting for super sign-off</span> : null}
                  {st === 2 ? signer ? <>
                    <button className="link" disabled={busy} onClick={() => onStep(j, "undo_super")}>Undo super</button>
                    <button className="primary" disabled={busy} onClick={() => onStep(j, "stp")}>STP lodged, finish</button>
                  </> : <span className="note">Super confirmed by {personName(j.super_done_by ?? null)}. Waiting for STP.</span> : null}
                  {st === 3 ? <span className="note okline">✓ {j.stp_done_at ? `STP lodged by ${personName(j.stp_done_by ?? null)}, ${at(j.stp_done_at)}` : `Lodged ${j.lodged_on ? fmtDate(j.lodged_on) : ""}`}</span> : null}
                </div>
              </li>);
          })}</ul>
        </div>) : null)}
      {coming.length && scope !== "signoff" ? <div className="panel paygroup coming">
        <div className="ph"><h2><span className="dot" />Coming up in the next 30 days</h2><span className="note">Created automatically on each pay day</span></div>
        <ul className="paylist">{coming.map((u) => (
          <li key={`${u.client.id}-${u.key}`} className="payrow future">
            <span className="num">·</span>
            <div className="paymain">
              <div className="t">{u.client.name}</div>
              <div className="s">{u.period} · Will go to {personName(u.who) || "nobody (set it on the client)"}</div>
            </div>
            <span className="duechip"><b>Pay day {fmtDate(u.due)}</b><span>in {daysFrom(u.due)} day{daysFrom(u.due) === 1 ? "" : "s"}</span></span>
            <span className="note payact">{u.client.payroll_freq}</span>
          </li>))}</ul>
      </div> : null}
    </>
  );
}
