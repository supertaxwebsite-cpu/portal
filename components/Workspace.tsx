"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Client, Job, JobTimer, Person, Profile, StatusId } from "@/lib/types";
import {
  ENTITIES, SERVICES, STATUSES, ST, SVC, currentFY, daysFrom, fmtDate, isOpen,
  periodLabel, projectedWork, roleLabel, suggestDue, svcLabel, todayISO, type PeriodInput,
} from "@/lib/domain";
import SignOutButton from "./SignOutButton";
import IdleSignOut from "./IdleSignOut";
import Timesheet from "./Timesheet";
import ClientNotes from "./ClientNotes";
import JobHistory, { type JobSummary } from "./JobHistory";
import MyJobs, { TeamRunning, fmtHours } from "./MyJobs";
import { checkImport, parseCsv, type ImportCheck } from "@/lib/clientImport";

type View = "overview" | "jobs" | "clients" | "timesheet" | "team";
const VIEWS: View[] = ["overview", "jobs", "clients", "timesheet", "team"];
interface JobFilter { q: string; service: string; status: string; assignee: string; due: string; client: string }
const NO_FILTER: JobFilter = { q: "", service: "", status: "open", assignee: "", due: "", client: "" };

type Modal =
  | { kind: "job"; job?: Job; clientId?: string }
  | { kind: "bulk" }
  | { kind: "client"; client?: Client }
  | { kind: "member"; member?: Profile }
  | { kind: "import" }
  | { kind: "query"; job: Job; mode: "send" | "answer" }
  | { kind: "temp"; name: string; email: string; password: string }
  | { kind: "confirm"; title: string; text: string; yes: string; run: () => Promise<boolean | void> }
  | null;

const PAGE = 1000;
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

