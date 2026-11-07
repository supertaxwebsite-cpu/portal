"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Attendance, Client, Job, Person, Profile, TimeEntry } from "@/lib/types";
import { fmtDate, iso, svcLabel, todayISO } from "@/lib/domain";

type SB = ReturnType<typeof createClient>;

const time = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const mins = (a: Attendance, now: number) => Math.max(0, ((a.clock_out ? Date.parse(a.clock_out) : now) - Date.parse(a.clock_in)) / 60000);
const hm = (m: number) => { const t = Math.round(m); return `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, "0")}m`; };
const hrs = (n: number) => `${Number(n.toFixed(2))} h`;
// Attendance rules: clock in after 7:45 am = Late; a past weekday with no timesheet = Leave;
// a finished day under 8 hours clocked = Half day.
const LATE_AFTER = 7 * 60 + 45;
const FULL_DAY_MIN = 8 * 60;
const sydneyMinutes = (ts: string) => {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const n = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  return n("hour") * 60 + n("minute");
};
const addDays = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1, dd + n)); return x.toISOString().slice(0, 10); };
const isWeekday = (d: string) => { const [y, m, dd] = d.split("-").map(Number); const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); return w >= 1 && w <= 5; };

export interface Day { user: string; date: string; first: string; last: string | null; open: boolean; m: number; h: number; late: boolean; leave: boolean; half: boolean }

function buildDays(att: Attendance[], entries: TimeEntry[], people: { id: string; created_at?: string }[], from: string, to: string, now: number): Day[] {
  const ids = new Set(people.map((p) => p.id));
  const map = new Map<string, Day>();
  const get = (user: string, date: string) => {
    const k = `${date}|${user}`;
    let d = map.get(k);
    if (!d) { d = { user, date, first: "", last: null, open: false, m: 0, h: 0, late: false, leave: false, half: false }; map.set(k, d); }
    return d;
  };
  att.filter((a) => ids.has(a.user_id) && a.work_date >= from && a.work_date <= to).forEach((a) => {
    const d = get(a.user_id, a.work_date);
    if (!d.first || a.clock_in < d.first) d.first = a.clock_in;
    if (!a.clock_out) d.open = true; else if (!d.last || a.clock_out > d.last) d.last = a.clock_out;
    d.m += mins(a, now);
  });
  entries.filter((e) => ids.has(e.user_id) && e.work_date >= from && e.work_date <= to).forEach((e) => { get(e.user_id, e.work_date).h += e.hours; });
  // Past weekdays with nothing recorded count as leave (from the day the person was added).
  const today = todayISO();
  people.forEach((p) => {
    const start = p.created_at && p.created_at.slice(0, 10) > from ? p.created_at.slice(0, 10) : from;
    for (let d = start; d <= to && d < today; d = addDays(d, 1)) if (isWeekday(d)) get(p.id, d);
  });
  return [...map.values()].map((d) => ({
    ...d,
    late: !!d.first && sydneyMinutes(d.first) > LATE_AFTER,
    leave: d.h === 0 && d.date < today,
    half: !d.open && d.m > 0 && d.m < FULL_DAY_MIN,
  }));
}

