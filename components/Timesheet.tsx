"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import { BREAK_ALLOWANCE_MIN, IDLE_ALERT_MIN, type AttBreak, type Attendance, type Client, type Job, type JobTimer, type Person, type Profile, type TimeEntry } from "@/lib/types";
import { AddLeave, Approvals, MonthGrid, monthDays } from "./TeamAttendance";
import ClientPicker from "./ClientPicker";
import { leaveLabel, leaveDays, LEAVE_KINDS, type LeaveReq } from "./Leave";
import { ST, fmtDate, iso, svcLabel, todayISO } from "@/lib/domain";
import { OFFICES, dayEndMs, isWorkDay, localMinutes, localTime, officeOf, suggestedOutFor, clockText, type Office } from "@/lib/office";

type SB = ReturnType<typeof createClient>;

const time = (ts: string | null, o: Office = OFFICES.India) => localTime(ts, o);
// A session counts up to its log-out, but never past midnight (local office time) of the day it started:
// a forgotten log-out closed days later must not add days of hours.
const mins = (a: Attendance, now: number, o: Office = OFFICES.India) => { const dayEnd = dayEndMs(a.work_date, o);
  return Math.max(0, (Math.min(a.clock_out ? Date.parse(a.clock_out) : now, isNaN(dayEnd) ? Infinity : dayEnd) - Date.parse(a.clock_in)) / 60000); };
const hm = (m: number) => { const t = Math.round(m); return `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, "0")}m`; };
const hrs = (n: number) => `${Number(n.toFixed(2))} h`;
// Office rules come from each person's work location (lib/office.ts): India office Monday to Saturday,
// 7:30 am to 4:30 pm; Australia office Monday to Friday, 9:00 am to 5:30 pm; both with a 45 min break.
// Log in after the late time = Late; a past working day with no timesheet = Absent;
// a finished day under the half-day minimum = Half day; logging out before the suggested time = Left early.
const EARLY_GRACE_MIN = 5;
const addDays = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1, dd + n)); return x.toISOString().slice(0, 10); };

export interface Override { user_id: string; work_date: string; status: "present" | "leave" | "half_day"; note: string }
export interface LateRequest { user_id: string; work_date: string; reason: string; status: "pending" | "approved" | "rejected" }

export interface Day { user: string; date: string; first: string; last: string | null; open: boolean; m: number; h: number; late: boolean; leave: boolean; half: boolean; early: number; suggested: string; booked?: LeaveReq["kind"]; bookedPart?: LeaveReq["part"]; override?: Override["status"]; request?: LateRequest["status"]; lateExcused: boolean; auto: boolean; office: Office }

function buildDays(att: Attendance[], entries: TimeEntry[], people: { id: string; created_at?: string; work_location?: string | null }[], from: string, to: string, now: number,
  overrides: Override[] = [], requests: LateRequest[] = [], leaves: LeaveReq[] = []): Day[] {
  const ids = new Set(people.map((p) => p.id));
  const offices = new Map(people.map((p) => [p.id, officeOf(p)]));
  const officeFor = (uid: string) => offices.get(uid) ?? OFFICES.India;
  const map = new Map<string, Day>();
  const get = (user: string, date: string) => {
    const k = `${date}|${user}`;
    let d = map.get(k);
    if (!d) { d = { user, date, first: "", last: null, open: false, m: 0, h: 0, late: false, leave: false, half: false, early: 0, suggested: "", lateExcused: false, auto: false, office: officeFor(user) }; map.set(k, d); }
    return d;
  };
  att.filter((a) => ids.has(a.user_id) && a.work_date >= from && a.work_date <= to).forEach((a) => {
    const d = get(a.user_id, a.work_date);
    if (!d.first || a.clock_in < d.first) d.first = a.clock_in;
    if (!a.clock_out) d.open = true; else if (!d.last || a.clock_out > d.last) d.last = a.clock_out;
    if (a.auto_closed) d.auto = true;
    d.m += mins(a, now, d.office);
  });
  entries.filter((e) => ids.has(e.user_id) && e.work_date >= from && e.work_date <= to).forEach((e) => { get(e.user_id, e.work_date).h += e.hours; });
  // Past working days (by office) with nothing recorded count as leave (from the day the person was added).
  const today = todayISO();
  people.forEach((p) => {
    const start = p.created_at && p.created_at.slice(0, 10) > from ? p.created_at.slice(0, 10) : from;
    for (let d = start; d <= to && d < today; d = addDays(d, 1)) if (isWorkDay(d, officeFor(p.id))) get(p.id, d);
  });
  // Approved leave: the booked days show with their leave type.
  const booked = new Map<string, LeaveReq>();
  leaves.filter((l) => l.status === "approved" && ids.has(l.user_id)).forEach((l) => {
    for (let d = l.start_date > from ? l.start_date : from; d <= l.end_date && d <= to && d <= today; d = addDays(d, 1)) if (isWorkDay(d, officeFor(l.user_id))) { get(l.user_id, d); booked.set(`${d}|${l.user_id}`, l); }
  });
  overrides.filter((o) => ids.has(o.user_id) && o.work_date >= from && o.work_date <= to).forEach((o) => { get(o.user_id, o.work_date); });
  const ov = new Map(overrides.map((o) => [`${o.work_date}|${o.user_id}`, o.status]));
  const rq = new Map(requests.map((r) => [`${r.work_date}|${r.user_id}`, r.status]));
  return [...map.values()].map((d) => {
    const k = `${d.date}|${d.user}`;
    const override = ov.get(k);
    const request = rq.get(k);
    const o = d.office;
    const wasLate = !!d.first && localMinutes(d.first, o) > o.lateAfter;
    const lateExcused = wasLate && request === "approved";
    // A master admin's status change wins over the automatic Leave / Half day marks.
    const bk = booked.get(k);
    const leave = override ? override === "leave" : bk ? bk.part === "full" : d.h === 0 && d.m === 0 && d.date < today;
    const half = override ? override === "half_day" : bk && bk.part !== "full" ? true : !d.open && d.m > 0 && d.m < o.halfDayMin;
    const suggested = d.first ? suggestedOutFor(d.first, o) : "";
    const earlyMin = !override && !half && !d.open && d.last && suggested ? Math.round((Date.parse(suggested) - Date.parse(d.last)) / 60000) : 0;
    return { ...d, booked: bk?.kind, bookedPart: bk?.part, override, request, lateExcused, late: wasLate && !lateExcused, leave, half, suggested, early: earlyMin > EARLY_GRACE_MIN ? earlyMin : 0 };
  });
}

const Status = ({ d }: { d: Day }) => (
  <>{d.leave ? <span className={`pill ${d.booked ? "info" : "danger"}`}>{d.booked ? leaveLabel(d.booked) : d.override === "leave" ? "Leave" : "Absent"}</span> : null} {d.late ? <span className="pill warn">Late{d.request === "pending" ? " · approval asked" : d.request === "rejected" ? " · not approved" : ""}</span> : null} {d.half ? <span className="pill info">Half day{d.booked && !d.leave ? ` · ${leaveLabel(d.booked)}` : ""}</span> : null} {d.early ? <span className="pill warn" title={`Suggested log out was ${time(d.suggested)}`}>Left {hm(d.early)} early</span> : null}
    {!d.leave && !d.late && !d.half && !d.early ? <span className="pill ok">{d.open ? "Working" : d.override === "present" ? "Working day" : "Present"}</span> : null}
    {d.lateExcused ? <> <span className="pill ok">Late approved</span></> : null}
    {d.override ? <span className="note" title="Changed by your manager"> ✎</span> : null}</>
);

const monday = () => { const d = new Date(); const back = (d.getDay() + 6) % 7; d.setDate(d.getDate() - back); return iso(d.getFullYear(), d.getMonth() + 1, d.getDate()); };