export default function Workspace({ me }: { me: Profile }) {
  const supabase = useMemo(() => createClient(), []);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [running, setRunning] = useState<JobTimer | null>(null);
  const [timerBusy, setTimerBusy] = useState(false);
  const [teamRunning, setTeamRunning] = useState<JobTimer[]>([]);
  const [jobHours, setJobHours] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [live, setLive] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [jf, setJf] = useState<JobFilter>(NO_FILTER);
  const [cq, setCq] = useState("");
  const [cservice, setCservice] = useState("");
  const [centity, setCentity] = useState<string[]>([]);
  const [clientId, setClientId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const isMaster = me.role === "master";
  const canManage = me.role === "master" || me.role === "manager";
  const canSeeTeam = canManage;
  const canDelete = canManage || !!me.can_delete;

  const say = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), err ? 6000 : 2600);
  }, []);

  const load = useCallback(async () => {
    try {
      const [p, d, c, j] = await Promise.all([
        fetchAll<Profile>((a, b) => supabase.from("profiles").select("*").order("full_name").range(a, b)),
        // Names of everyone (no emails or roles). Falls back to the visible profiles
        // if the database update that adds team_directory hasn't been run yet.
        supabase.rpc("team_directory").then(({ data, error }) => (error ? null : (data as Person[]))),
        fetchAll<Client>((a, b) => supabase.from("clients").select("*").order("name").range(a, b)),
        fetchAll<Job>((a, b) => supabase.from("jobs").select("*").order("due_date", { nullsFirst: false }).range(a, b)),
      ]);
      const { data: t } = await supabase.from("job_timers").select("*").eq("user_id", me.id).is("ended_at", null).limit(1);
      setRunning(((t as JobTimer[] | null) ?? [])[0] ?? null);
      if (me.role === "master" || me.role === "manager") {
        // Everyone this person can see (managers: their own staff) who has a job running, plus time logged on those jobs.
        const { data: tr } = await supabase.from("job_timers").select("*").is("ended_at", null).order("started_at");
        const list = ((tr as JobTimer[] | null) ?? []).filter((x) => x.job_id);
        setTeamRunning(list);
        const ids = [...new Set(list.map((x) => x.job_id as string))];
        const hrs: Record<string, number> = {};
        if (ids.length) {
          const { data: te } = await supabase.from("timesheet_entries").select("job_id,hours").in("job_id", ids);
          for (const e of (te as { job_id: string; hours: number }[] | null) ?? []) hrs[e.job_id] = (hrs[e.job_id] ?? 0) + Number(e.hours);
        }
        setJobHours(hrs);
      }
      setProfiles(p); setPeople(d ?? p.map(({ id, full_name, title, active }) => ({ id, full_name, title, active }))); setClients(c); setJobs(j); setLoaded(true); setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [supabase, me.id, me.role]);

  // Initial load + live refresh when anyone changes something.
  useEffect(() => {
    // Make sure today's automatic payroll and BAS jobs exist (does nothing if they already do).
    supabase.rpc("generate_recurring_jobs").then(({ error }) => (error ? supabase.rpc("generate_payroll_jobs") : null)).then(() => load(), () => load());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(load, 300); };
    const channel = supabase
      .channel("practice")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "clients" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "job_timers" }, refresh)
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearTimeout(timer); window.removeEventListener("focus", onFocus); supabase.removeChannel(channel); };
  }, [supabase, load]);

  // Hash routing so each section can be bookmarked.
  useEffect(() => {
    const route = () => {
      const h = window.location.hash.replace("#", "") as View;
      setView(VIEWS.includes(h) && (h !== "team" || canSeeTeam) ? h : "overview");
    };
    route();
    window.addEventListener("hashchange", route);
    return () => window.removeEventListener("hashchange", route);
  }, [canSeeTeam]);
  const go = (v: View) => { if (v !== "clients") setClientId(null); window.location.hash = v; setView(v); window.scrollTo(0, 0); };
  const gotoJobs = (f: Partial<JobFilter>) => { setJf({ ...NO_FILTER, ...f }); go("jobs"); };
  const openClient = (id: string) => { setClientId(id); window.location.hash = "clients"; setView("clients"); window.scrollTo(0, 0); };

  const profileById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const team = useMemo(() => people.filter((p) => p.active), [people]);
  const managers = useMemo(() => profiles.filter((p) => p.active && p.role === "manager"), [profiles]);
  const personName = (id: string | null) => (id ? profileById.get(id)?.full_name ?? "Former staff" : "");
  const clientName = (id: string) => clientById.get(id)?.name ?? "Deleted client";
  const openJobs = useMemo(() => jobs.filter((j) => isOpen(j.status)), [jobs]);

  /** Run a database write; show a friendly message either way. */
  async function save(fn: () => PromiseLike<{ error: { message: string; code?: string } | null }>, ok?: string): Promise<boolean> {
    const { error } = await fn();
    if (error) {
      const msg = error.code === "23505" ? "That job already exists for this client and period."
        : /row-level security|permission/i.test(error.message) ? "You don't have permission to do that. Ask your manager."
        : `That change was not saved: ${error.message}`;
      say(msg, true);
      return false;
    }
    if (ok) say(ok);
    load();
    return true;
  }

  async function adminCall(url: string, method: string, body?: unknown) {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { say(d.error ?? "That didn't work. Try again.", true); return null; }
    load();
    return d;
  }

  async function setStatus(j: Job, status: StatusId) {
    // Internal query: pick who to send it to first.
    if (status === "internal_query" && j.status !== "internal_query") { setModal({ kind: "query", job: j, mode: "send" }); return; }
    const upd: Partial<Job> = { status };
    if (status === "lodged" && !j.lodged_on) upd.lodged_on = todayISO();
    await save(() => supabase.from("jobs").update(upd).eq("id", j.id), `Marked ${ST[status].label.toLowerCase()}`);
  }

  /** My jobs: start/stop the job timer (time goes to the timesheet), change status, submit for review. */
  async function timerCall(fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>, ok: (d: unknown) => string | null) {
    setTimerBusy(true);
    const { data, error } = await fn();
    setTimerBusy(false);
    if (error) { say(/function|schema cache|does not exist/i.test(error.message) ? "The job timer isn't set up in the database yet." : error.message, true); return false; }
    const m = ok(data); if (m) say(m);
    await load();
    return true;
  }
  const startJob = (j: Job) => timerCall(() => supabase.rpc("start_job", { p_job: j.id }),
    () => (running && running.job_id !== j.id ? `Started ${clientName(j.client_id)}. The previous job's time is on your timesheet.` : `Started ${clientName(j.client_id)}`));
  const stopJob = () => timerCall(() => supabase.rpc("stop_job"), (h) => `Added ${fmtHours(Number(h))} to your timesheet`);
  const myReviewer = (j: Job) => j.reviewer_id ?? me.reports_to ?? null;
  async function myStatus(j: Job, status: StatusId) {
    if (running?.job_id === j.id && !isOpen(status) && !(await stopJob())) return;
    await setStatus(j, status);
  }
  async function submitForReview(j: Job) {
    if (running?.job_id === j.id && !(await stopJob())) return;
    const rev = myReviewer(j);
    await save(() => supabase.from("jobs").update({ status: "review", reviewer_id: rev }).eq("id", j.id),
      rev && rev !== me.id ? `Sent to ${personName(rev)} for review` : "Marked ready for review");
  }

  function exportCsv(list: Job[]) {
    const q = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [["Client", "ABN", "Service", "Period", "Due date", "Assigned to", "Reviewer", "Status", "Priority", "Lodged on", "Notes"]].concat(
      list.map((j) => [clientName(j.client_id), clientById.get(j.client_id)?.abn ?? "", svcLabel(j.service), j.period, j.due_date ?? "", personName(j.assignee_id), personName(j.reviewer_id), ST[j.status]?.label ?? j.status, j.priority, j.lodged_on ?? "", j.notes])
    );
    const blob = new Blob([rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `supertax-jobs-${todayISO()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- small renderers ---------- */
  const Due = ({ j }: { j: Job }) => {
    if (!j.due_date) return <div className="due"><span className="muted">No due date</span></div>;
    let note: React.ReactNode = null;
    if (isOpen(j.status)) {
      const d = daysFrom(j.due_date);
      if (d < 0) note = <small className="danger">{-d} day{d === -1 ? "" : "s"} overdue</small>;
      else if (d === 0) note = <small className="warn">Due today</small>;
      else if (d <= 7) note = <small className="warn">In {d} day{d === 1 ? "" : "s"}</small>;
    } else if (j.lodged_on) note = <small className="muted">Lodged {fmtDate(j.lodged_on)}</small>;
    return <div className="due"><span className="mono">{fmtDate(j.due_date)}</span>{note}</div>;
  };
  const statusCls = (j: Job) => { const s = ST[j.status] ?? ST.not_started; return s.open && j.due_date && daysFrom(j.due_date) < 0 ? "danger" : s.cls; };
  const StatusSelect = ({ j }: { j: Job }) => (
    <select className={`status ${statusCls(j)}`} id={`st-${j.id}`} aria-label="Status" value={j.status} onChange={(e) => setStatus(j, e.target.value as StatusId)}>
      {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </select>
  );

  /* ---------- views ---------- */
  function Overview() {
    const overdue = openJobs.filter((j) => j.due_date && daysFrom(j.due_date) < 0);
    const week = openJobs.filter((j) => j.due_date && daysFrom(j.due_date) >= 0 && daysFrom(j.due_date) <= 7);
    const waiting = openJobs.filter((j) => j.status === "waiting");
    const review = openJobs.filter((j) => j.status === "review" || j.status === "to_lodge");
    const month = todayISO().slice(0, 7);
    const lodged = jobs.filter((j) => (j.lodged_on ?? "").startsWith(month));
    const attention = [...overdue, ...week].sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? "")).slice(0, 12);
    const svcs = SERVICES.filter((s) => openJobs.some((j) => j.service === s.id));
    const cols = STATUSES.filter((s) => s.open);
    const rows = team.map((p) => ({ id: p.id, name: p.full_name, title: p.title, js: openJobs.filter((j) => j.assignee_id === p.id) }));
    const un = openJobs.filter((j) => !j.assignee_id || !profileById.get(j.assignee_id)?.active);
    if (un.length) rows.push({ id: "__none", name: "Unassigned", title: "", js: un });
    const max = Math.max(1, ...rows.map((r) => r.js.length));
    const projected = projectedWork(clients);
    const Tile = ({ lbl, n, cls, f }: { lbl: string; n: number; cls?: string; f: Partial<JobFilter> }) => (
      <button className={`tile ${cls ?? ""}`} onClick={() => gotoJobs(f)}><span className="lbl">{lbl}</span><span className="val">{n}</span></button>
    );
    return (
      <>
        <div className="pagehead">
          <div><h1>Practice overview</h1><p>{fmtDate(todayISO())} · {openJobs.length} open job{openJobs.length === 1 ? "" : "s"} across {clients.length} client{clients.length === 1 ? "" : "s"}</p></div>
          <div className="row"><button onClick={() => setModal({ kind: "bulk" })}>Create jobs for a period</button><button className="primary" onClick={() => setModal({ kind: "job" })}>New job</button></div>
        </div>
        {!clients.length ? (
          <div className="panel welcome"><div><h2 style={{ fontSize: 18 }}>Set up your practice</h2>
            <p className="muted" style={{ margin: 0 }}>Every BAS, payroll run and tax return in one shared list, with who&apos;s on it, its status and its ATO due date.</p>
            <ol>
              {isMaster ? <li><button className="link" onClick={() => go("team")}>Add your team</button> so they can sign in and be assigned work.</li> : null}
              <li><button className="link" onClick={() => setModal({ kind: "client" })}>Add your clients</button> and tick the services you do for each.</li>
              <li><button className="link" onClick={() => setModal({ kind: "bulk" })}>Create jobs for a period</button>, such as every quarterly BAS for Q2 FY{String(currentFY()).slice(2)}, in one step.</li>
            </ol></div>
            <div className="side"><strong>Signed in as {roleLabel(me.role)}</strong><span className="note">{isMaster ? "Only you can add team members, change roles and switch access off." : canManage ? "Managers can also delete clients and jobs." : "You can add and update clients and jobs."}</span></div>
          </div>
        ) : null}
        <div className="tiles">
          <Tile lbl="Overdue" n={overdue.length} cls={overdue.length ? "danger" : ""} f={{ due: "overdue" }} />
          <Tile lbl="Due in the next 7 days" n={week.length} cls={week.length ? "warn" : ""} f={{ due: "week" }} />
          <Tile lbl="Waiting on client" n={waiting.length} f={{ status: "waiting" }} />
          <Tile lbl="Ready for review or lodgment" n={review.length} f={{ status: "review_any" }} />
          <Tile lbl="Lodged this month" n={lodged.length} f={{ status: "lodged" }} />
        </div>
        <div className="panel" style={{ padding: "12px 14px", marginBottom: 16 }}>
          <div className="ph" style={{ padding: 0, marginBottom: 8 }}><h2>All jobs by status</h2><button className="link" onClick={() => gotoJobs({ status: "" })}>See all {jobs.length}</button></div>
          <div className="statusrow">{STATUSES.map((st) => { const n = jobs.filter((j) => j.status === st.id).length; return (
            <button key={st.id} className="statuschip" onClick={() => gotoJobs({ status: st.id })} disabled={!n}><strong className="mono">{n}</strong><span className={`pill ${st.cls}`}>{st.label}</span></button>); })}</div>
        </div>
        <div className="grid2">
          <div className="section">
            <MyJobs jobs={openJobs.filter((j) => j.assignee_id === me.id || (j.query_from === me.id && j.status === "internal_query"))} myId={me.id} personName={personName}
              onAnswer={(j) => setModal({ kind: "query", job: j, mode: "answer" })} running={running} clientName={clientName} busy={timerBusy}
              reviewerName={me.reports_to ? personName(me.reports_to) : ""}
              onStart={startJob} onStop={stopJob} onStatus={myStatus} onSubmit={submitForReview}
              onOpen={(j) => setModal({ kind: "job", job: j })} onSeeAll={() => gotoJobs({ assignee: me.id })} />
            <div className="panel">
              <div className="ph"><h2>Needs attention</h2>{attention.length ? <button className="link" onClick={() => gotoJobs({ due: "week_or_overdue" })}>See all</button> : null}</div>
              {attention.length ? (
                <ul className="list">{attention.map((j) => (
                  <li key={j.id}><div style={{ minWidth: 0 }}><div className="t">{clientName(j.client_id)}</div><div className="s">{svcLabel(j.service)} · {j.period} · {personName(j.assignee_id) || "Unassigned"}</div></div>
                    <div className="row"><Due j={j} /><button onClick={() => setModal({ kind: "job", job: j })}>Open</button></div></li>
                ))}</ul>
              ) : <div className="empty"><strong>Nothing overdue or due this week.</strong>Jobs due in the next 7 days show here.</div>}
            </div>
            {svcs.length ? (
              <div className="panel"><div className="ph"><h2>Open work by service</h2></div>
                <div style={{ overflowX: "auto", marginTop: 8 }}><table className="matrix"><thead><tr><th>Service</th>{cols.map((c) => <th key={c.id} style={{ textAlign: "right" }}>{c.label}</th>)}<th style={{ textAlign: "right" }}>Total</th></tr></thead>
                  <tbody>{svcs.map((s) => { const js = openJobs.filter((j) => j.service === s.id); return (
                    <tr key={s.id}><td>{s.label}</td>{cols.map((c) => { const n = js.filter((j) => j.status === c.id).length; return n
                      ? <td key={c.id} className="num"><button onClick={() => gotoJobs({ service: s.id, status: c.id })}>{n}</button></td>
                      : <td key={c.id} className="zero mono">0</td>; })}
                      <td className="num"><button onClick={() => gotoJobs({ service: s.id })}><strong>{js.length}</strong></button></td></tr>); })}</tbody></table></div></div>
            ) : null}
          </div>
          <div className="section">
            {canManage ? <TeamRunning timers={teamRunning} jobHours={jobHours} jobById={(id) => jobs.find((j) => j.id === id)} clientName={clientName} personName={personName}
              onOpen={(j) => setModal({ kind: "job", job: j })} /> : null}
            <div className="panel"><div className="ph"><h2>Team workload</h2><span className="note">Open jobs · <span style={{ color: "var(--danger)" }}>overdue</span></span></div>
              <div style={{ overflowX: "auto", marginTop: 8 }}><table className="workload"><tbody>{rows.map((r) => { const od = r.js.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length; const n = r.js.length; return (
                <tr key={r.id}><td style={{ width: "40%" }}><button className="link" style={{ color: "var(--fg)" }} onClick={() => gotoJobs({ assignee: r.id })}>{r.name}</button>{r.title ? <div className="note">{r.title}</div> : null}</td>
                  <td><div className="bar" title={`${n} open, ${od} overdue`}><i className="d" style={{ width: `${(od / max) * 100}%` }} /><i className="o" style={{ width: `${((n - od) / max) * 100}%` }} /></div></td>
                  <td className="mono" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{n}{od ? <> · <span style={{ color: "var(--danger)" }}>{od}</span></> : null}</td></tr>); })}</tbody></table></div></div>
            {projected.length ? (
              <div className="panel"><div className="ph"><h2>Projected work</h2><span className="note">Created automatically when the period ends</span></div>
                <ul className="list">{projected.map((p) => (
                  <li key={p.key}><div style={{ minWidth: 0 }}><div className="t">{p.label}</div><div className="s" title={p.clients.join(", ")}>{p.detail}: {p.clients.slice(0, 3).join(", ")}{p.clients.length > 3 ? ` +${p.clients.length - 3} more` : ""}</div></div>
                    <span className="pill">Appears {fmtDate(p.appears)}</span></li>))}</ul></div>
            ) : null}
          </div>
        </div>
      </>
    );
  }

  const filteredJobs = useMemo(() => {
    const f = jf, q = f.q.trim().toLowerCase();
    const base = f.status === "closed" ? jobs.filter((j) => !isOpen(j.status)) : f.status === "" || (ST[f.status] && !ST[f.status].open) ? jobs : openJobs;
    return base.filter((j) => {
      if (f.service && j.service !== f.service) return false;
      if (f.status === "review_any" && !(j.status === "review" || j.status === "to_lodge")) return false;
      if (ST[f.status] && j.status !== f.status) return false;
      if (f.client && j.client_id !== f.client) return false;
      if (f.assignee === "__none") { if (j.assignee_id && profileById.get(j.assignee_id)?.active) return false; }
      else if (f.assignee && j.assignee_id !== f.assignee) return false;
      if (f.due) {
        if (f.due === "nodate") { if (j.due_date) return false; }
        else {
          if (!j.due_date) return false;
          const d = daysFrom(j.due_date);
          if (f.due === "overdue" && d >= 0) return false;
          if (f.due === "week" && (d < 0 || d > 7)) return false;
          if (f.due === "week_or_overdue" && d > 7) return false;
          if (f.due === "month" && (d < 0 || d > 30)) return false;
        }
      }
      if (q) {
        const hay = [clientById.get(j.client_id)?.name, j.period, j.notes, svcLabel(j.service), profileById.get(j.assignee_id ?? "")?.full_name].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || (clientById.get(a.client_id)?.name ?? "").localeCompare(clientById.get(b.client_id)?.name ?? ""));
  }, [jf, jobs, openJobs, clientById, profileById]);

  function JobsView() {
    const set = (k: keyof JobFilter) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setJf({ ...jf, [k]: e.target.value });
    const list = filteredJobs, shown = list.slice(0, 500);
    return (
      <>
        <div className="pagehead">
          <div><h1>Jobs</h1><p>Every piece of client work, with its period, due date, owner and status.</p></div>
          <div className="row"><button onClick={() => exportCsv(list)}>Export CSV</button><button onClick={() => setModal({ kind: "bulk" })}>Create jobs for a period</button><button className="primary" onClick={() => setModal({ kind: "job" })}>New job</button></div>
        </div>
        <div className="toolbar">
          <input type="search" id="jf-q" placeholder="Search client, period or notes" aria-label="Search jobs" value={jf.q} onChange={set("q")} />
          <select id="jf-service" aria-label="Service" value={jf.service} onChange={set("service")}><option value="">All services</option>{SERVICES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
          <select id="jf-status" aria-label="Status" value={jf.status} onChange={set("status")}>
            <option value="open">All open jobs</option><option value="review_any">Ready for review or lodgment</option>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            <option value="">Everything</option>
          </select>
          <select id="jf-due" aria-label="Due" value={jf.due} onChange={set("due")}>
            {[["", "Any due date"], ["overdue", "Overdue"], ["week", "Due in 7 days"], ["week_or_overdue", "Overdue or due in 7 days"], ["month", "Due in 30 days"], ["nodate", "No due date"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select id="jf-assignee" aria-label="Assigned to" value={jf.assignee} onChange={set("assignee")}><option value="">Anyone</option><option value="__none">Unassigned</option>{team.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
          <select id="jf-client" aria-label="Client" value={jf.client} onChange={set("client")}><option value="">All clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button onClick={() => setJf(NO_FILTER)}>Clear</button>
        </div>
        <div className="tablebox">
          {!list.length ? (
            <div className="empty"><strong>{jobs.length ? "No jobs match these filters." : "No jobs yet."}</strong>{jobs.length ? "Clear a filter to see more." : "Use New job for one-off work, or Create jobs for a period to set up a whole quarter of BAS at once."}</div>
          ) : (
            <>
              <table><thead><tr><th>Client</th><th>Service</th><th>Period</th><th>Due</th><th>Assigned</th><th>Status</th><th></th></tr></thead>
                <tbody>{shown.map((j) => (
                  <tr key={j.id}>
                    <td className="client"><button className="link" onClick={() => openClient(j.client_id)}>{clientName(j.client_id)}</button>{j.priority === "high" ? <span className="prio" title="High priority">!</span> : null}</td>
                    <td>{svcLabel(j.service)}</td><td className="mono">{j.period}</td><td><Due j={j} /></td>
                    <td>{personName(j.assignee_id) || <span className="muted">Unassigned</span>}{j.reviewer_id ? <div className="note">Review: {personName(j.reviewer_id)}</div> : null}</td>
                    <td><StatusSelect j={j} /></td>
                    <td><button onClick={() => setModal({ kind: "job", job: j })}>Edit</button></td>
                  </tr>))}</tbody></table>
              <div className="count">{list.length} job{list.length === 1 ? "" : "s"}{list.length > 500 ? " · showing the first 500, narrow the filters to see the rest" : ""}</div>
            </>
          )}
        </div>
      </>
    );
  }

  function ClientsView() {
    const q = cq.trim().toLowerCase();
    const list = clients.filter((c) => (!cservice || c.services.includes(cservice)) && (!centity.length || centity.includes(c.entity)) && (!q || [c.name, c.abn, c.contact, c.email].join(" ").toLowerCase().includes(q)));
    const openBy = new Map<string, Job[]>();
    openJobs.forEach((j) => openBy.set(j.client_id, [...(openBy.get(j.client_id) ?? []), j]));
    return (
      <>
        <div className="pagehead"><div><h1>Clients</h1><p>Who you act for and which services you provide each of them.</p></div><div className="row">{canManage ? <button onClick={() => setModal({ kind: "import" })}>Import from CSV or Excel</button> : null}<button className="primary" onClick={() => setModal({ kind: "client" })}>Add client</button></div></div>
        <div className="toolbar">
          <input type="search" id="cq" placeholder="Search name, ABN or contact" aria-label="Search clients" value={cq} onChange={(e) => setCq(e.target.value)} />
          <select id="cservice" aria-label="Service" value={cservice} onChange={(e) => setCservice(e.target.value)}><option value="">Any service</option>{SERVICES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        </div>
        <div className="toolbar entity-filter" role="group" aria-label="Show entity types" style={{ borderRadius: 0, borderTop: "1px solid var(--line)", gap: 6 }}>
          <span className="note" style={{ marginRight: 4 }}>Show:</span>
          {ENTITIES.map((x) => { const on = centity.includes(x); return (
            <label key={x} className={`chip${on ? " on" : ""}`}><input type="checkbox" checked={on} onChange={() => setCentity(on ? centity.filter((y) => y !== x) : [...centity, x])} /> {x === "SMSF" ? "Super fund (SMSF)" : x}</label>); })}
          {centity.length ? <button type="button" className="link" onClick={() => setCentity([])}>Show all</button> : <span className="note">All types shown. Tick to narrow down.</span>}
        </div>
        <div className="tablebox">
          {!list.length ? <div className="empty"><strong>{clients.length ? "No clients match." : "No clients yet."}</strong>{clients.length ? "Try another search." : "Add your first client, then tick the services you do for them."}</div> : (
            <>
              <table><thead><tr><th>Client</th><th>Entity</th><th>ABN</th><th>Services</th><th>Manager</th><th style={{ textAlign: "right" }}>Open jobs</th></tr></thead>
                <tbody>{list.map((c) => { const oj = openBy.get(c.id) ?? []; const od = oj.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length; return (
                  <tr key={c.id}><td className="client"><button className="link" onClick={() => openClient(c.id)}>{c.name}</button>{c.contact ? <div className="note">{c.contact}</div> : null}</td>
                    <td>{c.entity}</td><td className="mono">{c.abn}</td>
                    <td>{c.services.map((s) => <span key={s} className="tag">{svcLabel(s)}{s === "bas" && c.bas_freq === "monthly" ? " (monthly)" : ""}{s === "payroll" && c.payroll_freq ? ` (${c.payroll_freq})` : ""}</span>)}</td>
                    <td>{personName(c.manager_id)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{oj.length}{od ? <> <span className="pill danger">{od} overdue</span></> : null}</td></tr>); })}</tbody></table>
              <div className="count">{list.length} client{list.length === 1 ? "" : "s"}</div>
            </>
          )}
        </div>
      </>
    );
  }

  function ClientDetail({ c }: { c: Client }) {
    const js = jobs.filter((j) => j.client_id === c.id).sort((a, b) => (b.due_date ?? "").localeCompare(a.due_date ?? ""));
    const openJ = js.filter((j) => isOpen(j.status)), closedJ = js.filter((j) => !isOpen(j.status));
    const Table = ({ list }: { list: Job[] }) => (
      <table><thead><tr><th>Service</th><th>Period</th><th>Due</th><th>Assigned</th><th>Status</th><th></th></tr></thead>
        <tbody>{list.map((j) => (
          <tr key={j.id}><td>{svcLabel(j.service)}{j.priority === "high" ? <span className="prio">!</span> : null}</td><td className="mono">{j.period}</td><td><Due j={j} /></td>
            <td>{personName(j.assignee_id) || <span className="muted">Unassigned</span>}</td><td><StatusSelect j={j} /></td><td><button onClick={() => setModal({ kind: "job", job: j })}>Edit</button></td></tr>))}</tbody></table>
    );
    return (
      <>
        <div className="pagehead">
          <div><button className="link" onClick={() => setClientId(null)}>← All clients</button><h1 style={{ marginTop: 6 }}>{c.name}</h1><p>{c.entity}{c.abn ? <> · ABN <span className="mono">{c.abn}</span></> : null}</p></div>
          <div className="row"><button onClick={() => setModal({ kind: "client", client: c })}>Edit client</button><button className="primary" onClick={() => setModal({ kind: "job", clientId: c.id })}>New job for this client</button></div>
        </div>
        <div className="detail">
          <div className="panel"><dl className="kv">
            <dt>Contact</dt><dd>{c.contact || "—"}</dd><dt>Email</dt><dd>{c.email || "—"}</dd><dt>Phone</dt><dd className="mono">{c.phone || "—"}</dd>
            <dt>Manager</dt><dd>{personName(c.manager_id) || "—"}</dd>
            <dt>Services</dt><dd>{c.services.length ? c.services.map((s) => <span key={s} className="tag">{svcLabel(s)}</span>) : "—"}</dd>
            {c.services.includes("payroll") ? <><dt>Payroll</dt><dd>{c.payroll_freq ? `${c.payroll_freq[0].toUpperCase()}${c.payroll_freq.slice(1)}, jobs created automatically` : "No automatic jobs"}</dd></> : null}
            {c.services.some((s) => SVC[s]?.kind === "bas") ? <><dt>BAS cycle</dt><dd>{c.bas_freq === "monthly" ? "Monthly" : "Quarterly"}</dd></> : null}
            {c.notes ? <><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{c.notes}</dd></> : null}
            <dt>Last change</dt><dd className="note">{fmtDate(c.updated_at)}{c.updated_by ? ` by ${personName(c.updated_by)}` : ""}</dd>
          </dl></div>
          <div className="section">
            <ClientNotes key={c.id} clientId={c.id} meId={me.id} isManager={canManage} canDelete={canDelete} supabase={supabase} personName={personName} say={say} />
            <div><h2>Open jobs ({openJ.length})</h2><div className="tablebox solo">{openJ.length ? <Table list={openJ} /> : <div className="empty">No open jobs for this client.</div>}</div></div>
            <div><h2>Lodged and completed ({closedJ.length})</h2><div className="tablebox solo">{closedJ.length ? <Table list={closedJ} /> : <div className="empty">Nothing lodged yet.</div>}</div></div>
          </div>
        </div>
      </>
    );
  }

  function TeamView() {
    const sorted = [...profiles].sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id) || Number(b.active) - Number(a.active) || a.full_name.localeCompare(b.full_name));
    return (
      <>
        <div className="pagehead"><div><h1>Team</h1><p>{isMaster ? "Everyone who can sign in. You add people, set their role and manager, and switch access off." : "You and the team members allocated to you."}</p></div>
          <div className="row">{isMaster ? <button className="primary" onClick={() => setModal({ kind: "member" })}>Add team member</button> : null}</div></div>
        <div className="tablebox solo"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th>{isMaster ? <th>Reports to</th> : null}<th>Can delete</th><th style={{ textAlign: "right" }}>Open jobs</th><th style={{ textAlign: "right" }}>Overdue</th><th></th></tr></thead>
          <tbody>{sorted.map((p) => { const oj = openJobs.filter((j) => j.assignee_id === p.id); const od = oj.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length; return (
            <tr key={p.id}><td className="client">{p.full_name}{p.id === me.id ? " (you)" : ""}{p.title ? <div className="note">{p.title}</div> : null}</td>
              <td>{p.email}</td>
              <td><span className="role">{roleLabel(p.role)}</span>{!p.active ? <> <span className="pill danger">Access off</span></> : p.must_change_password ? <> <span className="pill warn">Hasn&apos;t signed in yet</span></> : null}</td>
              {isMaster ? <td>{p.role === "staff" ? personName(p.reports_to ?? null) || <span className="note">Not allocated</span> : null}</td> : null}
              <td>{p.role !== "staff" ? <span className="note">Always</span>
                : (isMaster || p.reports_to === me.id) && p.active
                  ? <button type="button" aria-pressed={!!p.can_delete} className={p.can_delete ? "primary" : undefined} title={p.can_delete ? "Click to take delete access away" : "Click to let them delete clients and jobs"}
                      onClick={async () => { if (await adminCall(`/api/team/${p.id}/delete-access`, "PATCH", { allow: !p.can_delete })) say(p.can_delete ? `${p.full_name} can no longer delete` : `${p.full_name} can now delete clients and jobs`); }}>{p.can_delete ? "Yes" : "No"}</button>
                  : p.can_delete ? "Yes" : "No"}</td>
              <td className="mono" style={{ textAlign: "right" }}>{oj.length}</td><td className="mono" style={{ textAlign: "right", color: od ? "var(--danger)" : undefined }}>{od}</td>
              <td style={{ textAlign: "right" }}>{isMaster && p.id !== me.id ? <button onClick={() => setModal({ kind: "member", member: p })}>Manage</button> : null}</td></tr>); })}</tbody></table></div>
        {!isMaster && sorted.length <= 1 ? <p className="note">No team members are allocated to you yet. Ask for team members to be allocated to you.</p> : null}
        <div className="panel" style={{ padding: 16, marginTop: 16 }}>
          <h2>What each role can do</h2>
          <p className="note" style={{ margin: 0 }}><strong>Staff</strong> add and update clients and jobs. <strong>Managers</strong> can also delete clients and jobs, see their own team here, and give their staff delete access with the Can delete button. The <strong>Master admin</strong> sees everyone, can give any staff member delete access, adds people, changes roles, resets passwords and switches access off.</p>
        </div>
      </>
    );
  }

  /* ---------- modals ---------- */
  const close = () => setModal(null);
  const clientForDetail = clientId ? clientById.get(clientId) : undefined;

  if (!loaded) {
    return (
      <Shell me={me} view={view} go={go} live={live} showTeam={canSeeTeam}>
        <div className="panel empty"><strong>{loadError ? "The practice database did not answer." : "Loading your practice…"}</strong>{loadError ? `${loadError}. Reload the page to try again.` : "Clients, jobs and due dates appear here in a moment."}</div>
      </Shell>
    );
  }

  return (
    <Shell me={me} view={view} go={go} live={live} showTeam={canSeeTeam}>
      {view === "overview" ? <Overview /> : null}
      {view === "jobs" ? JobsView() : null}
      {view === "clients" ? (clientForDetail ? ClientDetail({ c: clientForDetail }) : ClientsView()) : null}
      {view === "timesheet" ? <Timesheet me={me} supabase={supabase} people={people} visible={profiles.filter((p) => p.active)} clients={clients} jobs={jobs} canSeeTeam={canSeeTeam} say={say} /> : null}
      {view === "team" && canSeeTeam ? <TeamView /> : null}

      {modal?.kind === "job" ? <JobModal job={modal.job} presetClient={modal.clientId} clients={clients} team={team} canDelete={canDelete} locked={!!modal.job && !canManage} meId={me.id} onQuery={(j) => setModal({ kind: "query", job: j, mode: "send" })} supabase={supabase} save={save} onClose={close} confirm={(m) => setModal({ kind: "confirm", ...m })} personName={personName} say={say} /> : null}
      {modal?.kind === "bulk" ? <BulkModal clients={clients} team={team} jobs={jobs} personName={personName} supabase={supabase} save={save} onClose={close} say={say} /> : null}
      {modal?.kind === "client" ? <ClientModal client={modal.client} team={team} canDelete={canDelete} jobs={jobs} supabase={supabase} save={save} onClose={close} confirm={(m) => setModal({ kind: "confirm", ...m })} onDeleted={() => setClientId(null)} /> : null}
      {modal?.kind === "import" && canManage ? <ImportModal clients={clients} people={people} supabase={supabase} onDone={(n) => { load(); say(`${n} client${n === 1 ? "" : "s"} imported`); close(); }} onClose={close} say={say} /> : null}
      {modal?.kind === "member" ? <MemberModal member={modal.member} managers={managers} adminCall={adminCall} onClose={close} onTemp={(t) => setModal({ kind: "temp", ...t })} confirm={(m) => setModal({ kind: "confirm", ...m })} say={say} /> : null}
      {modal?.kind === "temp" ? (
        <Overlay onClose={close}><div className="modal"><header><h2>Give {modal.name} their sign-in</h2><button type="button" onClick={close}>Close</button></header>
          <div className="body"><div className="full stack">
            <p style={{ margin: 0 }}>Send these to {modal.name} privately (for example by text). They&apos;ll choose their own password the first time they sign in.</p>
            <label className="f">Website<div className="temp">{typeof window !== "undefined" ? window.location.origin : ""}</div></label>
            <label className="f">Email<div className="temp">{modal.email}</div></label>
            <label className="f">Temporary password<div className="temp">{modal.password}</div></label>
            <button type="button" onClick={() => { navigator.clipboard?.writeText(`Supertax Practice Desk\n${window.location.origin}\nEmail: ${modal.email}\nTemporary password: ${modal.password}`).then(() => say("Copied"), () => say("Select the text to copy it", true)); }}>Copy all</button>
            <p className="note" style={{ margin: 0 }}>This password is shown only once.</p>
          </div></div>
          <footer><span /><button type="button" className="primary" onClick={close}>Done</button></footer></div></Overlay>
      ) : null}
      {modal?.kind === "query" ? <QueryModal job={modal.job} mode={modal.mode} me={me} team={team} clientName={clientName} personName={personName}
        run={async (to, note) => {
          const ok = await timerCall(() => modal.mode === "send"
            ? supabase.rpc("send_internal_query", { p_job: modal.job.id, p_to: to, p_note: note })
            : supabase.rpc("answer_internal_query", { p_job: modal.job.id, p_note: note }),
          () => (modal.mode === "send" ? `Sent to ${personName(to)} for an internal query` : `Sent back to ${personName(modal.job.query_from ?? null)}`));
          if (ok) close();
        }} onClose={close} /> : null}
      {modal?.kind === "confirm" ? <ConfirmModal {...modal} onClose={close} /> : null}

      {toast ? <div className={`toast${toast.err ? " err" : ""}`} role="status">{toast.msg}</div> : null}
    </Shell>
  );
}

/* ---------- layout ---------- */
function Shell({ me, view, go, live, showTeam, children }: { me: Profile; view: View; go: (v: View) => void; live: boolean; showTeam: boolean; children: React.ReactNode }) {
  const tabs: [View, string][] = [["overview", "Overview"], ["jobs", "Jobs"], ["clients", "Clients"], ["timesheet", "Timesheet"], ...(showTeam ? [["team", "Team"] as [View, string]] : [])];
  return (
    <>
      <header className="top"><div className="wrap">
        <div className="brand"><img src="/logo.webp" alt="Supertax" width={136} height={34} /><small>Practice Desk</small></div>
        <nav className="tabs" aria-label="Sections">{tabs.map(([v, l]) => (
          <a key={v} href={`#${v}`} aria-current={view === v ? "page" : undefined} onClick={(e) => { e.preventDefault(); go(v); }}>{l}</a>))}</nav>
        <div className="userbox"><span><strong>{me.full_name}</strong></span><SignOutButton /></div>
      </div></header>
      <IdleSignOut />
      <main className="wrap">
        {children}
        <p className="note" style={{ marginTop: 28 }}><span className={`live${live ? "" : " off"}`}>{live ? "Live: changes by your team appear automatically" : "Connecting to live updates…"}</span></p>
      </main>
    </>
  );
}

function Overlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>{children}</div>;
}