const Status = ({ d }: { d: Day }) => (
  <>{d.leave ? <span className="pill danger">Leave</span> : null} {d.late ? <span className="pill warn">Late</span> : null} {d.half ? <span className="pill info">Half day</span> : null}
    {!d.leave && !d.late && !d.half ? <span className="pill ok">{d.open ? "Working" : "Present"}</span> : null}</>
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
  }, [supabase, lo, hi, me.id]);

  useEffect(() => {
    load();
    const ch = supabase.channel("timesheets")
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "timesheet_entries" }, () => load())
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
    return <div className="panel empty"><strong>Timesheets aren&apos;t switched on yet.</strong>Your master admin needs to run the latest database update in Supabase.</div>;
  }

  const myMonth = buildDays(att, entries, [me], monthStart, todayISO(), now);

  // ----- team view -----
  const teamIds = new Set(visible.map((p) => p.id));
  const teamEntries = entries.filter((e) => teamIds.has(e.user_id) && e.work_date >= from && e.work_date <= to && (!who || e.user_id === who))
    .sort((a, b) => a.work_date.localeCompare(b.work_date) || name(a.user_id).localeCompare(name(b.user_id)));
  const teamPeople = visible.filter((p) => !who || p.id === who);
  const summary = buildDays(att, entries, teamPeople, from, to, now).sort((a, b) => b.date.localeCompare(a.date) || name(a.user).localeCompare(name(b.user)));
  const counts = { late: summary.filter((d) => d.late).length, leave: summary.filter((d) => d.leave).length, half: summary.filter((d) => d.half).length };

  function exportCsv() {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Date", "Person", "Client", "Job", "Hours", "Description"], ...teamEntries.map((e) => [e.work_date, name(e.user_id), clientName(e.client_id), jobLabel(e.job_id), e.hours, e.description])];
    rows.push([], ["Date", "Person", "Logged in", "Logged out", "Time logged in (hours)", "Timesheet hours", "Status"]);
    summary.forEach((d) => rows.push([d.date, name(d.user), time(d.first || null), d.open ? "Still logged in" : time(d.last), (d.m / 60).toFixed(2), d.h, [d.leave && "Leave", d.late && "Late", d.half && "Half day"].filter(Boolean).join(", ") || "Present"]));
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
                {openShift && !shiftFilled ? <p className="pill warn" style={{ margin: "8px 0 0", whiteSpace: "normal" }}>Fill in your timesheet for {fmtDate(openShift.work_date)} below before you log out.</p> : null}
              </div>
              {openShift
                ? <button type="button" className="primary big" style={{ width: "auto" }} disabled={busy || !shiftFilled} title={shiftFilled ? undefined : "Fill in your timesheet first"} onClick={() => clock("clock_out")}>Log out</button>
                : <button type="button" className="primary big" style={{ width: "auto" }} disabled={busy} onClick={() => clock("clock_in")}>Log in</button>}
            </div>
          </div>

        </div>

        <div className="section">
          <div className="panel" style={{ padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>My attendance this month</h2>
            <div className="row" style={{ margin: "6px 0 10px" }}>
              <span className="pill warn">{myMonth.filter((d) => d.late).length} late</span>
              <span className="pill info">{myMonth.filter((d) => d.half).length} half day</span>
              <span className="pill danger">{myMonth.filter((d) => d.leave).length} leave</span>
            </div>
            {myMonth.some((d) => d.late || d.half || d.leave) ? (
              <ul className="note" style={{ margin: 0, paddingLeft: 18 }}>{myMonth.filter((d) => d.late || d.half || d.leave).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map((d) => (
                <li key={d.date}>{fmtDate(d.date)}: <Status d={d} />{d.first ? ` (in ${time(d.first)})` : ""}</li>))}</ul>
            ) : <p className="note" style={{ margin: 0 }}>No late starts, half days or leave this month.</p>}
            <p className="note" style={{ margin: "10px 0 0" }}>Late = log in after 7:45 am · Half day = under 8 hours logged in · Leave = a weekday with no timesheet. Your manager and the master admin can see this.</p>
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
            {!dayOpen ? <p className="note" style={{ padding: "0 14px 12px", margin: 0 }}>🔒 Previous days are locked and can&apos;t be changed. Ask the master admin if something needs correcting.</p> : null}
          </div>
      </div>

      {canSeeTeam ? (
        <div className="section" style={{ marginTop: 24 }}>
          <div className="pagehead"><div><h2 style={{ fontSize: 20, margin: 0 }}>Team timesheets</h2><p>{me.role === "master" ? "Everyone in the practice." : "You and the team members allocated to you."}</p></div>
            <div className="row"><button type="button" onClick={exportCsv} disabled={!summary.length}>Export CSV</button></div></div>
          <div>
          <div className="toolbar">
            <label className="row note">From <input type="date" id="tt-from" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
            <label className="row note">To <input type="date" id="tt-to" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
            <select id="tt-who" aria-label="Person" value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{visible.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
            <span className="row" style={{ marginLeft: "auto", gap: 6 }}><span className="pill warn">{counts.late} late</span><span className="pill info">{counts.half} half day</span><span className="pill danger">{counts.leave} leave</span></span>
          </div>
          <div className="tablebox">
            {!summary.length ? <div className="empty"><strong>Nothing recorded for these dates.</strong>Log-ins and timesheet entries show here.</div> : (
              <table><thead><tr><th>Date</th><th>Person</th><th>Logged in</th><th>Logged out</th><th style={{ textAlign: "right" }}>Time logged in</th><th style={{ textAlign: "right" }}>Timesheet</th><th>Status</th></tr></thead>
                <tbody>{summary.map((d) => (
                  <tr key={`${d.date}|${d.user}`}><td>{fmtDate(d.date)}</td><td className="client">{name(d.user)}</td><td>{time(d.first || null) || "—"}</td>
                    <td>{d.open ? <span className="pill info">Still in</span> : time(d.last) || "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{d.m ? hm(d.m) : "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{d.h ? hrs(d.h) : "—"}</td><td><Status d={d} /></td></tr>))}</tbody></table>
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
  const clientJobs = useMemo(() => jobs.filter((j) => j.client_id === v.client_id), [jobs, v.client_id]);
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
      <td><select aria-label="Client" value={v.client_id} onChange={(x) => setV({ ...v, client_id: x.target.value, job_id: "" })} style={{ maxWidth: 180 }}>
        <option value="">Select client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
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
