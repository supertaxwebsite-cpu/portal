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

export default function PayrollView({ jobs, clients, meId, canSignOff, clientName, personName, running, busy, onStart, onStop, onSubmit, wasStarted, onStep, onOpen, onNew }: {
  jobs: Job[]; clients: Client[]; meId: string; canSignOff: boolean;
  clientName: (id: string) => string; personName: (id: string | null) => string;
  running: JobTimer | null; busy: boolean;
  onStart: (j: Job) => void; onStop: () => void; onSubmit: (j: Job) => void; wasStarted?: (j: Job) => boolean;
  onStep: (j: Job, step: "super" | "stp" | "undo_super") => void; onOpen: (j: Job) => void; onNew: () => void;
}) {
  const scope: "mine" | "all" = canSignOff ? "all" : "mine";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, [running]);

  const pay = useMemo(() => jobs.filter((j) => j.service === "payroll"), [jobs]);
  const mine = (j: Job) => j.assignee_id === meId || j.reviewer_id === meId;
  const scoped = pay.filter((j) => scope === "all" ? true : scope === "mine" ? mine(j) : payStage(j) === 1 || payStage(j) === 2);
  const open = scoped.filter((j) => payStage(j) < 3);
  const due = (j: Job) => (j.due_date ? daysFrom(j.due_date) : 9999);
  const byDue = (a: Job, b: Job) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || clientName(a.client_id).localeCompare(clientName(b.client_id));
  // Pay runs in the next 30 days that will be created automatically on the pay day.
  const coming = useMemo(() => clients.filter((c) => c.services.includes("payroll") && c.payroll_freq && c.payroll_anchor).flatMap((c) =>
    clientUpcoming(c, pay.filter((j) => j.client_id === c.id), 30).filter((u) => u.service === "payroll")
      .map((u) => ({ ...u, client: c, who: c.payroll_assignee || c.manager_id || null })))
    .filter((u) => scope !== "mine" || u.who === meId)
    .sort((a, b) => a.due.localeCompare(b.due) || a.client.name.localeCompare(b.client.name)), [clients, pay, scope, meId]);
  const month = new Date().toISOString().slice(0, 7);
  const finishedMonth = scoped.filter((j) => payStage(j) === 3 && (j.stp_done_at ?? j.lodged_on ?? "").startsWith(month)).length;
  const tiles: [string, number, string][] = [
    ["Due today", open.filter((j) => due(j) === 0).length, "accent"],
    ["Overdue", open.filter((j) => due(j) < 0).length, "danger"],
    ["Super to confirm", scoped.filter((j) => payStage(j) === 1).length, "warn"],
    ["STP to lodge", scoped.filter((j) => payStage(j) === 2).length, "warn"],
    ["Finished this month", finishedMonth, "ok"],
  ];
  // Payday Super: from 1 July 2026 super must reach the fund within 7 days of each pay day.
  const superWatch = pay.filter((j) => !j.super_done_at && payStage(j) < 3 && j.due_date && due(j) <= 0)
    .map((j) => ({ j, left: 7 + due(j) })).sort((a, b) => a.left - b.left);
  function exportCsv() {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Client", "Period", "Pay day", "Stage", "Prepared by", "Super confirmed", "STP lodged"],
      ...scoped.sort(byDue).map((j) => [clientName(j.client_id), j.period, j.due_date ?? "", STAGE[payStage(j)], personName(j.assignee_id), j.super_done_at ? at(j.super_done_at) : "", j.stp_done_at ? at(j.stp_done_at) : ""])];
    const blob = new Blob(["\ufeff" + rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `payroll-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }
  const [pill, setPill] = useState<"all" | "over" | "super" | "stp" | "mine" | "done">("all");
  const recentDone = (j: Job) => payStage(j) === 3 && (j.stp_done_at ? (now - new Date(j.stp_done_at).getTime()) / 864e5 <= 7 : j.lodged_on ? daysFrom(j.lodged_on) >= -7 : false);
  const PILLS: [typeof pill, string, (j: Job) => boolean, boolean][] = [
    ["all", "All pay runs", (j) => payStage(j) < 3 || recentDone(j), false],
    ["over", "Overdue", (j) => payStage(j) < 3 && due(j) < 0, true],
    ["super", "Super to confirm", (j) => payStage(j) === 1, false],
    ["stp", "STP to lodge", (j) => payStage(j) === 2, false],
    ["mine", "My pay runs", (j) => mine(j) && (payStage(j) < 3 || recentDone(j)), false],
    ["done", "Finished", recentDone, false],
  ];
  const pf = PILLS.find((x) => x[0] === pill)![2];
  const list = pay.filter(pf).sort((a, b) => Number(payStage(a) === 3) - Number(payStage(b) === 3) || byDue(a, b));
  const freqOf = (id: string) => { const c = clients.find((x) => x.id === id); return c?.payroll_freq ? `${c.payroll_freq[0].toUpperCase()}${c.payroll_freq.slice(1)}` : "Pay run"; };
  const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });

  return (
    <>
      <div className="pagehead">
        <div><h1>Payroll</h1><p>Every pay run in the practice: processed, super paid, STP lodged.</p></div>
        <div className="row"><button onClick={exportCsv} disabled={!scoped.length}>⬇ Export</button><button className="primary" onClick={onNew}>+ New payroll job</button></div>
      </div>
      <div className="paysum">
        {tiles.map(([l, v, c]) => <div key={l} className={`paystat ${c}`}><span className="val">{v}</span><span className="lbl">{l}</span></div>)}
      </div>
      <div className="jobgrid">
        <div className="jobmain">
          <div className="quickpills">{PILLS.map(([k, l, f, hot]) => { const c = pay.filter(f).length; return (
            <button key={k} type="button" className={pill === k ? "on" : undefined} onClick={() => setPill(k)}>{l} <i className={hot && c ? "hot" : undefined}>{c}</i></button>); })}</div>
          <div className="panel" style={{ marginTop: 0 }}>
            {!list.length ? <div className="empty"><strong>No pay runs here.</strong>Payroll jobs are created automatically on each client&apos;s pay day (set the pay frequency on the client), or add one with New payroll job.</div> : (
              <div style={{ overflowX: "auto" }}><table className="jobtable paytable"><thead><tr><th>Client</th><th>Pay day</th><th>Steps</th><th>Assigned</th><th>Status</th><th></th></tr></thead>
                <tbody>{list.map((j) => {
                  const st = payStage(j);
                  const on = running?.job_id === j.id;
                  const prep = j.assignee_id === meId;
                  const signer = canSignOff || j.reviewer_id === meId;
                  const d = due(j);
                  return (
                    <tr key={j.id} className={on ? "running" : undefined}>
                      <td className="client"><button className="link" style={{ color: "var(--fg)" }} onClick={() => onOpen(j)}>{clientName(j.client_id)}</button><div className="note">{freqOf(j.client_id)} · {j.period}</div></td>
                      <td style={{ whiteSpace: "nowrap" }}>{j.due_date ? dayLabel(j.due_date) : "—"}<div className={`note ${st < 3 && d < 0 ? "danger" : st < 3 && d === 0 ? "warn" : "okc"}`}>{st === 3 ? `Finished ${fmtDate((j.stp_done_at ?? j.lodged_on ?? "").slice(0, 10))}` : d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : d === 0 ? "Today" : `${d} day${d === 1 ? "" : "s"} left`}</div></td>
                      <td><div className="stagecell"><div className="stagedots">{[0, 1, 2].map((i) => <i key={i} className={i < st ? "d" : i === st ? "n" : ""} />)}</div><small>{STAGE[st]}</small></div></td>
                      <td title={personName(j.assignee_id)}>{personName(j.assignee_id).split(" ")[0] || <span className="muted">Nobody</span>}</td>
                      <td><span className={`pill ${["info", "warn", "warn", "ok"][st]}`}>{STAGE[st]}</span></td>
                      <td><div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                        {st === 0 && prep ? <>
                          {on ? <><span className="timer mono">● {elapsed(running!.started_at, now)}</span><button disabled={busy} onClick={onStop}>Stop</button></> : <button disabled={busy} onClick={() => onStart(j)}>Start</button>}
                          <button className="primary" disabled={busy || (!!wasStarted && !wasStarted(j))} title={wasStarted && !wasStarted(j) ? "Press Start first" : undefined} onClick={() => onSubmit(j)}>Processed, send for sign-off</button>
                        </> : null}
                        {st === 0 && !prep ? <span className="note">Waiting for {personName(j.assignee_id).split(" ")[0] || "someone to process it"}</span> : null}
                        {st === 1 ? signer ? <button className="primary" disabled={busy} onClick={() => onStep(j, "super")}>Confirm super paid</button> : <span className="note">Waiting for super sign-off</span> : null}
                        {st === 2 ? signer ? <><button disabled={busy} onClick={() => onStep(j, "undo_super")}>Undo</button><button className="primary" disabled={busy} onClick={() => onStep(j, "stp")}>STP lodged, finish</button></> : <span className="note">Waiting for STP</span> : null}
                        {st === 3 ? <span className="pill ok" title={j.stp_done_at ? `STP lodged by ${personName(j.stp_done_by ?? null)}, ${at(j.stp_done_at)}` : undefined}>Finished</span> : null}
                      </div></td>
                    </tr>); })}</tbody></table></div>)}
            <div className="count">Steps: processed → super paid → STP lodged. Click a client name to open the pay run.</div>
          </div>
        </div>
        <aside className="jobside">
          <div className="panel">
            <div className="ph"><h2>Coming up in the next 30 days</h2><span className="note">Created on each pay day</span></div>
            {coming.length ? <ul className="list paycoming">{coming.slice(0, 8).map((u) => { const dt = new Date(`${u.due}T00:00:00`); return (
              <li key={`${u.client.id}-${u.key}`}><span className="caldate"><small>{dt.toLocaleDateString("en-AU", { weekday: "short" })}</small><b>{dt.getDate()}</b></span>
                <div style={{ minWidth: 0, flex: 1 }}><div className="t">{u.client.name}</div><div className="s">{u.client.payroll_freq ? `${u.client.payroll_freq[0].toUpperCase()}${u.client.payroll_freq.slice(1)}` : ""} · {(personName(u.who) || "nobody").split(" ")[0]}</div></div>
                <span className="pill">Auto-created</span></li>); })}</ul>
              : <div className="empty">No automatic pay runs in the next 30 days. Set the pay frequency on a client to create them.</div>}
          </div>
          <div className="panel">
            <div className="ph"><h2>How a pay run moves</h2></div>
            <ol className="howpay">
              <li><span className="pill info">1 Processing</span> The preparer runs the pays and presses <b>Processed</b>.</li>
              <li><span className="pill warn">2 Super to confirm</span> A team leader or master admin confirms super is paid.</li>
              <li><span className="pill warn">3 STP to lodge</span> Lodge STP, then press <b>STP lodged, finish</b>.</li>
              <li><span className="pill ok">4 Finished</span> The next pay day is already created.</li>
            </ol>
          </div>
          <div className="panel">
            <div className="ph"><h2>Payday Super check</h2></div>
            <p className="note" style={{ margin: "0 16px 8px" }}>Since 1 July 2026, super has to reach the fund within 7 days of each pay day.</p>
            {superWatch.length ? <ul className="list">{superWatch.map(({ j, left }) => <li key={j.id}><div style={{ minWidth: 0 }}><div className="t"><button className="link" onClick={() => onOpen(j)}>{clientName(j.client_id)}</button></div><div className="s">Paid {fmtDate(j.due_date)}</div></div>
              <span className={`pill ${left < 0 ? "danger" : left <= 2 ? "warn" : "info"}`}>{left < 0 ? `${-left} day${left === -1 ? "" : "s"} late` : left === 0 ? "Last day today" : `${left} day${left === 1 ? "" : "s"} left`}</span></li>)}</ul>
              : <p className="note" style={{ margin: "0 16px 14px" }}>Nothing waiting: super is confirmed on every past pay run.</p>}
          </div>
        </aside>
      </div>
    </>
  );
}