type SaveFn = (fn: () => PromiseLike<{ error: { message: string; code?: string } | null }>, ok?: string) => Promise<boolean>;
type ConfirmArgs = { title: string; text: string; yes: string; run: () => Promise<boolean | void> };
type SB = ReturnType<typeof createClient>;

function ConfirmModal({ title, text, yes, run, onClose }: ConfirmArgs & { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Overlay onClose={onClose}><form className="modal" onSubmit={async (e) => { e.preventDefault(); setBusy(true); const r = await run(); setBusy(false); if (r !== false) onClose(); }}>
      <header><h2>{title}</h2></header>
      <div className="body"><p className="full" style={{ margin: 0 }}>{text}</p></div>
      <footer><span /><div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={busy} style={{ background: "var(--danger)", borderColor: "var(--danger)", color: "#fff" }}>{yes}</button></div></footer>
    </form></Overlay>
  );
}

function JobModal({ job, presetClient, clients, team, canDelete, locked, meId, onQuery, supabase, save, onClose, confirm, personName, say }: {
  job?: Job; presetClient?: string; clients: Client[]; team: Person[]; canDelete: boolean; locked: boolean; meId: string; onQuery: (j: Job) => void; supabase: SB; save: SaveFn; onClose: () => void;
  confirm: (m: ConfirmArgs) => void; personName: (id: string | null) => string; say: (m: string, e?: boolean) => void;
}) {
  const preset = presetClient ? clients.find((c) => c.id === presetClient) : undefined;
  const [v, setV] = useState({
    client_id: job?.client_id ?? presetClient ?? "", service: job?.service ?? "bas", period: job?.period ?? "", due_date: job?.due_date ?? "",
    priority: job?.priority ?? "normal", assignee_id: job?.assignee_id ?? preset?.manager_id ?? "", reviewer_id: job?.reviewer_id ?? "",
    status: job?.status ?? "not_started", lodged_on: job?.lodged_on ?? "", notes: job?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"details" | "history">("details");
  const [sum, setSum] = useState<JobSummary | null>(null);
  const logged = sum?.hours ?? 0;
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const next = { ...v, [k]: e.target.value };
    if (k === "client_id" && !v.assignee_id) next.assignee_id = clients.find((c) => c.id === e.target.value)?.manager_id ?? "";
    setV(next);
  };
  if (!clients.length) {
    return <Overlay onClose={onClose}><div className="modal"><header><h2>Add a client first</h2><button onClick={onClose}>Close</button></header><div className="body"><p className="full" style={{ margin: 0 }}>Jobs belong to a client. Add a client on the Clients page, then create jobs for them.</p></div></div></Overlay>;
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!v.client_id) { say("Choose a client.", true); return; }
    setBusy(true);
    // Staff can only change the status and notes of an existing job (the database enforces this too).
    const row: Partial<Job> = locked ? { status: v.status, notes: v.notes, ...(v.status === "lodged" && !job?.lodged_on ? { lodged_on: todayISO() } : {}) } : { ...v, period: v.period.trim(), due_date: v.due_date || null, assignee_id: v.assignee_id || null, reviewer_id: v.reviewer_id || null,
      lodged_on: v.lodged_on || (v.status === "lodged" ? todayISO() : null) };
    // Choosing Internal query: save the other changes, then pick who to send it to.
    const query = !!job && v.status === "internal_query" && job.status !== "internal_query";
    if (query) row.status = job.status;
    const ok = job ? await save(() => supabase.from("jobs").update(row).eq("id", job.id), query ? undefined : "Job saved")
      : await save(() => supabase.from("jobs").insert(row), "Job created");
    setBusy(false);
    if (ok && query) onQuery({ ...job, ...row } as Job);
    else if (ok) onClose();
  }
  const opts = (blank: string) => <><option value="">{blank}</option>{team.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</>;
  return (
    <Overlay onClose={onClose}><form className={`modal ${job ? "wide" : ""}`} onSubmit={submit}>
      <header><h2>{job ? "Edit job" : "New job"}</h2><button type="button" onClick={onClose}>Close</button></header>
      {job ? <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "details"} className={tab === "details" ? "on" : ""} onClick={() => setTab("details")}>Details</button>
        <button type="button" role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History &amp; time{sum ? ` · ${sum.hours ? fmtHours(sum.hours) : "0h"}${sum.comments ? ` · ${sum.comments} comment${sum.comments === 1 ? "" : "s"}` : ""}` : ""}</button>
      </div> : null}
      {job ? <div style={{ display: tab === "history" ? "block" : "none" }}><JobHistory jobId={job.id} meId={meId} canDelete={canDelete} supabase={supabase} personName={personName} say={say} onSummary={setSum} /></div> : null}
      <div className="body" style={{ display: tab === "details" ? undefined : "none" }}>
        {locked ? <div className="full hint">Only your manager can change the client, service, period, due date, priority, assignee, reviewer and lodgment date. You can update the status and notes.</div> : null}
        <label className="f full">Client<select id="m-client" required disabled={locked} value={v.client_id} onChange={set("client_id")}><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f">Service<select id="m-service" disabled={locked} value={v.service} onChange={set("service")}>{SERVICES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label className="f">Period<input id="m-period" required disabled={locked} placeholder="e.g. Q2 FY27, Oct 2026, FY2026" value={v.period} onChange={set("period")} /></label>
        <label className="f">Due date<input id="m-due" type="date" disabled={locked} value={v.due_date} onChange={set("due_date")} /></label>
        <label className="f">Priority<select id="m-priority" disabled={locked} value={v.priority} onChange={set("priority")}><option value="normal">Normal</option><option value="high">High</option></select></label>
        <label className="f">Assigned to<select id="m-assignee" disabled={locked} value={v.assignee_id} onChange={set("assignee_id")}>{opts("Unassigned")}</select></label>
        <label className="f">Reviewer<select id="m-reviewer" disabled={locked} value={v.reviewer_id} onChange={set("reviewer_id")}>{opts("No reviewer")}</select></label>
        <label className="f">Status<select id="m-status" value={v.status} onChange={set("status")}>{STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label className="f">Lodged on<input id="m-lodged" type="date" disabled={locked} value={v.lodged_on} onChange={set("lodged_on")} /></label>
        <label className="f full">Notes<textarea id="m-notes" placeholder="Records outstanding, queries for the client, lodgment receipt number…" value={v.notes} onChange={set("notes")} /></label>
        {job ? <div className="full hint">Last changed {fmtDate(job.updated_at)}{job.updated_by ? ` by ${personName(job.updated_by)}` : ""}{logged ? <> · <button type="button" className="link" onClick={() => setTab("history")}>{fmtHours(logged)} logged, see history</button></> : null}</div> : null}
      </div>
      <footer>
        {job && canDelete ? <button type="button" className="danger" onClick={() => confirm({ title: "Delete this job?", text: "The job and its notes are removed for everyone. This cannot be undone.", yes: "Delete job", run: () => save(() => supabase.from("jobs").delete().eq("id", job.id), "Job deleted") })}>Delete job</button> : <span />}
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy}>{job ? "Save changes" : "Create job"}</button></div>
      </footer>
    </form></Overlay>
  );
}

