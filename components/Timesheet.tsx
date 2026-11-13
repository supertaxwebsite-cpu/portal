"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Attendance, Client, Job, Person, Profile, TimeEntry } from "@/lib/types";
import ClientPicker from "./ClientPicker";
import { MyLeave, TeamLeave, leaveLabel, leaveDays, LEAVE_KINDS, type LeaveReq } from "./Leave";
import { ST, fmtDate, iso, svcLabel, todayISO } from "@/lib/domain";

type SB = ReturnType<typeof createClient>;

const time = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const mins = (a: Attendance, now: number) => Math.max(0, ((a.clock_out ? Date.parse(a.clock_out) : now) - Date.parse(a.clock_in)) / 60000);
const hm = (m: number) => { const t = Math.round(m); return `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, "0")}m`; };
const hrs = (n: number) => `${Number(n.toFixed(2))} h`;
// Office rules (India office): Monday to Saturday, 7:30 am to 4:30 pm with a 45 min break
// (8h 15m of work, 9h logged in). Sunday is off. No annual leave.
// Log in after 7:45 am = Late; a past working day with no timesheet = Leave;
// a finished day under 6 hours logged in = Half day; logging out before the suggested time = Left early.
const OFFICE_TZ = "Asia/Kolkata";
export const START = 7 * 60 + 30;
const LATE_AFTER = 7 * 60 + 45;
const HALF_DAY_MIN = 6 * 60;
const SHIFT_MIN = 9 * 60; // 8h 15m work + 45 min break
const WORK_DAY_H = 8.25;
const EARLY_GRACE_MIN = 5;
export const officeMinutes = (ts: string) => {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: OFFICE_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const n = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  return n("hour") * 60 + n("minute");
};
const addDays = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1, dd + n)); return x.toISOString().slice(0, 10); };
/** A working day: Monday to Saturday (Sunday is off). */
const isWeekday = (d: string) => { const [y, m, dd] = d.split("-").map(Number); const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); return w >= 1 && w <= 6; };
/** When someone should log out: 9 hours after they started (or after 7:30 am if they came in early). */
export const suggestedOut = (firstIn: string) => {
  const t = Date.parse(firstIn);
  const base = Math.max(t, t - (officeMinutes(firstIn) - START) * 60000);
  return new Date(base + SHIFT_MIN * 60000).toISOString();
};

export interface Override { user_id: string; work_date: string; status: "present" | "leave" | "half_day"; note: string }
export interface LateRequest { user_id: string; work_date: string; reason: string; status: "pending" | "approved" | "rejected" }

export interface Day { user: string; date: string; first: string; last: string | null; open: boolean; m: number; h: number; late: boolean; leave: boolean; half: boolean; early: number; suggested: string; booked?: LeaveReq["kind"]; bookedPart?: LeaveReq["part"]; override?: Override["status"]; request?: LateRequest["status"]; lateExcused: boolean }

