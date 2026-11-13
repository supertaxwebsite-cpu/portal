"use client";
import { useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Attendance, Client, Job, JobTimer, Profile, TimeEntry } from "@/lib/types";
import { fmtDate, svcLabel, todayISO } from "@/lib/domain";
import { leaveDays, leaveLabel, LEAVE_KINDS, type LeaveReq } from "./Leave";
import type { Day, LateRequest } from "./Timesheet";

type SB = ReturnType<typeof createClient>;
const WORK_DAY_H = 8.25;
/** Sick and personal leave allowance, days a year per person. */
export const LEAVE_ALLOWANCE = 10;
const time = (ts: string | null | undefined) => (ts ? new Date(ts).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const hm = (m: number) => { const t = Math.round(m); return `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, "0")}m`; };
const n1 = (n: number) => String(Number(n.toFixed(1)));
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("").toUpperCase();
const first = (n: string) => n.split(" ")[0];
export const addDays = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const dow = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };
export const monthDays = (ym: string) => { const out: string[] = []; for (let d = `${ym}-01`; d.slice(0, 7) === ym; d = addDays(d, 1)) out.push(d); return out; };
const leaveOn = (leaves: LeaveReq[], uid: string, d: string) => leaves.find((l) => l.user_id === uid && l.status !== "rejected" && l.start_date <= d && l.end_date >= d);

type Cell = { cls: string; t: string; tip: string };
function cellOf(rec: Day | undefined, lv: LeaveReq | undefined, d: string, today: string, leaveOnly: boolean): Cell {
  if (dow(d) === 0) return { cls: "sun", t: "", tip: "Sunday" };
  if (d > today || (!rec && lv)) {
    if (lv?.status === "approved") return { cls: "booked", t: lv.part === "full" ? "L" : "½", tip: `${leaveLabel(lv.kind)} booked` };
    if (lv?.status === "pending") return { cls: "pend", t: "?", tip: `${leaveLabel(lv.kind)} waiting for approval` };
    return { cls: "", t: "", tip: "" };
  }
  if (!rec) return { cls: "", t: "", tip: "" };
  if (rec.open && d < today && !leaveOnly) return { cls: "forgot", t: "–", tip: "Forgot to log out" };
  if (rec.leave) return rec.booked || rec.override === "leave" ? { cls: "leave", t: "L", tip: rec.booked ? leaveLabel(rec.booked) : "Leave" } : { cls: "absent", t: "!", tip: "Absent, no leave asked" };
  if (rec.half) return { cls: "half", t: "½", tip: rec.booked ? `Half day · ${leaveLabel(rec.booked)}` : "Half day" };
  if (lv?.status === "pending") return { cls: "pend", t: "?", tip: "Leave waiting for approval" };
  if (leaveOnly) return { cls: "", t: "", tip: "" };
  if (rec.late) return { cls: "late", t: "", tip: `Late · in ${time(rec.first)}` };
  if (rec.first || rec.h) return { cls: "ok", t: "", tip: rec.first ? `In ${time(rec.first)}` : "Present" };
  return { cls: "", t: "", tip: "" };
}