function BulkModal({ clients, team, jobs, personName, supabase, save, onClose, say }: {
  clients: Client[]; team: Person[]; jobs: Job[]; personName: (id: string | null) => string; supabase: SB; save: SaveFn; onClose: () => void; say: (m: string, e?: boolean) => void;
}) {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const m = now.getMonth() + 1;
  const [service, setService] = useState("bas");
  const [p, setP] = useState<PeriodInput>({ freq: "quarterly", fy: currentFY(), q: m >= 7 && m <= 9 ? 1 : m >= 10 ? 2 : m <= 3 ? 3 : 4, month: `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`, text: "" });
  const [due, setDue] = useState<string | null>(null); // null = use suggestion
  const [assign, setAssign] = useState("__mgr");
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const kind = SVC[service].kind;
  const isBas = kind === "bas", monthly = (isBas && p.freq === "monthly") || kind === "monthly";
  const label = periodLabel(service, p);
  const sug = suggestDue(service, p);
  const dueValue = due ?? sug;
  const existing = new Set(jobs.filter((j) => j.service === service && j.period === label).map((j) => j.client_id));
  const cands = clients.filter((c) => c.services.includes(service) && (!isBas || c.bas_freq === p.freq));
  const picked = cands.filter((c) => !existing.has(c.id) && !unticked.has(c.id));
  const fy = currentFY();
  const change = (patch: Partial<PeriodInput>) => { setP({ ...p, ...patch }); setDue(null); };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label) { say("Enter the period.", true); return; }
    if (!dueValue) { say("Enter the due date.", true); return; }
    if (!picked.length) { say("Tick at least one client.", true); return; }
    setBusy(true);
    const rows = picked.map((c) => ({ client_id: c.id, service, period: label, due_date: dueValue, status: "not_started", priority: "normal",
      assignee_id: assign === "__mgr" ? c.manager_id : assign === "__none" ? null : assign }));
    const ok = await save(() => supabase.from("jobs").upsert(rows, { onConflict: "client_id,service,period", ignoreDuplicates: true }), `${rows.length} job${rows.length === 1 ? "" : "s"} created for ${label}`);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Overlay onClose={onClose}><form className="modal" onSubmit={submit}>
      <header><h2>Create jobs for a period</h2><button type="button" onClick={onClose}>Close</button></header>
      <div className="body">
        <p className="full hint" style={{ margin: 0 }}>Pick a service and period. Every client you provide that service to is listed; untick any you don&apos;t want. Clients that already have this job are skipped.</p>
        <label className="f">Service<select id="b-service" value={service} onChange={(e) => { setService(e.target.value); setDue(null); setUnticked(new Set()); }}>{SERVICES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        {isBas ? <label className="f">BAS cycle<select id="b-freq" value={p.freq} onChange={(e) => change({ freq: e.target.value as PeriodInput["freq"] })}><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option></select></label> : null}
        {!monthly && kind !== "custom" ? <label className="f">{kind === "fbt" ? "FBT year ending 31 March" : "Financial year"}<select id="b-fy" value={p.fy} onChange={(e) => change({ fy: Number(e.target.value) })}>{[fy - 2, fy - 1, fy, fy + 1].map((y) => <option key={y} value={y}>{kind === "fbt" ? `FBT ${y}` : `FY${y} (Jul ${y - 1} – Jun ${y})`}</option>)}</select></label> : null}
        {isBas && p.freq === "quarterly" ? <label className="f">Quarter<select id="b-q" value={p.q} onChange={(e) => change({ q: Number(e.target.value) })}>{[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q} ({["Jul–Sep", "Oct–Dec", "Jan–Mar", "Apr–Jun"][q - 1]})</option>)}</select></label> : null}
        {monthly ? <label className="f">Month<input id="b-month" type="month" value={p.month} onChange={(e) => change({ month: e.target.value })} /></label> : null}
        {kind === "custom" ? <label className="f">Period<input id="b-text" placeholder="e.g. 2026 review" value={p.text} onChange={(e) => change({ text: e.target.value })} /></label> : null}
        <label className="f">Due date<input id="b-due" type="date" required value={dueValue} onChange={(e) => setDue(e.target.value)} />
          <span className="hint">{sug ? (isBas && p.freq === "monthly" ? "Suggested: 21st of the following month." : kind === "monthly" ? "Suggested: 7 days after month end. Change to suit." : "Suggested from the ATO tax agent lodgment program. Check for this client.") : "Enter the due date."}</span></label>
        <label className="f">Assign to<select id="b-assignee" value={assign} onChange={(e) => setAssign(e.target.value)}><option value="__mgr">Each client&apos;s manager</option><option value="__none">Unassigned</option>{team.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}</select></label>
        <div className="full">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}><strong>{cands.length} client{cands.length === 1 ? "" : "s"} with {SVC[service].label}{isBas ? ` (${p.freq})` : ""}</strong>
            <span className="row"><button type="button" className="link" onClick={() => setUnticked(new Set())}>Select all</button><button type="button" className="link" onClick={() => setUnticked(new Set(cands.map((c) => c.id)))}>Select none</button></span></div>
          <div className="picklist">{cands.length ? cands.map((c) => { const has = existing.has(c.id); return (
            <label key={c.id} className={has ? "off" : ""}><input type="checkbox" disabled={has} checked={!has && !unticked.has(c.id)} onChange={(e) => { const n = new Set(unticked); if (e.target.checked) n.delete(c.id); else n.add(c.id); setUnticked(n); }} /> {c.name}
              <span className="who">{has ? "Already created" : personName(c.manager_id) || "No manager"}</span></label>); })
            : <div className="empty" style={{ padding: 18 }}>No clients have this service ticked. Edit a client and tick {SVC[service].label} to include them.</div>}</div>
        </div>
      </div>
      <footer><span className="hint">{picked.length} job{picked.length === 1 ? "" : "s"} will be created{label ? ` for ${label}` : ""}</span>
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy || !picked.length}>Create jobs</button></div></footer>
    </form></Overlay>
  );
}