function buildDays(att: Attendance[], entries: TimeEntry[], people: { id: string; created_at?: string }[], from: string, to: string, now: number,
  overrides: Override[] = [], requests: LateRequest[] = [], leaves: LeaveReq[] = []): Day[] {
  const ids = new Set(people.map((p) => p.id));
  const map = new Map<string, Day>();
  const get = (user: string, date: string) => {
    const k = `${date}|${user}`;
    let d = map.get(k);
    if (!d) { d = { user, date, first: "", last: null, open: false, m: 0, h: 0, late: false, leave: false, half: false, early: 0, suggested: "", lateExcused: false }; map.set(k, d); }
    return d;
  };
  att.filter((a) => ids.has(a.user_id) && a.work_date >= from && a.work_date <= to).forEach((a) => {
    const d = get(a.user_id, a.work_date);
    if (!d.first || a.clock_in < d.first) d.first = a.clock_in;
    if (!a.clock_out) d.open = true; else if (!d.last || a.clock_out > d.last) d.last = a.clock_out;
    d.m += mins(a, now);
  });
  entries.filter((e) => ids.has(e.user_id) && e.work_date >= from && e.work_date <= to).forEach((e) => { get(e.user_id, e.work_date).h += e.hours; });
  // Past working days (Mon to Sat) with nothing recorded count as leave (from the day the person was added).
  const today = todayISO();
  people.forEach((p) => {
    const start = p.created_at && p.created_at.slice(0, 10) > from ? p.created_at.slice(0, 10) : from;
    for (let d = start; d <= to && d < today; d = addDays(d, 1)) if (isWeekday(d)) get(p.id, d);
  });
  // Approved leave: the booked days show with their leave type.
  const booked = new Map<string, LeaveReq>();
  leaves.filter((l) => l.status === "approved" && ids.has(l.user_id)).forEach((l) => {
    for (let d = l.start_date > from ? l.start_date : from; d <= l.end_date && d <= to && d <= today; d = addDays(d, 1)) if (isWeekday(d)) { get(l.user_id, d); booked.set(`${d}|${l.user_id}`, l); }
  });
  overrides.filter((o) => ids.has(o.user_id) && o.work_date >= from && o.work_date <= to).forEach((o) => { get(o.user_id, o.work_date); });
  const ov = new Map(overrides.map((o) => [`${o.work_date}|${o.user_id}`, o.status]));
  const rq = new Map(requests.map((r) => [`${r.work_date}|${r.user_id}`, r.status]));
  return [...map.values()].map((d) => {
    const k = `${d.date}|${d.user}`;
    const override = ov.get(k);
    const request = rq.get(k);
    const wasLate = !!d.first && officeMinutes(d.first) > LATE_AFTER;
    const lateExcused = wasLate && request === "approved";
    // A master admin's status change wins over the automatic Leave / Half day marks.
    const bk = booked.get(k);
    const leave = override ? override === "leave" : bk ? bk.part === "full" : d.h === 0 && d.date < today;
    const half = override ? override === "half_day" : bk && bk.part !== "full" ? true : !d.open && d.m > 0 && d.m < HALF_DAY_MIN;
    const suggested = d.first ? suggestedOut(d.first) : "";
    const earlyMin = !override && !half && !d.open && d.last && suggested ? Math.round((Date.parse(suggested) - Date.parse(d.last)) / 60000) : 0;
    return { ...d, booked: bk?.kind, bookedPart: bk?.part, override, request, lateExcused, late: wasLate && !lateExcused, leave, half, suggested, early: earlyMin > EARLY_GRACE_MIN ? earlyMin : 0 };
  });
}

const Status = ({ d }: { d: Day }) => (
  <>{d.leave ? <span className={`pill ${d.booked ? "info" : "danger"}`}>{d.booked ? leaveLabel(d.booked) : "Leave"}</span> : null} {d.late ? <span className="pill warn">Late{d.request === "pending" ? " · approval asked" : d.request === "rejected" ? " · not approved" : ""}</span> : null} {d.half ? <span className="pill info">Half day{d.booked && !d.leave ? ` · ${leaveLabel(d.booked)}` : ""}</span> : null} {d.early ? <span className="pill warn" title={`Suggested log out was ${time(d.suggested)}`}>Left {hm(d.early)} early</span> : null}
    {!d.leave && !d.late && !d.half && !d.early ? <span className="pill ok">{d.open ? "Working" : d.override === "present" ? "Working day" : "Present"}</span> : null}
    {d.lateExcused ? <> <span className="pill ok">Late approved</span></> : null}
    {d.override ? <span className="note" title="Changed by your manager"> ✎</span> : null}</>
);

const monday = () => { const d = new Date(); const back = (d.getDay() + 6) % 7; d.setDate(d.getDate() - back); return iso(d.getFullYear(), d.getMonth() + 1, d.getDate()); };