export default function Timesheet({ me, supabase, people, visible, clients, jobs, canSeeTeam, say, timers = [], startTab }: {
  startTab?: "req" | "mine"; me: Profile; supabase: SB; people: Person[]; visible: Profile[]; clients: Client[]; jobs: Job[]; canSeeTeam: boolean; timers?: JobTimer[];
  say: (m: string, e?: boolean) => void;
}) {
  const [day, setDay] = useState(todayISO());
  const [from, setFrom] = useState(monday());
  const [to, setTo] = useState(todayISO());
  const [who, setWho] = useState("");
  const [tday, setTday] = useState(todayISO()); // Team timesheets: the day shown
  const [twho, setTwho] = useState("");
  const [att, setAtt] = useState<Attendance[]>([]);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [requests, setRequests] = useState<LateRequest[]>([]);
  const [leaves, setLeaves] = useState<LeaveReq[]>([]);
  const [leaveMissing, setLeaveMissing] = useState(false);
  const [breaks, setBreaks] = useState<AttBreak[]>([]);
  const [breaksOn, setBreaksOn] = useState(false); // false until the breaks database update has been run

  const [tab, setTab] = useState<"grid" | "team" | "cal" | "req" | "log" | "mine">(startTab === "req" && canSeeTeam ? "req" : startTab === "mine" ? "mine" : canSeeTeam ? "grid" : "mine");
  const [gm, setGm] = useState(todayISO().slice(0, 7));
  const [adding, setAdding] = useState(false);
  const [mm, setMm] = useState(todayISO().slice(0, 7)); // My timesheet month
  const mmDays = monthDays(mm);
  const monthStart = todayISO().slice(0, 8) + "01";
  const gDays = monthDays(gm);
  const gStart = gDays[0], gEnd = gDays[gDays.length - 1];
  const lo = [day, tday, from, monthStart, mmDays[0], ...(canSeeTeam ? [gStart] : [])].sort()[0];
  const hi = [day, tday, to, mmDays[mmDays.length - 1], ...(canSeeTeam ? [gEnd] : [])].sort().pop()!;
  const yearStart = `${todayISO().slice(0, 4)}-01-01`;
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
    const lv = await supabase.from("leave_requests").select("*").gte("end_date", lo < yearStart ? lo : yearStart).order("start_date");
    setLeaveMissing(!!lv.error && /does not exist|schema cache|leave_requests/i.test(lv.error.message));
    setLeaves(lv.error ? [] : (lv.data as LeaveReq[]));
    const br = await supabase.from("attendance_breaks").select("*").gte("work_date", lo).lte("work_date", hi).order("started_at");
    setBreaksOn(!br.error);
    setBreaks(br.error ? [] : (br.data as AttBreak[]));
  }, [supabase, lo, hi, me.id, yearStart]);

  useEffect(() => {
    load();
    const ch = supabase.channel(`timesheets-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "timesheet_entries" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance_overrides" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "late_requests" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "leave_requests" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance_breaks" }, () => load())
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
  // Leave booked for the chosen day (approved): a full day takes no timesheet lines.
  const dayLeave = leaves.find((l) => l.user_id === me.id && l.status === "approved" && l.start_date <= day && l.end_date >= day);
  const dayFuture = day > todayISO();
  const dayOpen = !dayFuture && !(dayLeave && dayLeave.part === "full") && (day >= todayISO() || me.role === "master" || (!!openShift && openShift.work_date === day));
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
  async function takeBreak(kind: "start_break" | "end_break") {
    setBusy(true);
    const { error } = await supabase.rpc(kind);
    setBusy(false);
    if (error) { say(`That didn't work: ${error.message}`, true); return; }
    say(kind === "start_break" ? "Break started. Press End break when you're back." : "Welcome back. Break ended.");
    load();
  }

  if (missing) {
    return <div className="panel empty"><strong>Timesheets aren&apos;t switched on yet.</strong>Ask your manager to switch them on.</div>;
  }

  const myMonth = buildDays(att, entries, [me], monthStart, todayISO(), now, overrides, requests, leaves);
  const monthEnd = addDays(addDays(monthStart, 32).slice(0, 8) + "01", -1);
  const myLeaveMonth = leaves.filter((l) => l.user_id === me.id && l.status === "approved");
  const leaveByKind = LEAVE_KINDS.map((k) => ({ ...k, n: myLeaveMonth.filter((l) => l.kind === k.id).reduce((s, l) => s + leaveDays(l, monthStart, monthEnd), 0) })).filter((k) => k.n);
  // Suggested log-out for the shift that's running (a full shift after the start, or after the office start).
  const shiftFirst = openShift ? att.filter((a) => a.user_id === me.id && a.work_date === openShift.work_date).map((a) => a.clock_in).sort()[0] : "";
  const myOffice = officeOf(me);
  const outAt = shiftFirst ? suggestedOutFor(shiftFirst, myOffice) : "";
  const startedLate = !!shiftFirst && localMinutes(shiftFirst, myOffice) > myOffice.start;
  // Hours this month against the target (working days so far for their office).
  let workDays = 0;
  for (let d = monthStart; d <= todayISO(); d = addDays(d, 1)) if (isWorkDay(d, myOffice) && !myMonth.some((x) => x.date === d && (x.override === "leave" || (x.booked && x.bookedPart === "full")))) workDays++;
  const monthHours = entries.filter((e) => e.user_id === me.id && e.work_date >= monthStart).reduce((s, e) => s + e.hours, 0);
  const target = workDays * myOffice.workDayH;
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
    summary.forEach((d) => rows.push([d.date, name(d.user), time(d.first || null, d.office), d.open ? "Still logged in" : d.auto ? "Auto logged out" : time(d.last, d.office), (d.m / 60).toFixed(2), d.h, [d.leave && (d.booked ? leaveLabel(d.booked) : "Absent"), d.half && d.booked && !d.leave && leaveLabel(d.booked), d.late && "Late", d.half && "Half day", d.early && `Left ${d.early} min early`].filter(Boolean).join(", ") || "Present"]));
    const blob = new Blob(["﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `supertax-timesheets-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ----- team attendance (master admins and team leaders) -----
  const canApproveLeave = (uid: string) => uid !== me.id && (me.role === "master" || (me.role === "manager" && visible.some((p) => p.id === uid && (p.reports_to === me.id || p.manager_id === me.id))));
  async function decideLeave(l: LeaveReq, status: "approved" | "rejected") {
    const { error } = await supabase.from("leave_requests").update({ status, decided_by: me.id, decided_at: new Date().toISOString() }).eq("id", l.id);
    if (error) { say(`Not saved: ${error.message}`, true); return; }
    say(status === "approved" ? `Leave approved for ${name(l.user_id)}` : `Leave not approved for ${name(l.user_id)}`);
    load();
  }
  async function markSick(uid: string) {
    if (!window.confirm(`Mark ${name(uid)} as on sick leave today?`)) return;
    const t = todayISO();
    const { error } = await supabase.from("leave_requests").insert({ user_id: uid, start_date: t, end_date: t, kind: "sick", part: "full", reason: "Marked sick by manager", status: "approved", decided_by: me.id, decided_at: new Date().toISOString() });
    if (error) { say(/row-level security|policy/i.test(error.message) ? "Run the team leave database update first (database-update-team-leave.sql)" : `Not saved: ${error.message}`, true); return; }
    say(`${name(uid)} marked as sick today`);
    load();
  }
  const team = visible.filter((p) => p.active);
  const gTo = gEnd < todayISO() ? gEnd : todayISO();
  const gridDays = canSeeTeam ? buildDays(att, entries, team, gStart, gTo, now, overrides, requests, leaves) : [];
  const gm1 = gridDays.filter((d) => d.date.startsWith(gm));
  const teamH = gm1.reduce((s, d) => s + d.h, 0);
  const teamIn = gm1.reduce((s, d) => s + d.m, 0) / 60;
  const onJobsH = entries.filter((e) => e.job_id && e.work_date.startsWith(gm) && team.some((p) => p.id === e.user_id)).reduce((s, e) => s + e.hours, 0);
  const leaveTaken = leaves.filter((l) => l.status === "approved" && team.some((p) => p.id === l.user_id)).reduce((s, l) => s + leaveDays(l, gStart, gTo), 0) + gm1.filter((d) => d.leave && !d.booked && !d.override).length;
  const leaveAhead = leaves.filter((l) => l.status === "approved" && team.some((p) => p.id === l.user_id)).reduce((s, l) => s + leaveDays(l, addDays(gTo, 1), gEnd), 0);
  const forgot = gm1.filter((d) => d.open && d.date < todayISO()).length;
  const reqCount = leaves.filter((l) => l.status === "pending" && canApproveLeave(l.user_id)).length + (isMaster ? pending.length : 0);
  const shiftMonth = (n: number) => { const [y, m] = gm.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); setGm(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  function exportPayroll() {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows: unknown[][] = [["Person", "Days at work", "Timesheet hours", "Hours on jobs", "Extra hours", "Late starts", "Half days", "Absent (no leave asked)", ...LEAVE_KINDS.map((k) => `${k.label} (days)`)]];
    team.forEach((p) => {
      const ds = gm1.filter((d) => d.user === p.id);
      rows.push([p.full_name, ds.filter((d) => (d.first || d.h) && !d.leave).length, ds.reduce((s, d) => s + d.h, 0).toFixed(2),
        entries.filter((e) => e.user_id === p.id && e.job_id && e.work_date.startsWith(gm)).reduce((s, e) => s + e.hours, 0).toFixed(2),
        ds.reduce((s, d) => s + Math.max(0, d.h - d.office.workDayH), 0).toFixed(2), ds.filter((d) => d.late).length, ds.filter((d) => d.half).length, ds.filter((d) => d.leave && !d.booked && !d.override).length,
        ...LEAVE_KINDS.map((k) => leaves.filter((l) => l.user_id === p.id && l.status === "approved" && l.kind === k.id).reduce((s, l) => s + leaveDays(l, gStart, gEnd), 0))]);
    });
    const blob = new Blob(["\ufeff" + rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `supertax-payroll-${gm}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const dayEl = (
    <div className="panel">
      <div className="ph"><h2>Jobs and time · {fmtDate(day)}</h2><label className="row note">Date <input type="date" id="ts-day" value={day} max={todayISO()} onChange={(e) => { const v = e.target.value; if (!v) return; if (v > todayISO()) { say("Time can't be added for a future day.", true); setDay(todayISO()); } else setDay(v); }} /></label></div>
      <p className="note" style={{ padding: "4px 14px 0", margin: 0 }}>
        {dayLeave ? <><span className="pill info">On {leaveLabel(dayLeave.kind).toLowerCase()}{dayLeave.part !== "full" ? ` (${dayLeave.part === "am" ? "morning" : "afternoon"})` : ""}</span> · </> : null}{myDayAtt.length ? <>Logged in {myDayAtt.map((a) => `${time(a.clock_in)}–${a.clock_out ? time(a.clock_out) : "now"}`).join(", ")} · {hm(myDayAtt.reduce((s, a) => s + mins(a, now), 0))}</> : "No log-in this day."} · Timesheet <strong>{hrs(myHours)}</strong>
      </p>
      <div className="tablebox solo" style={{ margin: 12 }}>
        <table id="my-entries"><thead><tr><th>Client</th><th>Job</th><th style={{ textAlign: "right" }}>Hours</th><th style={{ minWidth: 280 }}>Timer times and comment</th><th></th></tr></thead>
          <tbody>
            {dayLines(myDay).map((g) => g.length === 1 && !timerParts(g[0])
              ? <EntryRow key={g[0].id} e={g[0]} locked={!dayOpen} userId={me.id} clients={clients} jobs={jobs} supabase={supabase} say={say} onSaved={load} />
              : <TimerLine key={g[0].id} list={g} locked={!dayOpen} clients={clients} jobs={jobs} supabase={supabase} say={say} onSaved={load} />)}
            {!dayOpen && !myDay.length ? <tr><td colSpan={5} className="note">{dayFuture ? "This day hasn't happened yet, so no time can be added." : dayLeave && dayLeave.part === "full" ? "You're on leave this day, so no time can be added." : "Nothing was recorded for this day."}</td></tr> : null}
            {dayOpen ? <EntryRow key={`new-${day}-${myDay.length}`} day={day} userId={me.id} clients={clients} jobs={jobs} supabase={supabase} say={say} onSaved={load} /> : null}
          </tbody>
          {myDay.length ? <tfoot><tr className="tstotal"><td colSpan={2}>Total for {fmtDate(day)}</td><td className="mono" style={{ textAlign: "right" }}>{hrs(myHours)}</td><td className="note">{hm(myHours * 60)} across {dayLines(myDay).length} line{dayLines(myDay).length === 1 ? "" : "s"}</td><td /></tr></tfoot> : null}</table>
      </div>
      {dayLeave && dayLeave.part !== "full" && dayOpen ? <p className="note" style={{ padding: "0 14px 12px", margin: 0 }}>Half day leave: add only the hours you worked (about 4h).</p> : null}
      {!dayOpen && !dayFuture && !(dayLeave && dayLeave.part === "full") ? <p className="note" style={{ padding: "0 14px 12px", margin: 0 }}>🔒 Previous days are locked and can&apos;t be changed. Ask your manager if something needs correcting.</p> : null}
    </div>
  );
  const mineEl = <MyTimesheet breaks={breaks} breaksOn={breaksOn} onBreak={takeBreak} me={me} supabase={supabase} embedded={canSeeTeam} month={mm} setMonth={setMm} att={att} entries={entries} leaves={leaves} requests={requests} overrides={overrides}
    timers={timers} jobs={jobs} clients={clients} now={now} busy={busy} leaveMissing={leaveMissing} openShift={openShift} shiftFilled={shiftFilled}
    day={day} setDay={setDay} onClock={clock} onExplain={askApproval} onSaved={load} say={say} dayEl={dayEl} />;

  if (!canSeeTeam) return mineEl;

  const logEl = (
    <>
      <div className="pagehead" style={{ marginTop: 4 }}><div><h2 style={{ fontSize: 20, margin: 0 }}>Day by day</h2><p>Log-in times, timesheet hours and status for each person and day.</p></div>
        <div className="row"><button type="button" onClick={exportCsv} disabled={!summary.length}>Export CSV</button></div></div>
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
                  <tr key={`${d.date}|${d.user}`}><td>{fmtDate(d.date)}</td><td className="client">{name(d.user)}</td><td>{time(d.first || null, d.office) || "—"}</td>
                    <td>{d.open ? <span className="pill info">Still in</span> : d.auto ? <span className="pill warn" title="Forgot to log out: logged out automatically at midnight India time">Auto logged out</span> : time(d.last, d.office) || "—"}</td>
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
    </>
  );
  // ----- team timesheets: one day, each person with their jobs on one line each -----
  const tPeople = visible.filter((p) => (!twho || p.id === twho) && p.active !== false);
  const tDays = new Map(buildDays(att, entries, tPeople, tday, tday, now, overrides, requests, leaves).map((d) => [d.user, d]));
  const tCards = tPeople.map((p) => ({ p, d: tDays.get(p.id), list: entries.filter((e) => e.user_id === p.id && e.work_date === tday) }))
    .sort((a, b) => Number(!!b.d?.first || b.list.length > 0) - Number(!!a.d?.first || a.list.length > 0) || a.p.full_name.localeCompare(b.p.full_name));
  const tTotal = tCards.reduce((s, c) => s + c.list.reduce((x, e) => x + Number(e.hours), 0), 0);
  const tIn = tCards.reduce((s, c) => s + (c.d?.m ?? 0), 0);
  const tRun = (uid: string) => timers.find((t) => t.user_id === uid && !t.ended_at);
  const shiftDay = (n: number) => { const v = addDays(tday, n); if (v <= todayISO()) setTday(v); };
  const teamDayEl = (
    <>
      <div className="toolbar tdaybar">
        <button type="button" aria-label="Previous day" onClick={() => shiftDay(-1)}>‹</button>
        <input type="date" id="td-day" value={tday} max={todayISO()} onChange={(e) => e.target.value && setTday(e.target.value > todayISO() ? todayISO() : e.target.value)} />
        <button type="button" aria-label="Next day" disabled={tday >= todayISO()} onClick={() => shiftDay(1)}>›</button>
        {tday !== todayISO() ? <button type="button" className="link" onClick={() => setTday(todayISO())}>Today</button> : null}
        <select aria-label="Person" value={twho} onChange={(e) => setTwho(e.target.value)}><option value="">Everyone</option>{visible.filter((p) => p.active !== false).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
        <span className="row" style={{ marginLeft: "auto", gap: 6 }}><span className="pill info">Timesheet {hrs(tTotal)}</span><span className="pill">Logged in {hm(tIn)}</span>{tIn ? <span className="pill ok">{Math.round((tTotal * 60 / tIn) * 100)}% on jobs</span> : null}</span>
      </div>
      {!tCards.length ? <div className="panel"><div className="empty"><strong>Nobody to show.</strong>Pick another person.</div></div> : tCards.map(({ p, d, list }) => {
        const lines = dayLines(list);
        const h = list.reduce((x, e) => x + Number(e.hours), 0);
        const run = tday === todayISO() ? tRun(p.id) : undefined;
        const runJob = run ? jobs.find((j) => j.id === run.job_id) : undefined;
        return (
          <div key={p.id} className="panel tdcard">
            <div className="tdhead">
              <div><strong>{p.full_name}</strong>{p.title ? <span className="note"> · {p.title}</span> : null}</div>
              <div className="tdmeta">
                {d?.first ? <span>In <b>{time(d.first, d.office)}</b></span> : null}
                {d?.first ? <span>Out <b>{d.open ? (tday === todayISO() ? "still in" : "not logged out") : d.auto ? "auto" : time(d.last, d.office) || "—"}</b></span> : null}
                {d?.m ? <span>Logged in <b>{hm(d.m)}</b></span> : null}
                <span>Timesheet <b>{hrs(h)}</b></span>
                {d?.m ? <span>On jobs <b>{Math.round((h * 60 / d.m) * 100)}%</b></span> : null}
                {d ? <Status d={d} /> : <span className="pill">No log-in</span>}
              </div>
            </div>
            {run ? <div className="tdrun">▶ Timer running now on <b>{clientName(runJob?.client_id ?? null) || "a job"}</b>{runJob ? ` · ${svcLabel(runJob.service)} ${runJob.period}` : ""} since {time(run.started_at)}</div> : null}
            {!lines.length ? <div className="note" style={{ padding: "10px 16px 14px" }}>No timesheet lines for this day.</div> : (
              <div style={{ overflowX: "auto" }}><table className="tdtable"><thead><tr><th>Client</th><th>Job</th><th style={{ textAlign: "right" }}>Hours</th><th>Timer times and comment</th></tr></thead>
                <tbody>{lines.map((g) => {
                  const ps = g.map((e) => ({ e, t: timerParts(e) }));
                  const comment = ps.map(({ e, t }) => (t ? t.comment : e.description)).filter(Boolean).join("\n");
                  return <tr key={g[0].id}><td>{clientName(g[0].client_id) || "General / admin"}</td><td>{jobLabel(g[0].job_id) || "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{hrs(g.reduce((x, e) => x + Number(e.hours), 0))}</td>
                    <td>{ps.some((x) => x.t) ? <div className="tsess">{ps.map(({ e, t }) => t ? <span key={e.id} className="tchip">🔒 {t.start}{t.end ? `–${t.end}` : ""}{t.label ? ` · ${t.label}` : ""}<i>{Number(Number(e.hours).toFixed(2))}h</i></span> : null)}</div> : <span className="pill">Added by hand</span>}
                      {comment ? <div className="tcomment">{comment}</div> : <div className="note tcomment">No comment</div>}</td></tr>;
                })}</tbody>
                <tfoot><tr className="tstotal"><td colSpan={2}>Total</td><td className="mono" style={{ textAlign: "right" }}>{hrs(h)}</td><td className="note">{hm(h * 60)} across {lines.length} line{lines.length === 1 ? "" : "s"}</td></tr></tfoot></table></div>)}
          </div>);
      })}
    </>
  );
  const monthLabel = new Date(`${gm}-01T00:00:00`).toLocaleDateString("en-AU", { month: "long", year: "numeric" });

  return (
    <>
      <div className="pagehead">
        <div><h1>Team attendance</h1><p>{me.role === "master" ? "Everyone's" : "Your team's"} log-ins, hours and leave for the whole month.</p></div>
        <div className="row">
          <button type="button" aria-label="Previous month" onClick={() => shiftMonth(-1)}>‹</button><strong style={{ minWidth: 130, textAlign: "center" }}>{monthLabel}</strong><button type="button" aria-label="Next month" onClick={() => shiftMonth(1)}>›</button>
          <button type="button" onClick={exportPayroll}>⬇ Export for payroll</button>
          <button type="button" onClick={() => setAdding(!adding)}>+ Add leave for someone</button>
        </div>
      </div>
      <div className="quickpills">{([["grid", "Month grid", 0], ["team", "Team timesheets", 0], ["cal", "Leave calendar", 0], ["req", "Requests", reqCount], ["log", "Day by day", 0], ["mine", "My own timesheet", 0]] as [typeof tab, string, number][]).map(([k, l, n]) => (
        <button key={k} type="button" className={tab === k ? "on" : undefined} onClick={() => setTab(k)}>{l}{n ? <i className="hot">{n}</i> : null}</button>))}</div>
      {adding ? <AddLeave people={team.filter((p) => canApproveLeave(p.id))} supabase={supabase} meId={me.id} say={say} onDone={() => { setAdding(false); load(); }} /> : null}
      {tab === "grid" ? <>
        <TeamToday people={team} att={att} entries={entries} timers={timers} breaks={breaks} breaksOn={breaksOn} leaves={leaves} requests={requests} overrides={overrides} jobs={jobs} clients={clients} now={now} canMark={canApproveLeave} onMarkSick={markSick} />
        <div className="atiles">
          <div className="panel b-blue"><span className="val">{Math.round(teamH)}<small>h</small></span><span className="lbl">Team hours this month</span></div>
          <div className="panel b-blue"><span className="val">{teamIn ? Math.round((onJobsH / teamIn) * 100) : 0}<small>%</small></span><span className="lbl">Time on jobs (timesheet hours on jobs out of hours logged in)</span></div>
          <div className="panel b-warn"><span className="val">{gm1.filter((d) => d.late).length}</span><span className="lbl">Late starts</span></div>
          <div className="panel b-blue"><span className="val">{gm1.filter((d) => d.half).length}</span><span className="lbl">Half days</span></div>
          <div className="panel b-danger"><span className="val">{Number(leaveTaken.toFixed(1))}{leaveAhead ? <small> + {Number(leaveAhead.toFixed(1))} booked</small> : null}</span><span className="lbl">Leave days this month</span></div>
          <div className="panel b-navy"><span className="val">{forgot}</span><span className="lbl">Forgot to log out</span></div>
        </div>
        <MonthGrid month={gm} people={team} days={gridDays} leaves={leaves} entries={entries} requests={requests} isMaster={isMaster} onOverride={setOverride} onLate={decide}
          onOpenDay={(uid, d) => { setFrom(d); setTo(d); setWho(uid); setTab("log"); }} />
        <Approvals me={me} people={team} leaves={leaves} requests={requests} att={att} canApprove={canApproveLeave} onLeave={decideLeave} onLate={decide} />
      </> : null}
      {tab === "cal" ? <MonthGrid leaveOnly month={gm} people={team} days={gridDays} leaves={leaves} entries={entries} requests={requests} isMaster={isMaster} onOverride={setOverride} onLate={decide}
        onOpenDay={(uid, d) => { setFrom(d); setTo(d); setWho(uid); setTab("log"); }} /> : null}
      {tab === "req" ? <>
        <Approvals me={me} people={team} leaves={leaves} requests={requests} att={att} canApprove={canApproveLeave} onLeave={decideLeave} onLate={decide} />
      </> : null}
      {tab === "team" ? teamDayEl : null}
      {tab === "log" ? logEl : null}
      {tab === "mine" ? mineEl : null}
    </>
  );
}

// ============================================================
// My timesheet: today, this month at a glance, leave, requests, day by day.
// ============================================================
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dowOf = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7; };
const short = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }); };
const n1 = (n: number) => String(Number(n.toFixed(1)));
/** Compact time for the calendar, e.g. 7:28. */
const hmS = (m: number) => { const t = Math.max(0, Math.round(m)); return t < 60 ? `${t}m` : `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, "0")}m`; };
const leaveSpan = (l: LeaveReq) => { const a = Number(l.start_date.slice(8)), b = Number(l.end_date.slice(8)); const mon = new Date(`${l.end_date}T00:00:00`).toLocaleDateString("en-AU", { month: "short" });
  return l.start_date === l.end_date ? `${a} ${mon}` : l.start_date.slice(0, 7) === l.end_date.slice(0, 7) ? `${a}–${b} ${mon}` : `${fmtDate(l.start_date)} to ${fmtDate(l.end_date)}`; };

function MyTimesheet({ breaks, breaksOn, onBreak, me, supabase, embedded, month, setMonth, att, entries, leaves, requests, overrides, timers, jobs, clients, now, busy, leaveMissing, openShift, shiftFilled,
  day, setDay, onClock, onExplain, onSaved, say, dayEl }: {
  me: Profile; supabase: SB; embedded: boolean; month: string; setMonth: (m: string) => void; att: Attendance[]; entries: TimeEntry[]; leaves: LeaveReq[]; requests: LateRequest[];
  overrides: Override[]; timers: JobTimer[]; jobs: Job[]; clients: Client[]; now: number; busy: boolean; leaveMissing: boolean; openShift?: Attendance; shiftFilled: boolean;
  day: string; setDay: (d: string) => void; onClock: (k: "clock_in" | "clock_out") => void; onExplain: (d: Day) => void; onSaved: () => void; say: (m: string, e?: boolean) => void; dayEl: React.ReactNode;
  breaks: AttBreak[]; breaksOn: boolean; onBreak: (k: "start_break" | "end_break") => void;
}) {
  const today = todayISO();
  const o = officeOf(me);
  const time = (ts: string | null) => localTime(ts, o);
  const ct = (ts: string) => time(ts).replace(/\s?[ap]m$/i, "");
  const mDays = monthDays(month);
  const mStart = mDays[0], mEnd = mDays[mDays.length - 1];
  const upTo = mEnd < today ? mEnd : today;
  const days = mStart <= today ? buildDays(att, entries, [me], mStart, upTo, now, overrides, requests, leaves) : [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const myLeaves = leaves.filter((l) => l.user_id === me.id);
  const leaveOn = (d: string) => myLeaves.find((l) => l.status !== "rejected" && l.start_date <= d && l.end_date >= d);
  const jobH = (d: string) => entries.filter((e) => e.user_id === me.id && e.work_date === d && e.job_id).reduce((s, e) => s + e.hours, 0);

  // ----- today -----
  const tDate = openShift?.work_date ?? today;
  const tAtt = att.filter((a) => a.user_id === me.id && a.work_date === tDate);
  const tFirst = tAtt.map((a) => a.clock_in).sort()[0] ?? "";
  const tMin = tAtt.reduce((s, a) => s + mins(a, now, o), 0);
  const myTimer = timers.find((t) => t.user_id === me.id && !t.ended_at);
  const runMin = myTimer ? Math.max(0, (now - Date.parse(myTimer.started_at)) / 60000) : 0;
  const tJobMin = jobH(tDate) * 60 + runMin;
  const runJob = myTimer?.job_id ? jobs.find((j) => j.id === myTimer.job_id) : undefined;
  const outAt = tFirst ? suggestedOutFor(tFirst, o) : "";
  const afterStart = tFirst ? localMinutes(tFirst, o) - o.start : 0;
  const TARGET = o.workDayH * 60; // work a day
  const DAY_IN = o.shiftMin; // logged in a day, including the 45 min break

  // ----- this month -----
  let workDays = 0;
  for (let d = mStart; d <= upTo; d = addDays(d, 1)) if (isWorkDay(d, o) && !days.some((x) => x.date === d && (x.override === "leave" || (x.booked && x.bookedPart === "full")))) workDays++;
  const worked = days.filter((d) => d.first && !d.leave).length;
  const tsH = entries.filter((e) => e.user_id === me.id && e.work_date >= mStart && e.work_date <= mEnd).reduce((s, e) => s + e.hours, 0);
  const inH = days.reduce((s, d) => s + d.m, 0) / 60;
  const jobsH = entries.filter((e) => e.user_id === me.id && e.job_id && e.work_date >= mStart && e.work_date <= mEnd).reduce((s, e) => s + e.hours, 0);
  const lateN = days.filter((d) => d.late).length;
  const halfN = days.filter((d) => d.half).length;
  const appr = myLeaves.filter((l) => l.status === "approved");
  const leaveTaken = appr.reduce((s, l) => s + leaveDays(l, mStart, upTo), 0) + days.filter((d) => d.leave && !d.booked && !d.override).length;
  const leaveAhead = appr.reduce((s, l) => s + leaveDays(l, addDays(upTo, 1), mEnd), 0);

  // ----- breaks, punctuality and idle time -----
  const brkMin = (d: string) => breaks.filter((b) => b.user_id === me.id && b.work_date === d).reduce((s, b) => s + Math.max(0, ((b.ended_at ? Date.parse(b.ended_at) : now) - Date.parse(b.started_at)) / 60000), 0);
  const myBrk = breaks.filter((b) => b.user_id === me.id && b.work_date === tDate);
  const onBrk = myBrk.find((b) => !b.ended_at);
  const tBrk = brkMin(tDate);
  const tWork = Math.max(0, tMin - tBrk);
  const lateBy = (d: Day) => (d.first ? Math.max(0, localMinutes(d.first, o) - o.lateAfter) : 0);
  const tLate = tFirst ? Math.max(0, localMinutes(tFirst, o) - o.lateAfter) : 0;
  const tLateOk = !!byDate.get(tDate)?.lateExcused;
  // Idle: no job timer and no break since the last timer stopped (or since logging in).
  const lastStop = Math.max(tFirst ? Date.parse(tFirst) : 0,
    ...entries.filter((e) => e.user_id === me.id && e.work_date === tDate && e.created_at && /\btimer /i.test(e.description)).map((e) => Date.parse(e.created_at!)),
    ...myBrk.filter((b) => b.ended_at).map((b) => Date.parse(b.ended_at!)));
  const idleMin = openShift && !myTimer && !onBrk && lastStop ? Math.floor((now - lastStop) / 60000) : 0;
  const wDays = days.filter((d) => d.first && !d.leave).sort((a, b) => a.date.localeCompare(b.date));
  const onTimeN = wDays.filter((d) => !d.late).length;
  const lateTotal = wDays.reduce((s, d) => s + (d.late ? lateBy(d) : 0), 0);
  const earlyN = days.filter((d) => d.early > 0).length;
  let streak = 0;
  for (let i = wDays.length - 1; i >= 0 && !wDays[i].late; i--) streak++;
  let best = 0, runN = 0;
  for (const d of wDays) { runN = d.late ? 0 : runN + 1; best = Math.max(best, runN); }
  const brkDays = [...new Set(breaks.filter((b) => b.user_id === me.id && b.work_date >= mStart && b.work_date <= upTo).map((b) => b.work_date))];
  const avgBrk = brkDays.length ? brkDays.reduce((s, d) => s + brkMin(d), 0) / brkDays.length : 0;
  const jobPct = inH ? Math.round((jobsH / inH) * 100) : 0;
  const punct = wDays.length ? Math.round((onTimeN / wDays.length) * 100) : 0;

  // ----- leave this year -----
  const yStart = `${today.slice(0, 4)}-01-01`, yEnd = `${today.slice(0, 4)}-12-31`;
  const yr = (ls: LeaveReq[], a = yStart, b = yEnd) => ls.reduce((s, l) => s + leaveDays(l, a, b), 0);
  const sp = myLeaves.filter((l) => l.kind !== "unpaid");
  const spTaken = yr(sp.filter((l) => l.status === "approved"), yStart, today);
  const spBooked = yr(sp.filter((l) => l.status === "approved"), addDays(today, 1));
  const spWait = yr(sp.filter((l) => l.status === "pending"));
  const up = myLeaves.filter((l) => l.kind === "unpaid");
  const upTaken = yr(up.filter((l) => l.status === "approved"), yStart, today);
  const upBooked = yr(up.filter((l) => l.status === "approved"), addDays(today, 1));
  const upWait = yr(up.filter((l) => l.status === "pending"));

  // ----- apply for leave -----
  const nextWork = (() => { let d = addDays(today, 1); while (!isWorkDay(d, o)) d = addDays(d, 1); return d; })();
  const [v, setV] = useState({ from: nextWork, to: nextWork, kind: "unpaid" as LeaveReq["kind"], part: "full" as LeaveReq["part"], reason: "" });
  const [sending, setSending] = useState(false);
  const vTo = v.part === "full" ? v.to : v.from;
  const vDays = leaveDays({ start_date: v.from, end_date: vTo, part: v.part });
  const dayName = (d: string) => DOW[dowOf(d)];
  async function apply() {
    if (!v.from || vTo < v.from) { say("The end date must be on or after the start date", true); return; }
    if (!vDays) { say("Those dates are all Sundays, which are already off", true); return; }
    setSending(true);
    const { error } = await supabase.from("leave_requests").insert({ user_id: me.id, start_date: v.from, end_date: vTo, kind: v.kind, part: v.part, reason: v.reason.trim() });
    setSending(false);
    if (error) { say(`Not sent: ${error.message}`, true); return; }
    say("Leave request sent to your manager for approval");
    setV({ ...v, reason: "" });
    onSaved();
  }
  async function cancel(l: LeaveReq) {
    if (!window.confirm(`Cancel your ${leaveLabel(l.kind).toLowerCase()} on ${leaveSpan(l)}?`)) return;
    const { error } = await supabase.from("leave_requests").delete().eq("id", l.id);
    if (error) { say(`Not cancelled: ${error.message}`, true); return; }
    say("Leave request cancelled");
    onSaved();
  }
  const reqs = [
    ...myLeaves.map((l) => ({ k: `l${l.id}`, sort: l.start_date, l, r: undefined as LateRequest | undefined })),
    ...requests.filter((r) => r.user_id === me.id).map((r) => ({ k: `r${r.work_date}`, sort: r.work_date, l: undefined as LeaveReq | undefined, r })),
  ].sort((a, b) => b.sort.localeCompare(a.sort)).slice(0, 8);

  // ----- calendar and day by day -----
  const lead = dowOf(mStart);
  const cells: (string | null)[] = [...Array(lead).fill(null), ...mDays];
  while (cells.length % 7) cells.push(null);
  const rows = [...days].filter((d) => d.first || d.leave || d.h).sort((a, b) => b.date.localeCompare(a.date));
  const shift = (n: number) => { const [y, m] = month.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const monthName = new Date(`${month}-01T00:00:00`).toLocaleDateString("en-AU", { month: "long", year: "numeric" });
  const pickDay = (d: string) => { setDay(d); setTimeout(() => document.getElementById("ts-dayjobs")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };
  const statusText = (d: Day) => d.leave ? (d.booked ? leaveLabel(d.booked) : d.override === "leave" ? "Leave" : "Absent") : d.open && d.date === today ? "Working" : d.half ? "Half day" : d.late ? "Late" : d.lateExcused ? "Late · approved" : "Present";
  const statusCls = (d: Day) => d.leave ? "danger" : d.open && d.date === today ? "ok" : d.half ? "info" : d.late ? "warn" : d.lateExcused ? "warn" : "ok";

  function download() {
    const q = (x: unknown) => `"${String(x ?? "").replace(/"/g, '""')}"`;
    const out: unknown[][] = [["Date", "Logged in", "Logged out", "Hours logged in", "Timesheet hours", "Hours on jobs", "Status"]];
    [...days].sort((a, b) => a.date.localeCompare(b.date)).forEach((d) => out.push([d.date, time(d.first || null), d.open ? "Still in" : time(d.last), (d.m / 60).toFixed(2), d.h.toFixed(2), jobH(d.date).toFixed(2), statusText(d)]));
    out.push([], ["Date", "Client", "Job", "Hours", "What you did"]);
    entries.filter((e) => e.user_id === me.id && e.work_date >= mStart && e.work_date <= mEnd).sort((a, b) => a.work_date.localeCompare(b.work_date)).forEach((e) => {
      const j = e.job_id ? jobs.find((x) => x.id === e.job_id) : undefined;
      out.push([e.work_date, clients.find((c) => c.id === e.client_id)?.name ?? "", j ? `${svcLabel(j.service)} ${j.period}` : "", e.hours, e.description]);
    });
    const blob = new Blob(["﻿" + out.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `my-timesheet-${month}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mts">
      <div className="pagehead">
        <div>{embedded ? <h2 style={{ fontSize: 20, margin: 0 }}>My own timesheet</h2> : <h1>My timesheet</h1>}<p>Your log-in times, hours, leave and job time for the month.</p></div>
        <div className="row">
          <button type="button" aria-label="Previous month" onClick={() => shift(-1)}>‹</button><strong style={{ minWidth: 130, textAlign: "center" }}>{monthName}</strong><button type="button" aria-label="Next month" onClick={() => shift(1)}>›</button>
          <button type="button" onClick={download}>⬇ Download my month</button>
          <button type="button" className="primary" onClick={() => document.getElementById("ts-apply")?.scrollIntoView({ behavior: "smooth", block: "start" })}>+ Apply for leave</button>
        </div>
      </div>

      <div className="panel todaybar">
        <div className="tb-l">
          <span className="lbl2">Today · {short(tDate)}</span>
          <span className="big mono">{tFirst ? hmS(breaksOn ? tWork : tMin) : "—"}</span>
          <span className="note">{tFirst ? <>Logged in <b className={tLate ? "latetxt" : undefined}>{time(tFirst)}</b>{afterStart > 0 ? ` · ${hmS(afterStart)} after ${clockText(o.start)}` : ""}</> : "Not logged in yet. Log in when you start work."}</span>
          {tLate ? <span className={`pill ${tLateOk ? "warn" : "danger solid"}`}>⚠ Late by {hmS(tLate)}{tLateOk ? " · approved" : ""}</span> : null}
          {openShift && outAt ? <span className="pill warn">🕓 Suggested log out <strong>&nbsp;{time(outAt)}</strong></span> : null}
        </div>
        <div className="tb-m">
          <div className="row" style={{ justifyContent: "space-between" }}><strong>{breaksOn ? <>Worked {hmS(tWork)} of {hmS(TARGET)}{tBrk >= 1 ? <span className="note"> (break {hmS(tBrk)} taken out)</span> : null}</> : <>Logged in {hmS(tMin)} of {hmS(o.shiftMin)}</>}</strong><span className="note">On jobs {hmS(tJobMin)}{tMin ? ` (${Math.round((tJobMin / tMin) * 100)}%)` : ""}</span></div>
          <div className="tbbar"><b style={{ width: `${Math.min(100, (Math.min(tJobMin, tMin) / DAY_IN) * 100)}%` }} /><i style={{ width: `${Math.min(100, (Math.max(0, tMin - tJobMin) / DAY_IN) * 100)}%` }} /></div>
          <span className="note">{onBrk ? <>☕ <strong>On a break</strong> since {time(onBrk.started_at)} · {hmS((now - Date.parse(onBrk.started_at)) / 60000)}. Press End break when you&apos;re back.</> : myTimer ? <>▶ Running now: <strong>{runJob ? clients.find((c) => c.id === runJob.client_id)?.name ?? "a job" : "a job"}</strong>{runJob ? ` · ${svcLabel(runJob.service)} ${runJob.period}` : ""} · {hmS(runMin)}</> : openShift ? "No job timer running. Start a job from My tasks so your time goes on the right job." : ""}</span>
          {openShift && !shiftFilled ? <span className="pill warn" style={{ whiteSpace: "normal" }}>Add at least one timesheet line for {fmtDate(openShift.work_date)} (below) before you log out.</span> : null}
        </div>
        <div className="tb-r">
          {openShift && breaksOn ? (onBrk
            ? <button type="button" className="primary" disabled={busy} onClick={() => onBreak("end_break")}>End break</button>
            : <button type="button" disabled={busy} onClick={() => onBreak("start_break")}>☕ Start break</button>) : null}
          {openShift
            ? <button type="button" className="primary" disabled={busy || !shiftFilled} title={shiftFilled ? undefined : "Fill in your timesheet first"} onClick={() => onClock("clock_out")}>Log out for the day</button>
            : <button type="button" className="primary" disabled={busy} onClick={() => onClock("clock_in")}>Log in</button>}
        </div>
      </div>

      {idleMin >= IDLE_ALERT_MIN ? <div className="idlealert"><span>⏸ <b>No job timer running for {hmS(idleMin)}.</b> Start a job, or press Start break, so your time is counted. Your team leader can see this after {IDLE_ALERT_MIN} minutes.</span></div> : null}

      {wDays.length || breaksOn ? <div className={`xbar${breaksOn ? "" : " two"}`}>
        {breaksOn ? <div className="panel"><h3>☕ Breaks today <span className="note">Allowance {BREAK_ALLOWANCE_MIN} min</span></h3>
          <div className="row" style={{ justifyContent: "space-between" }}><span><b className="mono" style={{ fontSize: 20 }}>{hmS(tBrk)}</b> <span className="note">of {BREAK_ALLOWANCE_MIN}m used{tBrk <= BREAK_ALLOWANCE_MIN ? ` · ${hmS(BREAK_ALLOWANCE_MIN - tBrk)} left` : ""}</span></span>
            <span className={`pill ${tBrk > BREAK_ALLOWANCE_MIN ? "danger" : "ok"}`}>{tBrk > BREAK_ALLOWANCE_MIN ? `${hmS(tBrk - BREAK_ALLOWANCE_MIN)} over` : "Within allowance"}</span></div>
          <div className="brkbar"><b style={{ width: `${Math.min(100, (Math.min(tBrk, BREAK_ALLOWANCE_MIN) / BREAK_ALLOWANCE_MIN) * 100)}%` }} />{tBrk > BREAK_ALLOWANCE_MIN ? <i style={{ width: `${Math.min(100, ((tBrk - BREAK_ALLOWANCE_MIN) / BREAK_ALLOWANCE_MIN) * 100)}%` }} /> : null}</div>
          {myBrk.length ? <div className="tsess">{myBrk.map((b) => <span key={b.id} className="tchip">☕ {time(b.started_at)}–{b.ended_at ? time(b.ended_at) : "now"}<i>{hmS(((b.ended_at ? Date.parse(b.ended_at) : now) - Date.parse(b.started_at)) / 60000)}</i></span>)}</div>
            : <p className="note" style={{ margin: 0 }}>No breaks yet today. Press Start break when you step away.</p>}
          <p className="note" style={{ margin: "8px 0 0" }}>Over {BREAK_ALLOWANCE_MIN} min the bar turns red. Break time isn&apos;t counted as time worked.</p></div> : null}
        <div className="panel"><h3>🔥 On-time streak</h3>
          <div className="streak">{streak} <small className="note">day{streak === 1 ? "" : "s"} in a row{!streak && wDays.length ? " · late on your last day" : ""}</small></div>
          <div className="sdots">{wDays.map((d) => <span key={d.date} className={d.late ? "r" : "g"} title={`${short(d.date)}: ${d.late ? `late ${hmS(lateBy(d))}` : "on time"}`}>{Number(d.date.slice(8))}</span>)}</div>
          <p className="note" style={{ margin: "8px 0 0" }}>Best this month: {best} day{best === 1 ? "" : "s"} in a row. Log in by {clockText(o.lateAfter)} am to keep it going.</p></div>
        <div className="panel"><h3>⏰ Punctuality this month</h3>
          <div><b className={`mono ${punct >= 90 ? "goodtxt" : punct >= 75 ? "warntxt" : "latetxt"}`} style={{ fontSize: 20 }}>{punct}%</b> <span className="note">on time · {onTimeN} of {wDays.length} day{wDays.length === 1 ? "" : "s"}</span></div>
          <div className="brkbar"><b className="ok" style={{ width: `${punct}%` }} />{wDays.length ? <i style={{ width: `${100 - punct}%` }} /> : null}</div>
          <p className="note" style={{ margin: "4px 0 0" }}><b className={lateN ? "latetxt" : undefined}>{lateN} late start{lateN === 1 ? "" : "s"}</b>{lateTotal ? ` (${hmS(lateTotal)} late in total)` : ""} · {earlyN} early log-out{earlyN === 1 ? "" : "s"}. <b>3 or more late starts</b> in a month are flagged to your team leader.</p></div>
      </div> : null}

      <div className="atiles">
        <div className="panel b-ok"><span className="val">{worked}<small> of {workDays}</small></span><span className="lbl">Days worked ({o.daysText}){halfN ? ` · ${halfN} half day${halfN === 1 ? "" : "s"}` : ""}{leaveTaken ? ` · ${n1(leaveTaken)} leave` : ""}</span></div>
        <div className="panel b-blue"><span className="val">{n1(tsH)}<small>h</small></span><span className="lbl">Hours worked (target {hmS(workDays * TARGET)}: {workDays} working day{workDays === 1 ? "" : "s"} × {hmS(TARGET)})</span></div>
        <div className={`panel ${jobPct < 70 ? "b-danger tv-bad" : jobPct < 80 ? "b-warn tv-warn" : "b-ok tv-good"}`}><span className="val">{jobPct}<small>%</small></span><span className="lbl">Time on jobs · red under 70%, green from 80%</span></div>
        <div className={`panel ${lateN ? "b-danger tv-bad" : "b-ok"}`}><span className="val">{lateN}</span><span className="lbl">Late starts (after {clockText(o.lateAfter)}){lateN >= 3 ? " · flagged to your team leader" : ""}</span></div>
        <div className={`panel ${earlyN ? "b-warn tv-warn" : "b-ok"}`}><span className="val">{earlyN}</span><span className="lbl">Early log-outs (left before the suggested time)</span></div>
        {breaksOn ? <div className={`panel ${avgBrk > BREAK_ALLOWANCE_MIN ? "b-danger tv-bad" : "b-blue"}`}><span className="val">{Math.round(avgBrk)}<small>m</small></span><span className="lbl">Average break a day (allowance {BREAK_ALLOWANCE_MIN}m)</span></div>
          : <div className="panel b-danger"><span className="val">{n1(leaveTaken)}{leaveAhead ? <small> + {n1(leaveAhead)} booked</small> : null}</span><span className="lbl">Leave days this month</span></div>}
      </div>

      <div id="ts-dayjobs" style={{ marginBottom: 16 }}>{dayEl}</div>

      <div className="mtsgrid">
        <div className="section">
          <div className="panel">
            <div className="ph"><h2>{new Date(`${month}-01T00:00:00`).toLocaleDateString("en-AU", { month: "long" })} at a glance</h2><span className="note">Click a day to see its log-ins and jobs</span></div>
            <div className="mcal">
              {DOW.map((d) => <div key={d} className="mh">{d}</div>)}
              {cells.map((d, i) => {
                if (!d) return <div key={`x${i}`} className="mc blank" />;
                const n = Number(d.slice(8));
                if (dowOf(d) === 6) return <div key={d} className="mc sun"><span className="dn">{n}</span><span className="note">Sun · off</span></div>;
                const x = byDate.get(d);
                const lv = leaveOn(d);
                if (d > today || !x) {
                  if (lv) return <button type="button" key={d} className={`mc booked${lv.status === "pending" ? " wait" : ""}`} onClick={() => pickDay(d)}><span className="dn">{n}</span>
                    <span className="pill danger">🌴 {lv.part === "full" ? leaveLabel(lv.kind) : `Half day ${lv.part}`}</span><span className="note">{lv.status === "approved" ? "Approved" : "Waiting"}</span></button>;
                  return <div key={d} className="mc future"><span className="dn">{n}</span></div>;
                }
                const cls = x.leave ? "lv" : x.late ? `late${x.open && d === today ? " now" : ""}` : x.open && d === today ? "now" : x.half ? "half" : "ok";
                return <button type="button" key={d} className={`mc ${cls}${d === day ? " sel" : ""}`} onClick={() => pickDay(d)}>
                  <span className="dn">{n}</span>
                  {x.first ? <span className="mono hh">{n1(x.m / 60)}h{x.open && d === today ? " so far" : ""}</span> : null}
                  {x.first ? <span className="mono tt2">{ct(x.first)}{x.last && !x.open ? ` – ${ct(x.last)}` : ""}</span> : null}
                  {x.leave ? <span className={`pill ${x.booked ? "info" : "danger"}`}>{x.booked ? leaveLabel(x.booked) : x.override === "leave" ? "Leave" : "Absent"}</span>
                    : x.late ? <span className="pill danger solid" title={`Logged in ${time(x.first)}`}>Late {hmS(lateBy(x))}</span>
                    : x.open && d === today ? <span className="pill ok">● Working</span>
                    : x.half ? <span className="pill info">Half day</span> : null}
                  {!x.leave && x.early > 0 && !x.open ? <span className="pill warn">Left {hmS(x.early)} early</span> : null}
                </button>;
              })}
            </div>
            <div className="mlegend"><span><i className="c-ok" />Present</span><span><i className="c-late" />Late</span><span><i className="c-half" />Half day</span><span><i className="c-lv" />Leave</span><span><i className="c-bk" />Booked leave</span></div>
            <p className="note" style={{ margin: "0 14px 14px" }}>Office hours ({o.location} office): {o.daysText}, {o.hoursText}. Late = log in after {clockText(o.lateAfter)} am. If you start after {clockText(o.start)}, your suggested log-out time moves later so you still work a full day.</p>
          </div>

          <div className="panel" id="ts-daybyday">
            <div className="ph"><h2>Day by day</h2><span className="note">Log in, log out and job time</span></div>
            <div className="tablebox solo" style={{ margin: 0, border: 0 }}>
              {!rows.length ? <div className="empty"><strong>Nothing recorded this month yet.</strong>Your log-ins show here.</div> : (
                <table><thead><tr><th>Date</th><th>Logged in</th><th>Logged out</th><th>Hours</th>{breaksOn ? <th>Break</th> : null}<th>On jobs</th><th>Status</th><th></th></tr></thead>
                  <tbody>{rows.map((d) => { const jh = jobH(d.date); return (
                    <tr key={d.date} className={d.date === day ? "sel" : undefined}><td><button type="button" className="link" onClick={() => pickDay(d.date)}>{short(d.date)}</button></td>
                      <td className={`mono${d.late ? " latetxt" : ""}`}>{time(d.first || null) || "—"}</td>
                      <td className="mono">{d.open ? (d.date === today ? "Still in" : <span className="warn">Not logged out</span>) : d.auto ? <span className="pill warn" title="Forgot to log out: logged out automatically at midnight India time">Auto logged out</span> : time(d.last) || "—"}</td>
                      <td className="mono">{d.m ? hmS(d.m) : "—"}</td>
                      {breaksOn ? (() => { const b = brkMin(d.date); return <td className={`mono${b > BREAK_ALLOWANCE_MIN ? " latetxt" : ""}`}>{b >= 1 ? hmS(b) : "—"}</td>; })() : null}
                      <td className="mono">{jh ? `${hmS(jh * 60)}${d.m ? ` (${Math.round((jh * 60 / d.m) * 100)}%)` : ""}` : "—"}</td>
                      <td><span className={`pill ${d.late ? "danger solid" : statusCls(d)}`}>{d.late ? `Late ${hmS(lateBy(d))}` : statusText(d)}{d.late && d.request === "pending" ? " · asked" : ""}</span>{d.late && d.open && d.date === today ? <span className="pill ok" style={{ marginLeft: 4 }}>Working</span> : null}</td>
                      <td className="note">{d.late && !d.request ? <button type="button" onClick={() => onExplain(d)}>Explain</button>
                        : d.open && d.date < today ? "Forgot to log out? Ask your manager to fix it."
                        : d.early ? `Left ${hmS(d.early)} early (suggested ${time(d.suggested)})`
                        : d.lateExcused ? `Suggested log out was ${time(d.suggested)}` : null}</td></tr>); })}</tbody></table>)}
            </div>
          </div>

        </div>

        <div className="section">
          <div className="panel">
            <div className="ph"><h2>My leave this year</h2><span className="note">{today.slice(0, 4)}</span></div>
            <div className="lvbal">
              <div className="row" style={{ justifyContent: "space-between" }}><strong>Sick / personal</strong><span className="note">No paid leave balance, needs approval</span></div>
              <div className="row" style={{ justifyContent: "space-between" }}><span className="note">Taken {n1(spTaken)} · Booked {n1(spBooked)} · Waiting {n1(spWait)}</span><strong>{n1(spTaken + spBooked)} days</strong></div>
            </div>
            <div className="lvbal">
              <div className="row" style={{ justifyContent: "space-between" }}><strong>Unpaid leave</strong><span className="note">Needs approval</span></div>
              <div className="row" style={{ justifyContent: "space-between" }}><span className="note">Taken {n1(upTaken)} · Booked {n1(upBooked)} · Waiting {n1(upWait)}</span><strong>{n1(upTaken + upBooked)} days</strong></div>
            </div>
            <p className="note" style={{ margin: "0 14px 14px" }}>There is no leave balance. All leave is recorded here and needs approval from your manager.</p>
          </div>

          <div className="panel" id="ts-apply">
            <div className="ph"><h2>Apply for leave</h2></div>
            {leaveMissing ? <p className="note" style={{ margin: "0 14px 14px" }}>Leave booking isn&apos;t switched on yet. Ask your master admin to run the leave database update.</p> : <div className="lvform">
              <span className="lbl2">Type</span>
              <div className="seg">{LEAVE_KINDS.map((k) => <button key={k.id} type="button" className={v.kind === k.id ? "on" : undefined} onClick={() => setV({ ...v, kind: k.id })}>{k.label.replace(" leave", "")}</button>)}</div>
              <div className="row" style={{ gap: 8 }}>
                <label className="f" style={{ flex: 1 }}>{v.part === "full" ? "From" : "Date"}<input id="lv-from" type="date" value={v.from} onChange={(e) => e.target.value && setV({ ...v, from: e.target.value, to: e.target.value > v.to ? e.target.value : v.to })} /></label>
                {v.part === "full" ? <label className="f" style={{ flex: 1 }}>To<input id="lv-to" type="date" min={v.from} value={v.to} onChange={(e) => e.target.value && setV({ ...v, to: e.target.value })} /></label> : null}
              </div>
              <span className="lbl2">Length</span>
              <div className="seg">{([["full", "Full days"], ["am", "Half day (am)"], ["pm", "Half day (pm)"]] as [LeaveReq["part"], string][]).map(([k, l]) => <button key={k} type="button" className={v.part === k ? "on" : undefined} onClick={() => setV({ ...v, part: k })}>{l}</button>)}</div>
              <label className="f">Reason (optional)<input id="lv-reason" value={v.reason} maxLength={1000} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="e.g. Family trip" /></label>
              {vDays ? <div className="lvsum">{v.part === "full" ? `${n1(vDays)} working day${vDays === 1 ? "" : "s"}` : "Half a day"} of {leaveLabel(v.kind).toLowerCase()}{v.part === "full" && vTo > v.from ? ` (${dayName(v.from)} to ${dayName(vTo)})` : ` (${dayName(v.from)})`}.</div>
                : <div className="lvsum warn">Those dates are all Sundays, which are already off.</div>}
              <button type="button" className="primary" disabled={sending || !vDays} onClick={apply}>Send to manager for approval</button>
              <span className="note">Your manager gets a notification. Approved leave shows on your calendar and the team&apos;s.</span>
            </div>}
          </div>

          <div className="panel">
            <div className="ph"><h2>My requests</h2></div>
            {!reqs.length ? <div className="empty"><strong>No requests yet.</strong>Leave and late-start requests show here.</div> : (
              <ul className="list reqs">{reqs.map(({ k, l, r }) => l ? (
                <li key={k}><span className="ricon">🌴</span><div className="grow"><div className="t">{leaveSpan(l)} · {leaveLabel(l.kind)}{l.part !== "full" ? `, half day ${l.part}` : `, ${n1(leaveDays(l))} day${leaveDays(l) === 1 ? "" : "s"}`}</div>
                  <div className="s">{l.status === "pending" ? `Sent ${fmtDate(l.created_at.slice(0, 10))}` : l.status === "approved" ? "Approved" : "Not approved"}{l.reason ? ` · ${l.reason}` : ""}</div></div>
                  <div className="row"><span className={`pill ${l.status === "approved" ? "ok" : l.status === "rejected" ? "danger" : "warn"}`}>{l.status === "approved" ? "Approved" : l.status === "rejected" ? "Not approved" : "Waiting"}</span>
                    {l.end_date >= today && (l.status === "pending" || l.start_date > today) ? <button type="button" onClick={() => cancel(l)}>Cancel</button> : null}</div></li>
              ) : r ? (
                <li key={k}><span className="ricon">⏰</span><div className="grow"><div className="t">{fmtDate(r.work_date)} · Late start</div><div className="s">&ldquo;{r.reason || "No reason given"}&rdquo;</div></div>
                  <span className={`pill ${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}`}>{r.status === "approved" ? "Late approved" : r.status === "rejected" ? "Not approved" : "Waiting"}</span></li>
              ) : null)}</ul>)}
          </div>
        </div>
      </div>
    </div>
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
      <td><textarea aria-label="What you did" rows={Math.min(6, Math.max(2, v.description.split("\n").length))} value={v.description} onChange={(x) => setV({ ...v, description: x.target.value })}
        placeholder="Detail comment: what you did on this job, what is left, anything to follow up" style={{ minWidth: 260, width: "100%", resize: "vertical", font: "inherit" }}
        onKeyDown={(x) => { if (x.key === "Enter" && !x.shiftKey && dirty) { x.preventDefault(); save(); } }} />
        <span className="note" style={{ fontSize: 11 }}>Enter to save · Shift+Enter for a new line</span></td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        {dirty ? <button type="button" className={e ? undefined : "primary"} disabled={busy} onClick={save}>{e ? "Save" : "Add"}</button> : null}
        {e ? <button type="button" className="link" onClick={() => { setEditing(false); setV({ client_id: e.client_id ?? "", job_id: e.job_id ?? "", hours: String(e.hours), description: e.description }); }} style={{ marginLeft: 6 }}>Cancel</button> : null}
      </td>
    </tr>
  );
}

/** A timer line: "Preparing for signing, timer 4:05pm to 4:06pm IST", then the person's comment on the lines below. */
const TIMER_RE = /^(.*?\btimer (\d{1,2}:\d{2}[ap]m)(?: to (\d{1,2}:\d{2}[ap]m))?(?: IST)?(, stopped automatically at midnight \(forgot to stop\))?)(.*)$/i;
function timerParts(e: TimeEntry) {
  if (!e.job_id) return null;
  const [first, ...rest] = (e.description || "").split("\n");
  const m = TIMER_RE.exec(first);
  if (!m) return null;
  const label = first.slice(0, first.toLowerCase().indexOf("timer ")).replace(/[,\s]+$/, "");
  const extra = m[5].replace(/^[\s,.:;\u2013-]+/, "").trim();
  const comment = [extra, ...rest].join("\n").trim();
  return { head: m[1], start: m[2], end: m[3] ?? (m[4] ? "midnight (auto stop)" : ""), label, comment };
}
/** One line per job for the day: every start/stop of the timer on a job goes on the same line. Hand-added lines stay as they are. */
function dayLines(list: TimeEntry[]): TimeEntry[][] {
  const out: TimeEntry[][] = [];
  const byJob = new Map<string, TimeEntry[]>();
  for (const e of list) {
    if (!timerParts(e)) { out.push([e]); continue; }
    const g = byJob.get(e.job_id!);
    if (g) g.push(e); else { const n = [e]; byJob.set(e.job_id!, n); out.push(n); }
  }
  return out;
}

function TimerLine({ list, locked, clients, jobs, supabase, say, onSaved }: {
  list: TimeEntry[]; locked: boolean; clients: Client[]; jobs: Job[]; supabase: SB; say: (m: string, er?: boolean) => void; onSaved: () => void;
}) {
  const parts = list.map((e) => ({ e, p: timerParts(e)! }));
  const comment = parts.map((x) => x.p.comment).filter(Boolean).join("\n");
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment);
  const [busy, setBusy] = useState(false);
  const c = clients.find((x) => x.id === list[0].client_id);
  const j = jobs.find((x) => x.id === list[0].job_id);
  const total = list.reduce((s, e) => s + Number(e.hours), 0);
  async function save() {
    setBusy(true);
    // The comment sits under the first timer of the day; the timer times themselves never change.
    const t = text.trim();
    const writes = parts.map(({ e, p }, i) => {
      const want = i === 0 && t ? `${p.head}\n${t}` : p.head;
      return want === e.description ? null : supabase.from("timesheet_entries").update({ description: want }).eq("id", e.id);
    }).filter(Boolean);
    const res = await Promise.all(writes);
    setBusy(false);
    const bad = res.find((r) => r && r.error);
    if (bad && bad.error) { say(`Not saved: ${bad.error.message}`, true); return; }
    say("Comment saved");
    setEditing(false);
    onSaved();
  }
  return <tr className="tsline">
    <td>{c?.name ?? "General / admin"}</td><td>{j ? `${svcLabel(j.service)} · ${j.period}` : "—"}</td>
    <td className="mono" style={{ textAlign: "right" }}>{Number(total.toFixed(2))} h</td>
    <td>
      <div className="tsess" title="Timer start and stop times can't be changed">{parts.map(({ e, p }) => <span key={e.id} className="tchip">🔒 {p.start}{p.end ? `–${p.end}` : ""}{p.label ? ` · ${p.label}` : ""}<i>{Number(Number(e.hours).toFixed(2))}h</i></span>)}</div>
      {editing ? <><textarea aria-label="Comment" autoFocus rows={Math.min(6, Math.max(2, text.split("\n").length))} value={text} onChange={(x) => setText(x.target.value)}
          placeholder="Comment: what you did on this job, what is left, anything to follow up" style={{ width: "100%", resize: "vertical", font: "inherit", marginTop: 6 }}
          onKeyDown={(x) => { if (x.key === "Enter" && !x.shiftKey) { x.preventDefault(); save(); } if (x.key === "Escape") { setEditing(false); setText(comment); } }} />
        <span className="note" style={{ fontSize: 11 }}>Enter to save · Shift+Enter for a new line</span></>
        : comment ? <div className="tcomment">{comment}</div> : <div className="note tcomment">{locked ? "No comment" : "No comment yet"}</div>}
    </td>
    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{locked ? null : editing
      ? <><button type="button" className="primary" disabled={busy} onClick={save}>Save</button><button type="button" className="link" style={{ marginLeft: 6 }} onClick={() => { setEditing(false); setText(comment); }}>Cancel</button></>
      : <button type="button" className="link" onClick={() => { setText(comment); setEditing(true); }}>{comment ? "Edit comment" : "Add comment"}</button>}</td>
  </tr>;
}

// ============================================================
// Team today: who is in on time, late, on a break, not logged in or on leave, and this month's punctuality.
function TeamToday({ people, att, entries, timers, breaks, breaksOn, leaves, requests, overrides, jobs, clients, now, canMark, onMarkSick }: {
  people: Profile[]; att: Attendance[]; entries: TimeEntry[]; timers: JobTimer[]; breaks: AttBreak[]; breaksOn: boolean; leaves: LeaveReq[]; requests: LateRequest[]; overrides: Override[];
  jobs: Job[]; clients: Client[]; now: number; canMark: (uid: string) => boolean; onMarkSick: (uid: string) => void;
}) {
  const today = todayISO();
  const mStart = `${today.slice(0, 7)}-01`;
  const first = (n: string) => n.split(" ")[0];
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "a client";
  const brkOf = (uid: string, d: string) => breaks.filter((b) => b.user_id === uid && b.work_date === d);
  const brkMin = (uid: string, d: string) => brkOf(uid, d).reduce((s, b) => s + Math.max(0, ((b.ended_at ? Date.parse(b.ended_at) : now) - Date.parse(b.started_at)) / 60000), 0);
  const rows = people.filter((p) => p.active !== false && p.role !== "master").map((p) => {
    const o = officeOf(p);
    const mine = att.filter((a) => a.user_id === p.id && a.work_date === today);
    const firstIn = mine.map((a) => a.clock_in).sort()[0] ?? "";
    const open = mine.some((a) => !a.clock_out);
    const lastOut = mine.map((a) => a.clock_out ?? "").sort().pop() ?? "";
    const lv = leaves.find((l) => l.user_id === p.id && l.status === "approved" && l.start_date <= today && l.end_date >= today);
    const t = timers.find((x) => x.user_id === p.id && !x.ended_at);
    const j = t?.job_id ? jobs.find((x) => x.id === t.job_id) : undefined;
    const lateMin = firstIn ? Math.max(0, localMinutes(firstIn, o) - o.lateAfter) : 0;
    const onBrk = open ? brkOf(p.id, today).find((b) => !b.ended_at) : undefined;
    const brkToday = brkMin(p.id, today);
    const lastStop = Math.max(firstIn ? Date.parse(firstIn) : 0,
      ...entries.filter((e) => e.user_id === p.id && e.work_date === today && e.created_at && /\btimer /i.test(e.description)).map((e) => Date.parse(e.created_at!)),
      ...brkOf(p.id, today).filter((b) => b.ended_at).map((b) => Date.parse(b.ended_at!)));
    const idle = open && !t && !onBrk && lastStop ? Math.floor((now - lastStop) / 60000) : 0;
    const month = buildDays(att, entries, [p], mStart, today, now, overrides, requests, leaves).filter((d) => d.first && !d.leave);
    const lateN = month.filter((d) => d.late).length;
    const lateTot = month.reduce((s, d) => s + (d.late && d.first ? Math.max(0, localMinutes(d.first, o) - o.lateAfter) : 0), 0);
    const earlyN = month.filter((d) => d.early > 0).length;
    const inMin = month.reduce((s, d) => s + d.m, 0);
    const jobMin = entries.filter((e) => e.user_id === p.id && e.job_id && e.work_date >= mStart && e.work_date <= today).reduce((s, e) => s + e.hours * 60, 0);
    const bDays = [...new Set(breaks.filter((b) => b.user_id === p.id && b.work_date >= mStart && b.work_date <= today).map((b) => b.work_date))];
    const avgBrk = bDays.length ? bDays.reduce((s, d) => s + brkMin(p.id, d), 0) / bDays.length : 0;
    let streak = 0;
    for (let i = month.length - 1; i >= 0 && !month[i].late; i--) streak++;
    const todayLate = !!firstIn && month.some((d) => d.date === today && d.late);
    const group = lv && !firstIn ? "lv" : !firstIn ? "out" : onBrk ? "brk" : todayLate ? "late" : "in";
    return { p, o, firstIn, open, lastOut, lv, t, j, lateMin, onBrk, brkToday, idle, group, lateN, lateTot, earlyN, inMin, jobMin, avgBrk, streak, days: month.length };
  });
  type Row = (typeof rows)[number];
  const due = (r: Row) => isWorkDay(today, r.o) && localMinutes(new Date(now).toISOString(), r.o) > r.o.lateAfter;
  const n = (g: string) => rows.filter((r) => r.group === g).length;
  const card = (r: Row) => {
    const tm = (ts: string) => localTime(ts, r.o);
    let sub = "";
    if (r.group === "lv") sub = `🌴 ${leaveLabel(r.lv!.kind)}${r.lv!.part !== "full" ? " (half day)" : ""}`;
    else if (r.group === "out") sub = due(r) ? `Due at ${clockText(r.o.start)} am` : "Not started yet";
    else if (r.group === "brk") sub = `Break since ${tm(r.onBrk!.started_at)} · ${hmS((now - Date.parse(r.onBrk!.started_at)) / 60000)}`;
    else sub = `In ${tm(r.firstIn)}${r.lateMin && r.group === "late" ? ` · late ${hmS(r.lateMin)}` : ""}${!r.open ? ` · logged out ${tm(r.lastOut)}` : r.t ? ` · on ${r.j ? `${clientName(r.j.client_id)} ${svcLabel(r.j.service)}` : "a job"}` : ""}`;
    return (
      <div key={r.p.id} className="ttp">
        <b>{r.p.full_name}</b><span className="note">{sub}</span>
        {r.group === "brk" && breaksOn ? <span className="note">Break today {hmS(r.brkToday)} of {BREAK_ALLOWANCE_MIN}m</span> : null}
        {r.group === "late" ? <span className={`tflag${r.lateN >= 3 ? "" : " w"}`}>{r.lateN >= 3 ? "⚠ " : ""}{ordinal(r.lateN)} late this month</span> : null}
        {r.idle >= IDLE_ALERT_MIN ? <span className="tflag w">⏸ No job for {hmS(r.idle)}</span> : null}
        {breaksOn && r.brkToday > BREAK_ALLOWANCE_MIN ? <span className="tflag">☕ Breaks {hmS(r.brkToday)} today</span> : null}
        {r.group === "out" && due(r) && !requests.some((q) => q.user_id === r.p.id && q.work_date === today) ? <span className="tflag">No leave asked</span> : null}
        {r.group === "out" && canMark(r.p.id) ? <div style={{ marginTop: 6 }}><button type="button" onClick={() => onMarkSick(r.p.id)}>Mark sick</button></div> : null}
      </div>);
  };
  const COLS: [string, string, string][] = [["in", "✅ In on time", "in"], ["late", "⏰ Late", "late"], ["brk", "☕ On break", "brk"], ["out", "⭕ Not logged in", "out"], ["lv", "🌴 On leave", "lv"]];
  const table = [...rows].filter((r) => r.days).sort((a, b) => b.lateN - a.lateN || b.lateTot - a.lateTot || a.p.full_name.localeCompare(b.p.full_name));
  return (
    <div className="panel teamtoday">
      <div className="ph"><h2>Team today · {new Date(now).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</h2>
        <span className="ttsum"><span className="pill ok">{n("in")} in on time</span><span className="pill danger">{n("late")} late</span>{breaksOn ? <span className="pill warn">{n("brk")} on break</span> : null}<span className="pill">{n("out")} not logged in</span><span className="pill info">{n("lv")} on leave</span></span></div>
      <div className="tt-body">
        <div className="ttcols">{COLS.filter(([g]) => g !== "brk" || breaksOn).map(([g, label, cls]) => (
          <div key={g} className={`ttcol ${cls}`}><h4>{label} <span>{n(g)}</span></h4>
            {rows.filter((r) => r.group === g).map(card)}
            {!n(g) ? <div className="ttp note">Nobody</div> : null}</div>))}</div>
        {table.length ? <div className="ttable"><table><thead><tr><th>Punctuality this month</th><th>On time</th><th>Late starts</th><th>Total late</th><th>Early log-outs</th>{breaksOn ? <th>Avg break</th> : null}<th>Time on jobs</th><th></th></tr></thead>
          <tbody>{table.map((r) => { const pct = r.inMin ? Math.round((r.jobMin / r.inMin) * 100) : 0; const on = r.days - r.lateN; return (
            <tr key={r.p.id}><td><b>{r.p.full_name}</b></td><td>{on} of {r.days} · {Math.round((on / r.days) * 100)}%</td>
              <td className={r.lateN >= 3 ? "latetxt" : r.lateN ? undefined : "goodtxt"}>{r.lateN}</td><td className={r.lateN >= 3 ? "latetxt" : undefined}>{r.lateTot ? hmS(r.lateTot) : "—"}</td>
              <td>{r.earlyN}</td>{breaksOn ? <td className={r.avgBrk > BREAK_ALLOWANCE_MIN ? "latetxt" : undefined}>{r.avgBrk ? hmS(r.avgBrk) : "—"}</td> : null}
              <td className={pct < 70 ? "latetxt" : pct < 80 ? "warntxt" : "goodtxt"}>{pct}%</td>
              <td>{r.lateN >= 3 ? <span className="tflag">Flagged: 3+ late</span> : null}{breaksOn && r.avgBrk > BREAK_ALLOWANCE_MIN ? <span className="tflag w">Breaks over {BREAK_ALLOWANCE_MIN}m</span> : null}{r.streak >= 5 && !r.lateN ? <span className="pill ok">🔥 {r.streak}-day streak</span> : null}</td></tr>); })}</tbody></table></div> : null}
        <p className="note" style={{ margin: "10px 0 0" }}>Late = logged in after the office late time (7:45 am India). From the 3rd late start in a month the team leader gets a notification. Breaks over {BREAK_ALLOWANCE_MIN} minutes and {IDLE_ALERT_MIN} minutes with no job running are flagged here.</p>
      </div>
    </div>
  );
}
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