function ClientModal({ client, team, canDelete, jobs, supabase, save, onClose, confirm, onDeleted }: {
  client?: Client; team: Person[]; canDelete: boolean; jobs: Job[]; supabase: SB; save: SaveFn; onClose: () => void; confirm: (m: ConfirmArgs) => void; onDeleted: () => void;
}) {
  const [v, setV] = useState({
    name: client?.name ?? "", entity: client?.entity ?? "Company", abn: client?.abn ?? "", contact: client?.contact ?? "", manager_id: client?.manager_id ?? "",
    email: client?.email ?? "", phone: client?.phone ?? "", services: client?.services ?? [], bas_freq: client?.bas_freq ?? "quarterly", notes: client?.notes ?? "",
    payroll_freq: (client?.payroll_freq ?? "") as string, payroll_anchor: client?.payroll_anchor ?? "",
  });
  const hasPayroll = v.services.includes("payroll");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    if (hasPayroll && v.payroll_freq && !v.payroll_anchor) { setBusy(false); alert("Enter the next pay date so payroll jobs can be created on the right days."); return; }
    const { payroll_freq, payroll_anchor, ...base } = v;
    // Payroll fields are sent only when relevant, so saving works even before the payroll database update.
    const payroll = hasPayroll || client?.payroll_freq ? { payroll_freq: hasPayroll ? payroll_freq : "", payroll_anchor: hasPayroll && payroll_freq ? payroll_anchor || null : null } : {};
    const row: Record<string, unknown> = { ...base, ...payroll, name: v.name.trim(), abn: v.abn.trim(), manager_id: v.manager_id || null };
    const ok = client ? await save(() => supabase.from("clients").update(row).eq("id", client.id), "Client saved") : await save(() => supabase.from("clients").insert(row), "Client added");
    setBusy(false);
    if (ok) onClose();
  }
  const n = client ? jobs.filter((j) => j.client_id === client.id).length : 0;
  return (
    <Overlay onClose={onClose}><form className="modal" onSubmit={submit}>
      <header><h2>{client ? "Edit client" : "Add client"}</h2><button type="button" onClick={onClose}>Close</button></header>
      <div className="body">
        <label className="f full">Client name<input id="c-name" required value={v.name} onChange={set("name")} placeholder="e.g. Harbourside Plumbing Pty Ltd" /></label>
        <label className="f">Entity type<select id="c-entity" value={v.entity} onChange={set("entity")}>{ENTITIES.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="f">ABN<input id="c-abn" inputMode="numeric" value={v.abn} onChange={set("abn")} placeholder="11 digits" /></label>
        <label className="f">Contact person<input id="c-contact" value={v.contact} onChange={set("contact")} /></label>
        <label className="f">Manager<select id="c-manager" value={v.manager_id} onChange={set("manager_id")}><option value="">No manager</option>{team.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label>
        <label className="f">Email<input id="c-email" type="email" value={v.email} onChange={set("email")} /></label>
        <label className="f">Phone<input id="c-phone" type="tel" value={v.phone} onChange={set("phone")} /></label>
        <div className="f full">Services you provide<div className="checks">{SERVICES.map((s) => (
          <label key={s.id}><input type="checkbox" checked={v.services.includes(s.id)} onChange={(e) => setV({ ...v, services: e.target.checked ? [...v.services, s.id] : v.services.filter((x) => x !== s.id) })} /> {s.label}</label>))}</div></div>
        <label className="f">BAS / IAS cycle<select id="c-basfreq" value={v.bas_freq} onChange={set("bas_freq")}><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option></select></label>
        {hasPayroll ? <>
          <label className="f">Pay frequency<select id="c-payfreq" value={v.payroll_freq} onChange={set("payroll_freq")}><option value="">Not set (no automatic jobs)</option><option value="weekly">Weekly</option><option value="fortnightly">Fortnightly</option><option value="monthly">Monthly</option></select></label>
          {v.payroll_freq ? <label className="f">{v.payroll_freq === "monthly" ? "A pay date (sets the day of the month)" : "Next pay date"}<input id="c-payanchor" type="date" value={v.payroll_anchor} onChange={set("payroll_anchor")} required /></label> : null}
          {v.payroll_freq ? <p className="full hint" style={{ margin: 0 }}>A payroll job is created automatically on each pay day, assigned to the client&apos;s manager.</p> : null}
        </> : null}
        <label className="f full">Notes<textarea id="c-notes" value={v.notes} onChange={set("notes")} placeholder="Software they use, year-end, quirks…" /></label>
        <p className="full hint" style={{ margin: 0 }}>Don&apos;t store TFNs, passwords or bank details here.</p>
      </div>
      <footer>
        {client && canDelete ? <button type="button" className="danger" onClick={() => confirm({ title: `Delete ${client.name}?`, text: `This removes the client and their ${n} job${n === 1 ? "" : "s"} for everyone. This cannot be undone.`, yes: "Delete client",
          run: async () => { const ok = await save(() => supabase.from("clients").delete().eq("id", client.id), "Client deleted"); if (ok) onDeleted(); return ok; } })}>Delete client</button> : <span />}
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy}>{client ? "Save changes" : "Add client"}</button></div>
      </footer>
    </form></Overlay>
  );
}