export default function Timesheet({ me, supabase, people, visible, clients, jobs, canSeeTeam, say }: {
  me: Profile; supabase: SB; people: Person[]; visible: Profile[]; clients: Client[]; jobs: Job[]; canSeeTeam: boolean;
  say: (m: string, e?: boolean) => void;
}) {
  const [day, setDay] = useState(todayISO());
  const [from, setFrom] = useState(monday());
  const [to, setTo] = useState(todayISO());
  const [who, setWho] = useState("");
  const [att, setAtt] = useState<Attendance[]>([]);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [requests, setRequests] = useState<LateRequest[]>([]);
  const [leaves, setLeaves] = useState<LeaveReq[]>([]);
  const [leaveMissing, setLeaveMissing] = useState(false);

  const monthStart = todayISO().slice(0, 8) + "01";
  const lo = [day, from, monthStart].sort()[0];
  const hi = [day, to].sort()[1];
  const load = useCallback(async () => {
    const [a, e] = await Promise.all([
      supabase.from("attendance").select("*").gte("work_date", lo).lte("work_date", hi).order("clock_in"),
      supabase.from("timesheet_entries").select("*").gte("work_date", lo).lte("work_date", hi).order("created_at"),
    ]);
    // Also find an open clock-in from an earlier day (someone forgot to clock out).
    const open = await supabase.from("attendance").select("*").eq("user_id", me.id).is("clock_out", null).order("clock_in", { ascending: false }).limit(1);
    if (a.error || e.error) { setMissing(/does not exist|schema cache/i.test((a.error ?? e.error)!.message)); return; }
    const all = [...(a.data as Attendance[]), ...((open.data as Attendance[] | null) ?? [])];
    setAtt([...new Map(all.map((x) => [x.id, x])).values()]);
    setEntries((e.data as TimeEntry[]).map((x) => ({ ...x, hours: Number(x.hours) })));
    // Status changes and late approvals (ignored if that database update hasn't been run yet).
    const [o, r] = await Promise.all([
      supabase.from("attendance_overrides").select("*").gte("work_date", lo).lte("work_date", hi),
      supabase.from("late_requests").select("*").or(`status.eq.pending,and(work_date.gte.${lo},work_date.lte.${hi})`),
    ]);
    setOverrides(o.error ? [] : (o.data as Override[]));
    setRequests(r.error ? [] : (r.data as LateRequest[]));
    // Booked leave: anything that ends on or after the earliest date shown (so future leave shows too).
    const lv = await supabase.from("leave_requests").select("*").gte("end_date", lo).order("start_date");
    setLeaveMissing(!!lv.error && /does not exist|schema cache|leave_requests/i.test(lv.error.message));
    setLeaves(lv.error ? [] : (lv.data as LeaveReq[]));
  }, [supabase, lo, hi, me.id]);

  useEffect(() => {
    load();
    const ch = supabase.channel("timesheets")
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "timesheet_entries" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance_overrides" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "late_requests" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "leave_requests" }, () => load())
      .subscribe();
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => { clearInterval(t); supabase.removeChannel(ch); };
  }, [supabase, load]);

  const name = (id: string) => people.find((p) => p.id === id)?.full_name ?? "Former staff";
  const clientName = (id: string | null) => (id ? clients.find((c) => c.id === id)?.name ?? "Deleted client" : "");
  const jobLabel = (id: string | null) => { const j = id ? jobs.find((x) => x.id === id) : undefined; return j ? `${svcLabel(j.service)} · ${j.period}` : ""; };

  const openShift = att.filter((a) => a.user_id === me.id && !a.clock_out).sort((a, b) => b.clock_in.localeCompare(a.clock_in))[0];
  const myDayAtt = att.filter((a) => a.user_id === me.id && a.work_date === day);
  const myDay = entries.filter((e) => e.user_id === me.id && e.work_date === day);
  const myHours = myDay.reduce((s, e) => s + e.hours, 0);
  // Clock out is allowed only once the shift's day has at least one timesheet line.
  // Previous days are locked (except the master admin, and the day of a shift still clocked in).
  const dayOpen = day >= todayISO() || me.role === "master" || (!!openShift && openShift.work_date === day);
  const shiftFilled = !!openShift && entries.some((e) => e.user_id === me.id && e.work_date === openShift.work_date);
  // While clocked in, show the shift's own day (a shift that started before midnight stays on that day).
  const jumped = useRef("");
  useEffect(() => {
    if (openShift && jumped.current !== openShift.id) { jumped.current = openShift.id; setDay(openShift.work_date); }
  }, [openShift]);

  async function clock(kind: "clock_in" | "clock_out") {
    setBusy(true);
    const { error } = await supabase.rpc(kind);
    setBusy(false);
    if (error) { say(`That didn't work: ${error.message.replace(/clock out/g, "log out").replace(/clocked in/g, "logged in")}`, true); return; }
    say(kind === "clock_in" ? "Logged in" : "Logged out");
    load();
  }

  if (missing) {
    return <div className="panel empty"><strong>Timesheets aren&apos;t switched on yet.</strong>Ask your manager to switch them on.</div>;
  }

  const myMonth = buildDays(att, entries, [me], monthStart, todayISO(), now, overrides, requests, leaves);
  const monthEnd = addDays(addDays(monthStart, 32).slice(0, 8) + "01", -1);
  const myLeaveMonth = leaves.filter((l) => l.user_id === me.id && l.status === "approved");
  const leaveByKind = LEAVE_KINDS.map((k) => ({ ...k, n: myLeaveMonth.filter((l) => l.kind === k.id).reduce((s, l) => s + leaveDays(l, monthStart, monthEnd), 0) })).filter((k) => k.n);
  // Suggested log-out for the shift that's running (9 hours after the start, or after 7:30 am).
  const shiftFirst = openShift ? att.filter((a) => a.user_id === me.id && a.work_date === openShift.work_date).map((a) => a.clock_in).sort()[0] : "";
  const outAt = shiftFirst ? suggestedOut(shiftFirst) : "";
  const startedLate = !!shiftFirst && officeMinutes(shiftFirst) > START;
  // Hours this month against the target (working days so far, Mon to Sat, 8h 15m each).
  let workDays = 0;
  for (let d = monthStart; d <= todayISO(); d = addDays(d, 1)) if (isWeekday(d) && !myMonth.some((x) => x.date === d && (x.override === "leave" || (x.booked && x.bookedPart === "full")))) workDays++;
  const monthHours = entries.filter((e) => e.user_id === me.id && e.work_date >= monthStart).reduce((s, e) => s + e.hours, 0);
  const target = workDays * WORK_DAY_H;
  const isMaster = me.role === "master";

  async function askApproval(d: Day) {
    const reason = window.prompt(`Why were you late on ${fmtDate(d.date)}? This goes to your manager for approval.`);
    if (reason === null) return;
    const { error } = await supabase.from("late_requests").insert({ user_id: me.id, work_date: d.date, reason: reason.trim(), status: "pending" });
    if (error) { say(`Not sent: ${error.message}`, true); return; }
    say("Sent to your manager for approval");
    load();
  }
  async function decide(r: LateRequest, status: "approved" | "rejected") {
    const { error } = await supabase.from("late_requests").update({ status, decided_by: me.id, decided_at: new Date().toISOString() }).eq("user_id", r.user_id).eq("work_date", r.work_date);
    if (error) { say(`Not saved: ${error.message}`, true); return; }
    say(status === "approved" ? "Late approved" : "Late not approved");
    load();
  }
  async function setOverride(d: Day, status: string) {
    const q = status
      ? supabase.from("attendance_overrides").upsert({ user_id: d.user, work_date: d.date, status, set_by: me.id, set_at: new Date().toISOString() })
      : supabase.from("attendance_overrides").delete().eq("user_id", d.user).eq("work_date", d.date);
    const { error } = await q;
    if (error) { say(`Not saved: ${error.message}`, true); return; }
    say(status ? "Status changed" : "Back to automatic status");
    load();
  }
  const pending = requests.filter((r) => r.status === "pending" && visible.some((p) => p.id === r.user_id));

  // ----- team view -----
  const teamIds = new Set(visible.map((p) => p.id));
  const teamEntries = entries.filter((e) => teamIds.has(e.user_id) && e.work_date >= from && e.work_date <= to && (!who || e.user_id === who))
    .sort((a, b) => a.work_date.localeCompare(b.work_date) || name(a.user_id).localeCompare(name(b.user_id)));
  const teamPeople = visible.filter((p) => !who || p.id === who);
  const summary = buildDays(att, entries, teamPeople, from, to, now, overrides, requests, leaves).sort((a, b) => b.date.localeCompare(a.date) || name(a.user).localeCompare(name(b.user)));
  const counts = { early: summary.filter((d) => d.early).length, late: summary.filter((d) => d.late).length, leave: summary.filter((d) => d.leave).length, half: summary.filter((d) => d.half).length };

  function exportCsv() {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Date", "Person", "Client", "Job", "Hours", "Description"], ...teamEntries.map((e) => [e.work_date, name(e.user_id), clientName(e.client_id), jobLabel(e.job_id), e.hours, e.description])];
    rows.push([], ["Date", "Person", "Logged in", "Logged out", "Time logged in (hours)", "Timesheet hours", "Status"]);
    summary.forEach((d) => rows.push([d.date, name(d.user), time(d.first || null), d.open ? "Still logged in" : time(d.last), (d.m / 60).toFixed(2), d.h, [d.leave && (d.booked ? leaveLabel(d.booked) : "Absent"), d.half && d.booked && !d.leave && leaveLabel(d.booked), d.late && "Late", d.half && "Half day", d.early && `Left ${d.early} min early`].filter(Boolean).join(", ") || "Present"]));
    const blob = new Blob(["﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `supertax-timesheets-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <div className="pagehead"><div><h1>Timesheet</h1><p>Log in when you start, log out when you finish, and record what you worked on.</p></div></div>

      <div className="grid2">
        <div className="section">
          <div className="panel" style={{ padding: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <h2 style={{ margin: 0 }}>{openShift ? "You're logged in" : "You're logged out"}</h2>
                <p className="note" style={{ margin: "4px 0 0" }}>{openShift
                  ? <>Since {time(openShift.clock_in)}{openShift.work_date !== todayISO() ? ` on ${fmtDate(openShift.work_date)}` : ""} · {hm(mins(openShift, now))}</>
                  : "Log in when you start work."}</p>
                {openShift && outAt ? <p className="pill warn" style={{ margin: "8px 0 0", whiteSpace: "normal" }}>🕓 Suggested log out <strong>{time(outAt)}</strong>{startedLate ? " (you started after 7:30, so this moves later to make up 8h 15m of work)" : ""}</p> : null}
                {openShift && !shiftFilled ? <p className="pill warn" style={{ margin: "8px 0 0", whiteSpace: "normal" }}>Fill in your timesheet for {fmtDate(openShift.work_date)} below before you log out.</p> : null}
              </div>
              {openShift
                ? <button type="button" className="primary big" style={{ width: "auto" }} disabled={busy || !shiftFilled} title={shiftFilled ? undefined : "Fill in your timesheet first"} onClick={() => clock("clock_out")}>Log out</button>
                : <button type="button" className="primary big" style={{ width: "auto" }} disabled={busy} onClick={() => clock("clock_in")}>Log in</button>}
            </div>
          </div>
          <MyLeave me={me} supabase={supabase} list={leaves} missing={leaveMissing} say={say} onSaved={load} />
        </div>

        <div className="section">
          <div className="panel" style={{ padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>My attendance this month</h2>
            <p className="note" style={{ margin: "2px 0 0" }}>Timesheet <strong>{hrs(monthHours)}</strong> of {hrs(target)} target ({workDays} working day{workDays === 1 ? "" : "s"} so far, 8h 15m each)</p>
            <div className="row" style={{ margin: "6px 0 10px" }}>
              <span className="pill warn">{myMonth.filter((d) => d.late).length} late</span>
              <span className="pill warn">{myMonth.filter((d) => d.early).length} left early</span>
              <span className="pill info">{myMonth.filter((d) => d.half).length} half day</span>
              <span className="pill danger">{myMonth.filter((d) => d.leave && !d.booked).length} absent</span>
            </div>
            {leaveByKind.length ? <p className="note" style={{ margin: "0 0 8px" }}>Leave booked this month: {leaveByKind.map((k) => `${k.label} ${k.n} day${k.n === 1 ? "" : "s"}`).join(" · ")}</p> : null}
            {myMonth.some((d) => d.late || d.half || d.leave || d.early || d.lateExcused) ? (
              <ul className="note" style={{ margin: 0, paddingLeft: 18 }}>{myMonth.filter((d) => d.late || d.half || d.leave || d.early || d.lateExcused).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map((d) => (
                <li key={d.date}>{fmtDate(d.date)}: <Status d={d} />{d.first ? ` (in ${time(d.first)})` : ""}
                  {d.late && !d.request ? <> <button type="button" className="link" onClick={() => askApproval(d)}>Ask for approval</button></> : null}</li>))}</ul>
            ) : <p className="note" style={{ margin: 0 }}>No late starts, half days or leave this month.</p>}
            <p className="note" style={{ margin: "10px 0 0" }}>Office hours: Monday to Saturday, 7:30 am to 4:30 pm (India time) with a 45 min break, so 8h 15m of work. Sunday is off. Late = log in after 7:45 am · Left early = log out before your suggested time · Half day = under 6 hours logged in · Absent = a working day with no timesheet and no leave booked. Your manager can see this.</p>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
          <div className="panel">
            <div className="ph"><h2>My timesheet</h2><label className="row note">Date <input type="date" id="ts-day" value={day} max={todayISO()} onChange={(e) => e.target.value && setDay(e.target.value)} /></label></div>
            <p className="note" style={{ padding: "4px 14px 0", margin: 0 }}>
              {myDayAtt.length ? <>Logged in {myDayAtt.map((a) => `${time(a.clock_in)}–${a.clock_out ? time(a.clock_out) : "now"}`).join(", ")} · {hm(myDayAtt.reduce((s, a) => s + mins(a, now), 0))}</> : "No log-in this day."} · Timesheet <strong>{hrs(myHours)}</strong>
            </p>
            <div className="tablebox solo" style={{ margin: 12 }}>
              <table id="my-entries"><thead><tr><th>Client</th><th>Job</th><th style={{ textAlign: "right" }}>Hours</th><th>What you did</th><th></th></tr></thead>
                <tbody>
                  {myDay.map((e) => <EntryRow key={e.id} e={e} locked={!dayOpen} userId={me.id} clients={clients} jobs={jobs} supabase={supabase} say={say} onSaved={load} />)}
                  {!dayOpen && !myDay.length ? <tr><td colSpan={5} className="note">Nothing was recorded for this day.</td></tr> : null}
                  {dayOpen ? <EntryRow key={`new-${day}-${myDay.length}`} day={day} userId={me.id} clients={clients} jobs={jobs} supabase={supabase} say={say} onSaved={load} /> : null}
                </tbody></table>
            </div>
            {!dayOpen ? <p className="note" style={{ padding: "0 14px 12px", margin: 0 }}>🔒 Previous days are locked and can&apos;t be changed. Ask your manager if something needs correcting.</p> : null}
          </div>
      </div>

      {canSeeTeam ? (
        <div className="section" style={{ marginTop: 24 }}>
          <div className="pagehead"><div><h2 style={{ fontSize: 20, margin: 0 }}>Team timesheets</h2><p>{me.role === "master" ? "Everyone in the practice." : "You and the team members allocated to you."}</p></div>
            <div className="row"><button type="button" onClick={exportCsv} disabled={!summary.length}>Export CSV</button></div></div>
          <TeamLeave me={me} supabase={supabase} list={leaves} visible={visible} people={people} say={say} onSaved={load} />
          {isMaster && pending.length ? (
            <div className="panel" style={{ padding: 14, marginBottom: 12, borderColor: "var(--warn)" }}>
              <h2 style={{ margin: "0 0 8px" }}>Late log-ins waiting for your approval ({pending.length})</h2>
              <table><tbody>{pending.map((r) => { const first = att.filter((a) => a.user_id === r.user_id && a.work_date === r.work_date).map((a) => a.clock_in).sort()[0]; return (
                <tr key={`${r.user_id}|${r.work_date}`}><td className="client">{name(r.user_id)}</td><td>{fmtDate(r.work_date)}</td><td>{first ? `Logged in ${time(first)}` : ""}</td><td style={{ whiteSpace: "pre-wrap" }}>{r.reason || <span className="note">No reason given</span>}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}><button type="button" className="primary" onClick={() => decide(r, "approved")}>Approve</button> <button type="button" onClick={() => decide(r, "rejected")}>Don&apos;t approve</button></td></tr>); })}</tbody></table>
            </div>
          ) : null}
          <div>
          <div className="toolbar">
            <label className="row note">From <input type="date" id="tt-from" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
            <label className="row note">To <input type="date" id="tt-to" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
            <select id="tt-who" aria-label="Person" value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{visible.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
            <span className="row" style={{ marginLeft: "auto", gap: 6 }}><span className="pill warn">{counts.late} late</span><span className="pill warn">{counts.early} left early</span><span className="pill info">{counts.half} half day</span><span className="pill danger">{counts.leave} leave</span></span>
          </div>
          <div className="tablebox">
            {!summary.length ? <div className="empty"><strong>Nothing recorded for these dates.</strong>Log-ins and timesheet entries show here.</div> : (
              <table><thead><tr><th>Date</th><th>Person</th><th>Logged in</th><th>Logged out</th><th style={{ textAlign: "right" }}>Time logged in</th><th style={{ textAlign: "right" }}>Timesheet</th><th>Status</th></tr></thead>
                <tbody>{summary.map((d) => (
                  <tr key={`${d.date}|${d.user}`}><td>{fmtDate(d.date)}</td><td className="client">{name(d.user)}</td><td>{time(d.first || null) || "—"}</td>
                    <td>{d.open ? <span className="pill info">Still in</span> : time(d.last) || "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{d.m ? hm(d.m) : "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{d.h ? hrs(d.h) : "—"}</td><td><Status d={d} />
                      {isMaster ? <select aria-label="Change status" value={d.override ?? ""} onChange={(e) => setOverride(d, e.target.value)} style={{ marginLeft: 6, fontSize: 12, padding: "2px 4px" }}>
                        <option value="">Automatic</option><option value="present">Working day</option><option value="half_day">Half day</option><option value="leave">Leave</option></select> : null}</td></tr>))}</tbody></table>
            )}
          </div>
          </div>
          {teamEntries.length ? (
            <div className="tablebox solo" style={{ marginTop: 16 }}>
              <table><thead><tr><th>Date</th><th>Person</th><th>Client</th><th>Job</th><th style={{ textAlign: "right" }}>Hours</th><th>What they did</th></tr></thead>
                <tbody>{teamEntries.map((e) => (
                  <tr key={e.id}><td>{fmtDate(e.work_date)}</td><td>{name(e.user_id)}</td><td>{clientName(e.client_id)}</td><td>{jobLabel(e.job_id)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{hrs(e.hours)}</td><td style={{ whiteSpace: "pre-wrap" }}>{e.description}</td></tr>))}</tbody></table>
              <div className="count">{teamEntries.length} entr{teamEntries.length === 1 ? "y" : "ies"} · {hrs(teamEntries.reduce((s, e) => s + e.hours, 0))}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function EntryRow({ e, day, locked, userId, clients, jobs, supabase, say, onSaved }: {
  e?: TimeEntry; day?: string; locked?: boolean; userId: string; clients: Client[]; jobs: Job[]; supabase: SB; say: (m: string, er?: boolean) => void; onSaved: () => void;
}) {
  const [v, setV] = useState({ client_id: e?.client_id ?? "", job_id: e?.job_id ?? "", hours: e ? String(e.hours) : "", description: e?.description ?? "" });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // Lodged and completed jobs are closed for new time.
  const clientJobs = useMemo(() => jobs.filter((j) => j.client_id === v.client_id && (ST[j.status]?.open !== false || j.id === v.job_id)), [jobs, v.client_id, v.job_id]);
  const dirty = !e || v.client_id !== (e.client_id ?? "") || v.job_id !== (e.job_id ?? "") || Number(v.hours) !== e.hours || v.description !== e.description;

  async function save() {
    const hours = Number(v.hours);
    if (!(hours > 0 && hours <= 24)) { say("Enter hours between 0.25 and 24, for example 1.5", true); return; }
    if (!v.description.trim() && !v.client_id) { say("Pick a client or say what you worked on", true); return; }
    setBusy(true);
    const row = { client_id: v.client_id || null, job_id: v.job_id || null, hours, description: v.description.trim() };
    const { error } = e
      ? await supabase.from("timesheet_entries").update(row).eq("id", e.id)
      : await supabase.from("timesheet_entries").insert({ ...row, work_date: day, user_id: userId });
    setBusy(false);
    if (error) { say(`Not saved: ${error.message}`, true); return; }
    say(e ? "Saved" : "Added");
    setEditing(false);
    onSaved();
  }
  async function remove() {
    if (!e) return;
    const { error } = await supabase.from("timesheet_entries").delete().eq("id", e.id);
    if (error) { say(`Not removed: ${error.message}`, true); return; }
    onSaved();
  }

  // Saved lines show as plain text; the blank row at the bottom is the only form.
  if (e && (locked || !editing)) {
    const c = clients.find((x) => x.id === e.client_id);
    const j = jobs.find((x) => x.id === e.job_id);
    return <tr><td>{c?.name ?? "General / admin"}</td><td>{j ? `${svcLabel(j.service)} · ${j.period}` : "—"}</td><td className="mono" style={{ textAlign: "right" }}>{e.hours} h</td><td style={{ whiteSpace: "pre-wrap" }}>{e.description}</td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{locked ? null : <><button type="button" className="link" onClick={() => setEditing(true)}>Edit</button><button type="button" className="link" onClick={remove} style={{ marginLeft: 8 }}>Remove</button></>}</td></tr>;
  }
  return (
    <tr>
      <td><ClientPicker clients={clients} value={v.client_id} placeholder="Search client…" onChange={(id) => setV({ ...v, client_id: id, job_id: "" })} style={{ maxWidth: 200 }} /></td>
      <td><select aria-label="Job" value={v.job_id} onChange={(x) => setV({ ...v, job_id: x.target.value })} disabled={!v.client_id} style={{ maxWidth: 170 }}>
        <option value="">—</option>{clientJobs.map((j) => <option key={j.id} value={j.id}>{svcLabel(j.service)} · {j.period}</option>)}</select></td>
      <td style={{ textAlign: "right" }}><input aria-label="Hours" type="number" min="0.25" max="24" step="0.25" value={v.hours} onChange={(x) => setV({ ...v, hours: x.target.value })} style={{ width: 72 }} /></td>
      <td><input aria-label="What you did" value={v.description} onChange={(x) => setV({ ...v, description: x.target.value })} style={{ minWidth: 160, width: "100%" }}
        onKeyDown={(x) => { if (x.key === "Enter" && dirty) save(); }} /></td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        {dirty ? <button type="button" className={e ? undefined : "primary"} disabled={busy} onClick={save}>{e ? "Save" : "Add"}</button> : null}
        {e ? <button type="button" className="link" onClick={() => { setEditing(false); setV({ client_id: e.client_id ?? "", job_id: e.job_id ?? "", hours: String(e.hours), description: e.description }); }} style={{ marginLeft: 6 }}>Cancel</button> : null}
      </td>
    </tr>
  );
}
