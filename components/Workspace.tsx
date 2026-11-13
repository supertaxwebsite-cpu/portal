"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Client, ClientLink, Job, JobTimer, Person, Profile, StatusId } from "@/lib/types";
import { periodOptions, clientUpcoming,
  ENTITIES, PRACTICES, periodFY, DEFAULT_PRACTICE, practiceOf, STAFF_CANT_PICK, NO_SIGN_SERVICES, SUBMITTED_LOCK_MSG, staffSubmittedLock, SERVICES, STATUSES, ST, SVC, currentFY, daysFrom, fmtDate, isOpen,
  RELATIONS, relationText, clientGroup,
  periodLabel, projectedWork, roleLabel, suggestDue, svcLabel, todayISO, type PeriodInput,
} from "@/lib/domain";
import SignOutButton from "./SignOutButton";
import IdleSignOut from "./IdleSignOut";
import WorkGate from "./WorkGate";
import JobBrief from "./JobBrief";
import Reminders from "./Reminders";
import UpdateBanner from "./UpdateBanner";
import { MeetingsView, MeetingModal, MeetingReminders, involves, type Meeting } from "./Meetings";
import type { MeetingDraft } from "@/lib/quickMeeting";
import Bell, { type Notice } from "./Bell";
import PayrollView from "./Payroll";
import { similarClients, type Similar } from "@/lib/dupes";
import Timesheet from "./Timesheet";
import ClientNotes from "./ClientNotes";
import ClientPicker from "./ClientPicker";
import RelatedClients from "./RelatedClients";
import ProspectsView from "./Prospects";
import ActivityLog from "./ActivityLog";
import { CHECKLISTS, STEPS } from "@/lib/checklists";
import TeamBoard from "./TeamBoard";
import JobPage from "./JobPage";
import JobHistory, { type JobSummary } from "./JobHistory";
import JobFiles from "./JobFiles";
import JobEmail from "./JobEmail";
import MyJobs, { fmtHours } from "./MyJobs";
import StaffHome from "./StaffHome";
import { NeedsAttention, ReviewByPerson, ReviewTypes } from "./OverviewPanels";
import { checkImport, parseCsv, type ImportCheck } from "@/lib/clientImport";

type View = "overview" | "jobs" | "payroll" | "clients" | "prospects" | "timesheet" | "team" | "meetings";
/** Statuses where nothing more needs doing: kept out of the unassigned list. */
const FINISHED = new Set(["done", "sent_for_sign", "lodged"]);
const VIEWS: View[] = ["overview", "jobs", "payroll", "clients", "prospects", "timesheet", "team", "meetings"];
/** A dropdown of tick boxes: pick one or several values (stored comma-separated; empty means all). */
function MultiPick({ id, all, value, options, onChange }: { id: string; all: string; value: string; options: { v: string; l: string; short?: string }[]; onChange: (v: string) => void }) {
  const picked = value ? value.split(",") : [];
  const names = options.filter((o) => picked.includes(o.v)).map((o) => o.short ?? o.l);
  const label = !names.length ? all : names.length <= 2 ? names.join(", ") : `${names.length} selected`;
  return (
    <details className="colpick multipick" id={id}>
      <summary className={picked.length ? "on" : undefined} title={names.join(", ") || all}>{label}</summary>
      <div className="colmenu">
        {options.map((o) => <label key={o.v}><input type="checkbox" checked={picked.includes(o.v)} onChange={(e) => onChange((e.target.checked ? options.map((x) => x.v).filter((x) => x === o.v || picked.includes(x)) : picked.filter((x) => x !== o.v)).join(","))} /> {o.l}</label>)}
        {picked.length ? <button type="button" className="link" onClick={() => onChange("")}>Clear ({all.toLowerCase()})</button> : null}
      </div>
    </details>
  );
}

/** Columns the Clients list can show. */
const CLIENT_COLS = [
  { id: "practice", label: "Practice" }, { id: "entity", label: "Entity" }, { id: "abn", label: "ABN" },
  { id: "contact", label: "Contact person" }, { id: "email", label: "Email" }, { id: "phone", label: "Phone" },
  { id: "address", label: "Address" }, { id: "services", label: "Services" }, { id: "manager", label: "Manager" },
  { id: "open", label: "Open jobs" },
];
const DEFAULT_CLIENT_COLS = ["practice", "services", "manager", "open"];

interface JobFilter { q: string; service: string; status: string; assignee: string; due: string; client: string; group: string; practice: string; entity: string; fy: string; quarter: string }
const NO_FILTER: JobFilter = { q: "", service: "", status: "open", assignee: "", due: "", client: "", group: "", practice: "", entity: "", fy: "", quarter: "" };

type Modal =
  | { kind: "job"; job?: Job; clientId?: string; service?: string; tab?: "queries" | "email" }
  | { kind: "bulk" }
  | { kind: "client"; client?: Client }
  | { kind: "member"; member?: Profile }
  | { kind: "import" }
  | { kind: "meeting"; meeting?: Meeting; date?: string; draft?: MeetingDraft }
  | { kind: "query"; job: Job; mode: "send" | "answer" }
  | { kind: "handsign"; job: Job }
  | { kind: "submit"; job: Job }
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

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };

export default function Workspace({ me }: { me: Profile }) {
  const supabase = useMemo(() => createClient(), []);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [links, setLinks] = useState<ClientLink[]>([]);
  const [linksMissing, setLinksMissing] = useState(false);
  const [prospectsDue, setProspectsDue] = useState(0); // my open prospects with a follow-up due
  const [navTick, setNavTick] = useState(0); // bumps on each top-menu click so Payroll/Timesheet/Meetings start fresh
  // Whole-group work on a client's page: ticked jobs and the status to move them to.
  const [gsel, setGsel] = useState<Set<string>>(new Set());
  const [gstatus, setGstatus] = useState<string>("");
  const [running, setRunning] = useState<JobTimer | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [timerBusy, setTimerBusy] = useState(false);
  const [teamRunning, setTeamRunning] = useState<JobTimer[]>([]);
  /** Jobs someone has started (pressed Start or logged time). null = not known yet / database not updated. */
  const [started, setStarted] = useState<Set<string> | null>(null);
  const [jobHours, setJobHours] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [live, setLive] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [jf, setJf] = useState<JobFilter>(NO_FILTER);
  // Jobs list sort: click a column heading; click again to reverse.
  const [jsort, setJsort] = useState<{ k: string; dir: 1 | -1 }>({ k: "due", dir: 1 });
  // Ticked rows on the Jobs list, for changing several jobs at once.
  const [jsel, setJsel] = useState<Set<string>>(new Set());
  const [ovTab, setOvTab] = useState<"team" | "mine">("team"); // managers: whole team, or their own task list
  const [bulk, setBulk] = useState({ assignee: "", reviewer: "", status: "", due: "" });
  // Open internal queries, open review notes and files per job (the flags under each job name).
  const [flags, setFlags] = useState<Map<string, { q: number; rn: number; f: number }>>(new Map());
  const [cq, setCq] = useState("");
  const [cservice, setCservice] = useState("");
  const [centity, setCentity] = useState<string[]>([]);
  const [cpractice, setCpractice] = useState("");
  const [cquick, setCquick] = useState("");
  const [teamFilter, setTeamFilter] = useState(""); // quick filter on Clients: overdue, waiting, related, nojobs
  // Filters and sort on the Jobs and Clients lists are remembered on this computer
  // (across page reloads and visits) until Clear is pressed.
  const [filtersReady, setFiltersReady] = useState(false);
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("pd-list-filters") ?? "null");
      if (s && typeof s === "object") {
        if (s.jf && typeof s.jf === "object") setJf({ ...NO_FILTER, ...s.jf });
        if (s.jsort && typeof s.jsort.k === "string" && (s.jsort.dir === 1 || s.jsort.dir === -1)) setJsort(s.jsort);
        if (typeof s.cq === "string") setCq(s.cq);
        if (typeof s.cservice === "string") setCservice(s.cservice);
        if (Array.isArray(s.centity)) setCentity(s.centity.filter((x: unknown) => typeof x === "string"));
        if (typeof s.cpractice === "string") setCpractice(s.cpractice);
      }
    } catch { /* ignore */ }
    setFiltersReady(true);
  }, []);
  useEffect(() => {
    if (!filtersReady) return;
    try { localStorage.setItem("pd-list-filters", JSON.stringify({ jf, jsort, cq, cservice, centity, cpractice })); } catch { /* ignore */ }
  }, [filtersReady, jf, jsort, cq, cservice, centity, cpractice]);
  // Which columns the Clients list shows; remembered on this computer.
  const [ccols, setCcolsState] = useState<string[]>(DEFAULT_CLIENT_COLS);
  useEffect(() => { try { const s = JSON.parse(localStorage.getItem("pd-client-cols-v2") ?? "null"); if (Array.isArray(s)) setCcolsState(s.filter((x) => CLIENT_COLS.some((c) => c.id === x))); } catch { /* ignore */ } }, []);
  // Columns menu closes on a click outside it or Esc; wide tables can be dragged sideways with the mouse.
  useEffect(() => {
    const closeMenus = (e: Event) => {
      document.querySelectorAll<HTMLDetailsElement>("details.colpick[open]").forEach((d) => {
        if (e.type === "keydown" ? (e as KeyboardEvent).key === "Escape" : !d.contains(e.target as Node)) d.open = false;
      });
    };
    let drag: { el: HTMLElement; x: number; left: number; moved: boolean } | null = null;
    const down = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".dragscroll");
      if (!el || e.button !== 0 || el.scrollWidth <= el.clientWidth) return;
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      drag = { el, x: e.clientX, left: el.scrollLeft, moved: false };
    };
    const move = (e: MouseEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 5) return;
      drag.moved = true; drag.el.classList.add("dragging");
      drag.el.scrollLeft = drag.left - dx; e.preventDefault();
    };
    const up = () => {
      if (drag?.moved) {
        const el = drag.el; el.classList.remove("dragging");
        // Don't treat the end of a drag as a click on a client name.
        const stop = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
        el.addEventListener("click", stop, { capture: true, once: true });
        setTimeout(() => el.removeEventListener("click", stop, { capture: true }), 0);
      }
      drag = null;
    };
    document.addEventListener("mousedown", closeMenus); document.addEventListener("keydown", closeMenus);
    document.addEventListener("mousedown", down); document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousedown", closeMenus); document.removeEventListener("keydown", closeMenus);
      document.removeEventListener("mousedown", down); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
    };
  }, []);
  const setCcols = (c: string[]) => { setCcolsState(c); try { localStorage.setItem("pd-client-cols-v2", JSON.stringify(c)); } catch { /* ignore */ } };
  const [clientId, setClientId] = useState<string | null>(null);
  const [jobPageId, setJobPageId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const isMaster = me.role === "master";
  const canManage = me.role === "master" || me.role === "manager";
  useEffect(() => {
    if (view !== "jobs" && view !== "clients") return;
    let live = true;
    (async () => {
      const [q, rn, f] = await Promise.all([
        supabase.from("job_queries").select("job_id").is("parent_id", null).is("answered_at", null).limit(5000),
        supabase.from("review_notes").select("job_id").in("status", ["open", "fixed"]).limit(5000),
        supabase.from("job_files").select("job_id").limit(10000),
      ]);
      const m = new Map<string, { q: number; rn: number; f: number }>();
      const add = (rows: unknown, k: "q" | "rn" | "f") => ((rows as { job_id: string }[] | null) ?? []).forEach((r) => { const x = m.get(r.job_id) ?? { q: 0, rn: 0, f: 0 }; x[k]++; m.set(r.job_id, x); });
      add(q.data, "q"); add(rn.data, "rn"); add(f.data, "f");
      if (live) setFlags(m);
    })();
    return () => { live = false; };
  }, [supabase, view, jobs]);
  const canSeeTeam = canManage;
  /** Team workload and Working now: master admins, plus anyone a master admin has allowed. */
  const canSeeWorkload = isMaster || !!me.can_see_workload;
  /** Team leaders without that permission still see their own team's workload and running jobs. */
  const seesOwnTeam = !canSeeWorkload && me.role === "manager";
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
      // Related clients (empty until the database update that adds client_links has been run).
      const { data: lk, error: lkErr } = await supabase.from("client_links").select("*").order("created_at");
      setLinks((lk as ClientLink[] | null) ?? []); setLinksMissing(!!lkErr);
      const { count: pd } = await supabase.from("prospects").select("id", { count: "exact", head: true })
        .eq("owner_id", me.id).in("stage", ["new", "contacted", "meeting", "proposal"]).lte("follow_up", todayISO());
      setProspectsDue(pd ?? 0);
      const { data: t } = await supabase.from("job_timers").select("*").eq("user_id", me.id).is("ended_at", null).limit(1);
      setRunning(((t as JobTimer[] | null) ?? [])[0] ?? null);
      const { data: sj, error: sjErr } = await supabase.rpc("started_jobs");
      setStarted(sjErr ? null : new Set(((sj as (string | { started_jobs: string })[] | null) ?? []).map((x) => (typeof x === "string" ? x : x.started_jobs))));
      const { data: mt } = await supabase.from("meetings").select("*").gte("starts_at", new Date(Date.now() - 120 * 864e5).toISOString()).order("starts_at");
      setMeetings((mt as Meeting[] | null) ?? []);
      if (canSeeWorkload || seesOwnTeam) {
        // Everyone this person can see (managers: their own staff) who has a job running, plus time logged on those jobs.
        const { data: tr } = await supabase.from("job_timers").select("*").is("ended_at", null).order("started_at");
        const list = ((tr as JobTimer[] | null) ?? []).filter((x) => x.job_id);
        setTeamRunning(list);
        const ids = [...new Set(list.map((x) => x.job_id as string))];
        const hrs: Record<string, number> = {};
        if (ids.length) {
          const { data: jh, error: jhErr } = await supabase.rpc("job_hours", { p_jobs: ids });
          const te = jhErr ? (await supabase.from("timesheet_entries").select("job_id,hours").in("job_id", ids)).data : jh;
          for (const e of (te as { job_id: string; hours: number }[] | null) ?? []) hrs[e.job_id] = (hrs[e.job_id] ?? 0) + Number(e.hours);
        }
        setJobHours(hrs);
      }
      setProfiles(p); setPeople(d ?? p.map(({ id, full_name, title, active }) => ({ id, full_name, title, active }))); setClients(c); setJobs(j); setLoaded(true); setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [supabase, me.id, canSeeWorkload, seesOwnTeam]);

  // Initial load + live refresh when anyone changes something.
  useEffect(() => {
    // Make sure today's automatic payroll and BAS jobs exist (does nothing if they already do).
    supabase.rpc("remind_unsigned").then(() => null, () => null);
    supabase.rpc("generate_recurring_jobs").then(({ error }) => (error ? supabase.rpc("generate_payroll_jobs") : null)).then(() => load(), () => load());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(load, 300); };
    const channel = supabase
      .channel("practice")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "clients" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "job_timers" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "meetings" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "client_links" }, refresh)
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearTimeout(timer); window.removeEventListener("focus", onFocus); supabase.removeChannel(channel); };
  }, [supabase, load]);

  // Hash routing so each section can be bookmarked.
  useEffect(() => {
    const route = () => {
      const h = window.location.hash.replace("#", "") as View;
      setView(VIEWS.includes(h) && ((h !== "team" && h !== "meetings" && h !== "prospects") || canSeeTeam) ? h : "overview");
    };
    route();
    window.addEventListener("hashchange", route);
    return () => window.removeEventListener("hashchange", route);
  }, [canSeeTeam]);
  const go = (v: View) => { if (v !== "clients") setClientId(null); setJobPageId(null); window.location.hash = v; setView(v); window.scrollTo(0, 0); };
  // Top menu: start the page fresh, with every filter and sort cleared, so the totals show.
  const navGo = (v: View) => {
    setJf(NO_FILTER); setJsort({ k: "due", dir: 1 });
    setCq(""); setCpractice(""); setCservice(""); setCentity([]); setCquick(""); setTeamFilter(""); setOvTab("team"); setJsel(new Set());
    setGsel(new Set()); setGstatus(""); setClientId(null); setNavTick((n) => n + 1);
    go(v);
  };
  const gotoJobs = (f: Partial<JobFilter>) => { setJf({ ...NO_FILTER, ...f }); go("jobs"); };
  const openJob = (j: Job) => { setModal(null); setJobPageId(j.id); window.location.hash = "jobs"; setView("jobs"); window.scrollTo(0, 0); };
  const openClient = (id: string) => { setJobPageId(null); setClientId(id); window.location.hash = "clients"; setView("clients"); window.scrollTo(0, 0); };

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

  /** Move several jobs (e.g. a whole client group) to one status in one go. */
  async function applyGroupStatus(list: Job[]) {
    const status = gstatus as StatusId;
    if (!list.length || !ST[status]) return;
    if (!window.confirm(`Change ${list.length} job${list.length === 1 ? "" : "s"} to "${ST[status].label}"?`)) return;
    const ids = list.map((j) => j.id);
    const ok = await save(() => supabase.from("jobs").update({ status }).in("id", ids), `${ids.length} job${ids.length === 1 ? "" : "s"} marked ${ST[status].label.toLowerCase()}`);
    if (ok && status === "lodged") await supabase.from("jobs").update({ lodged_on: todayISO() }).in("id", ids).is("lodged_on", null);
    if (ok) { setGsel(new Set()); setGstatus(""); }
  }

  async function setStatus(j: Job, status: StatusId) {
    // Internal query: pick who to send it to first.
    if (status === "internal_query" && j.status !== "internal_query") { setModal({ kind: "query", job: j, mode: "send" }); return; }
    const upd: Partial<Job> = { status };
    if (status === "lodged" && !j.lodged_on) upd.lodged_on = todayISO();
    await save(() => supabase.from("jobs").update(upd).eq("id", j.id), status === "client_query"
      ? "Marked query with client. It leaves My jobs, and you'll get a reminder if there's no reply in 2 days"
      : `Marked ${ST[status].label.toLowerCase()}`);
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
    if (me.role === "staff" && status === "review") { await submitForReview(j); return; }
    if (running?.job_id === j.id && (!isOpen(status) || status === "client_query") && !(await stopJob())) return;
    await setStatus(j, status);
  }
  /** Reviewer: approve (ready for signing) or send back to the preparer with a note. */
  async function approveReview(j: Job) {
    if (running?.job_id === j.id && !(await stopJob())) return;
    if (j.needs_signature === false) {
      await save(() => supabase.from("jobs").update({ status: "done" }).eq("id", j.id), "Approved and completed. Nothing for the client to sign");
      return;
    }
    await save(() => supabase.from("jobs").update({ status: "to_lodge" }).eq("id", j.id), "Approved. It's in your My jobs as Ready for signing");
  }
  /** Nothing to sign: close the job straight away as Completed. */
  async function completeNoSign(j: Job) {
    if (!window.confirm(`Mark ${clientName(j.client_id)} · ${svcLabel(j.service)} ${j.period} as Completed? Use this when nothing needs to be signed by the client.`)) return;
    if (running?.job_id === j.id && !(await stopJob())) return;
    await save(() => supabase.from("jobs").update({ status: "done" }).eq("id", j.id), `${clientName(j.client_id)} marked completed`);
  }
  async function sendBackReview(j: Job) {
    const note = window.prompt(`What does ${personName(j.assignee_id) || "the preparer"} need to fix? (optional)`, "");
    if (note === null) return;
    if (running?.job_id === j.id && !(await stopJob())) return;
    const stamp = new Date().toLocaleDateString("en-AU", { day: "numeric", month: "short" });
    const notes = note.trim() ? `${j.notes ? `${j.notes}\n` : ""}Review (${stamp}, ${me.full_name}): ${note.trim()}` : j.notes;
    await save(() => supabase.from("jobs").update({ status: "in_progress", notes }).eq("id", j.id), `Sent back to ${personName(j.assignee_id) || "the preparer"}`);
  }
  /** Staff can't change a job's status until it has been started. */
  // Nobody changes a job's status until it has been started (master admins can still do it in Edit job).
  const staffNotStarted = (j: Job) => !wasStarted(j);
  /** Staff can't change the status of a job they've submitted for review (until it's sent back). */
  const staffSubmitted = (j: Job) => me.role === "staff" && staffSubmittedLock(j, me.id);
  /** What belongs in My jobs: my own work, reviews waiting for me, and jobs I approved that wait for the client's signature. */
  const myJobFilter = (j: Job) => {
    // Ready for signing: the approver sends it to the client.
    if (j.status === "to_lodge") return (j.sign_owner ?? j.reviewer_id ?? j.assignee_id) === me.id;
    // Sent for sign: out of the list until it's 2+ days unsigned, then back so they chase the client.
    if (j.status === "sent_for_sign") return (j.sign_owner ?? j.reviewer_id ?? j.assignee_id) === me.id
      && !!j.sign_sent_at && Date.now() - new Date(j.sign_sent_at).getTime() >= 2 * 864e5;
    // Query with client: out of the list until 2+ days without a reply, then back so they follow up.
    if (j.status === "client_query") return (j.sign_owner ?? j.assignee_id) === me.id
      && (!j.sign_sent_at || Date.now() - new Date(j.sign_sent_at).getTime() >= 2 * 864e5);
    if (j.status === "review") return j.reviewer_id === me.id || (!j.reviewer_id && j.assignee_id === me.id);
    return j.assignee_id === me.id || (j.query_from === me.id && j.status === "internal_query");
  };
  async function markSentForSign(j: Job) {
    if (running?.job_id === j.id && !(await stopJob())) return;
    await save(() => supabase.from("jobs").update({ status: "sent_for_sign" }).eq("id", j.id), "Moved to Sent for sign. You'll get a reminder if the client hasn't signed in 2 days");
  }
  /** Query with client: chased them again, so hide it for another 2 days. */
  async function followedUp(j: Job) {
    await save(() => supabase.from("jobs").update({ sign_sent_at: new Date().toISOString(), sign_reminded_at: null }).eq("id", j.id), "Got it. It comes back in 2 days if the client still hasn't answered");
  }
  async function markSigned(j: Job) {
    if (running?.job_id === j.id && !(await stopJob())) return;
    await save(() => supabase.from("jobs").update({ status: "lodged", lodged_on: j.lodged_on ?? todayISO() }).eq("id", j.id), `${clientName(j.client_id)} signed. Job marked lodged`);
  }
  const wasStarted = (j: Job) => !started || started.has(j.id) || running?.job_id === j.id;
  /** Submit for review: pick the senior or manager who checks it (defaults to the job's reviewer or your team leader). */
  async function submitForReview(j: Job) {
    if (!wasStarted(j)) { say("Start the job first: press Start, do the work, then submit it for review.", true); return; }
    setModal({ kind: "submit", job: j });
  }
  async function sendForReview(j: Job, to: string, note: string) {
    const { error } = await supabase.rpc("submit_for_review", { p_job: j.id, p_to: to, p_note: note });
    if (!error) { say(to === me.id ? "Ready for your review. It's in your My jobs: Approve it when you've checked it" : `Sent to ${personName(to)} for review`); setModal(null); await load(); return; }
    if (!/function|schema cache|does not exist/i.test(error.message)) { say(error.message, true); return; }
    // Database update not run yet: the old way (job's reviewer or your team leader).
    if (running?.job_id === j.id && !(await stopJob())) return;
    const rev = myReviewer(j);
    await save(() => supabase.from("jobs").update({ status: "review", reviewer_id: rev }).eq("id", j.id),
      rev && rev !== me.id ? `Sent to ${personName(rev)} for review` : "Marked ready for review");
    setModal(null);
  }

  async function payrollStep(j: Job, step: "super" | "stp" | "undo_super") {
    if (step === "stp" && running?.job_id === j.id && !(await stopJob())) return;
    await save(() => supabase.rpc("payroll_step", { p_job: j.id, p_step: step }),
      step === "super" ? `Super confirmed for ${clientName(j.client_id)}` : step === "stp" ? `STP lodged. ${clientName(j.client_id)} pay run finished` : "Super tick taken back");
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
  /** Where a job is in its life: preparation, review, signing, lodged. */
  const STAGE_NAMES = ["Preparation", "Review", "Signing", "Lodged"];
  const stageOf = (j: Job) => (!isOpen(j.status) ? 3 : j.status === "review" ? 1 : j.status === "to_lodge" || j.status === "sent_for_sign" ? 2 : 0);
  const Stage = ({ j }: { j: Job }) => { const s = stageOf(j); const lbl = ST[j.status]?.label ?? ""; return (
    <div className="stagecell" title={`Stage ${s + 1} of 4: ${STAGE_NAMES[s]}`}><div className="stagedots">{STAGE_NAMES.map((n, i) => <i key={n} className={i < s || (s === 3) ? "d" : i === s ? "n" : ""} />)}</div>
      <small>{s === 0 && j.status !== "in_progress" && j.status !== "not_started" ? lbl : j.status === "done" ? "Completed" : STAGE_NAMES[s]}</small></div>); };
  const TimeLeft = ({ j }: { j: Job }) => {
    if (!isOpen(j.status)) return <div className="tleft ok"><b>{j.status === "done" ? "Completed" : "Lodged"}</b><small>{j.lodged_on ? fmtDate(j.lodged_on) : ""}</small></div>;
    if (j.status === "sent_for_sign" && j.sign_sent_at) { const d = -daysFrom(j.sign_sent_at.slice(0, 10)); return <div className="tleft ok"><b>Sent {d ? `${d} day${d === 1 ? "" : "s"} ago` : "today"}</b><small>{j.due_date ? `Due ${fmtDate(j.due_date)}` : ""}</small></div>; }
    if (!j.due_date) return <div className="tleft"><b className="muted">No due date</b></div>;
    const d = daysFrom(j.due_date);
    const cls = d < 0 ? "danger" : d <= 7 ? "warn" : "ok";
    return <div className={`tleft ${cls}`}><b>{d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : d === 0 ? "Due today" : `${d} day${d === 1 ? "" : "s"} left`}</b><small>{fmtDate(j.due_date)}</small></div>;
  };
  const statusCls = (j: Job) => { const s = ST[j.status] ?? ST.not_started; return s.open && j.due_date && daysFrom(j.due_date) < 0 ? "danger" : s.cls; };
  // Lodged and completed jobs are read-only for everyone except master admins.
  const closedFor = (j: Job) => !isOpen(j.status) && !isMaster;
  const StatusSelect = ({ j }: { j: Job }) => (
    <select className={`status ${statusCls(j)}`} id={`st-${j.id}`} aria-label="Status" value={j.status} disabled={closedFor(j) || staffSubmitted(j) || staffNotStarted(j)} title={closedFor(j) ? "Only a master admin can change a lodged or completed job" : staffSubmitted(j) ? SUBMITTED_LOCK_MSG : staffNotStarted(j) ? "Not started yet. The person it's assigned to presses Start first, then the status can change" : undefined} onChange={(e) => (me.role === "staff" && e.target.value === "review" ? submitForReview(j) : setStatus(j, e.target.value as StatusId))}>
      {STATUSES.map((s) => <option key={s.id} value={s.id} disabled={me.role === "staff" && STAFF_CANT_PICK.has(s.id) && s.id !== j.status && j.reviewer_id !== me.id}>{s.label}</option>)}
    </select>
  );

  /* ---------- views ---------- */
  // Meetings in My jobs: every meeting I booked or was invited to that isn't marked done, for the next 30 days.
  // Ones I booked stay until I press Done; ones I was invited to drop off after the day they happen.
  const myMeetings = useMemo(() => {
    const now = Date.now(), dayStart = new Date(new Date().toDateString()).getTime();
    return meetings.filter((m) => {
      if (m.done || !involves(m, me.id)) return false;
      const at = new Date(m.starts_at).getTime(), end = at + m.duration_min * 60000;
      if (at > now + 30 * 864e5) return false;
      return m.owner_id === me.id ? true : end >= dayStart;
    });
  }, [meetings, me.id]);

  function Overview() {
    const overdue = openJobs.filter((j) => j.due_date && daysFrom(j.due_date) < 0);
    const week = openJobs.filter((j) => j.due_date && daysFrom(j.due_date) >= 0 && daysFrom(j.due_date) <= 7);
    const waiting = openJobs.filter((j) => j.status === "waiting");
    const review = openJobs.filter((j) => j.status === "review" || j.status === "to_lodge");
    const month = todayISO().slice(0, 7);
    const lodged = jobs.filter((j) => (j.lodged_on ?? "").startsWith(month));
    // Needs attention is personal: my own jobs that are overdue, due within 7 days, or high priority.
    const attention = openJobs.filter((j) => j.assignee_id === me.id && j.status !== "sent_for_sign" && j.status !== "client_query"
      && ((j.due_date && daysFrom(j.due_date) <= 7) || j.priority === "high"))
      .sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high") || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
    const svcs = SERVICES.filter((s) => openJobs.some((j) => j.service === s.id));
    const cols = STATUSES.filter((s) => s.open);
    const myTeam = new Set([me.id, ...profiles.filter((p) => p.reports_to === me.id).map((p) => p.id)]);
    const rows = team.filter((p) => !seesOwnTeam || myTeam.has(p.id)).map((p) => ({ id: p.id, name: p.full_name, title: p.title, js: openJobs.filter((j) => j.assignee_id === p.id) }));
    const un = openJobs.filter((j) => !FINISHED.has(j.status) && (!j.assignee_id || !profileById.get(j.assignee_id)?.active));
    if (un.length && !seesOwnTeam) rows.push({ id: "__none", name: "Unassigned", title: "", js: un });
    const projected = projectedWork(clients);
    const Tile = ({ lbl, n, cls, f, sub }: { lbl: string; n: number; cls?: string; f: Partial<JobFilter>; sub?: string }) => (
      <button className={`tile ${cls ?? ""}`} onClick={() => gotoJobs(f)}><span className="lbl">{lbl}</span><span className="val">{n}</span>{sub ? <span className="note">{sub}</span> : null}</button>
    );
    const ym = (off: number) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
    const lastMonthLodged = jobs.filter((j) => (j.lodged_on ?? "").startsWith(ym(-1))).length;
    const myOpen = openJobs.filter(myJobFilter);
    const teamPill = me.role !== "staff" ? <div className="quickpills"><button type="button" onClick={() => setOvTab("team")}>← Team overview</button></div> : null;
    if (me.role === "staff" || ovTab === "mine") {
      const ym = (off: number) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
      const closedIn = (m: string) => jobs.filter((j) => j.assignee_id === me.id && !isOpen(j.status) && (j.lodged_on ?? "").startsWith(m)).length;
      return (<>{teamPill}
        <StaffHome supabase={supabase} meId={me.id} firstName={me.full_name.split(" ")[0]} jobs={openJobs.filter(myJobFilter)} closedThisMonth={closedIn(ym(0))} closedLastMonth={closedIn(ym(-1))}
          running={running} busy={timerBusy} personName={personName} wasStarted={wasStarted}
          clientLine={(j) => { const c = clientById.get(j.client_id); return [clientName(j.client_id), `${practiceOf(c)}${c?.entity ? ` · ${c.entity}` : ""}`]; }}
          onOpen={(j) => openJob(j)} onStart={startJob} onStop={stopJob} onApprove={approveReview} onSendBack={sendBackReview} onSentForSign={markSentForSign}
          onSigned={markSigned} onReplied={(j) => myStatus(j, "in_progress")} onAnswer={(j) => setModal({ kind: "query", job: j, mode: "answer" })} onPayroll={() => go("payroll")}
          statusEl={(j) => <StatusSelect j={j} />}>
          {myMeetings.length ? <div style={{ marginTop: 16 }}><MyJobs title="My meetings" jobs={[]} meetings={myMeetings} myId={me.id} personName={personName} running={null} clientName={clientName} reviewerName="" busy={timerBusy}
            onOpenMeeting={(m) => setModal({ kind: "meeting", meeting: m })} onMeetingDone={(m) => save(() => supabase.from("meetings").update({ done: true }).eq("id", m.id), "Meeting marked done")}
            onStart={startJob} onStop={stopJob} onStatus={myStatus} onSubmit={submitForReview} onAnswer={() => {}} onOpen={(j) => openJob(j)} onSeeAll={() => gotoJobs({ assignee: me.id })} /></div> : null}
        </StaffHome></>
      );
    }
    return (
      <>
        <div className="pagehead">
          <div><h1>Practice desk</h1><p>{greeting()} {me.full_name.split(" ")[0]}. {seesOwnTeam ? "Your team at a glance" : "The whole practice at a glance"} · {openJobs.length} open job{openJobs.length === 1 ? "" : "s"} across {clients.length} client{clients.length === 1 ? "" : "s"}.</p></div>
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
            <div className="side"><strong>Signed in as {roleLabel(me.role)}</strong><span className="note">{isMaster ? "Only you can add team members, change roles and switch access off." : canManage ? "Only master admins can delete clients and jobs." : "You can add and update clients and jobs."}</span></div>
          </div>
        ) : null}
        <div className="quickpills">
          <button type="button" className="on">Team</button>
          <button type="button" onClick={() => setOvTab("mine")}>My tasks <i>{myOpen.length}</i></button>
          <button type="button" onClick={() => setOvTab("mine")}>Waiting for my review <i>{openJobs.filter((j) => j.status === "review" && j.reviewer_id === me.id).length}</i></button>
          <button type="button" onClick={() => gotoJobs({ status: "internal_query" })}>Queries to answer <i className={openJobs.some((j) => j.status === "internal_query") ? "hot" : undefined}>{openJobs.filter((j) => j.status === "internal_query").length}</i></button>
          <button type="button" onClick={() => setOvTab("mine")}>Signing &amp; client queries <i>{myOpen.filter((j) => j.status === "to_lodge" || j.status === "sent_for_sign" || j.status === "client_query").length}</i></button>
        </div>
        <div className="tiles">
          <Tile lbl="Overdue" n={overdue.length} cls={overdue.length ? "danger" : ""} f={{ due: "overdue" }} sub="Click to see them in Jobs" />
          <Tile lbl="Due in the next 7 days" n={week.length} cls={week.length ? "warn" : ""} f={{ due: "week" }} sub="Click to see them in Jobs" />
          <Tile lbl="Waiting on client" n={waiting.length} f={{ status: "waiting" }} sub={`+ ${openJobs.filter((j) => j.status === "client_query").length} client queries`} />
          <Tile lbl="Ready for review or signing" n={review.length} cls="info" f={{ status: "review_any" }} sub={`${openJobs.filter((j) => j.status === "review").length} review · ${openJobs.filter((j) => j.status === "to_lodge").length} signing`} />
          <Tile lbl="Lodged this month" n={lodged.length} cls="lodg" f={{ status: "lodged" }} sub={`Last month ${lastMonthLodged}`} />
        </div>
        <div className="panel" style={{ padding: "12px 14px", marginBottom: 16 }}>
          <div className="ph" style={{ padding: 0, marginBottom: 8 }}><h2>All jobs by status</h2><button className="link" onClick={() => gotoJobs({ status: "" })}>See all {jobs.length}</button></div>
          <div className="statusrow">{STATUSES.map((st) => { const n = jobs.filter((j) => j.status === st.id).length; return (
            <button key={st.id} className="statuschip" onClick={() => gotoJobs({ status: st.id })} disabled={!n}><strong className="mono">{n}</strong><span className={`pill ${st.cls}`}>{st.label}</span></button>); })}</div>
        </div>
        {canSeeWorkload || seesOwnTeam ? <TeamBoard supabase={supabase} rows={rows} timers={teamRunning} jobById={(id) => jobs.find((j) => j.id === id)} clientName={clientName} meId={me.id}
          title={seesOwnTeam ? "My team board" : "Team board"} onOpen={(j) => openJob(j)} onViewTasks={(id) => gotoJobs({ assignee: id })} /> : null}
        <div className="grid2 ovbottom">
          <NeedsAttention supabase={supabase} meId={me.id} canManage={canManage} jobs={openJobs} clientName={clientName} personName={personName}
            onOpen={(j) => openJob(j)} onFollowedUp={followedUp} onProspects={() => go("prospects")} />
          <div className="section">
            <ReviewTypes supabase={supabase} personName={personName} visible={new Set(rows.map((r) => r.id))} />
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

  const jobFYs = useMemo(() => [...new Set(jobs.flatMap((j) => periodFY(j.period).fys))].filter((y) => y > 2000 && y < 2100).sort((a, b) => b - a), [jobs]);
  const filteredJobs = useMemo(() => {
    const f = jf, q = f.q.trim().toLowerCase();
    const inGroup = f.client && f.group ? clientGroup(f.client, links) : null;
    const base = f.status === "closed" ? jobs.filter((j) => !isOpen(j.status)) : f.status === "" || (ST[f.status] && !ST[f.status].open) ? jobs : openJobs;
    return base.filter((j) => {
      const has = (list: string, v: string | undefined | null) => !list || list.split(",").includes(v ?? "");
      if (!has(f.service, j.service)) return false;
      if (f.status === "review_any" && !(j.status === "review" || j.status === "to_lodge")) return false;
      if (f.status === "has_notes" && !flags.get(j.id)?.rn) return false;
      if (ST[f.status] && j.status !== f.status) return false;
      if (f.client && (inGroup ? !inGroup.has(j.client_id) : j.client_id !== f.client)) return false;
      if (f.assignee === "__none") {
        if (j.assignee_id && profileById.get(j.assignee_id)?.active) return false;
        if (FINISHED.has(j.status)) return false; // nothing left to do on these
      }
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
      if (!has(f.practice, practiceOf(clientById.get(j.client_id)))) return false;
      if (!has(f.entity, clientById.get(j.client_id)?.entity)) return false;
      if (f.fy || f.quarter) {
        const pf = periodFY(j.period);
        if (f.fy && !pf.fys.some((y) => f.fy.split(",").includes(String(y)))) return false;
        const yearly = ["itr", "ctr", "trust", "partnership", "smsf"].includes(j.service) ? "TAX" : j.service === "fbt" ? "FBT" : j.service === "bas" || /annual gst/i.test(j.period) ? "GST" : "A";
        if (f.quarter && !has(f.quarter, pf.q ? String(pf.q) : yearly)) return false;
      }
      if (q) {
        const hay = [clientById.get(j.client_id)?.name, j.period, j.notes, svcLabel(j.service), profileById.get(j.assignee_id ?? "")?.full_name].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || (clientById.get(a.client_id)?.name ?? "").localeCompare(clientById.get(b.client_id)?.name ?? ""));
  }, [jf, jobs, openJobs, clientById, profileById, links, flags]);

  function JobsView() {
    const set = (k: keyof JobFilter) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setJf({ ...jf, [k]: e.target.value });
    const sortVal = (j: Job): string => {
      switch (jsort.k) {
        case "client": return clientName(j.client_id).toLowerCase();
        case "service": return svcLabel(j.service).toLowerCase();
        case "period": { const pf = periodFY(j.period); return `${pf.fys[0] ?? 0}-${pf.q ?? 9}-${j.period}`; }
        case "assigned": return (personName(j.assignee_id) || "\uffff").toLowerCase();
        case "status": return String(STATUSES.findIndex((s) => s.id === j.status)).padStart(2, "0");
        default: return j.due_date ?? "9999";
      }
    };
    const list = jsort.k === "due" && jsort.dir === 1 ? filteredJobs
      : [...filteredJobs].sort((a, b) => sortVal(a).localeCompare(sortVal(b), undefined, { numeric: true }) * jsort.dir || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
    const shown = list.slice(0, 500);
    const filtered = JSON.stringify(jf) !== JSON.stringify(NO_FILTER);
    const H = ({ k, children }: { k: string; children: React.ReactNode }) => (
      <th aria-sort={jsort.k === k ? (jsort.dir === 1 ? "ascending" : "descending") : undefined}>
        <button type="button" className={`sorth${jsort.k === k ? " on" : ""}`} onClick={() => setJsort(jsort.k === k ? { k, dir: jsort.dir === 1 ? -1 : 1 } : { k, dir: 1 })}>
          {children}<span className="arrow">{jsort.k === k ? (jsort.dir === 1 ? "▲" : "▼") : "↕"}</span></button></th>
    );
    return (
      <>
        <div className="pagehead">
          <div><h1>Jobs <span className="pill info" style={{ fontSize: 13, verticalAlign: "middle" }}>{openJobs.length.toLocaleString()} open</span></h1><p>{me.role === "staff" ? "Your jobs, plus unassigned jobs you can pick up with Take it." : "Every job in the practice. Team leaders see their own team's jobs. Staff see only their own."}</p></div>
          <div className="row"><button onClick={() => exportCsv(list)}>Export CSV</button><button onClick={() => setModal({ kind: "bulk" })}>Create jobs for a period</button><button className="primary" onClick={() => setModal({ kind: "job" })}>New job</button></div>
        </div>
        <div className="quickpills">{(me.role === "staff" ? [
          ["My open jobs", { assignee: me.id }, openJobs.filter((j) => j.assignee_id === me.id).length, ""],
          ["Overdue", { due: "overdue" }, openJobs.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length, "hot"],
          ["Unassigned I can take", { assignee: "__none" }, openJobs.filter((j) => !FINISHED.has(j.status) && (!j.assignee_id || !profileById.get(j.assignee_id)?.active)).length, ""],
          ["Ready for review or signing", { status: "review_any" }, openJobs.filter((j) => j.status === "review" || j.status === "to_lodge").length, ""],
          ["Internal queries", { status: "internal_query" }, openJobs.filter((j) => j.status === "internal_query").length, "hot"],
        ] as [string, Partial<JobFilter>, number, string][] : [
          ["All open", { status: "open" }, openJobs.length, ""],
          ["ATO & SGC", { service: "ato_payment,sgc,ato_comm" }, openJobs.filter((j) => ["ato_payment", "sgc", "ato_comm"].includes(j.service)).length, ""],
          ["Overdue", { due: "overdue" }, openJobs.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length, "hot"],
          ["Unassigned", { assignee: "__none" }, openJobs.filter((j) => !FINISHED.has(j.status) && (!j.assignee_id || !profileById.get(j.assignee_id)?.active)).length, ""],
          ["Waiting for review", { status: "review" }, openJobs.filter((j) => j.status === "review").length, ""],
          ["Open queries", { status: "internal_query" }, openJobs.filter((j) => j.status === "internal_query").length, "hot"],
          ["Open review notes", { status: "has_notes" }, openJobs.filter((j) => flags.get(j.id)?.rn).length, "hot"],
          ["Lodged this month", { status: "lodged" }, jobs.filter((j) => (j.lodged_on ?? "").startsWith(todayISO().slice(0, 7))).length, ""],
        ] as [string, Partial<JobFilter>, number, string][]).map(([l, f, n, hot]) => { const on = JSON.stringify({ ...NO_FILTER, ...f }) === JSON.stringify(jf); return (
          <button key={l} type="button" className={on ? "on" : undefined} onClick={() => setJf({ ...NO_FILTER, ...f })}>{l} <i className={hot && n ? "hot" : undefined}>{n}</i></button>); })}</div>
        <div className="toolbar">
          <input type="search" id="jf-q" style={{ minWidth: 240 }} placeholder="Search client, period or notes" aria-label="Search jobs" value={jf.q} onChange={set("q")} />
          <MultiPick id="jf-service" all="All services" value={jf.service} onChange={(v) => setJf({ ...jf, service: v })} options={SERVICES.map((s) => ({ v: s.id, l: s.label }))} />
          <MultiPick id="jf-fy" all="Any financial year" value={jf.fy} onChange={(v) => setJf({ ...jf, fy: v })} options={jobFYs.map((y) => ({ v: String(y), l: `FY${y} (Jul ${y - 1} – Jun ${y})`, short: `FY${y}` }))} />
          <MultiPick id="jf-quarter" all="Any quarter or yearly" value={jf.quarter} onChange={(v) => setJf({ ...jf, quarter: v })} options={[...[1, 2, 3, 4].map((q) => ({ v: String(q), l: `Q${q} (${["Jul–Sep", "Oct–Dec", "Jan–Mar", "Apr–Jun"][q - 1]})`, short: `Q${q}` })), { v: "TAX", l: "Tax returns", short: "Tax returns" }, { v: "GST", l: "Annual GST", short: "Annual GST" }, { v: "FBT", l: "FBT", short: "FBT" }, { v: "A", l: "Other yearly work", short: "Other yearly" }]} />
          <MultiPick id="jf-entity" all="All entity types" value={jf.entity} onChange={(v) => setJf({ ...jf, entity: v })} options={ENTITIES.map((x) => ({ v: x, l: x === "SMSF" ? "Super fund (SMSF)" : x }))} />
          <MultiPick id="jf-practice" all="All practices" value={jf.practice} onChange={(v) => setJf({ ...jf, practice: v })} options={PRACTICES.map((p) => ({ v: p, l: p }))} />
          <select id="jf-status" aria-label="Status" value={jf.status} onChange={set("status")}>
            <option value="open">All open jobs</option><option value="review_any">Ready for review or signing</option>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            <option value="">Everything</option>
          </select>
          <select id="jf-due" aria-label="Due" value={jf.due} onChange={set("due")}>
            {[["", "Any due date"], ["overdue", "Overdue"], ["week", "Due in 7 days"], ["week_or_overdue", "Overdue or due in 7 days"], ["month", "Due in 30 days"], ["nodate", "No due date"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select id="jf-assignee" aria-label="Assigned to" value={jf.assignee} onChange={set("assignee")}>{me.role === "staff"
            ? <><option value="">Mine and unassigned</option><option value="__none">Unassigned</option></>
            : <><option value="">Anyone</option><option value="__none">Unassigned</option>{team.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</>}</select>
          <ClientPicker id="jf-client" clients={clients} value={jf.client} emptyLabel="All clients" onChange={(id) => setJf({ ...jf, client: id })} style={{ minWidth: 200 }} />
          {jf.client && links.some((l) => l.client_id === jf.client || l.related_id === jf.client) ? <label className="chip" style={{ whiteSpace: "nowrap" }}><input type="checkbox" id="jf-group" checked={!!jf.group} onChange={(e) => setJf({ ...jf, group: e.target.checked ? "1" : "" })} /> With related clients</label> : null}
          <button onClick={() => { setJf(NO_FILTER); setJsort({ k: "due", dir: 1 }); }}>Clear</button>
          <span className="clientcount"><strong>{list.length.toLocaleString()}</strong> {filtered ? "matching " : ""}job{list.length === 1 ? "" : "s"}</span>
        </div>
        <div className="tablebox">
          {!list.length ? (
            <div className="empty"><strong>{jobs.length ? "No jobs match these filters." : "No jobs yet."}</strong>{jobs.length ? "Clear a filter to see more." : "Use New job for one-off work, or Create jobs for a period to set up a whole quarter of BAS at once."}</div>
          ) : (
            <>
              <table className="jobtable"><thead><tr>{canManage ? <th className="tick"><input type="checkbox" aria-label="Tick all shown" checked={shown.length > 0 && shown.every((j) => jsel.has(j.id))} onChange={(e) => setJsel(e.target.checked ? new Set(shown.map((j) => j.id)) : new Set())} /></th> : null}<H k="client">Client · practice</H><H k="service">Job</H><th>Stage</th><H k="assigned">Assigned</H><th>Reviewer</th><H k="due">Due / time left</H><H k="status">Status</H><th>Priority</th><th></th></tr></thead>
                <tbody>{shown.map((j) => { const c = clientById.get(j.client_id); const fl = flags.get(j.id); return (
                  <tr key={j.id} className={jsel.has(j.id) ? "picked" : undefined}>
                    {canManage ? <td className="tick"><input type="checkbox" aria-label={`Tick ${clientName(j.client_id)} ${svcLabel(j.service)} ${j.period}`} checked={jsel.has(j.id)} onChange={(e) => { const n = new Set(jsel); if (e.target.checked) n.add(j.id); else n.delete(j.id); setJsel(n); }} /></td> : null}
                    <td className="client"><button className="link" style={{ color: "var(--fg)" }} onClick={() => openClient(j.client_id)}>{clientName(j.client_id)}</button><div className="note">{practiceOf(c)}{c?.entity ? ` · ${c.entity}` : ""}</div></td>
                    <td><button className="link jobname" onClick={() => openJob(j)}>{svcLabel(j.service)} · {j.period}</button>
                      {j.service === "company_formation" || fl?.q || fl?.rn || fl?.f ? <div className="jflags">
                        {j.service === "company_formation" ? <span className="jf new">New company</span> : null}
                        {fl?.q ? <span className="jf q">{fl.q} quer{fl.q === 1 ? "y" : "ies"}</span> : null}
                        {fl?.rn ? <span className="jf rn">{fl.rn} review note{fl.rn === 1 ? "" : "s"}</span> : null}
                        {fl?.f ? <span className="jf f" title={`${fl.f} file${fl.f === 1 ? "" : "s"}`}>📎 {fl.f}</span> : null}
                      </div> : null}</td>
                    <td><Stage j={j} /></td>
                    <td title={personName(j.assignee_id)}>{personName(j.assignee_id).split(" ")[0] || (me.role === "staff" && isOpen(j.status) ? <button type="button" title="Make this job yours" onClick={() => save(() => supabase.from("jobs").update({ assignee_id: me.id }).eq("id", j.id), "The job is yours. It's in My tasks now")}>Take it</button> : <span className="muted">Unassigned</span>)}</td>
                    <td title={personName(j.reviewer_id)}>{personName(j.reviewer_id).split(" ")[0] || <span className="muted">—</span>}</td>
                    <td><TimeLeft j={j} /></td>
                    <td><StatusSelect j={j} /></td>
                    <td>{j.priority === "high" ? <span className="pill danger">High</span> : null}</td>
                    <td><button onClick={() => openJob(j)}>{closedFor(j) ? "View" : "Open"}</button></td>
                  </tr>); })}</tbody></table>
              {canManage && jsel.size ? <div className="bulkbar">
                <strong>{jsel.size} selected</strong>
                <label>Assign to<select id="bk-assignee" value={bulk.assignee} onChange={(e) => setBulk({ ...bulk, assignee: e.target.value })}><option value="">Choose…</option><option value="__none">Nobody</option>{team.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label>
                <label>Reviewer<select id="bk-reviewer" value={bulk.reviewer} onChange={(e) => setBulk({ ...bulk, reviewer: e.target.value })}><option value="">Choose…</option><option value="__none">Nobody</option>{team.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label>
                <label>Status<select id="bk-status" value={bulk.status} onChange={(e) => setBulk({ ...bulk, status: e.target.value })}><option value="">Choose…</option>{STATUSES.filter((x) => isMaster || x.open).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
                <label>Due date<input id="bk-due" type="date" value={bulk.due} onChange={(e) => setBulk({ ...bulk, due: e.target.value })} /></label>
                <span style={{ flex: 1 }} />
                <button type="button" className="link" style={{ color: "#fff" }} onClick={() => setJsel(new Set())}>Clear</button>
                <button type="button" className="primary" disabled={!bulk.assignee && !bulk.reviewer && !bulk.status && !bulk.due} onClick={async () => {
                  const patch: Record<string, unknown> = {};
                  if (bulk.assignee) patch.assignee_id = bulk.assignee === "__none" ? null : bulk.assignee;
                  if (bulk.reviewer) patch.reviewer_id = bulk.reviewer === "__none" ? null : bulk.reviewer;
                  if (bulk.status) patch.status = bulk.status;
                  if (bulk.due) patch.due_date = bulk.due;
                  const ids = [...jsel].filter((id) => { const j = jobs.find((x) => x.id === id); return j && !closedFor(j); });
                  if (!ids.length) { say("Only a master admin can change lodged or completed jobs", true); return; }
                  if (await save(() => supabase.from("jobs").update(patch).in("id", ids), `${ids.length} job${ids.length === 1 ? "" : "s"} updated`)) { setJsel(new Set()); setBulk({ assignee: "", reviewer: "", status: "", due: "" }); }
                }}>Apply to {jsel.size} job{jsel.size === 1 ? "" : "s"}</button>
              </div> : null}
              <div className="count">{list.length} job{list.length === 1 ? "" : "s"}{list.length > 500 ? " · showing the first 500, narrow the filters to see the rest" : ""}</div>
            </>
          )}
        </div>
        <div className="panel newtypes">
          <div className="ph"><h2>New job types</h2><span className="note">Choose them in New job. Each comes with its own checklist.</span></div>
          <div className="ntgrid">{([["ato_payment", "🏦", "Help a client pay the ATO: the amount, how and by when."], ["sgc", "🧾", "Late or missed super: work out the charge and lodge the statement."], ["ato_comm", "✉️", "An ATO letter or portal message that needs action."], ["company_formation", "🏢", "Set up a new company from start to handover."]] as [string, string, string][]).map(([id, icon, blurb]) => (
            <div key={id} className="nt"><strong>{icon} {svcLabel(id)}</strong><p className="note">{blurb}</p>
              <ol>{(STEPS[id] ? STEPS[id].map((x) => x.title) : CHECKLISTS[id] ?? []).map((x) => <li key={x}>{x}</li>)}</ol>
              <button type="button" className="link" onClick={() => setModal({ kind: "job", service: id })}>+ Start one in New job</button></div>))}</div>
        </div>
        <p className="note" style={{ margin: "10px 2px 0" }}>Stage bar: green = done, blue = current (Preparation → Review → Signing → Lodge). Flags show open internal queries, review notes and file counts. Click a job to open its job page.</p>
      </>
    );
  }

  function ClientsView() {
    const q = cq.trim().toLowerCase();
    const qd = q.replace(/\s+/g, "");
    const list = clients.filter((c) => (!cpractice || practiceOf(c) === cpractice) && (!cservice || c.services.includes(cservice)) && (!centity.length || centity.includes(c.entity))
      && (!q || [c.name, c.abn, c.contact, c.email, c.phone, c.address ?? ""].join(" ").toLowerCase().includes(q) || (qd.length >= 4 && /^\d+$/.test(qd) && [c.abn, c.phone].join(" ").replace(/\s+/g, "").includes(qd))));
    const show = (id: string) => ccols.includes(id);
    const filtered = !!(q || cpractice || cservice || centity.length);
    const linkCount = new Map<string, number>();
    links.forEach((l) => { linkCount.set(l.client_id, (linkCount.get(l.client_id) ?? 0) + 1); linkCount.set(l.related_id, (linkCount.get(l.related_id) ?? 0) + 1); });
    const openBy = new Map<string, Job[]>();
    openJobs.forEach((j) => openBy.set(j.client_id, [...(openBy.get(j.client_id) ?? []), j]));
    const QUICK: [string, string, (c: Client) => boolean][] = [
      ["", "All clients", () => true],
      ["overdue", "With overdue work", (c) => (openBy.get(c.id) ?? []).some((j) => j.due_date && daysFrom(j.due_date) < 0)],
      ["waiting", "Waiting on client", (c) => (openBy.get(c.id) ?? []).some((j) => j.status === "waiting" || j.status === "client_query" || j.status === "sent_for_sign")],
      ["related", "Related groups", (c) => !!linkCount.get(c.id)],
      ["nojobs", "No open jobs", (c) => !(openBy.get(c.id) ?? []).length],
    ];
    const qf = QUICK.find((x) => x[0] === cquick)?.[2] ?? (() => true);
    const base = list;
    const shownC = base.filter(qf);
    const nextDue = (c: Client) => (openBy.get(c.id) ?? []).filter((j) => j.due_date).sort((a, b) => a.due_date!.localeCompare(b.due_date!))[0];
    function exportClients() {
      const q = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const rows = [["Client", "Practice", "Entity", "ABN", "Contact", "Email", "Phone", "Services", "Manager", "Open jobs"], ...shownC.map((c) => [c.name, practiceOf(c), c.entity, c.abn, c.contact, c.email, c.phone, c.services.map(svcLabel).join("; "), personName(c.manager_id), (openBy.get(c.id) ?? []).length])];
      const blob = new Blob(["\ufeff" + rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `supertax-clients-${todayISO()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    return (
      <>
        <div className="pagehead"><div><h1>Clients <span className="pill info" style={{ fontSize: 13, verticalAlign: "middle" }}>{clients.length.toLocaleString()}</span></h1><p>Who you act for, what you do for them, and what&apos;s open right now.</p></div><div className="row"><button onClick={exportClients} disabled={!shownC.length}>⬇ Export</button>{canManage ? <button onClick={() => setModal({ kind: "import" })}>Import from CSV or Excel</button> : null}<button className="primary" onClick={() => setModal({ kind: "client" })}>Add client</button></div></div>
        <div className="quickpills">{QUICK.map(([k, l, f]) => { const n = base.filter(f).length; return <button key={k || "all"} type="button" className={cquick === k ? "on" : undefined} onClick={() => setCquick(k)}>{l} <i className={k === "overdue" && n ? "hot" : undefined}>{n.toLocaleString()}</i></button>; })}</div>
        <div className="toolbar">
          <input type="search" id="cq" placeholder="Search name, ABN, contact, email, phone or address" aria-label="Search clients" value={cq} onChange={(e) => setCq(e.target.value)} />
          <select id="cpractice" aria-label="Practice" value={cpractice} onChange={(e) => setCpractice(e.target.value)}><option value="">All practices</option>{PRACTICES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          <select id="cservice" aria-label="Service" value={cservice} onChange={(e) => setCservice(e.target.value)}><option value="">Any service</option>{SERVICES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        <details className="colpick"><summary>Columns</summary><div className="colmenu">
            {CLIENT_COLS.map((col) => <label key={col.id}><input type="checkbox" checked={show(col.id)} onChange={(e) => setCcols(e.target.checked ? CLIENT_COLS.map((x) => x.id).filter((x) => x === col.id || ccols.includes(x)) : ccols.filter((x) => x !== col.id))} /> {col.label}</label>)}
            <button type="button" className="link" onClick={() => setCcols(DEFAULT_CLIENT_COLS)}>Reset to default</button>
          </div></details>
          {filtered || cquick ? <button onClick={() => { setCq(""); setCpractice(""); setCservice(""); setCentity([]); setCquick(""); }}>Clear</button> : null}
          <span className="clientcount"><strong>{list.length.toLocaleString()}</strong> {filtered ? `of ${clients.length.toLocaleString()} ` : ""}client{list.length === 1 ? "" : "s"}</span>
        </div>
        <div className="toolbar entity-filter" role="group" aria-label="Show entity types" style={{ borderRadius: 0, borderTop: "1px solid var(--line)", gap: 6 }}>
          <span className="note" style={{ marginRight: 4 }}>Show:</span>
          {ENTITIES.map((x) => { const on = centity.includes(x); return (
            <label key={x} className={`chip${on ? " on" : ""}`}><input type="checkbox" checked={on} onChange={() => setCentity(on ? centity.filter((y) => y !== x) : [...centity, x])} /> {x === "SMSF" ? "Super fund (SMSF)" : x}</label>); })}
          {centity.length ? <button type="button" className="link" onClick={() => setCentity([])}>Show all</button> : <span className="note">All types shown. Tick to narrow down.</span>}
        </div>
        <div className="tablebox dragscroll" id="clients-table">
          {!shownC.length ? <div className="empty"><strong>{clients.length ? "No clients match." : "No clients yet."}</strong>{clients.length ? "Try another search." : "Add your first client, then tick the services you do for them."}</div> : (
            <>
              <table className="clienttable"><thead><tr><th>Client</th>{CLIENT_COLS.filter((col) => show(col.id)).map((col) => <th key={col.id} style={col.id === "open" ? { textAlign: "right" } : undefined}>{col.label}</th>)}<th>Next due</th><th></th></tr></thead>
                <tbody>{shownC.map((c) => { const oj = openBy.get(c.id) ?? []; const od = oj.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length; return (
                  <tr key={c.id}><td className="client"><button className="link clip" style={{ color: "var(--fg)", fontWeight: 700 }} title={c.name} onClick={() => openClient(c.id)}>{c.name}</button>{linkCount.get(c.id) ? <span className="linkmark" title={`Linked to ${linkCount.get(c.id)} related client${linkCount.get(c.id) === 1 ? "" : "s"}`}>🔗 {linkCount.get(c.id)}</span> : null}<div className="note clip">{c.entity}{c.abn ? ` · ABN ${c.abn}` : ""}</div></td>
                    {show("practice") ? <td>{practiceOf(c)}</td> : null}
                    {show("entity") ? <td>{c.entity}</td> : null}
                    {show("abn") ? <td className="mono nowrap">{c.abn}</td> : null}
                    {show("contact") ? <td><span className="clip w-contact" title={c.contact}>{c.contact}</span></td> : null}
                    {show("email") ? <td><span className="clip w-email" title={c.email}>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : null}</span></td> : null}
                    {show("phone") ? <td className="mono nowrap">{c.phone}</td> : null}
                    {show("address") ? <td><span className="clip w-address" title={c.address ?? ""}>{c.address}</span></td> : null}
                    {show("services") ? <td><span className="clip w-svc" title={c.services.map(svcLabel).join(", ")}>{c.services.map((s) => <span key={s} className="tag">{svcLabel(s)}{s === "bas" && c.bas_freq !== "quarterly" ? ` (${c.bas_freq})` : ""}{s === "payroll" && c.payroll_freq ? ` (${c.payroll_freq})` : ""}</span>)}</span></td> : null}
                    {show("manager") ? <td className="nowrap">{personName(c.manager_id)}</td> : null}
                    {show("open") ? <td className="mono" style={{ textAlign: "right" }}>{oj.length}{od ? <> <span className="pill danger">{od} overdue</span></> : null}</td> : null}
                    <td>{(() => { const nj = nextDue(c); if (!nj) return <div className="tleft ok"><b>{oj.length ? "No due date" : "No open jobs"}</b></div>; const d = daysFrom(nj.due_date!); return <div className={`tleft ${d < 0 ? "danger" : d <= 7 ? "warn" : "ok"}`}><b>{fmtDate(nj.due_date).replace(/ \d{4}$/, "")} · {d < 0 ? `${-d} days over` : d === 0 ? "today" : `${d} days`}</b></div>; })()}</td>
                    <td><button type="button" onClick={() => openClient(c.id)}>Open</button></td></tr>); })}</tbody></table>
              <div className="count row" style={{ justifyContent: "space-between" }}><span>Showing {shownC.length.toLocaleString()} of {clients.length.toLocaleString()} · 🔗 related clients</span>
                {ccols.length > 6 ? <span className="scrollhint">Drag the table sideways to see more columns
                  <button type="button" aria-label="Scroll left" onClick={() => document.getElementById("clients-table")?.scrollBy({ left: -400, behavior: "smooth" })}>◀</button>
                  <button type="button" aria-label="Scroll right" onClick={() => document.getElementById("clients-table")?.scrollBy({ left: 400, behavior: "smooth" })}>▶</button></span> : null}</div>
            </>
          )}
        </div>
      </>
    );
  }

  function ClientDetail({ c }: { c: Client }) {
    const js = jobs.filter((j) => j.client_id === c.id).sort((a, b) => (b.due_date ?? "").localeCompare(a.due_date ?? ""));
    const openJ = js.filter((j) => isOpen(j.status)), closedJ = js.filter((j) => !isOpen(j.status));
    const upcoming = clientUpcoming(c, js);
    const group = clientGroup(c.id, links);
    const groupJobs = group.size > 1 ? openJobs.filter((j) => group.has(j.client_id)).sort((a, b) => clientName(a.client_id).localeCompare(clientName(b.client_id)) || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999")) : [];
    const picked = groupJobs.filter((j) => gsel.has(j.id));
    const allPicked = groupJobs.length > 0 && picked.length === groupJobs.length;
    const Table = ({ list }: { list: Job[] }) => (
      <table className="jobtable"><thead><tr><th>Job</th><th>Stage</th><th>Assigned</th><th>Reviewer</th><th>Due / time left</th><th>Status</th><th></th></tr></thead>
        <tbody>{list.map((j) => { const fl = flags.get(j.id); return (
          <tr key={j.id}><td><button className="link jobname" onClick={() => openJob(j)}>{svcLabel(j.service)} · {j.period}</button>
            {j.priority === "high" || fl?.q || fl?.rn ? <div className="jflags">{j.priority === "high" ? <span className="pill danger">High</span> : null}{fl?.q ? <span className="jf q">{fl.q} quer{fl.q === 1 ? "y" : "ies"}</span> : null}{fl?.rn ? <span className="jf rn">{fl.rn} review note{fl.rn === 1 ? "" : "s"}</span> : null}</div> : null}</td>
            <td><Stage j={j} /></td><td title={personName(j.assignee_id)}>{personName(j.assignee_id).split(" ")[0] || <span className="muted">Unassigned</span>}</td><td title={personName(j.reviewer_id)}>{personName(j.reviewer_id).split(" ")[0] || <span className="muted">—</span>}</td>
            <td><TimeLeft j={j} /></td><td><StatusSelect j={j} /></td><td><button onClick={() => openJob(j)}>{closedFor(j) ? "View" : "Open"}</button></td></tr>); })}</tbody></table>
    );
    const od = openJ.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length;
    const waitingN = openJ.filter((j) => j.status === "waiting" || j.status === "client_query" || j.status === "sent_for_sign").length;
    const freq = (sv: string) => sv === "bas" ? (c.bas_freq === "monthly" ? " · monthly" : c.bas_freq === "annual" ? " · annually" : " · quarterly") : sv === "payroll" && c.payroll_freq ? ` · ${c.payroll_freq}` : "";
    const go2 = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    const showClosed = () => { const d = document.getElementById("cl-closed") as HTMLDetailsElement | null; if (d) d.open = true; go2("cl-closed"); };
    const yearH = js.reduce((t, j) => t + (jobHours[j.id] ?? 0), 0);
    const fy = currentFY();
    const fyStart = `${fy - 1}-07-01`, fyEnd = `${fy}-06-30`;
    const lodgedFY = closedJ.filter((j) => (j.lodged_on ?? "") >= fyStart && (j.lodged_on ?? "") <= fyEnd).length;
    const sumFlag = (k: "q" | "rn" | "f") => js.reduce((t, j) => t + (flags.get(j.id)?.[k] ?? 0), 0);
    return (
      <>
        <div className="crumb"><button type="button" className="link" onClick={() => setClientId(null)}>← Clients</button> / Client page</div>
        <div className="jobhero">
          <h1>{c.name} <span>· {c.entity}</span></h1>
          <div className="facts">
            {c.abn ? <span>ABN <b className="mono">{c.abn}</b></span> : null}<span>Practice <b>{practiceOf(c)}</b></span><span>Manager <b>{personName(c.manager_id) || "—"}</b></span>
            {c.contact ? <span>Contact <b>{c.contact}</b></span> : null}{c.phone ? <span>📞 <b>{c.phone}</b></span> : null}{c.email ? <span>✉ <b><a href={`mailto:${c.email}`}>{c.email}</a></b></span> : null}
          </div>
          {c.services.length ? <div className="row" style={{ marginTop: 10 }}>{c.services.map((sv) => <span key={sv} className="chip">{svcLabel(sv)}{freq(sv)}</span>)}</div> : null}
          <div className="row" style={{ marginTop: 12 }}><button onClick={() => setModal({ kind: "client", client: c })}>✎ Edit client</button><button className="primary" onClick={() => setModal({ kind: "job", clientId: c.id })}>+ New job for this client</button></div>
          <div className="counts">
            <button type="button" className="count" onClick={() => go2("cl-work")}>Open jobs <i className="blue">{openJ.length}</i></button>
            <button type="button" className="count" onClick={() => go2("cl-work")}>Overdue <i className={od ? "red" : ""}>{od}</i></button>
            <button type="button" className="count" onClick={() => go2("cl-work")}>Waiting on client <i className={waitingN ? "amber" : ""}>{waitingN}</i></button>
            <button type="button" className="count" onClick={() => go2("cl-related")}>Related clients <i className="blue">{Math.max(0, group.size - 1)}</i></button>
            <span className="count">Time on jobs <i className="dark">{fmtHours(yearH)}</i></span>
            <button type="button" className="count" onClick={showClosed}>Lodged FY{String(fy).slice(2)} <i className="green">{lodgedFY}</i></button>
            <span style={{ flex: 1 }} />
            {c.email ? <a className="btnlink" href={`mailto:${c.email}`}>✉ Email client</a> : null}
            <span className="count">📎 All files <i className="blue">{sumFlag("f")}</i></span>
          </div>
        </div>
        <div className="jobgrid">
          <div className="jobmain">
            <div className="panel" id="cl-work">
              <div className="ph"><h2>Work for this client</h2><span className="note">Open jobs, what stage they&apos;re at, who has them</span></div>
              {openJ.length ? <div style={{ overflowX: "auto" }}><Table list={openJ} /></div> : <div className="empty">No open jobs for this client.</div>}
              <div className="note row" style={{ padding: "10px 14px", borderTop: "1px solid var(--line)", justifyContent: "space-between" }}>
                <span>{upcoming.length ? <><strong style={{ color: "var(--fg)" }}>Coming up automatically:</strong> {upcoming.slice(0, 4).map((u) => `${svcLabel(u.service)} ${u.period} on ${fmtDate(u.appears)}`).join(" · ")}</> : null}</span>
                <button type="button" className="link" onClick={showClosed}>Lodged and completed ({closedJ.length}) ▸</button></div>
            </div>
            <div id="cl-related"><RelatedClients key={`rel-${c.id}`} client={c} clients={clients} links={links} supabase={supabase} say={say} missing={linksMissing} onOpen={openClient} onChanged={load} /></div>
            {group.size > 1 ? <div id="group-work" className="panel"><div className="ph"><h2>Whole group: {groupJobs.length} open job{groupJobs.length === 1 ? "" : "s"} across {group.size} clients</h2></div>
              <div>
                {canManage && groupJobs.length ? <div className="toolbar groupbar">
                  <span className="note"><strong>{picked.length}</strong> ticked</span>
                  <select id="group-status" aria-label="New status for ticked jobs" value={gstatus} onChange={(e) => setGstatus(e.target.value)}>
                    <option value="">Change status to…</option>
                    {STATUSES.filter((s) => s.id !== "internal_query").map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                  <button type="button" className="primary" disabled={!picked.length || !gstatus} onClick={() => applyGroupStatus(picked)}>Apply to ticked jobs</button>
                  <button type="button" onClick={() => gotoJobs({ client: c.id, group: "1" })}>Open in Jobs</button>
                </div> : null}
                {groupJobs.length ? <div style={{ overflowX: "auto" }}><table><thead><tr>
                  {canManage ? <th style={{ width: 32 }}><input type="checkbox" aria-label="Tick all" checked={allPicked} onChange={() => setGsel(allPicked ? new Set() : new Set(groupJobs.map((j) => j.id)))} /></th> : null}
                  <th>Client</th><th>Job</th><th>Due</th><th>Assigned</th><th>Status</th><th></th></tr></thead>
                  <tbody>{groupJobs.map((j) => <tr key={j.id}>
                    {canManage ? <td><input type="checkbox" aria-label={`Tick ${clientName(j.client_id)} ${svcLabel(j.service)} ${j.period}`} checked={gsel.has(j.id)} onChange={() => { const n = new Set(gsel); if (n.has(j.id)) n.delete(j.id); else n.add(j.id); setGsel(n); }} /></td> : null}
                    <td>{j.client_id === c.id ? <strong>{clientName(j.client_id)}</strong> : <button className="link" onClick={() => openClient(j.client_id)}>{clientName(j.client_id)}</button>}</td>
                    <td>{svcLabel(j.service)} · {j.period}</td><td><TimeLeft j={j} /></td>
                    <td>{personName(j.assignee_id) || <span className="muted">Unassigned</span>}</td><td><StatusSelect j={j} /></td>
                    <td><button onClick={() => openJob(j)}>Open</button></td></tr>)}</tbody></table></div>
                  : <div className="empty">No pending work for anyone in this group.</div>}
              </div></div> : null}
            <ClientNotes key={c.id} clientId={c.id} meId={me.id} isManager={canManage} canDelete={canDelete} supabase={supabase} personName={personName} say={say} />
            <details className="panel" id="cl-closed"><summary className="ph" style={{ cursor: "pointer" }}><h2 style={{ display: "inline" }}>Lodged and completed ({closedJ.length})</h2></summary>
              {closedJ.length ? <div style={{ overflowX: "auto" }}><Table list={closedJ} /></div> : <div className="empty">Nothing lodged yet.</div>}</details>
          </div>
          <aside className="jobside">
            {canManage || me.can_see_mgmt_notes ? <ClientNotes key={`m-${c.id}`} mgmt clientId={c.id} meId={me.id} isManager={canManage} canDelete={false} supabase={supabase} personName={personName} say={say} /> : null}
            <div className="panel"><div className="ph"><h2>Contact</h2></div>
              <dl className="people"><dt>Contact</dt><dd>{c.contact || "—"}</dd><dt>Phone</dt><dd>{c.phone || "—"}</dd><dt>Email</dt><dd style={{ overflowWrap: "anywhere" }}>{c.email || "—"}</dd><dt>Address</dt><dd>{c.address || "—"}</dd></dl></div>
            <div className="panel"><div className="ph"><h2>Summary</h2></div>
              <ul className="actions summary">
                <li><span>🕘 Time on this client&apos;s jobs</span><b>{fmtHours(yearH)}</b></li>
                <li><span>📎 Files across all jobs</span><b>{sumFlag("f")}</b></li>
                <li><span>⚠️ Open review notes</span><b className={sumFlag("rn") ? "red" : ""}>{sumFlag("rn")}</b></li>
                <li><span>❓ Open internal queries</span><b className={sumFlag("q") ? "red" : ""}>{sumFlag("q")}</b></li>
              </ul></div>
            <div className="panel"><div className="ph"><h2>Other actions</h2></div>
              <ul className="actions">
                <li><button type="button" className="link" onClick={() => setModal({ kind: "client", client: c })}>✎ Edit client details</button></li>
                {canManage ? <li><button type="button" className="link" onClick={() => setModal({ kind: "client", client: c })}>⇄ Change manager</button></li> : null}
                <li><button type="button" className="link" onClick={() => gotoJobs({ client: c.id, status: "" })}>🗂 All jobs for this client</button></li>
                {canDelete ? <li><button type="button" className="link" style={{ color: "var(--danger)" }} onClick={() => setModal({ kind: "client", client: c })}>🗑 Delete client (in Edit client)</button></li> : null}
              </ul></div>
            <div className="panel"><div className="ph"><h2>Details</h2></div>
              <dl className="people">
                {c.services.includes("payroll") ? <><dt>Payroll</dt><dd>{c.payroll_freq ? `${c.payroll_freq[0].toUpperCase()}${c.payroll_freq.slice(1)}, automatic` : "No automatic jobs"}</dd></> : null}
                {c.services.some((sv) => SVC[sv]?.kind === "bas") ? <><dt>BAS cycle</dt><dd>{c.bas_freq === "monthly" ? "Monthly" : c.bas_freq === "annual" ? "Annually" : "Quarterly"}</dd></> : null}
                <dt>Last change</dt><dd>{fmtDate(c.updated_at)}{c.updated_by ? ` · ${personName(c.updated_by)}` : ""}</dd></dl>
              {c.notes ? <div style={{ padding: "0 14px 14px", whiteSpace: "pre-wrap" }} className="note">{c.notes}</div> : null}</div>
          </aside>
        </div>
      </>
    );
  }

  function TeamView() {
    const sorted = [...profiles].sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id) || Number(b.active) - Number(a.active) || a.full_name.localeCompare(b.full_name));
    const runningBy = new Map(teamRunning.map((t) => [t.user_id, t]));
    const leaders = profiles.filter((p) => p.active && p.role === "manager" && profiles.some((x) => x.reports_to === p.id));
    const openOf = (id: string) => openJobs.filter((j) => j.assignee_id === id);
    const maxOpen = Math.max(1, ...sorted.map((p) => openOf(p.id).length));
    const busiest = [...sorted].filter((p) => p.active).sort((a, b) => openOf(b.id).length - openOf(a.id).length)[0];
    const FILTERS: [string, string, (p: Profile) => boolean][] = [
      ["", "Everyone", () => true],
      ...leaders.map((l) => [l.id, `${l.full_name.split(" ")[0]}'s team`, (p: Profile) => p.id === l.id || p.reports_to === l.id] as [string, string, (p: Profile) => boolean]),
      ["__now", "Working now", (p: Profile) => runningBy.has(p.id)],
      ["__off", "Access off", (p: Profile) => !p.active],
    ];
    const tf = FILTERS.find((f) => f[0] === teamFilter) ?? FILTERS[0];
    const list = sorted.filter(tf[2]);
    const ini = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("").toUpperCase();
    const roleCls = (r: string) => (r === "master" ? "danger" : r === "manager" ? "warn" : "info");
    return (
      <>
        <div className="pagehead"><div><h1>Team</h1><p>Who&apos;s on the team, what they can see, and how busy they are.</p></div>
          <div className="row"><a className="btn" href="#activity-log" onClick={(e) => { e.preventDefault(); document.getElementById("activity-log")?.scrollIntoView({ behavior: "smooth" }); }}>🕘 Activity log</a><a className="btn" href="#roles" onClick={(e) => { e.preventDefault(); document.getElementById("roles")?.scrollIntoView({ behavior: "smooth" }); }}>What each role can do</a>{isMaster ? <button className="primary" onClick={() => setModal({ kind: "member" })}>+ Add team member</button> : null}</div></div>
        <div className="teamtiles">
          <div className="tt blue"><b>{sorted.filter((p) => p.active).length}</b><span>Team members</span></div>
          <div className="tt green"><b>{teamRunning.length}</b><span>Working on a job now</span></div>
          <div className="tt blue"><b>{sorted.reduce((n, p) => n + openOf(p.id).length, 0)}</b><span>Open jobs across the team</span></div>
          <div className="tt amber"><b>{busiest ? busiest.full_name.split(" ")[0] : "—"}</b><span>{busiest ? `Busiest · ${openOf(busiest.id).length} jobs, ${openOf(busiest.id).filter((j) => j.due_date && daysFrom(j.due_date) < 0).length} overdue` : "Busiest"}</span></div>
        </div>
        <div className="quickpills">{FILTERS.map(([k, l, f]) => { const n = sorted.filter(f).length; return k === "__off" && !n ? null : <button key={k || "all"} type="button" className={teamFilter === k ? "on" : undefined} onClick={() => setTeamFilter(k)}>{l} <i>{n}</i></button>; })}</div>
        <div className="teamcards">{list.map((p) => {
          const oj = openOf(p.id); const od = oj.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length;
          const t = runningBy.get(p.id); const tj = t?.job_id ? jobs.find((j) => j.id === t.job_id) : undefined;
          const canToggleDelete = (isMaster || p.reports_to === me.id) && p.active && p.role === "staff";
          const chip = (on: boolean, label: string, onClick?: () => void) => onClick
            ? <button type="button" className={`perm${on ? " on" : ""}`} onClick={onClick} title="Click to change">{on ? "✓ " : ""}{label}</button>
            : <span className={`perm${on ? " on" : ""}`}>{on ? "✓ " : ""}{label}</span>;
          return (
            <div key={p.id} className={`mcard${p.active ? "" : " off"}`}>
              <div className="mtop"><span className="av big">{ini(p.full_name)}</span><div style={{ minWidth: 0 }}><b>{p.full_name}{p.id === me.id ? <span className="note"> (you)</span> : null}</b><div className="note">{p.title || p.email}</div></div>
                <span className={`pill ${roleCls(p.role)}`} style={{ marginLeft: "auto" }}>{roleLabel(p.role)}</span></div>
              <div className={`mnow${t ? " on" : ""}`}>{!p.active ? "Access switched off" : p.must_change_password ? "Hasn't signed in yet" : t ? <>● Working now · {tj ? `${clientName(tj.client_id)} · ${svcLabel(tj.service)}` : "a job"}</> : "Not on a job right now"}</div>
              <div className="mrow"><span>Practices <b>{p.role !== "staff" || !p.practices?.length ? "All" : p.practices.join(", ")}</b></span></div>
              <div className="mrow"><span>Team leader <b>{p.role === "staff" ? personName(p.reports_to ?? null) || "—" : "—"}</b></span><span>Clients <b>{p.role !== "staff" || !p.client_types?.length ? "All" : p.client_types.join(", ")}</b></span></div>
              <div className="mrow"><span><b>{oj.length} open job{oj.length === 1 ? "" : "s"}</b></span><span style={{ color: od ? "var(--danger)" : "var(--muted)" }}>{od} overdue</span></div>
              <div className={`mbar${od >= 3 ? " red" : ""}`}><i style={{ width: `${(oj.length / maxOpen) * 100}%` }} /></div>
              <div className="perms">
                {chip(p.role !== "staff" || !!p.can_delete, "Can delete notes", canToggleDelete ? async () => { if (await adminCall(`/api/team/${p.id}/delete-access`, "PATCH", { allow: !p.can_delete })) say(p.can_delete ? `${p.full_name} can no longer delete notes` : `${p.full_name} can now delete notes and comments`); } : undefined)}
                {p.role === "staff" ? chip(!!p.can_pick_reviewer, "Chooses own reviewer") : null}
                {p.role === "staff" ? chip(!!p.can_see_mgmt_notes, "Sees management notes") : chip(true, "Sees management notes")}
                {chip(p.role === "master" || !!p.can_see_workload, "Sees team workload", isMaster && p.role !== "master" && p.active ? async () => { if (await adminCall(`/api/team/${p.id}/workload-access`, "PATCH", { allow: !p.can_see_workload })) say(p.can_see_workload ? `${p.full_name} can no longer see the team workload` : `${p.full_name} can now see the team workload`); } : undefined)}
              </div>
              <div className="row">{isMaster && p.id !== me.id ? <button onClick={() => setModal({ kind: "member", member: p })}>Edit</button> : null}<button onClick={() => gotoJobs({ assignee: p.id })}>View jobs</button></div>
            </div>); })}</div>
        {!isMaster && sorted.length <= 1 ? <p className="note">No team members are allocated to you yet. Ask for team members to be allocated to you.</p> : null}
        <div className="grid2" style={{ marginTop: 16 }}>
          <div className="panel" id="roles">
            <div className="ph"><h2>What each role can do</h2></div>
            <table className="roletable"><thead><tr><th></th><th>Staff</th><th>Team leader</th><th>Master admin</th></tr></thead>
              <tbody><tr><td>See and work on own jobs</td><td><span className="yes">✓</span></td><td><span className="yes">✓</span></td><td><span className="yes">✓</span></td></tr><tr><td>Pick up unassigned jobs</td><td><span className="yes">✓</span></td><td><span className="yes">✓</span></td><td><span className="yes">✓</span></td></tr><tr><td>See clients</td><td>Allowed types</td><td>All</td><td>All</td></tr><tr><td>Create and assign jobs</td><td><span className="muted">–</span></td><td><span className="yes">✓</span></td><td><span className="yes">✓</span></td></tr><tr><td>Review and approve jobs</td><td><span className="muted">–</span></td><td><span className="yes">✓</span></td><td><span className="yes">✓</span></td></tr><tr><td>Management notes</td><td>If allowed</td><td><span className="yes">✓</span></td><td><span className="yes">✓</span></td></tr><tr><td>Book meetings, prospects</td><td><span className="muted">–</span></td><td><span className="yes">✓</span></td><td><span className="yes">✓</span></td></tr><tr><td>Team page and permissions</td><td><span className="muted">–</span></td><td>Own team</td><td><span className="yes">✓</span></td></tr><tr><td>Delete clients and jobs</td><td><span className="muted">–</span></td><td><span className="muted">–</span></td><td><span className="yes">✓</span></td></tr></tbody></table>
            <p className="note" style={{ margin: "8px 16px 14px" }}>Click the Can delete notes or Sees team workload tags on a card to switch them, or use Edit for everything else.</p>
          </div>
          <ReviewByPerson supabase={supabase} people={sorted.filter((p) => p.active && p.role === "staff")} />
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

  async function openNotice(n: Notice) {
    if (n.kind === "sign_reminder" || n.kind === "client_query_reminder") {
      // Answered from the Reminders box on the Overview, without opening the job.
      navGo("overview");
      setTimeout(() => document.getElementById("reminders")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
      return;
    }
    if (n.job_id) {
      const j = jobs.find((x) => x.id === n.job_id);
      if (j) setModal({ kind: "job", job: j, ...(n.kind === "internal_query" || n.kind === "query_answered" ? { tab: "queries" as const } : {}) }); else say("That job has been deleted or is no longer visible to you.", true);
    } else if (n.meeting_id) {
      let m = meetings.find((x) => x.id === n.meeting_id);
      if (!m) { const { data } = await supabase.from("meetings").select("*").eq("id", n.meeting_id).maybeSingle(); m = (data as Meeting | null) ?? undefined; }
      if (m) setModal({ kind: "meeting", meeting: m }); else say("That meeting has been cancelled.", true);
    }
  }

  return (
    <Shell me={me} view={view} go={navGo} live={live} showTeam={canSeeTeam} badges={{ prospects: prospectsDue }} wide={view === "clients" && !clientId && ccols.length > 6} bell={<Bell supabase={supabase} meId={me.id} personName={personName} onOpen={openNotice} />}>
      <WorkGate supabase={supabase} meId={me.id} isStaff={me.role === "staff"} running={running} onTimesheet={view === "timesheet"} onMyJobs={() => navGo("overview")} say={say}>
      {view === "overview" ? <Overview /> : null}
      {view === "jobs" ? (() => {
        const jp = jobPageId ? jobs.find((x) => x.id === jobPageId) : undefined;
        if (!jp) return JobsView();
        return <JobPage key={jp.id} job={jp} client={clientById.get(jp.client_id)} meId={me.id} team={team} canAnswerAll={me.role !== "staff"} canDelete={canDelete}
          readOnly={!isOpen(jp.status) && !isMaster} supabase={supabase} personName={personName} say={say} statusEl={<StatusSelect j={jp} />} hours={jobHours[jp.id] ?? 0}
          running={running} busy={timerBusy} onStart={startJob} onStop={stopJob} wasStarted={wasStarted} onBack={() => { setJobPageId(null); window.scrollTo(0, 0); }}
          onEdit={(tab) => setModal({ kind: "job", job: jp, tab })} onOpenClient={openClient} onNewClient={() => setModal({ kind: "client" })}
          flag={flags.get(jp.id)} related={links.filter((l) => l.client_id === jp.client_id || l.related_id === jp.client_id).length}
          onApprove={approveReview} onSendBack={sendBackReview} onHandSign={(j) => setModal({ kind: "handsign", job: j })} />;
      })() : null}
      {view === "payroll" ? <PayrollView key={navTick} jobs={jobs} clients={clients} meId={me.id} canSignOff={canManage} clientName={clientName} personName={personName} running={running} busy={timerBusy}
        onStart={startJob} onStop={stopJob} onSubmit={submitForReview} wasStarted={wasStarted} onStep={payrollStep} onOpen={(j) => openJob(j)} onNew={() => setModal({ kind: "job", service: "payroll" })} /> : null}
      {view === "clients" ? (clientForDetail ? ClientDetail({ c: clientForDetail }) : ClientsView()) : null}
      {view === "prospects" && canSeeTeam ? <ProspectsView key={navTick} supabase={supabase} meId={me.id} team={team} clients={clients} canDelete={canDelete} personName={personName} say={say} onOpenClient={openClient} onChanged={load} /> : null}
      {view === "timesheet" ? <Timesheet key={navTick} timers={teamRunning} me={me} supabase={supabase} people={people} visible={profiles.filter((p) => p.active)} clients={clients} jobs={jobs} canSeeTeam={canSeeTeam} say={say} /> : null}
      {view === "team" && canSeeTeam ? <><TeamView /><ActivityLog supabase={supabase} jobs={jobs} clients={clients} people={people} onOpenJob={(j) => openJob(j)} /></> : null}
      {view === "meetings" && canSeeTeam ? <MeetingsView key={navTick} meetings={meetings} meId={me.id} isMaster={isMaster} personName={personName} clientName={clientName}
        onBook={(date) => setModal({ kind: "meeting", date })} onOpen={(m) => setModal({ kind: "meeting", meeting: m })}
        quick={{ clients, team, supabase, say, onSaved: load, onEdit: (d) => setModal({ kind: "meeting", draft: d }) }}
        onFollowUp={(m) => setModal({ kind: "job", clientId: m.client_id ?? undefined })}
        onAfter={async (m, text) => {
          const t = text.trim();
          if (t && m.client_id) {
            const { error } = await supabase.from("client_notes").insert({ client_id: m.client_id, author_id: me.id, category: "general", body: `Meeting ${fmtDate(m.starts_at.slice(0, 10))} (${m.title}): ${t}`, pinned: false });
            if (error) { say(`Notes not saved: ${error.message}`, true); return false; }
          }
          const { error } = await supabase.from("meetings").update({ done: true, ...(t && !m.client_id ? { notes: [m.notes, t].filter(Boolean).join("\n") } : {}) }).eq("id", m.id);
          if (error) { say(`Not saved: ${error.message}`, true); return false; }
          say(t ? (m.client_id ? "Notes saved to the client and meeting marked done" : "Notes saved and meeting marked done") : "Meeting marked done");
          load();
          return true;
        }} /> : null}
      </WorkGate>
      {modal?.kind === "job" ? <JobModal key={modal.job?.id ?? "new"} job={modal.job} initialTab={modal.tab} presetClient={modal.clientId} presetService={modal.service} isStaff={me.role === "staff"} leaderId={me.reports_to ?? null} statusLocked={!!modal.job && ((!isMaster && staffNotStarted(modal.job)) || staffSubmitted(modal.job))} statusLockMsg={modal.job && staffSubmitted(modal.job) ? SUBMITTED_LOCK_MSG : undefined} onOpenClient={(id) => { close(); openClient(id); }} clients={clients} team={team} canDelete={canDelete} canDeleteJob={isMaster} locked={!!modal.job && !canManage} readOnly={!!modal.job && !isOpen(modal.job.status) && !isMaster} meId={me.id} meName={me.full_name} signCol={jobs.length > 0 && "needs_signature" in jobs[0]} canPickReviewer={me.role === "staff" && !!me.can_pick_reviewer} onNewClient={() => setModal({ kind: "client" })} onQuery={(j) => setModal({ kind: "query", job: j, mode: "send" })} onHandSign={(j) => setModal({ kind: "handsign", job: j })} canHandSign={(j) => canManage || (j.sign_owner ?? j.reviewer_id ?? j.assignee_id) === me.id} supabase={supabase} save={save} onClose={close} confirm={(m) => setModal({ kind: "confirm", ...m })} personName={personName} say={say} /> : null}
      {modal?.kind === "bulk" ? <BulkModal clients={clients} team={me.role === "staff" ? team.filter((p) => p.id === me.id) : team} jobs={jobs} personName={personName} supabase={supabase} save={save} onClose={close} say={say} /> : null}
      {modal?.kind === "client" ? <ClientModal client={modal.client} clients={clients} team={team} canDelete={isMaster} jobs={jobs} supabase={supabase} save={save} onClose={close} confirm={(m) => setModal({ kind: "confirm", ...m })} onDeleted={() => setClientId(null)} /> : null}
      {modal?.kind === "import" && canManage ? <ImportModal clients={clients} people={people} supabase={supabase} onDone={(n) => { load(); say(`${n} client${n === 1 ? "" : "s"} imported`); close(); }} onClose={close} say={say} /> : null}
      {modal?.kind === "member" ? <MemberModal member={modal.member} managers={managers} staff={profiles.filter((p) => p.active && p.role === "staff")} adminCall={adminCall} onClose={close} onTemp={(t) => setModal({ kind: "temp", ...t })} confirm={(m) => setModal({ kind: "confirm", ...m })} say={say} /> : null}
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
      {modal?.kind === "submit" ? <SubmitModal job={modal.job} me={me} team={team} suggested={myReviewer(modal.job)} clientName={clientName} onClose={close}
        run={(to, note) => sendForReview(modal.job, to, note)} /> : null}
      {modal?.kind === "handsign" ? <HandSignModal job={modal.job} me={me} team={team} clientName={clientName} personName={personName} onClose={close}
        run={async (to, note) => { if (await save(() => supabase.rpc("hand_signing", { p_job: modal.job.id, p_to: to, p_note: note }), `Handed to ${personName(to)}. It's in their My jobs now`)) close(); }} /> : null}
      {modal?.kind === "query" ? <QueryModal job={modal.job} mode={modal.mode} me={me} team={team} clientName={clientName} personName={personName}
        run={async (to, note) => {
          const ok = await timerCall(() => modal.mode === "send"
            ? supabase.rpc("send_internal_query", { p_job: modal.job.id, p_to: to, p_note: note })
            : supabase.rpc("answer_internal_query", { p_job: modal.job.id, p_note: note }),
          () => (modal.mode === "send" ? `Sent to ${personName(to)} for an internal query` : `Sent back to ${personName(modal.job.query_from ?? null)}`));
          if (ok) close();
        }} onClose={close} /> : null}
      {modal?.kind === "confirm" ? <ConfirmModal {...modal} onClose={close} /> : null}
      {modal?.kind === "meeting" ? <MeetingModal meeting={modal.meeting} date={modal.date} draft={modal.draft} meId={me.id} canEdit={!modal.meeting || modal.meeting.owner_id === me.id || isMaster}
        team={team} clients={clients} supabase={supabase} say={say} personName={personName} onClose={close} onSaved={load} /> : null}
      <MeetingReminders meetings={meetings} meId={me.id} clientName={clientName} onOpen={(m) => setModal({ kind: "meeting", meeting: m })} />

      {toast ? <div className={`toast${toast.err ? " err" : ""}`} role="status">{toast.msg}</div> : null}
    </Shell>
  );
}

/* ---------- layout ---------- */
function Shell({ me, view, go, live, showTeam, bell, wide, badges, children }: { me: Profile; view: View; go: (v: View) => void; live: boolean; showTeam: boolean; bell?: React.ReactNode; wide?: boolean; badges?: Partial<Record<View, number>>; children: React.ReactNode }) {
  const tabs: [View, string][] = [["overview", "Overview"], ["jobs", "Jobs"], ["payroll", "Payroll"], ["clients", "Clients"], ...(showTeam ? [["prospects", "Prospects"] as [View, string]] : []), ["timesheet", "Timesheet"], ...(showTeam ? [["team", "Team"] as [View, string], ["meetings", "Meetings"] as [View, string]] : [])];
  return (
    <>
      <header className="top"><div className="wrap">
        <div className="brand"><img src="/logo.webp" alt="Supertax" width={136} height={34} /><small>Practice Desk</small></div>
        <nav className="tabs" aria-label="Sections">{tabs.map(([v, l]) => (
          <a key={v} href={`#${v}`} aria-current={view === v ? "page" : undefined} onClick={(e) => { e.preventDefault(); go(v); }}>{l}{badges?.[v] ? <span className="navbadge" title={`${badges[v]} follow-up${badges[v] === 1 ? "" : "s"} due`}>{badges[v]}</span> : null}</a>))}</nav>
        <div className="userbox">{bell}<span><strong>{me.full_name}</strong></span><SignOutButton /></div>
      </div></header>
      <IdleSignOut />
      <UpdateBanner />
      <main className={`wrap${wide ? " wide" : ""}`}>
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

function JobModal({ job, initialTab, onNewClient, presetClient, presetService, isStaff, leaderId, statusLocked, statusLockMsg, onOpenClient, clients, team, canDelete, canDeleteJob, locked: staffLock, readOnly, meId, meName, canPickReviewer = false, signCol = false, onQuery, onHandSign, canHandSign, supabase, save, onClose, confirm, personName, say }: {
  job?: Job; initialTab?: "queries" | "email"; onNewClient?: () => void; presetClient?: string; presetService?: string; isStaff: boolean; leaderId: string | null; statusLocked: boolean; statusLockMsg?: string; onOpenClient?: (id: string) => void; clients: Client[]; team: Person[]; canDelete: boolean; canDeleteJob: boolean; locked: boolean; readOnly: boolean; meId: string; meName: string; canPickReviewer?: boolean; signCol?: boolean; onQuery: (j: Job) => void; onHandSign: (j: Job) => void; canHandSign: (j: Job) => boolean; supabase: SB; save: SaveFn; onClose: () => void;
  confirm: (m: ConfirmArgs) => void; personName: (id: string | null) => string; say: (m: string, e?: boolean) => void;
}) {
  const locked = staffLock || readOnly;
  const preset = presetClient ? clients.find((c) => c.id === presetClient) : undefined;
  const [v, setV] = useState({
    client_id: job?.client_id ?? presetClient ?? "", service: job?.service ?? presetService ?? "bas", period: job?.period ?? "", due_date: job?.due_date ?? "",
    priority: job?.priority ?? "normal", assignee_id: job?.assignee_id ?? preset?.manager_id ?? "", reviewer_id: job?.reviewer_id ?? "",
    status: job?.status ?? "not_started", lodged_on: job?.lodged_on ?? "", notes: job?.notes ?? "",
  });
  // Does the client need to sign? (Saved only once the database has the column.)
  const [needsSign, setNeedsSign] = useState<boolean>(job ? job.needs_signature !== false : !NO_SIGN_SERVICES.has(presetService ?? "bas"));
  const hasSignCol = job ? "needs_signature" in job : signCol;
  const [busy, setBusy] = useState(false);
  // Team members see the job at a glance (no edit form): the manager has set it up.
  const brief = !!job && staffLock;
  const [tab, setTab] = useState<"details" | "queries" | "history" | "files" | "email">(initialTab === "email" ? "email" : brief || initialTab === "queries" || (job && STEPS[job.service]) ? "queries" : "details");
  const [openQs, setOpenQs] = useState(0);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [sum, setSum] = useState<JobSummary | null>(null);
  const logged = sum?.hours ?? 0;
  // Add a new client without leaving the form.
  const [quick, setQuick] = useState<{ name: string; entity: string; abn: string; practice: string } | null>(null);
  const [added, setAdded] = useState<Client[]>([]);
  const allClients = useMemo(() => [...clients, ...added.filter((a) => !clients.some((c) => c.id === a.id))].sort((a, b) => a.name.localeCompare(b.name)), [clients, added]);
  const [quickDupes, setQuickDupes] = useState<Similar[] | null>(null);
  async function addQuickClient() {
    if (!quick?.name.trim()) return;
    if (!quickDupes) { const found = similarClients(quick.name, quick.abn, allClients); if (found.length) { setQuickDupes(found); return; } }
    setBusy(true);
    const { data, error } = await supabase.from("clients").insert({ ...(quick.practice !== DEFAULT_PRACTICE ? { practice: quick.practice } : {}), name: quick.name.trim(), entity: quick.entity, abn: quick.abn.trim(), services: SVC[v.service] && v.service !== "other" ? [v.service] : [] }).select().single();
    setBusy(false);
    if (error || !data) { say(`Client not added: ${error?.message ?? "try again"}`, true); return; }
    const c = data as Client;
    setAdded((x) => [...x, c]);
    setV((cur) => ({ ...cur, client_id: c.id, assignee_id: cur.assignee_id || c.manager_id || "" }));
    setQuick(null); setQuickDupes(null);
    say(`${c.name} added`);
  }
  // Period choices depend on the service (and the client's BAS / payroll settings).
  const client = allClients.find((c) => c.id === v.client_id);
  const groups = useMemo(() => periodOptions(v.service, client), [v.service, client]);
  const allOpts = groups.flatMap((g) => g.options);
  const [custom, setCustom] = useState(() => !!job?.period && !periodOptions(job.service, clients.find((c) => c.id === job.client_id)).some((g) => g.options.some((o) => o.label === job.period)));
  const isCustom = custom || !groups.length;
  const [autoDue, setAutoDue] = useState(!job);
  const pickPeriod = (label: string) => {
    if (label === "__own") { setCustom(true); setV({ ...v, period: "" }); return; }
    const o = allOpts.find((x) => x.label === label);
    setV({ ...v, period: label, due_date: autoDue || !v.due_date ? o?.due ?? v.due_date : v.due_date });
    if (!v.due_date) setAutoDue(true);
  };
  // Repeat automatically (BAS and payroll are created by the system each period).
  const canRepeat = !job && (v.service === "bas" || v.service === "payroll");
  const alreadyRepeats = !!client && (v.service === "bas" ? client.services.includes("bas")
    : v.service === "payroll" ? client.services.includes("payroll") && !!client.payroll_freq && !!client.payroll_anchor : false);
  const [repeat, setRepeat] = useState(false);
  const [payFreq, setPayFreq] = useState("fortnightly");
  const [payAnchor, setPayAnchor] = useState("");
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const next = { ...v, [k]: e.target.value };
    if (k === "client_id" && !v.assignee_id) next.assignee_id = clients.find((c) => c.id === e.target.value)?.manager_id ?? "";
    if (k === "service" && !job) { next.period = ""; if (autoDue) next.due_date = ""; setCustom(false); }
    if (k === "due_date") setAutoDue(false);
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
    const row: Partial<Job> = locked ? { status: v.status, notes: v.notes, ...(ownPick && v.reviewer_id && v.reviewer_id !== job?.reviewer_id ? { reviewer_id: v.reviewer_id } : {}), ...(v.status === "lodged" && !job?.lodged_on ? { lodged_on: todayISO() } : {}) } : { ...v, period: v.period.trim(), due_date: v.due_date || null, assignee_id: v.assignee_id || null, reviewer_id: v.reviewer_id || null,
      lodged_on: v.lodged_on || (v.status === "lodged" ? todayISO() : null), ...(hasSignCol ? { needs_signature: needsSign } : {}) };
    // Choosing Internal query: save the other changes, then pick who to send it to.
    const query = !!job && v.status === "internal_query" && job.status !== "internal_query";
    if (query) row.status = job.status;
    const ok = job ? await save(() => supabase.from("jobs").update(row).eq("id", job.id), query ? undefined : "Job saved")
      : await save(() => supabase.from("jobs").insert(row), "Job created");
    // Set the client up so the next periods are created automatically.
    if (ok && !job && canRepeat && repeat && !alreadyRepeats && client) {
      const services = client.services.includes(v.service) ? client.services : [...client.services, v.service];
      const upd = v.service === "bas"
        ? { services, bas_freq: /^Q/.test(v.period) ? "quarterly" : /^Annual/i.test(v.period) ? "annual" : "monthly" }
        : { services, payroll_freq: payFreq, payroll_anchor: payAnchor || (/^Pay /.test(v.period) ? v.due_date : "") || null };
      await save(() => supabase.from("clients").update(upd).eq("id", client.id), "Job created and set to repeat automatically");
    }
    setBusy(false);
    if (ok && query) onQuery({ ...job, ...row } as Job);
    else if (ok) onClose();
  }
  // Staff only see themselves (and whoever is already on this job, or their team leader), not the whole team.
  // Staff allowed to choose their own reviewer: on their own open jobs, any team member (or themselves).
  const ownPick = canPickReviewer && !!job && job.assignee_id === meId && !readOnly;
  const pick = isStaff ? team.filter((p) => p.id === meId || p.id === v.assignee_id || p.id === v.reviewer_id || p.id === leaderId) : team;
  const opts = (blank: string) => <><option value="">{blank}</option>{pick.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</>;
  return (
    <Overlay onClose={onClose}><form className={`modal ${job ? "wide" : ""}`} onSubmit={submit}>
      <header><h2>{readOnly ? "Job (read-only)" : brief ? "Job" : job ? "Edit job" : "New job"}</h2><button type="button" onClick={onClose}>Close</button></header>
      {job ? <div className="tabs" role="tablist">
        {brief ? null : <button type="button" role="tab" aria-selected={tab === "details"} className={tab === "details" ? "on" : ""} onClick={() => setTab("details")}>Details</button>}
        <button type="button" role="tab" aria-selected={tab === "queries"} className={tab === "queries" ? "on" : ""} onClick={() => setTab("queries")}>{brief ? "Job" : job && STEPS[job.service] ? "Steps & queries" : "Checklist & queries"}{openQs ? <span className="navbadge">{openQs}</span> : null}</button>
        <button type="button" role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History &amp; time{sum ? ` · ${sum.hours ? fmtHours(sum.hours) : "0h"}${sum.comments ? ` · ${sum.comments} comment${sum.comments === 1 ? "" : "s"}` : ""}` : ""}</button>
        <button type="button" role="tab" aria-selected={tab === "files"} className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>Files{fileCount ? ` · ${fileCount}` : ""}</button>
        <button type="button" role="tab" aria-selected={tab === "email"} className={tab === "email" ? "on" : ""} onClick={() => setTab("email")}>Email client</button>
      </div> : null}
      {job && tab === "email" ? <div className="jobemailwrap"><JobEmail job={job} client={client} clients={allClients} meName={meName} readOnly={readOnly} supabase={supabase} personName={personName} say={say} onSent={onClose} /></div> : null}
      {job ? <div className="body" style={{ display: tab === "queries" ? "block" : "none" }}><JobBrief job={job} clientName={client?.name ?? ""} showInfo={brief} meId={meId} canAnswerAll={!isStaff} team={team} defaultTo={job.reviewer_id ?? leaderId} readOnly={readOnly} supabase={supabase} personName={personName} say={say} onQueries={setOpenQs} onNewClient={onNewClient} /></div> : null}
      {job ? <div style={{ display: tab === "files" ? "block" : "none" }}><JobFiles jobId={job.id} meId={meId} canDelete={canDelete} readOnly={readOnly} supabase={supabase} personName={personName} say={say} onCount={setFileCount} /></div> : null}
      {job ? <div style={{ display: tab === "history" ? "block" : "none" }}><JobHistory jobId={job.id} readOnly={readOnly} meId={meId} canDelete={canDelete} supabase={supabase} personName={personName} say={say} onSummary={setSum} /></div> : null}
      <div className="body" style={{ display: tab === "details" ? undefined : "none" }}>
        {readOnly ? <div className="full hint lockednote">This job is {job?.status === "lodged" ? "lodged" : "completed"}, so it&apos;s read-only. Only a master admin can change it. The History &amp; time tab shows everything that was done.</div>
          : staffLock ? <div className="full hint">Only your manager can change the client, service, period, due date, priority, assignee, reviewer and lodgment date. You can update the status and notes.</div> : null}
        <label className="f full"><span className="row" style={{ justifyContent: "space-between" }}>Client{v.client_id && onOpenClient ? <button type="button" className="link" style={{ fontSize: 13 }} onClick={() => onOpenClient(v.client_id)}>Open client profile →</button> : null}</span><ClientPicker id="m-client" required disabled={locked} clients={allClients} value={v.client_id} placeholder="Search client by name or ABN…"
          onChange={(id) => set("client_id")({ target: { value: id } } as React.ChangeEvent<HTMLSelectElement>)}
          onCreate={job ? undefined : (name) => setQuick({ name, entity: "Company", abn: "", practice: DEFAULT_PRACTICE })} /></label>
        {quick ? <div className="full quickclient">
          <strong>New client</strong>
          <div className="qrow">
            <label className="f">Practice<select id="qc-practice" value={quick.practice} onChange={(e) => setQuick({ ...quick, practice: e.target.value })}>{PRACTICES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
            <label className="f">Name<input id="qc-name" autoFocus value={quick.name} onChange={(e) => { setQuick({ ...quick, name: e.target.value }); setQuickDupes(null); }} placeholder="e.g. Sahej Logistics Pty Ltd" /></label>
            <label className="f">Entity type<select id="qc-entity" value={quick.entity} onChange={(e) => setQuick({ ...quick, entity: e.target.value })}>{ENTITIES.map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="f">ABN<input id="qc-abn" value={quick.abn} onChange={(e) => { setQuick({ ...quick, abn: e.target.value }); setQuickDupes(null); }} placeholder="Optional" inputMode="numeric" /></label>
          </div>
          {quickDupes?.length ? <div className="dupwarn" role="alert">
            <strong>This client may already exist</strong>
            <ul>{quickDupes.map((d) => <li key={d.client.id}>{d.client.name} <span className="pill warn">{d.why}</span> <button type="button" className="link" onClick={() => { setV((cur) => ({ ...cur, client_id: d.client.id, assignee_id: cur.assignee_id || (d.client as Client).manager_id || "" })); setQuick(null); setQuickDupes(null); }}>Use this one</button></li>)}</ul>
          </div> : null}
          <div className="row"><button type="button" className="primary" disabled={busy || !quick.name.trim()} onClick={addQuickClient}>{quickDupes?.length ? "Yes, add anyway" : "Add client"}</button><button type="button" onClick={() => { setQuick(null); setQuickDupes(null); }}>Cancel</button>
            <span className="note">You can add contact details later from the client page.</span></div>
        </div> : null}
        <label className="f">Service<select id="m-service" disabled={locked} value={v.service} onChange={(e) => { setV({ ...v, service: e.target.value }); if (!job) setNeedsSign(!NO_SIGN_SERVICES.has(e.target.value)); }}>{SERVICES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label className="f">Period{isCustom ? <span className="periodown">
            <input id="m-period" required disabled={locked} placeholder="e.g. Q2 FY27, Oct 2026, FY2026" value={v.period} onChange={set("period")} />
            {groups.length && !locked ? <button type="button" className="link" onClick={() => { setCustom(false); setV({ ...v, period: "" }); }}>Pick from list</button> : null}</span>
          : <select id="m-period" required disabled={locked} value={v.period} onChange={(e) => pickPeriod(e.target.value)}>
            <option value="">Choose a period…</option>
            {groups.map((g) => <optgroup key={g.label} label={g.label}>{g.options.map((o) => <option key={o.label} value={o.label}>{o.label}</option>)}</optgroup>)}
            <option value="__own">Other (type your own)…</option>
          </select>}</label>
        {canRepeat ? <div className="full repeatbox">
          {alreadyRepeats ? <span className="note">✓ This client is already set up for automatic {v.service === "bas" ? `${client?.bas_freq ?? "quarterly"} BAS` : `${client?.payroll_freq} payroll`} jobs. The next one is created by itself.</span> : <>
            <label className="row" style={{ gap: 8, fontWeight: 600 }}><input id="m-repeat" type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Repeat automatically for this client</label>
            {repeat && v.service === "bas" ? <span className="note">The next {/^Q/.test(v.period) || !v.period ? "quarter's" : "month's"} BAS job is created by itself the day after that period ends{/^Q/.test(v.period) || !v.period ? " (e.g. Q2 FY27 appears on 1 Jan 2027)" : ""}.</span> : null}
            {repeat && v.service === "payroll" ? <div className="row">
              <label className="f" style={{ flex: 1 }}>How often<select id="m-payfreq" value={payFreq} onChange={(e) => setPayFreq(e.target.value)}><option value="weekly">Weekly</option><option value="fortnightly">Fortnightly</option><option value="monthly">Monthly</option></select></label>
              <label className="f" style={{ flex: 1 }}>A pay day<input id="m-payday" type="date" required value={payAnchor || (/^Pay /.test(v.period) ? v.due_date : "")} onChange={(e) => setPayAnchor(e.target.value)} /></label>
              <span className="note" style={{ flexBasis: "100%" }}>A payroll job is created on each pay day from then on.</span></div> : null}
          </>}
        </div> : null}
        <label className="f">Due date<input id="m-due" type="date" disabled={locked} value={v.due_date} onChange={set("due_date")} /></label>
        {hasSignCol ? <label className="f full row" style={{ gap: 8, flexDirection: "row", alignItems: "center", fontSize: 14, fontWeight: 400, color: "inherit" }}><input id="m-needsign" type="checkbox" disabled={locked} checked={needsSign} onChange={(e) => setNeedsSign(e.target.checked)} /> Needs the client&apos;s signature <span className="note">(untick if there&apos;s nothing to sign: approving it then marks it Completed)</span></label> : null}
        <label className="f">Priority<select id="m-priority" disabled={locked} value={v.priority} onChange={set("priority")}><option value="normal">Normal</option><option value="high">High</option></select></label>
        <label className="f">Assigned to<select id="m-assignee" disabled={locked} value={v.assignee_id} onChange={set("assignee_id")}>{opts("Unassigned")}</select></label>
        <label className="f">Reviewer<select id="m-reviewer" disabled={locked && !ownPick} value={v.reviewer_id} onChange={set("reviewer_id")}>{ownPick ? <><option value="">No reviewer</option>{team.map((p) => <option key={p.id} value={p.id}>{p.id === meId ? `${p.full_name} (me)` : p.full_name}</option>)}</> : opts("No reviewer")}</select></label>
        <label className="f">Status<select id="m-status" disabled={readOnly || statusLocked} title={statusLocked ? statusLockMsg ?? "Press Start on this job in My jobs first" : undefined} value={v.status} onChange={set("status")}>{STATUSES.map((s) => <option key={s.id} value={s.id} disabled={isStaff && STAFF_CANT_PICK.has(s.id) && s.id !== job?.status && job?.reviewer_id !== meId}>{s.label}</option>)}</select></label>
        {job && (job.status === "to_lodge" || job.status === "sent_for_sign") ? <div className="full hint">Signing handled by <strong>{personName(job.sign_owner ?? job.reviewer_id ?? job.assignee_id) || "nobody yet"}</strong>
          {canHandSign(job) ? <> · <button type="button" className="link" onClick={() => onHandSign(job)}>Hand to a team member</button></> : null}</div> : null}
        <label className="f">Lodged on<input id="m-lodged" type="date" disabled={locked} value={v.lodged_on} onChange={set("lodged_on")} /></label>
        <label className="f full">Notes<textarea id="m-notes" readOnly={readOnly} placeholder="Records outstanding, queries for the client, lodgment receipt number…" value={v.notes} onChange={set("notes")} /></label>
        {job ? <div className="full hint">Last changed {fmtDate(job.updated_at)}{job.updated_by ? ` by ${personName(job.updated_by)}` : ""}{logged ? <> · <button type="button" className="link" onClick={() => setTab("history")}>{fmtHours(logged)} logged, see history</button></> : null}</div> : null}
      </div>
      <footer style={{ display: tab === "email" || (!brief && tab === "queries") ? "none" : undefined }}>
        {job && canDeleteJob ? <button type="button" className="danger" onClick={() => confirm({ title: "Delete this job?", text: "The job and its notes are removed for everyone. This cannot be undone.", yes: "Delete job", run: () => save(() => supabase.from("jobs").delete().eq("id", job.id), "Job deleted") })}>Delete job</button> : <span />}
        <div className="row">{job && staffLock && !job.assignee_id && !readOnly ? <button type="button" disabled={busy} onClick={async () => { if (await save(() => supabase.from("jobs").update({ assignee_id: meId }).eq("id", job.id), "The job is yours. It's in My jobs now")) onClose(); }}>Take this job</button> : null}
          <button type="button" onClick={onClose}>{readOnly || brief ? "Close" : "Cancel"}</button>{readOnly || brief ? null : <button type="submit" className="primary" disabled={busy}>{job ? "Save changes" : "Create job"}</button>}</div>
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
        {isBas ? <label className="f">BAS cycle<select id="b-freq" value={p.freq} onChange={(e) => change({ freq: e.target.value as PeriodInput["freq"] })}><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option><option value="annual">Annually</option></select></label> : null}
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

function ClientModal({ client, clients, team, canDelete, jobs, supabase, save, onClose, confirm, onDeleted }: {
  client?: Client; clients: Client[]; team: Person[]; canDelete: boolean; jobs: Job[]; supabase: SB; save: SaveFn; onClose: () => void; confirm: (m: ConfirmArgs) => void; onDeleted: () => void;
}) {
  const [v, setV] = useState({
    practice: practiceOf(client), name: client?.name ?? "", entity: client?.entity ?? "Company", abn: client?.abn ?? "", contact: client?.contact ?? "", manager_id: client?.manager_id ?? "",
    email: client?.email ?? "", phone: client?.phone ?? "", address: client?.address ?? "", services: client?.services ?? [], bas_freq: client?.bas_freq ?? "quarterly", notes: client?.notes ?? "",
    payroll_freq: (client?.payroll_freq ?? "") as string, payroll_anchor: client?.payroll_anchor ?? "",
    payroll_assignee: client?.payroll_assignee ?? "", bas_assignee: client?.bas_assignee ?? "",
  });
  const hasPayroll = v.services.includes("payroll");
  const [busy, setBusy] = useState(false);
  const [dupes, setDupes] = useState<Similar[] | null>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => { setV({ ...v, [k]: e.target.value }); if (k === "name" || k === "abn") setDupes(null); };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Possible duplicate? Show it and only save once they confirm.
    const changed = !client || client.name.trim() !== v.name.trim() || (client.abn ?? "").trim() !== v.abn.trim();
    if (changed && !dupes) {
      const found = similarClients(v.name, v.abn, clients, client?.id);
      if (found.length) { setDupes(found); return; }
    }
    setBusy(true);
    if (hasPayroll && v.payroll_freq && !v.payroll_anchor) { setBusy(false); alert("Enter the next pay date so payroll jobs can be created on the right days."); return; }
    const { payroll_freq, payroll_anchor, payroll_assignee, bas_assignee, practice, address, ...base } = v;
    // Default people for automatic jobs: only sent when set or changed, so saving works before that database update.
    const who: Record<string, string | null> = {};
    if (payroll_assignee || client?.payroll_assignee) who.payroll_assignee = hasPayroll ? payroll_assignee || null : null;
    if (bas_assignee || client?.bas_assignee) who.bas_assignee = v.services.includes("bas") ? bas_assignee || null : null;
    // Payroll fields are sent only when relevant, so saving works even before the payroll database update.
    const payroll = hasPayroll || client?.payroll_freq ? { payroll_freq: hasPayroll ? payroll_freq : "", payroll_anchor: hasPayroll && payroll_freq ? payroll_anchor || null : null } : {};
    // Practice is sent when it isn't the default (or already stored), so saving works before that database update.
    const prac = practice !== DEFAULT_PRACTICE || client?.practice ? { practice } : {};
    const addr = address.trim() || client?.address ? { address: address.trim() } : {};
    const row: Record<string, unknown> = { ...base, ...payroll, ...who, ...prac, ...addr, name: v.name.trim(), abn: v.abn.trim(), manager_id: v.manager_id || null };
    const ok = client ? await save(() => supabase.from("clients").update(row).eq("id", client.id), "Client saved") : await save(() => supabase.from("clients").insert(row), "Client added");
    setBusy(false);
    if (ok) onClose();
  }
  const n = client ? jobs.filter((j) => j.client_id === client.id).length : 0;
  return (
    <Overlay onClose={onClose}><form className="modal" onSubmit={submit}>
      <header><h2>{client ? "Edit client" : "Add client"}</h2><button type="button" onClick={onClose}>Close</button></header>
      <div className="body">
        <label className="f full">Practice<select id="c-practice" value={v.practice} onChange={set("practice")}>{PRACTICES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label className="f full">Client name<input id="c-name" required value={v.name} onChange={set("name")} placeholder="e.g. Harbourside Plumbing Pty Ltd" /></label>
        {dupes?.length ? <div className="full dupwarn" role="alert">
          <strong>This client may already exist</strong>
          <ul>{dupes.map((d) => <li key={d.client.id}>{d.client.name}{d.client.abn ? <span className="note"> · ABN {d.client.abn}</span> : null} <span className="pill warn">{d.why}</span></li>)}</ul>
          <span className="note">Check it isn&apos;t the same client. If it&apos;s a different one, click {client ? "Save anyway" : "Yes, add anyway"}.</span>
        </div> : null}
        <label className="f">Entity type<select id="c-entity" value={v.entity} onChange={set("entity")}>{ENTITIES.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="f">ABN<input id="c-abn" inputMode="numeric" value={v.abn} onChange={set("abn")} placeholder="11 digits" /></label>
        <label className="f">Contact person<input id="c-contact" value={v.contact} onChange={set("contact")} /></label>
        <label className="f">Manager<select id="c-manager" value={v.manager_id} onChange={set("manager_id")}><option value="">No manager</option>{team.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label>
        <label className="f">Email<input id="c-email" type="email" value={v.email} onChange={set("email")} /></label>
        <label className="f">Phone<input id="c-phone" type="tel" value={v.phone} onChange={set("phone")} /></label>
        <label className="f full">Address<input id="c-address" autoComplete="off" value={v.address} onChange={set("address")} placeholder="e.g. 12 George St, Parramatta NSW 2150" /></label>
        <div className="f full">Services you provide<div className="checks">{SERVICES.map((s) => (
          <label key={s.id}><input type="checkbox" checked={v.services.includes(s.id)} onChange={(e) => setV({ ...v, services: e.target.checked ? [...v.services, s.id] : v.services.filter((x) => x !== s.id) })} /> {s.label}</label>))}</div></div>
        <label className="f">BAS / IAS cycle<select id="c-basfreq" value={v.bas_freq} onChange={set("bas_freq")}><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option><option value="annual">Annually</option></select></label>
        {v.services.includes("bas") ? <label className="f">BAS jobs go to<select id="c-basto" value={v.bas_assignee} onChange={set("bas_assignee")}><option value="">The client&apos;s manager</option>{team.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label> : null}
        {hasPayroll ? <>
          <label className="f">Pay frequency<select id="c-payfreq" value={v.payroll_freq} onChange={set("payroll_freq")}><option value="">Not set (no automatic jobs)</option><option value="weekly">Weekly</option><option value="fortnightly">Fortnightly</option><option value="monthly">Monthly</option></select></label>
          <label className="f">Payroll jobs go to<select id="c-payto" value={v.payroll_assignee} onChange={set("payroll_assignee")}><option value="">The client&apos;s manager</option>{team.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label>
          {v.payroll_freq ? <label className="f">{v.payroll_freq === "monthly" ? "A pay date (sets the day of the month)" : "Next pay date"}<input id="c-payanchor" type="date" value={v.payroll_anchor} onChange={set("payroll_anchor")} required /></label> : null}
          {v.payroll_freq ? <p className="full hint" style={{ margin: 0 }}>A payroll job is created automatically on each pay day and assigned to the person above (or the client&apos;s manager). They get a bell notification.</p> : null}
        </> : null}
        <label className="f full">Notes<textarea id="c-notes" value={v.notes} onChange={set("notes")} placeholder="Software they use, year-end, quirks…" /></label>
        <p className="full hint" style={{ margin: 0 }}>Don&apos;t store TFNs, passwords or bank details here.</p>
      </div>
      <footer>
        {client && canDelete ? <button type="button" className="danger" onClick={() => confirm({ title: `Delete ${client.name}?`, text: `This removes the client and their ${n} job${n === 1 ? "" : "s"} for everyone. This cannot be undone.`, yes: "Delete client",
          run: async () => { const ok = await save(() => supabase.from("clients").delete().eq("id", client.id), "Client deleted"); if (ok) onDeleted(); return ok; } })}>Delete client</button> : <span />}
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy}>{dupes?.length ? (client ? "Save anyway" : "Yes, add anyway") : client ? "Save changes" : "Add client"}</button></div>
      </footer>
    </form></Overlay>
  );
}

function MemberModal({ member, managers, staff, adminCall, onClose, onTemp, confirm, say }: {
  member?: Profile; managers: Profile[]; staff: Profile[]; adminCall: (url: string, method: string, body?: unknown) => Promise<{ tempPassword?: string } | null>; onClose: () => void;
  onTemp: (t: { name: string; email: string; password: string }) => void; confirm: (m: ConfirmArgs) => void; say: (m: string, e?: boolean) => void;
}) {
  const [v, setV] = useState({ fullName: member?.full_name ?? "", email: member?.email ?? "", title: member?.title ?? "", role: member?.role ?? "staff", reportsTo: member?.reports_to ?? "" });
  const [perm, setPerm] = useState({ canDelete: !!member?.can_delete, canSeeWorkload: !!member?.can_see_workload, canPickReviewer: !!member?.can_pick_reviewer, canSeeMgmt: !!member?.can_see_mgmt_notes, clientTypes: member?.client_types ?? [] as string[], practices: member?.practices ?? [] as string[] });
  const [teamIds, setTeamIds] = useState<string[]>(() => (member ? staff.filter((s) => s.reports_to === member.id).map((s) => s.id) : []));
  const extra = () => ({ canDelete: v.role === "staff" ? perm.canDelete : false, canPickReviewer: v.role === "staff" ? perm.canPickReviewer : false, canSeeMgmt: v.role === "staff" ? perm.canSeeMgmt : false, clientTypes: v.role === "staff" ? perm.clientTypes : [], practices: v.role === "staff" ? perm.practices : [], canSeeWorkload: v.role === "master" ? false : perm.canSeeWorkload, ...(v.role === "manager" ? { team: teamIds } : {}) });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    if (member) {
      const r = await adminCall(`/api/admin/users/${member.id}`, "PATCH", { fullName: v.fullName, title: v.title, role: v.role, reportsTo: v.role === "staff" ? v.reportsTo || null : null, ...extra() });
      setBusy(false);
      if (r) { say("Saved"); onClose(); }
    } else {
      const r = await adminCall("/api/admin/users", "POST", { ...v, ...extra() });
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
        <label className="f">Role<select id="u-role" value={v.role} onChange={set("role")}><option value="staff">Staff</option><option value="manager">Team leader (manager)</option><option value="master">Master admin (full control)</option></select></label>
        {v.role === "staff" ? (
          <label className="f">Team leader<select id="u-reports" value={v.reportsTo} onChange={set("reportsTo")}><option value="">No team leader</option>{managers.filter((m) => m.id !== member?.id).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}</select></label>
        ) : null}
        <p className="full hint" style={{ margin: 0 }}>{v.role === "staff" ? "Staff see and work on the jobs assigned to them, add and update clients and jobs, and fill in their timesheet."
          : v.role === "manager" ? "A team leader sees their team members here, their timesheets and attendance, what they are working on right now, and their workload. They can assign jobs and book meetings."
          : "A master admin can do everything: add people, change roles and permissions, delete clients and jobs, and see the whole practice."}</p>
        {v.role === "manager" ? <div className="f full"><span>Their team members</span>
          {staff.filter((s) => s.id !== member?.id).length ? <div className="row" style={{ marginTop: 6 }}>{staff.filter((s) => s.id !== member?.id).map((s) => { const on = teamIds.includes(s.id); const other = !on && s.reports_to && s.reports_to !== member?.id ? managers.find((m) => m.id === s.reports_to)?.full_name : ""; return (
            <label key={s.id} className={`chip ${on ? "on" : ""}`} title={other ? `Currently in ${other}'s team. Ticking moves them.` : undefined}><input type="checkbox" checked={on} onChange={() => setTeamIds(on ? teamIds.filter((x) => x !== s.id) : [...teamIds, s.id])} />{s.full_name}{other ? <span className="note"> ({other})</span> : null}</label>); })}</div>
            : <span className="note" style={{ marginTop: 4 }}>No staff yet. Add staff members, then choose them here (or pick this team leader under &quot;Team leader&quot; on their form).</span>}
        </div> : null}
        {v.role !== "master" ? <div className="f full permbox"><span>Permissions</span>
          <label className="row" style={{ gap: 8 }}><input id="u-workload" type="checkbox" checked={perm.canSeeWorkload} onChange={(e) => setPerm({ ...perm, canSeeWorkload: e.target.checked })} /> See the whole practice&apos;s Team workload and Working now{v.role === "manager" ? " (not just their own team)" : ""}</label>
          {v.role === "staff" ? <label className="row" style={{ gap: 8 }}><input id="u-candelete" type="checkbox" checked={perm.canDelete} onChange={(e) => setPerm({ ...perm, canDelete: e.target.checked })} /> Delete client notes and job comments</label> : null}
          {v.role === "staff" ? <label className="row" style={{ gap: 8 }}><input id="u-pickrev" type="checkbox" checked={perm.canPickReviewer} onChange={(e) => setPerm({ ...perm, canPickReviewer: e.target.checked })} /> Choose the reviewer on their own jobs (including themselves)</label> : null}
          {v.role === "staff" ? <label className="row" style={{ gap: 8 }}><input id="u-mgmt" type="checkbox" checked={perm.canSeeMgmt} onChange={(e) => setPerm({ ...perm, canSeeMgmt: e.target.checked })} /> See and add confidential management notes on clients (quotes, fees)</label> : null}
          {v.role === "staff" ? <div style={{ marginTop: 6 }}><span>Practices they can see</span>
            <div className="row" style={{ marginTop: 4, flexWrap: "wrap", gap: 6 }}>{PRACTICES.map((t) => { const on = perm.practices.includes(t); return (
              <label key={t} className={`chip ${on ? "on" : ""}`}><input type="checkbox" checked={on} onChange={() => setPerm({ ...perm, practices: on ? perm.practices.filter((x) => x !== t) : [...perm.practices, t] })} />{t}</label>); })}</div>
            <span className="note">{perm.practices.length ? `They see only clients of ${perm.practices.join(", ")}, plus the clients of any job assigned to them.` : "None ticked: they see clients of every practice."}</span></div> : null}
          {v.role === "staff" ? <div style={{ marginTop: 6 }}><span>Client types they can see</span>
            <div className="row" style={{ marginTop: 4, flexWrap: "wrap", gap: 6 }}>{ENTITIES.map((t) => { const on = perm.clientTypes.includes(t); return (
              <label key={t} className={`chip ${on ? "on" : ""}`}><input type="checkbox" checked={on} onChange={() => setPerm({ ...perm, clientTypes: on ? perm.clientTypes.filter((x) => x !== t) : [...perm.clientTypes, t] })} />{t}</label>); })}</div>
            <span className="note">{perm.clientTypes.length ? `They see only ${perm.clientTypes.join(", ")} clients, plus the clients of any job assigned to them.` : "None ticked: they see every client."}</span></div> : null}
          <span className="note">Only master admins can delete clients and jobs. Managers always see management notes.</span>
        </div> : null}
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
  const [practice, setPractice] = useState<string>(DEFAULT_PRACTICE);
  const [table, setTable] = useState<unknown[][] | null>(null);
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
      setTable(table);
      const r = checkImport(table, clients, people, practice);
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
        <label className="f" style={{ maxWidth: 320 }}>Practice for these clients<select id="import-practice" value={practice} onChange={(e) => {
          setPractice(e.target.value);
          if (table) { const r = checkImport(table, clients, people, e.target.value); if (!("error" in r)) setCheck(r); }
        }}>{PRACTICES.map((p) => <option key={p} value={p}>{p}</option>)}</select><span className="note">A Practice column in the file, if you have one, wins over this.</span></label>
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
              <div className="tablebox solo" style={{ maxHeight: 260, overflowY: "auto" }}><table><thead><tr><th>Client</th><th>Practice</th><th>Entity</th><th>ABN</th><th>Services</th></tr></thead>
                <tbody>{check.ready.slice(0, 200).map((r) => <tr key={r.line}><td className="client">{r.name}{r.address ? <div className="note">{r.address}</div> : null}</td><td>{r.practice}</td><td>{r.entity}</td><td className="mono">{r.abn}</td><td>{r.services.map((s) => <span key={s} className="tag">{svcLabel(s)}</span>)}</td></tr>)}</tbody></table></div>
            ) : null}
          </div>
        ) : null}
      </div></div>
      <footer><span className="note">Only the master admin and managers can import.</span><div className="row"><button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={busy || !check?.ready.length} onClick={run}>{busy ? "Importing…" : `Import ${check?.ready.length ?? 0} client${check?.ready.length === 1 ? "" : "s"}`}</button></div></footer>
    </div></Overlay>
  );
}

function SubmitModal({ job, me, team, suggested, clientName, run, onClose }: {
  job: Job; me: Profile; team: Person[]; suggested: string | null; clientName: (id: string) => string;
  run: (to: string, note: string) => Promise<void>; onClose: () => void;
}) {
  // "Myself" only when a manager has made you this job's reviewer.
  const others = [...team.filter((p) => p.id !== me.id), ...(job.reviewer_id === me.id || me.can_pick_reviewer ? [{ id: me.id, full_name: "Myself", title: "I'm the reviewer" } as Person] : [])];
  const [to, setTo] = useState(suggested && others.some((p) => p.id === suggested) ? suggested : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Overlay onClose={onClose}><form className="modal" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await run(to, note); setBusy(false); }}>
      <header><h2>Submit for review</h2><button type="button" onClick={onClose}>Close</button></header>
      <div className="body">
        <p className="full muted" style={{ margin: 0 }}>{clientName(job.client_id)} · {svcLabel(job.service)} · {job.period}</p>
        <label className="f full">Send to (senior or manager)<select id="sr-to" required value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose who reviews it…</option>
          {others.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.title ? ` · ${p.title}` : ""}{p.id === suggested ? " (usual reviewer)" : ""}</option>)}</select></label>
        <label className="f full">Note for the reviewer (optional)<textarea id="sr-note" placeholder="e.g. All done. Please check the depreciation schedule and the rental property expenses." value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="full hint">Your timer stops and the time goes to your timesheet. The job moves to Ready for review in their My jobs and they get a bell notification. You can&apos;t change its status after this unless they send it back to you.</div>
      </div>
      <footer><span /><div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy || !to}>Submit for review</button></div></footer>
    </form></Overlay>
  );
}

function HandSignModal({ job, me, team, clientName, personName, run, onClose }: {
  job: Job; me: Profile; team: Person[]; clientName: (id: string) => string; personName: (id: string | null) => string;
  run: (to: string, note: string) => Promise<void>; onClose: () => void;
}) {
  const owner = job.sign_owner ?? job.reviewer_id ?? job.assignee_id;
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const sent = job.status === "sent_for_sign";
  return (
    <Overlay onClose={onClose}><form className="modal" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await run(to, note); setBusy(false); }}>
      <header><h2>{sent ? "Hand over the signing follow-up" : "Hand over for signing"}</h2><button type="button" onClick={onClose}>Close</button></header>
      <div className="body">
        <p className="full muted" style={{ margin: 0 }}>{clientName(job.client_id)} · {svcLabel(job.service)} · {job.period}{owner ? ` · now with ${owner === me.id ? "you" : personName(owner)}` : ""}</p>
        <label className="f full">Give it to<select id="hs-to" required value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose a team member…</option>{team.filter((p) => p.id !== owner).map((p) => <option key={p.id} value={p.id}>{p.id === me.id ? `${p.full_name} (me)` : p.full_name}</option>)}</select></label>
        <label className="f full">Note (optional)<textarea id="hs-note" placeholder={sent ? "e.g. Sent by email on Monday, please call the client" : "e.g. Prepare the engagement letter and send it by DocuSign"} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="full hint">{sent
          ? "The job stays Sent for sign. It moves to their My jobs, they get the 2-day reminders to chase the client, and they mark it signed."
          : "The job stays Ready for signing and moves to their My jobs. They can time the work and click Sent to client for signing."} They get a bell notification.</div>
      </div>
      <footer><span /><div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy || !to}>Hand over</button></div></footer>
    </form></Overlay>
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