function MemberModal({ member, managers, adminCall, onClose, onTemp, confirm, say }: {
  member?: Profile; managers: Profile[]; adminCall: (url: string, method: string, body?: unknown) => Promise<{ tempPassword?: string } | null>; onClose: () => void;
  onTemp: (t: { name: string; email: string; password: string }) => void; confirm: (m: ConfirmArgs) => void; say: (m: string, e?: boolean) => void;
}) {
  const [v, setV] = useState({ fullName: member?.full_name ?? "", email: member?.email ?? "", title: member?.title ?? "", role: member?.role ?? "staff", reportsTo: member?.reports_to ?? "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    if (member) {
      const r = await adminCall(`/api/admin/users/${member.id}`, "PATCH", { fullName: v.fullName, title: v.title, role: v.role, reportsTo: v.role === "staff" ? v.reportsTo || null : null });
      setBusy(false);
      if (r) { say("Saved"); onClose(); }
    } else {
      const r = await adminCall("/api/admin/users", "POST", v);
      setBusy(false);
      if (r?.tempPassword) onTemp({ name: v.fullName, email: v.email.trim().toLowerCase(), password: r.tempPassword });
    }
  }
  return (
    <Overlay onClose={onClose}><form className="modal" onSubmit={submit}>
      <header><h2>{member ? `Manage ${member.full_name}` : "Add team member"}</h2><button type="button" onClick={onClose}>Close</button></header>
      <div className="body">
        <label className="f">Name<input id="u-name" required value={v.fullName} onChange={set("fullName")} /></label>
        <label className="f">Email{member ? <input id="u-email" value={v.email} disabled /> : <input id="u-email" type="email" required value={v.email} onChange={set("email")} />}</label>
        <label className="f">Job title<input id="u-title" value={v.title} onChange={set("title")} placeholder="e.g. Senior accountant" /></label>
        <label className="f">Role<select id="u-role" value={v.role} onChange={set("role")}><option value="staff">Staff</option><option value="manager">Manager</option><option value="master">Master admin (full control)</option></select></label>
        {v.role === "staff" ? (
          <label className="f">Reports to (manager)<select id="u-reports" value={v.reportsTo} onChange={set("reportsTo")}><option value="">No manager</option>{managers.filter((m) => m.id !== member?.id).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}</select></label>
        ) : null}
        {!member ? <p className="full hint" style={{ margin: 0 }}>You&apos;ll get a temporary password to give them. They choose their own the first time they sign in.</p> : null}
        {member ? (
          <div className="full row" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <button type="button" onClick={async () => { const r = await adminCall(`/api/admin/users/${member.id}`, "POST"); if (r?.tempPassword) onTemp({ name: member.full_name, email: member.email, password: r.tempPassword }); }}>Reset password</button>
            {member.active
              ? <button type="button" className="danger" onClick={() => confirm({ title: `Switch off ${member.full_name}'s access?`, text: "They are signed out and can't sign in again until you switch access back on. Their jobs and history stay.", yes: "Switch off access", run: async () => !!(await adminCall(`/api/admin/users/${member.id}`, "PATCH", { active: false })) })}>Switch off access</button>
              : <button type="button" onClick={async () => { if (await adminCall(`/api/admin/users/${member.id}`, "PATCH", { active: true })) { say("Access switched back on"); onClose(); } }}>Switch access back on</button>}
          </div>
        ) : null}
      </div>
      <footer><span /><div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy}>{member ? "Save" : "Add and get password"}</button></div></footer>
    </form></Overlay>
  );
}