/** The month grid: one row per person, one square per day; click a square for the day's detail. */
export function MonthGrid({ month, people, days, leaves, entries, requests, leaveOnly, isMaster, onOverride, onLate, onOpenDay }: {
  month: string; people: Profile[]; days: Day[]; leaves: LeaveReq[]; entries: TimeEntry[]; requests: LateRequest[]; leaveOnly?: boolean; isMaster: boolean;
  onOverride: (d: Day, status: string) => void; onLate: (r: LateRequest, s: "approved" | "rejected") => void; onOpenDay: (uid: string, date: string) => void;
}) {
  const [pick, setPick] = useState<{ uid: string; date: string; x: number; y: number } | null>(null);
  const today = todayISO();
  const ds = monthDays(month);
  const recs = new Map(days.map((d) => [`${d.date}|${d.user}`, d]));
  const jobHours = (uid: string, d?: string) => entries.filter((e) => e.user_id === uid && e.job_id && (d ? e.work_date === d : e.work_date.startsWith(month)));
  const sel = pick ? recs.get(`${pick.date}|${pick.uid}`) : undefined;
  const selReq = pick ? requests.find((r) => r.user_id === pick.uid && r.work_date === pick.date) : undefined;
  const selLv = pick ? leaveOn(leaves, pick.uid, pick.date) : undefined;
  const who = (uid: string) => people.find((p) => p.id === uid)?.full_name ?? "";
  return (
    <div className="panel mgrid">
      <div className="ph"><h2>{new Date(`${month}-01T00:00:00`).toLocaleDateString("en-AU", { month: "long" })} {leaveOnly ? "leave calendar" : "month grid"}</h2><span className="note">{leaveOnly ? "Booked, waiting and taken leave for everyone" : "Click any square to see the day or change it"}</span></div>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th className="who">Staff</th>{ds.map((d) => <th key={d} className={`${dow(d) === 0 ? "sun" : ""}${d === today ? " today" : ""}`}><span>{Number(d.slice(8))}</span><small>{"SMTWTFS"[dow(d)]}</small></th>)}
            {leaveOnly ? <th className="num">Leave</th> : <><th className="num">Days</th><th className="num">Hours</th><th className="num">Late</th><th className="num">Half</th><th className="num">Leave</th><th className="num" title="Timesheet hours on jobs out of hours logged in">On jobs</th><th className="num" title="Hours over 8h 15m a day">Extra hrs</th></>}</tr></thead>
          <tbody>{people.map((p) => {
            const mine = days.filter((d) => d.user === p.id && d.date.startsWith(month));
            const h = mine.reduce((s, d) => s + d.h, 0);
            const inH = mine.reduce((s, d) => s + d.m, 0) / 60;
            const onJobs = jobHours(p.id).reduce((s, e) => s + e.hours, 0);
            const pct = inH ? Math.round((onJobs / inH) * 100) : null;
            const lvDays = leaves.filter((l) => l.user_id === p.id && l.status === "approved").reduce((s, l) => s + leaveDays(l, `${month}-01`, `${month}-31`), 0) + mine.filter((d) => d.leave && !d.booked).length;
            return (
              <tr key={p.id}>
                <td className="who"><span className="av">{initials(p.full_name)}</span> {first(p.full_name)}</td>
                {ds.map((d) => { const c = cellOf(recs.get(`${d}|${p.id}`), leaveOn(leaves, p.id, d), d, today, !!leaveOnly); const on = pick?.uid === p.id && pick.date === d; return (
                  <td key={d} className={`${dow(d) === 0 ? "sun" : ""}${d === today ? " today" : ""}`}>
                    {c.cls && c.cls !== "sun" ? <button type="button" className={`sq ${c.cls}${on ? " on" : ""}`} title={`${who(p.id)} · ${fmtDate(d)}: ${c.tip}`} aria-label={`${who(p.id)} ${fmtDate(d)} ${c.tip}`}
                      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPick(on ? null : { uid: p.id, date: d, x: Math.min(r.left, window.innerWidth - 290), y: r.bottom + 6 }); }}>{c.t}</button> : null}
                  </td>); })}
                {leaveOnly ? <td className="num mono">{n1(lvDays)}</td> : <>
                  <td className="num mono">{mine.filter((d) => (d.first || d.h) && !d.leave).length}</td>
                  <td className="num mono">{n1(h)}</td>
                  <td className="num mono" style={{ color: mine.some((d) => d.late) ? "var(--warn)" : undefined }}>{mine.filter((d) => d.late).length}</td>
                  <td className="num mono">{mine.filter((d) => d.half).length}</td>
                  <td className="num mono" style={{ color: lvDays ? "var(--danger)" : undefined }}>{n1(lvDays)}</td>
                  <td className="num mono" style={{ color: pct !== null && pct < 80 ? "var(--danger)" : undefined }}>{pct === null ? "—" : `${pct}%`}</td>
                  <td className="num mono">{n1(mine.reduce((s, d) => s + Math.max(0, d.h - WORK_DAY_H), 0))}</td></>}
              </tr>); })}</tbody>
        </table>
      </div>
      <div className="mlegend">
        {leaveOnly ? null : <><span><i className="sq ok" /> Present</span><span><i className="sq late" /> Late</span></>}
        <span><i className="sq half">½</i> Half day</span><span><i className="sq leave">L</i> Approved leave</span><span><i className="sq absent">!</i> Absent, no leave asked</span>
        <span><i className="sq booked">L</i> Booked leave</span><span><i className="sq pend">?</i> Leave waiting for approval</span>{leaveOnly ? null : <span><i className="sq forgot">–</i> Forgot to log out</span>}
      </div>
      {pick ? <div className="daypop" style={{ left: pick.x, top: pick.y }} role="dialog" aria-label="Day detail">
        <div className="row" style={{ justifyContent: "space-between" }}><strong>{first(who(pick.uid))} · {new Date(`${pick.date}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}</strong><button type="button" className="link" aria-label="Close" onClick={() => setPick(null)}>✕</button></div>
        <dl>
          {selLv ? <><dt>Leave</dt><dd>{leaveLabel(selLv.kind)}{selLv.part !== "full" ? " (half day)" : ""} · {selLv.status === "approved" ? "approved" : selLv.status === "pending" ? "waiting" : "not approved"}</dd></> : null}
          {sel?.first ? <><dt>Logged in</dt><dd>{time(sel.first)}{sel.late ? " (late)" : sel.lateExcused ? " (late, approved)" : ""}</dd><dt>Logged out</dt><dd>{sel.open ? "Still logged in" : time(sel.last) || "—"}</dd><dt>Logged in for</dt><dd>{hm(sel.m)}</dd></> : null}
          {sel ? <><dt>Timesheet</dt><dd>{n1(sel.h)}h</dd><dt>On jobs</dt><dd>{(() => { const js = jobHours(pick.uid, pick.date); return `${n1(js.reduce((s, e) => s + e.hours, 0))}h · ${new Set(js.map((e) => e.job_id)).size} job${new Set(js.map((e) => e.job_id)).size === 1 ? "" : "s"}`; })()}</dd></> : null}
          {selReq ? <><dt>Late reason</dt><dd>&ldquo;{selReq.reason || "No reason given"}&rdquo;</dd></> : null}
        </dl>
        {sel && isMaster ? <select aria-label="Change status" value={sel.override ?? ""} onChange={(e) => onOverride(sel, e.target.value)}>
          <option value="">{sel.late ? "Late (automatic)" : sel.leave ? "Leave (automatic)" : sel.half ? "Half day (automatic)" : "Automatic"}</option><option value="present">Working day</option><option value="half_day">Half day</option><option value="leave">Leave</option></select> : null}
        <div className="row" style={{ marginTop: 8 }}>
          {selReq?.status === "pending" && isMaster ? <><button type="button" className="ok" onClick={() => onLate(selReq, "approved")}>Approve late</button><button type="button" className="dangerlink" onClick={() => onLate(selReq, "rejected")}>Reject</button></> : null}
          <button type="button" onClick={() => { onOpenDay(pick.uid, pick.date); setPick(null); }}>Open day</button>
        </div>
      </div> : null}
    </div>
  );
}

/** Who is in right now, late, on a job, on leave or not logged in yet. */
export function RightNow({ people, att, timers, leaves, requests, jobs, clients, now, canMark, onMarkSick }: {
  people: Profile[]; att: Attendance[]; timers: JobTimer[]; leaves: LeaveReq[]; requests: LateRequest[]; jobs: Job[]; clients: Client[]; now: number;
  canMark: (uid: string) => boolean; onMarkSick: (uid: string) => void;
}) {
  const today = todayISO();
  const rows = people.map((p) => {
    const mine = att.filter((a) => a.user_id === p.id && a.work_date === today);
    const firstIn = mine.map((a) => a.clock_in).sort()[0];
    const open = mine.some((a) => !a.clock_out);
    const lastOut = mine.map((a) => a.clock_out ?? "").sort().pop();
    const lv = leaves.find((l) => l.user_id === p.id && l.status === "approved" && l.start_date <= today && l.end_date >= today);
    const t = timers.find((x) => x.user_id === p.id);
    const j = t?.job_id ? jobs.find((x) => x.id === t.job_id) : undefined;
    const late = !!firstIn && officeMin(firstIn) > 7 * 60 + 45;
    const asked = requests.some((r) => r.user_id === p.id && r.work_date === today && r.status === "pending");
    return { p, firstIn, open, lastOut, lv, t, j, late, asked };
  });
  const inN = rows.filter((r) => r.open).length, lvN = rows.filter((r) => r.lv && !r.open).length, noN = rows.filter((r) => !r.firstIn && !r.lv).length;
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "a client";
  return (
    <div className="panel rightnow">
      <div className="ph"><h2>Right now · {new Date(now).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</h2>
        <span className="note">{inN} of {rows.length} in · {lvN} on leave · {noN} not logged in</span></div>
      <div className="rnchips">{rows.map(({ p, firstIn, open, lastOut, lv, t, j, late, asked }) => (
        <span key={p.id} className={`rnchip ${lv && !open ? "leave" : !firstIn ? "none" : late ? "late" : open ? "in" : "out"}`}>
          <span className="av">{initials(p.full_name)}</span><b>{first(p.full_name)}</b>
          <span className="note">{lv && !open ? `🌴 ${leaveLabel(lv.kind).toLowerCase()}${lv.part !== "full" ? " (half day)" : ""}`
            : !firstIn ? "not logged in yet"
            : !open ? `in ${time(firstIn)} · logged out ${time(lastOut)}`
            : `${late ? "late " : "in "}${time(firstIn)}${late ? ` · log out ${time(new Date(Date.parse(firstIn) + 9 * 3600e3).toISOString())}` : ""} · ${t ? `on ${j ? `${clientName(j.client_id)} ${svcLabel(j.service)}` : "a job"}` : "no job running"}${asked ? " · approval asked" : ""}`}</span>
          {!firstIn && !lv && canMark(p.id) ? <button type="button" onClick={() => onMarkSick(p.id)}>Mark sick</button> : null}
        </span>))}</div>
    </div>
  );
}

const officeMin = (ts: string) => {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const n = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  return n("hour") * 60 + n("minute");
};

/** Leave and late starts waiting for this person's decision, and sick / personal leave left this year. */
export function Approvals({ me, people, leaves, requests, att, canApprove, onLeave, onLate }: {
  me: Profile; people: Profile[]; leaves: LeaveReq[]; requests: LateRequest[]; att: Attendance[]; canApprove: (uid: string) => boolean;
  onLeave: (l: LeaveReq, s: "approved" | "rejected") => void; onLate: (r: LateRequest, s: "approved" | "rejected") => void;
}) {
  const name = (id: string) => people.find((p) => p.id === id)?.full_name ?? "Former staff";
  const year = todayISO().slice(0, 4);
  const used = (uid: string) => leaves.filter((l) => l.user_id === uid && l.status === "approved" && (l.kind === "sick" || l.kind === "personal")).reduce((s, l) => s + leaveDays(l, `${year}-01-01`, `${year}-12-31`), 0);
  const lv = leaves.filter((l) => l.status === "pending" && canApprove(l.user_id)).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const late = me.role === "master" ? requests.filter((r) => r.status === "pending" && people.some((p) => p.id === r.user_id)) : [];
  const span = (l: LeaveReq) => (l.start_date === l.end_date ? fmtDate(l.start_date) : `${fmtDate(l.start_date)} to ${fmtDate(l.end_date)}`);
  const clash = (l: LeaveReq) => [...new Set(leaves.filter((o) => o.id !== l.id && o.user_id !== l.user_id && o.status === "approved" && o.start_date <= l.end_date && o.end_date >= l.start_date).map((o) => first(name(o.user_id))))];
  return (
    <div className="grid2" style={{ marginTop: 16 }}>
      <div className="panel">
        <div className="ph"><h2>Waiting for your approval</h2><span className="note">{lv.length + late.length}</span></div>
        {!lv.length && !late.length ? <div className="empty"><strong>Nothing waiting.</strong>Leave requests and late starts that need your decision show here.</div> : (
          <ul className="list apprlist">
            {lv.map((l) => { const c = clash(l); const d = leaveDays(l); return (
              <li key={l.id}><span className="av">{initials(name(l.user_id))}</span><div style={{ minWidth: 0, flex: 1 }}><div className="t">{first(name(l.user_id))} <span className="note">· {leaveLabel(l.kind)}, {span(l)}{l.part !== "full" ? ` half day ${l.part}` : ` (${d} day${d === 1 ? "" : "s"})`}</span></div>
                <div className="s">{l.reason ? `"${l.reason}" · ` : ""}{l.kind !== "unpaid" ? `${n1(LEAVE_ALLOWANCE - used(l.user_id))} days left · ` : ""}{c.length ? <span className="warn">⚠ {c.join(" and ")} also off</span> : "nobody else off"}</div></div>
                <div className="row"><button type="button" className="ok" onClick={() => onLeave(l, "approved")}>Approve</button><button type="button" className="dangerlink" onClick={() => onLeave(l, "rejected")}>Reject</button></div></li>); })}
            {late.map((r) => { const f = att.filter((a) => a.user_id === r.user_id && a.work_date === r.work_date).map((a) => a.clock_in).sort()[0]; return (
              <li key={`${r.user_id}|${r.work_date}`}><span className="av">{initials(name(r.user_id))}</span><div style={{ minWidth: 0, flex: 1 }}><div className="t">{first(name(r.user_id))} <span className="note">· Late start {r.work_date === todayISO() ? "today" : fmtDate(r.work_date)}{f ? ` ${time(f)}` : ""}</span></div>
                <div className="s">&ldquo;{r.reason || "No reason given"}&rdquo;</div></div>
                <div className="row"><button type="button" className="ok" onClick={() => onLate(r, "approved")}>Approve</button><button type="button" className="dangerlink" onClick={() => onLate(r, "rejected")}>Reject</button></div></li>); })}
          </ul>)}
      </div>
      <div className="panel">
        <div className="ph"><h2>Sick / personal leave left</h2><span className="note">{LEAVE_ALLOWANCE} days a year each</span></div>
        <div className="leaveleft">{people.map((p) => { const left = Math.max(0, LEAVE_ALLOWANCE - used(p.id)); return (
          <div key={p.id} className="row"><span className="nm">{first(p.full_name)}</span><i><b className={left < 3 ? "low" : undefined} style={{ width: `${(left / LEAVE_ALLOWANCE) * 100}%` }} /></i><span className="mono">{n1(left)} d</span></div>); })}</div>
        <p className="note" style={{ margin: "0 16px 14px" }}>Counts approved sick and personal leave from 1 January. Unpaid leave doesn&apos;t use the allowance.</p>
      </div>
    </div>
  );
}

/** Book approved leave for a team member (sick call, leave agreed in person). */
export function AddLeave({ people, supabase, meId, say, onDone }: { people: Profile[]; supabase: SB; meId: string; say: (m: string, e?: boolean) => void; onDone: () => void }) {
  const t = todayISO();
  const [v, setV] = useState({ user: people[0]?.id ?? "", kind: "sick" as LeaveReq["kind"], part: "full" as LeaveReq["part"], from: t, to: t, reason: "" });
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const to = v.part === "full" ? v.to : v.from;
    if (to < v.from) { say("The end date must be on or after the start date", true); return; }
    setBusy(true);
    const { error } = await supabase.from("leave_requests").insert({ user_id: v.user, start_date: v.from, end_date: to, kind: v.kind, part: v.part, reason: v.reason.trim(), status: "approved", decided_by: meId, decided_at: new Date().toISOString() });
    setBusy(false);
    if (error) { say(/row-level security|policy/i.test(error.message) ? "Run the team leave database update first (database-update-team-leave.sql)" : `Not saved: ${error.message}`, true); return; }
    say(`${leaveLabel(v.kind)} added for ${people.find((p) => p.id === v.user)?.full_name ?? "them"}`);
    onDone();
  }
  return (
    <form className="panel leaveform" style={{ padding: 16, marginBottom: 16 }} onSubmit={save}>
      <label className="f">Person<select id="al-user" value={v.user} onChange={(e) => setV({ ...v, user: e.target.value })}>{people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label>
      <label className="f">Type<select id="al-kind" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as LeaveReq["kind"] })}>{LEAVE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></label>
      <label className="f">How long<select id="al-part" value={v.part} onChange={(e) => setV({ ...v, part: e.target.value as LeaveReq["part"] })}><option value="full">Full day(s)</option><option value="am">Half day (morning)</option><option value="pm">Half day (afternoon)</option></select></label>
      <label className="f">{v.part === "full" ? "From" : "Date"}<input id="al-from" type="date" value={v.from} onChange={(e) => setV({ ...v, from: e.target.value, to: e.target.value > v.to ? e.target.value : v.to })} /></label>
      {v.part === "full" ? <label className="f">To<input id="al-to" type="date" min={v.from} value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} /></label> : null}
      <label className="f" style={{ gridColumn: "1 / -1" }}>Reason (optional)<input id="al-reason" value={v.reason} maxLength={1000} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="e.g. Called in sick" /></label>
      <div className="row" style={{ gridColumn: "1 / -1", justifyContent: "flex-end" }}><button type="button" onClick={onDone}>Cancel</button><button type="submit" className="primary" disabled={busy || !v.user}>Add approved leave</button></div>
    </form>
  );
}
