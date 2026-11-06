"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Attendance, Client, Job, Person, Profile, TimeEntry } from "@/lib/types";
import { fmtDate, iso, svcLabel, todayISO } from "@/lib/domain";

type SB = ReturnType<typeof createClient>;

const time = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const mins = (a: Attendance, now: number) => Math.max(0, ((a.clock_out ? Date.parse(a.clock_out) : now) - Date.parse(a.clock_in)) / 60000);
const hm = (m: number) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;
const hrs = (n: number) => `${Number(n.toFixed(2))} h`;
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

  const lo = [day, from].sort()[0];
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

  async function clock(kind: "clock_in" | "clock_out") {
    setBusy(true);
    const { error } = await supabase.rpc(kind);
    setBusy(false);
    if (error) { say(`That didn't work: ${error.message}`, true); return; }
    say(kind === "clock_in" ? "Clocked in" : "Clocked out");
    load();
  }

  if (missing) {
    return <div className="panel empty"><strong>Timesheets aren&apos;t switched on yet.</strong>Your master admin needs to run the latest database update in Supabase.</div>;
  }

  // ----- team view -----
  const teamIds = new Set(visible.map((p) => p.id));
  const teamEntries = entries.filter((e) => teamIds.has(e.user_id) && e.work_date >= from && e.work_date <= to && (!who || e.user_id === who))
    .sort((a, b) => a.work_date.localeCompare(b.work_date) || name(a.user_id).localeCompare(name(b.user_id)));
  const teamAtt = att.filter((a) => teamIds.has(a.user_id) && a.work_date >= from && a.work_date <= to && (!who || a.user_id === who));
  const daysKey = new Map<string, { user: string; date: string; first: string; last: string | null; open: boolean; m: number; h: number }>();
  teamAtt.forEach((a) => {
    const k = `${a.work_date}|${a.user_id}`;
    const d = daysKey.get(k) ?? { user: a.user_id, date: a.work_date, first: a.clock_in, last: a.clock_out, open: false, m: 0, h: 0 };
    if (a.clock_in < d.first) d.first = a.clock_in;
    if (!a.clock_out) d.open = true; else if (!d.last || a.clock_out > d.last) d.last = a.clock_out;
    d.m += mins(a, now);
    daysKey.set(k, d);
  });
  teamEntries.forEach((e) => {
    const k = `${e.work_date}|${e.user_id}`;
    const d = daysKey.get(k) ?? { user: e.user_id, date: e.work_date, first: "", last: null, open: false, m: 0, h: 0 };
    d.h += e.hours;
    daysKey.set(k, d);
  });
  const summary = [...daysKey.values()].sort((a, b) => b.date.localeCompare(a.date) || name(a.user).localeCompare(name(b.user)));

  function exportCsv() {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Date", "Person", "Client", "Job", "Hours", "Description"], ...teamEntries.map((e) => [e.work_date, name(e.user_id), clientName(e.client_id), jobLabel(e.job_id), e.hours, e.description])];
    rows.push([], ["Date", "Person", "Clocked in", "Clocked out", "Time clocked (hours)", "Timesheet hours"]);
    summary.forEach((d) => rows.push([d.date, name(d.user), time(d.first || null), d.open ? "Still clocked in" : time(d.last), (d.m / 60).toFixed(2), d.h]));
    const blob = new Blob(["﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `supertax-timesheets-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <div className="pagehead"><div><h1>Timesheet</h1><p>Clock in when you start, clock out when you finish, and record what you worked on.</p></div></div>

      <div className="grid2">
        <div className="section">
          <div className="panel" style={{ padding: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <h2 style={{ margin: 0 }}>{openShift ? "You're clocked in" : "You're clocked out"}</h2>
                <p className="note" style={{ margin: "4px 0 0" }}>{openShift
                  ? <>Since {time(openShift.clock_in)}{openShift.work_date !== todayISO() ? ` on ${fmtDate(openShift.work_date)}` : ""} · {hm(mins(openShift, now))}</>
                  : "Clock in when you start work."}</p>
              </div>
              {openShift
                ? <button type="button" className="primary big" style={{ width: "auto" }} disabled={busy} onClick={() => clock("clock_out")}>Clock out</button>
                : <button type="button" className="primary big" style={{ width: "auto" }} disabled={busy} onClick={() => clock("clock_in")}>Clock in</button>}
            </div>
          </div>

          <div className="panel">
            <div className="ph"><h2>My timesheet</h2><label className="row note">Date <input type="date" id="ts-day" value={day} max={todayISO()} onChange={(e) => e.target.value && setDay(e.target.value)} /></label></div>
            <p className="note" style={{ padding: "4px 14px 0", margin: 0 }}>
              {myDayAtt.length ? <>Clocked {myDayAtt.map((a) => `${time(a.clock_in)}–${a.clock_out ? time(a.clock_out) : "now"}`).join(", ")} · {hm(myDayAtt.reduce((s, a) => s + mins(a, now), 0))}</> : "No clock-in this day."} · Timesheet <strong>{hrs(myHours)}</strong>
            </p>
            <div className="tablebox solo" style={{ margin: 12 }}>
              <table id="my-entries"><thead><tr><th>Client</th><th>Job</th><th style={{ textAlign: "right" }}>Hours</th><th>What you did</th><th></th></tr></thead>
                <tbody>
                  {myDay.map((e) => <EntryRow key={e.id} e={e} userId={me.id} clients={clients} jobs={jobs} supabase={supabase} say={say} onSaved={load} />)}
                  <EntryRow key={`new-${day}-${myDay.length}`} day={day} userId={me.id} clients={clients} jobs={jobs} supabase={supabase} say={say} onSaved={load} />
                </tbody></table>
            </div>
          </div>
        </div>

        <div className="section">
          <div className="panel" style={{ padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>Who sees your timesheet</h2>
            <p className="note" style={{ margin: 0 }}>You can add, change and remove only your own entries. Your manager and the master admin can see them. Clock times come from the portal&apos;s clock and can&apos;t be edited.</p>
          </div>
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
          </div>
          <div className="tablebox">
            {!summary.length ? <div className="empty"><strong>Nothing recorded for these dates.</strong>Clock-ins and timesheet entries show here.</div> : (
              <table><thead><tr><th>Date</th><th>Person</th><th>Clocked in</th><th>Clocked out</th><th style={{ textAlign: "right" }}>Time clocked</th><th style={{ textAlign: "right" }}>Timesheet</th></tr></thead>
                <tbody>{summary.map((d) => (
                  <tr key={`${d.date}|${d.user}`}><td>{fmtDate(d.date)}</td><td className="client">{name(d.user)}</td><td>{time(d.first || null) || "—"}</td>
                    <td>{d.open ? <span className="pill info">Still in</span> : time(d.last) || "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{d.m ? hm(d.m) : "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{d.h ? hrs(d.h) : <span className="pill warn">None</span>}</td></tr>))}</tbody></table>
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

function EntryRow({ e, day, userId, clients, jobs, supabase, say, onSaved }: {
  e?: TimeEntry; day?: string; userId: string; clients: Client[]; jobs: Job[]; supabase: SB; say: (m: string, er?: boolean) => void; onSaved: () => void;
}) {
  const [v, setV] = useState({ client_id: e?.client_id ?? "", job_id: e?.job_id ?? "", hours: e ? String(e.hours) : "", description: e?.description ?? "" });
  const [busy, setBusy] = useState(false);
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
    onSaved();
  }
  async function remove() {
    if (!e) return;
    const { error } = await supabase.from("timesheet_entries").delete().eq("id", e.id);
    if (error) { say(`Not removed: ${error.message}`, true); return; }
    onSaved();
  }

  return (
    <tr>
      <td><select aria-label="Client" value={v.client_id} onChange={(x) => setV({ ...v, client_id: x.target.value, job_id: "" })} style={{ maxWidth: 180 }}>
        <option value="">General / admin</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
      <td><select aria-label="Job" value={v.job_id} onChange={(x) => setV({ ...v, job_id: x.target.value })} disabled={!v.client_id} style={{ maxWidth: 170 }}>
        <option value="">—</option>{clientJobs.map((j) => <option key={j.id} value={j.id}>{svcLabel(j.service)} · {j.period}</option>)}</select></td>
      <td style={{ textAlign: "right" }}><input aria-label="Hours" type="number" min="0.25" max="24" step="0.25" value={v.hours} onChange={(x) => setV({ ...v, hours: x.target.value })} style={{ width: 72 }} placeholder="0.0" /></td>
      <td><input aria-label="What you did" value={v.description} onChange={(x) => setV({ ...v, description: x.target.value })} placeholder="e.g. Prepared Q2 BAS" style={{ minWidth: 160, width: "100%" }}
        onKeyDown={(x) => { if (x.key === "Enter" && dirty) save(); }} /></td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        {dirty ? <button type="button" className={e ? undefined : "primary"} disabled={busy} onClick={save}>{e ? "Save" : "Add"}</button> : null}
        {e ? <button type="button" className="link" onClick={remove} style={{ marginLeft: 6 }}>Remove</button> : null}
      </td>
    </tr>
  );
}