function ImportModal({ clients, people, supabase, onDone, onClose, say }: {
  clients: Client[]; people: Person[]; supabase: SB; onDone: (n: number) => void; onClose: () => void; say: (m: string, e?: boolean) => void;
}) {
  const [file, setFile] = useState("");
  const [check, setCheck] = useState<ImportCheck | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    setCheck(null); setError(""); setFile(f?.name ?? "");
    if (!f) return;
    try {
      let table: unknown[][];
      if (/\.csv$/i.test(f.name)) table = parseCsv(await f.text());
      else if (/\.xlsx$/i.test(f.name)) {
        const { readSheet } = await import("read-excel-file/browser");
        table = await readSheet(f) as unknown[][];
      } else { setError("Choose a .csv or .xlsx file. If you have an older .xls file, open it in Excel and save it as .xlsx."); return; }
      const r = checkImport(table, clients, people);
      if ("error" in r) setError(r.error); else setCheck(r);
    } catch (err) {
      setError(`Couldn't read that file: ${(err as Error).message}`);
    }
  }

  async function run() {
    if (!check?.ready.length) return;
    setBusy(true);
    const rows = check.ready.map(({ line: _line, ...r }) => r);
    const { data, error } = await supabase.rpc("import_clients", { rows });
    setBusy(false);
    if (error) { say(/permission|42501|only the master/i.test(error.message) ? "Only the master admin or a manager can import clients." : `Nothing was imported: ${error.message}`, true); return; }
    onDone(typeof data === "number" ? data : rows.length);
  }

  const List = ({ items, cls }: { items: { line: number; name: string; reason: string }[]; cls: string }) => (
    <ul className="note" style={{ margin: "4px 0 0", paddingLeft: 18, maxHeight: 140, overflowY: "auto" }}>{items.map((x, i) => <li key={i}><span className={`pill ${cls}`}>Row {x.line}</span> {x.name}: {x.reason}</li>)}</ul>
  );

  return (
    <Overlay onClose={onClose}><div className="modal" style={{ maxWidth: 760 }}>
      <header><h2>Import clients</h2><button type="button" onClick={onClose}>Close</button></header>
      <div className="body"><div className="full stack">
        <p style={{ margin: 0 }}>1. Download the template, fill in one client per row, and save it.</p>
        <div className="row"><a className="btn" href="/client-import-template.xlsx" download>Excel template</a><a className="btn" href="/client-import-template.csv" download>CSV template</a></div>
        <p style={{ margin: "8px 0 0" }}>2. Upload it. You&apos;ll see what will be added before anything is saved.</p>
        <input type="file" id="import-file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={pick} aria-label="Choose a CSV or Excel file" />
        {error ? <p className="pill danger" style={{ whiteSpace: "normal" }}>{error}</p> : null}
        {check ? (
          <div className="stack">
            <p style={{ margin: 0 }}><strong>{file}</strong>: <span className="pill ok">{check.ready.length} ready to add</span> {check.skipped.length ? <span className="pill">{check.skipped.length} already in the portal</span> : null} {check.problems.length ? <span className="pill danger">{check.problems.length} need fixing</span> : null}</p>
            {check.problems.length ? <div><strong>Not imported until fixed</strong><List items={check.problems} cls="danger" /></div> : null}
            {check.warnings.length ? <div><strong>Will import, but check</strong><List items={check.warnings} cls="warn" /></div> : null}
            {check.skipped.length ? <div><strong>Skipped</strong><List items={check.skipped} cls="" /></div> : null}
            {check.ready.length ? (
              <div className="tablebox solo" style={{ maxHeight: 260, overflowY: "auto" }}><table><thead><tr><th>Client</th><th>Entity</th><th>ABN</th><th>Services</th></tr></thead>
                <tbody>{check.ready.slice(0, 200).map((r) => <tr key={r.line}><td className="client">{r.name}</td><td>{r.entity}</td><td className="mono">{r.abn}</td><td>{r.services.map((s) => <span key={s} className="tag">{svcLabel(s)}</span>)}</td></tr>)}</tbody></table></div>
            ) : null}
          </div>
        ) : null}
      </div></div>
      <footer><span className="note">Only the master admin and managers can import.</span><div className="row"><button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={busy || !check?.ready.length} onClick={run}>{busy ? "Importing…" : `Import ${check?.ready.length ?? 0} client${check?.ready.length === 1 ? "" : "s"}`}</button></div></footer>
    </div></Overlay>
  );
}

function QueryModal({ job, mode, me, team, clientName, personName, run, onClose }: {
  job: Job; mode: "send" | "answer"; me: Profile; team: Person[]; clientName: (id: string) => string; personName: (id: string | null) => string;
  run: (to: string, note: string) => Promise<void>; onClose: () => void;
}) {
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const send = mode === "send";
  const back = personName(job.query_from ?? null);
  return (
    <Overlay onClose={onClose}><form className="modal" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await run(to, note); setBusy(false); }}>
      <header><h2>{send ? "Send for internal query" : "Send back"}</h2><button type="button" onClick={onClose}>Close</button></header>
      <div className="body">
        <p className="full muted" style={{ margin: 0 }}>{clientName(job.client_id)} · {svcLabel(job.service)} · {job.period}</p>
        {send ? <label className="f full">Send to<select id="q-to" required value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose a team member…</option>{team.filter((p) => p.id !== me.id).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label> : null}
        <label className="f full">{send ? "What's the query?" : "Your reply"}<textarea id="q-note" placeholder={send ? "e.g. Please check the GST coding on the October invoices" : "e.g. Checked, the coding is right"} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="full hint">{send
          ? "The job moves to them as an Internal query and shows in their My jobs, where they can Start and Stop it to log their review time. When they send it back, it returns to the person it came from."
          : `The job goes back to ${back || "the person who sent it"} as In progress. Your note is added to the job's notes.`}</div>
      </div>
      <footer><span /><div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy || (send && !to)}>{send ? "Send query" : `Send back${back ? ` to ${back}` : ""}`}</button></div></footer>
    </form></Overlay>
  );
}
