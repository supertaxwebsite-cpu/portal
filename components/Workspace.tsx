"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Client, ClientLink, Job, JobTimer, Person, Profile, StatusId } from "@/lib/types";
import { periodOptions, clientUpcoming,
  ENTITIES, PRACTICES, periodFY, DEFAULT_PRACTICE, practiceOf, STAFF_CANT_PICK, SUBMITTED_LOCK_MSG, staffSubmittedLock, SERVICES, STATUSES, ST, SVC, currentFY, daysFrom, fmtDate, isOpen,
  RELATIONS, relationText, clientGroup,
  periodLabel, projectedWork, roleLabel, suggestDue, svcLabel, todayISO, type PeriodInput,
} from "@/lib/domain";
import SignOutButton from "./SignOutButton";
import IdleSignOut from "./IdleSignOut";
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
import JobHistory, { type JobSummary } from "./JobHistory";
import JobFiles from "./JobFiles";
import JobEmail from "./JobEmail";
import MyJobs, { TeamRunning, fmtHours } from "./MyJobs";
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
const DEFAULT_CLIENT_COLS = ["practice", "entity", "abn", "services", "manager", "open"];

interface JobFilter { q: string; service: string; status: string; assignee: string; due: string; client: string; group: string; practice: string; entity: string; fy: string; quarter: string }
const NO_FILTER: JobFilter = { q: "", service: "", status: "open", assignee: "", due: "", client: "", group: "", practice: "", entity: "", fy: "", quarter: "" };

type Modal =
  | { kind: "job"; job?: Job; clientId?: string; service?: string }
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
  const [cq, setCq] = useState("");
  const [cservice, setCservice] = useState("");
  const [centity, setCentity] = useState<string[]>([]);
  const [cpractice, setCpractice] = useState("");
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
  useEffect(() => { try { const s = JSON.parse(localStorage.getItem("pd-client-cols") ?? "null"); if (Array.isArray(s)) setCcolsState(s.filter((x) => CLIENT_COLS.some((c) => c.id === x))); } catch { /* ignore */ } }, []);
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
  const setCcols = (c: string[]) => { setCcolsState(c); try { localStorage.setItem("pd-client-cols", JSON.stringify(c)); } catch { /* ignore */ } };
  const [clientId, setClientId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const isMaster = me.role === "master";
  const canManage = me.role === "master" || me.role === "manager";
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
  const go = (v: View) => { if (v !== "clients") setClientId(null); window.location.hash = v; setView(v); window.scrollTo(0, 0); };
  // Top menu: start the page fresh, with every filter and sort cleared, so the totals show.
  const navGo = (v: View) => {
    setJf(NO_FILTER); setJsort({ k: "due", dir: 1 });
    setCq(""); setCpractice(""); setCservice(""); setCentity([]);
    setGsel(new Set()); setGstatus(""); setClientId(null); setNavTick((n) => n + 1);
    go(v);
  };
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
    await save(() => supabase.from("jobs").update({ status: "to_lodge" }).eq("id", j.id), "Approved. It's in your My jobs as Ready for signing");
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
  const staffNotStarted = (j: Job) => me.role === "staff" && !wasStarted(j);
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
    await save(() => supabase.from("jobs").update({ sign_sent_at: new Date().toISOString(), sign_reminded_at: null }).eq("id", j.id), "Got it. It comes back in 2 days if the client still hasn't replied");
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
    if (!error) { say(`Sent to ${personName(to)} for review`); setModal(null); await load(); return; }
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
  const statusCls = (j: Job) => { const s = ST[j.status] ?? ST.not_started; return s.open && j.due_date && daysFrom(j.due_date) < 0 ? "danger" : s.cls; };
  // Lodged and completed jobs are read-only for everyone except master admins.
  const closedFor = (j: Job) => !isOpen(j.status) && !isMaster;
  const StatusSelect = ({ j }: { j: Job }) => (
    <select className={`status ${statusCls(j)}`} id={`st-${j.id}`} aria-label="Status" value={j.status} disabled={closedFor(j) || staffSubmitted(j) || staffNotStarted(j)} title={closedFor(j) ? "Only a master admin can change a lodged or completed job" : staffSubmitted(j) ? SUBMITTED_LOCK_MSG : staffNotStarted(j) ? "Press Start on this job first, then you can change its status" : undefined} onChange={(e) => (me.role === "staff" && e.target.value === "review" ? submitForReview(j) : setStatus(j, e.target.value as StatusId))}>
      {STATUSES.map((s) => <option key={s.id} value={s.id} disabled={me.role === "staff" && STAFF_CANT_PICK.has(s.id) && s.id !== j.status}>{s.label}</option>)}
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
            <div className="side"><strong>Signed in as {roleLabel(me.role)}</strong><span className="note">{isMaster ? "Only you can add team members, change roles and switch access off." : canManage ? "Only master admins can delete clients and jobs." : "You can add and update clients and jobs."}</span></div>
          </div>
        ) : null}
        <div className="tiles">
          <Tile lbl="Overdue" n={overdue.length} cls={overdue.length ? "danger" : ""} f={{ due: "overdue" }} />
          <Tile lbl="Due in the next 7 days" n={week.length} cls={week.length ? "warn" : ""} f={{ due: "week" }} />
          <Tile lbl="Waiting on client" n={waiting.length} f={{ status: "waiting" }} />
          <Tile lbl="Ready for review or signing" n={review.length} f={{ status: "review_any" }} />
          <Tile lbl="Lodged this month" n={lodged.length} f={{ status: "lodged" }} />
        </div>
        <div className="panel" style={{ padding: "12px 14px", marginBottom: 16 }}>
          <div className="ph" style={{ padding: 0, marginBottom: 8 }}><h2>All jobs by status</h2><button className="link" onClick={() => gotoJobs({ status: "" })}>See all {jobs.length}</button></div>
          <div className="statusrow">{STATUSES.map((st) => { const n = jobs.filter((j) => j.status === st.id).length; return (
            <button key={st.id} className="statuschip" onClick={() => gotoJobs({ status: st.id })} disabled={!n}><strong className="mono">{n}</strong><span className={`pill ${st.cls}`}>{st.label}</span></button>); })}</div>
        </div>
        <div className="grid2">
          <div className="section">
            <MyJobs jobs={openJobs.filter(myJobFilter)}
              onSigned={markSigned} onSentForSign={markSentForSign} onFollowedUp={followedUp} onHandSign={(j) => setModal({ kind: "handsign", job: j })}
              onApprove={approveReview} onSendBack={sendBackReview} onOpenClient={openClient} isStaff={me.role === "staff"} onPayroll={() => go("payroll")} myId={me.id} personName={personName}
              onAnswer={(j) => setModal({ kind: "query", job: j, mode: "answer" })}
              meetings={myMeetings}
              onOpenMeeting={(m) => setModal({ kind: "meeting", meeting: m })}
              onMeetingDone={(m) => save(() => supabase.from("meetings").update({ done: true }).eq("id", m.id), "Meeting marked done")} running={running} clientName={clientName} busy={timerBusy}
              reviewerName={me.reports_to ? personName(me.reports_to) : ""}
              onStart={startJob} onStop={stopJob} onStatus={myStatus} onSubmit={submitForReview} wasStarted={wasStarted}
              onOpen={(j) => setModal({ kind: "job", job: j })} onSeeAll={() => gotoJobs({ assignee: me.id })} />
            <div className="panel">
              <div className="ph"><h2>Needs attention</h2><span className="note">Your jobs: overdue, due this week or high priority</span></div>
              {attention.length ? (
                <ul className="list">{attention.map((j) => (
                  <li key={j.id}><div style={{ minWidth: 0 }}><div className="t">{clientName(j.client_id)}</div><div className="s">{svcLabel(j.service)} · {j.period}{j.priority === "high" ? <> · <span style={{ color: "var(--danger)", fontWeight: 600 }}>High priority</span></> : null}</div></div>
                    <div className="row"><Due j={j} /><button onClick={() => setModal({ kind: "job", job: j })}>Open</button></div></li>
                ))}</ul>
              ) : <div className="empty"><strong>Nothing needs your attention.</strong>Your jobs that are overdue, due in the next 7 days or marked high priority show here.</div>}
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
            {canSeeWorkload || seesOwnTeam ? <TeamRunning timers={teamRunning} jobHours={jobHours} jobById={(id) => jobs.find((j) => j.id === id)} clientName={clientName} personName={personName}
              onOpen={(j) => setModal({ kind: "job", job: j })} /> : null}
            {canSeeWorkload || seesOwnTeam ? <div className="panel"><div className="ph"><h2>{seesOwnTeam ? "My team's workload" : "Team workload"}</h2><span className="note">Open jobs · <span style={{ color: "var(--danger)" }}>overdue</span></span></div>
              <div style={{ overflowX: "auto", marginTop: 8 }}><table className="workload"><tbody>{rows.map((r) => { const od = r.js.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length; const n = r.js.length; return (
                <tr key={r.id}><td style={{ width: "40%" }}><button className="link" style={{ color: "var(--fg)" }} onClick={() => gotoJobs({ assignee: r.id })}>{r.name}</button>{r.title ? <div className="note">{r.title}</div> : null}</td>
                  <td><div className="bar" title={`${n} open, ${od} overdue`}><i className="d" style={{ width: `${(od / max) * 100}%` }} /><i className="o" style={{ width: `${((n - od) / max) * 100}%` }} /></div></td>
                  <td className="mono" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{n}{od ? <> · <span style={{ color: "var(--danger)" }}>{od}</span></> : null}</td></tr>); })}</tbody></table></div></div> : null}
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
  }, [jf, jobs, openJobs, clientById, profileById, links]);

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
          <div><h1>Jobs</h1><p>{me.role === "staff" ? "Your jobs and unassigned jobs. Open an unassigned job and click Take this job to start on it." : "Every piece of client work, with its period, due date, owner and status."}</p></div>
          <div className="row"><button onClick={() => exportCsv(list)}>Export CSV</button><button onClick={() => setModal({ kind: "bulk" })}>Create jobs for a period</button><button className="primary" onClick={() => setModal({ kind: "job" })}>New job</button></div>
        </div>
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
              <table><thead><tr><H k="client">Client</H><H k="service">Service</H><H k="period">Period</H><H k="due">Due</H><H k="assigned">Assigned</H><H k="status">Status</H><th></th></tr></thead>
                <tbody>{shown.map((j) => (
                  <tr key={j.id}>
                    <td className="client"><button className="link" onClick={() => openClient(j.client_id)}>{clientName(j.client_id)}</button>{j.priority === "high" ? <span className="prio" title="High priority">!</span> : null}<div className="note">{practiceOf(clientById.get(j.client_id))}</div></td>
                    <td>{svcLabel(j.service)}</td><td className="mono">{j.period}</td><td><Due j={j} /></td>
                    <td>{personName(j.assignee_id) || <span className="muted">Unassigned</span>}{j.reviewer_id ? <div className="note">Review: {personName(j.reviewer_id)}</div> : null}</td>
                    <td><StatusSelect j={j} /></td>
                    <td><button onClick={() => setModal({ kind: "job", job: j })}>{closedFor(j) ? "View" : "Edit"}</button></td>
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
    const qd = q.replace(/\s+/g, "");
    const list = clients.filter((c) => (!cpractice || practiceOf(c) === cpractice) && (!cservice || c.services.includes(cservice)) && (!centity.length || centity.includes(c.entity))
      && (!q || [c.name, c.abn, c.contact, c.email, c.phone, c.address ?? ""].join(" ").toLowerCase().includes(q) || (qd.length >= 4 && /^\d+$/.test(qd) && [c.abn, c.phone].join(" ").replace(/\s+/g, "").includes(qd))));
    const show = (id: string) => ccols.includes(id);
    const filtered = !!(q || cpractice || cservice || centity.length);
    const linkCount = new Map<string, number>();
    links.forEach((l) => { linkCount.set(l.client_id, (linkCount.get(l.client_id) ?? 0) + 1); linkCount.set(l.related_id, (linkCount.get(l.related_id) ?? 0) + 1); });
    const openBy = new Map<string, Job[]>();
    openJobs.forEach((j) => openBy.set(j.client_id, [...(openBy.get(j.client_id) ?? []), j]));
    return (
      <>
        <div className="pagehead"><div><h1>Clients</h1><p>Who you act for and which services you provide each of them.</p></div><div className="row">{canManage ? <button onClick={() => setModal({ kind: "import" })}>Import from CSV or Excel</button> : null}<button className="primary" onClick={() => setModal({ kind: "client" })}>Add client</button></div></div>
        <div className="toolbar">
          <input type="search" id="cq" placeholder="Search name, ABN, contact, email, phone or address" aria-label="Search clients" value={cq} onChange={(e) => setCq(e.target.value)} />
          <select id="cpractice" aria-label="Practice" value={cpractice} onChange={(e) => setCpractice(e.target.value)}><option value="">All practices</option>{PRACTICES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          <select id="cservice" aria-label="Service" value={cservice} onChange={(e) => setCservice(e.target.value)}><option value="">Any service</option>{SERVICES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        <details className="colpick"><summary>Columns</summary><div className="colmenu">
            {CLIENT_COLS.map((col) => <label key={col.id}><input type="checkbox" checked={show(col.id)} onChange={(e) => setCcols(e.target.checked ? CLIENT_COLS.map((x) => x.id).filter((x) => x === col.id || ccols.includes(x)) : ccols.filter((x) => x !== col.id))} /> {col.label}</label>)}
            <button type="button" className="link" onClick={() => setCcols(DEFAULT_CLIENT_COLS)}>Reset to default</button>
          </div></details>
          {filtered ? <button onClick={() => { setCq(""); setCpractice(""); setCservice(""); setCentity([]); }}>Clear</button> : null}
          <span className="clientcount"><strong>{list.length.toLocaleString()}</strong> {filtered ? `of ${clients.length.toLocaleString()} ` : ""}client{list.length === 1 ? "" : "s"}</span>
        </div>
        <div className="toolbar entity-filter" role="group" aria-label="Show entity types" style={{ borderRadius: 0, borderTop: "1px solid var(--line)", gap: 6 }}>
          <span className="note" style={{ marginRight: 4 }}>Show:</span>
          {ENTITIES.map((x) => { const on = centity.includes(x); return (
            <label key={x} className={`chip${on ? " on" : ""}`}><input type="checkbox" checked={on} onChange={() => setCentity(on ? centity.filter((y) => y !== x) : [...centity, x])} /> {x === "SMSF" ? "Super fund (SMSF)" : x}</label>); })}
          {centity.length ? <button type="button" className="link" onClick={() => setCentity([])}>Show all</button> : <span className="note">All types shown. Tick to narrow down.</span>}
        </div>
        <div className="tablebox dragscroll" id="clients-table">
          {!list.length ? <div className="empty"><strong>{clients.length ? "No clients match." : "No clients yet."}</strong>{clients.length ? "Try another search." : "Add your first client, then tick the services you do for them."}</div> : (
            <>
              <table className="clienttable"><thead><tr><th>Client</th>{CLIENT_COLS.filter((col) => show(col.id)).map((col) => <th key={col.id} style={col.id === "open" ? { textAlign: "right" } : undefined}>{col.label}</th>)}</tr></thead>
                <tbody>{list.map((c) => { const oj = openBy.get(c.id) ?? []; const od = oj.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length; return (
                  <tr key={c.id}><td className="client"><button className="link clip" title={c.name} onClick={() => openClient(c.id)}>{c.name}</button>{linkCount.get(c.id) ? <span className="linkmark" title={`Linked to ${linkCount.get(c.id)} related client${linkCount.get(c.id) === 1 ? "" : "s"}`}>🔗 {linkCount.get(c.id)}</span> : null}{c.contact && !show("contact") ? <div className="note clip" title={c.contact}>{c.contact}</div> : null}</td>
                    {show("practice") ? <td>{practiceOf(c)}</td> : null}
                    {show("entity") ? <td>{c.entity}</td> : null}
                    {show("abn") ? <td className="mono nowrap">{c.abn}</td> : null}
                    {show("contact") ? <td><span className="clip w-contact" title={c.contact}>{c.contact}</span></td> : null}
                    {show("email") ? <td><span className="clip w-email" title={c.email}>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : null}</span></td> : null}
                    {show("phone") ? <td className="mono nowrap">{c.phone}</td> : null}
                    {show("address") ? <td><span className="clip w-address" title={c.address ?? ""}>{c.address}</span></td> : null}
                    {show("services") ? <td><span className="clip w-svc" title={c.services.map(svcLabel).join(", ")}>{c.services.map((s) => <span key={s} className="tag">{svcLabel(s)}{s === "bas" && c.bas_freq !== "quarterly" ? ` (${c.bas_freq})` : ""}{s === "payroll" && c.payroll_freq ? ` (${c.payroll_freq})` : ""}</span>)}</span></td> : null}
                    {show("manager") ? <td className="nowrap">{personName(c.manager_id)}</td> : null}
                    {show("open") ? <td className="mono" style={{ textAlign: "right" }}>{oj.length}{od ? <> <span className="pill danger">{od} overdue</span></> : null}</td> : null}</tr>); })}</tbody></table>
              <div className="count row" style={{ justifyContent: "space-between" }}><span>{list.length} client{list.length === 1 ? "" : "s"}</span>
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
      <table><thead><tr><th>Service</th><th>Period</th><th>Due</th><th>Assigned</th><th>Status</th><th></th></tr></thead>
        <tbody>{list.map((j) => (
          <tr key={j.id}><td>{svcLabel(j.service)}{j.priority === "high" ? <span className="prio">!</span> : null}</td><td className="mono">{j.period}</td><td><Due j={j} /></td>
            <td>{personName(j.assignee_id) || <span className="muted">Unassigned</span>}</td><td><StatusSelect j={j} /></td><td><button onClick={() => setModal({ kind: "job", job: j })}>{closedFor(j) ? "View" : "Edit"}</button></td></tr>))}</tbody></table>
    );
    return (
      <>
        <div className="pagehead">
          <div><button className="link" onClick={() => setClientId(null)}>← All clients</button><h1 style={{ marginTop: 6 }}>{c.name}</h1><p>{c.entity}{c.abn ? <> · ABN <span className="mono">{c.abn}</span></> : null}</p></div>
          <div className="row"><button onClick={() => setModal({ kind: "client", client: c })}>Edit client</button><button className="primary" onClick={() => setModal({ kind: "job", clientId: c.id })}>New job for this client</button></div>
        </div>
        <div className="detail">
          <div className="panel"><dl className="kv">
            <dt>Practice</dt><dd>{practiceOf(c)}</dd><dt>Contact</dt><dd>{c.contact || "—"}</dd><dt>Email</dt><dd>{c.email || "—"}</dd><dt>Phone</dt><dd className="mono">{c.phone || "—"}</dd><dt>Address</dt><dd>{c.address || "—"}</dd>
            <dt>Manager</dt><dd>{personName(c.manager_id) || "—"}</dd>
            <dt>Services</dt><dd>{c.services.length ? c.services.map((s) => <span key={s} className="tag">{svcLabel(s)}</span>) : "—"}</dd>
            {c.services.includes("payroll") ? <><dt>Payroll</dt><dd>{c.payroll_freq ? `${c.payroll_freq[0].toUpperCase()}${c.payroll_freq.slice(1)}, jobs created automatically` : "No automatic jobs"}</dd></> : null}
            {c.services.some((s) => SVC[s]?.kind === "bas") ? <><dt>BAS cycle</dt><dd>{c.bas_freq === "monthly" ? "Monthly" : c.bas_freq === "annual" ? "Annually" : "Quarterly"}</dd></> : null}
            {c.notes ? <><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{c.notes}</dd></> : null}
            <dt>Last change</dt><dd className="note">{fmtDate(c.updated_at)}{c.updated_by ? ` by ${personName(c.updated_by)}` : ""}</dd>
          </dl></div>
          <div className="section">
            <RelatedClients key={`rel-${c.id}`} client={c} clients={clients} links={links} supabase={supabase} say={say} missing={linksMissing} onOpen={openClient} onChanged={load} />
            {group.size > 1 ? <div id="group-work"><h2>Whole group: pending work ({groupJobs.length} job{groupJobs.length === 1 ? "" : "s"} across {group.size} clients)</h2>
              <div className="tablebox solo">
                {canManage && groupJobs.length ? <div className="toolbar groupbar">
                  <span className="note"><strong>{picked.length}</strong> ticked</span>
                  <select id="group-status" aria-label="New status for ticked jobs" value={gstatus} onChange={(e) => setGstatus(e.target.value)}>
                    <option value="">Change status to…</option>
                    {STATUSES.filter((s) => s.id !== "internal_query").map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                  <button type="button" className="primary" disabled={!picked.length || !gstatus} onClick={() => applyGroupStatus(picked)}>Apply to ticked jobs</button>
                  <button type="button" onClick={() => gotoJobs({ client: c.id, group: "1" })}>Open in Jobs</button>
                </div> : null}
                {groupJobs.length ? <table><thead><tr>
                  {canManage ? <th style={{ width: 32 }}><input type="checkbox" aria-label="Tick all" checked={allPicked} onChange={() => setGsel(allPicked ? new Set() : new Set(groupJobs.map((j) => j.id)))} /></th> : null}
                  <th>Client</th><th>Service</th><th>Period</th><th>Due</th><th>Assigned</th><th>Status</th><th></th></tr></thead>
                  <tbody>{groupJobs.map((j) => <tr key={j.id}>
                    {canManage ? <td><input type="checkbox" aria-label={`Tick ${clientName(j.client_id)} ${svcLabel(j.service)} ${j.period}`} checked={gsel.has(j.id)} onChange={() => { const n = new Set(gsel); if (n.has(j.id)) n.delete(j.id); else n.add(j.id); setGsel(n); }} /></td> : null}
                    <td>{j.client_id === c.id ? <strong>{clientName(j.client_id)}</strong> : <button className="link" onClick={() => openClient(j.client_id)}>{clientName(j.client_id)}</button>}</td>
                    <td>{svcLabel(j.service)}</td><td className="mono">{j.period}</td><td><Due j={j} /></td>
                    <td>{personName(j.assignee_id) || <span className="muted">Unassigned</span>}</td><td><StatusSelect j={j} /></td>
                    <td><button onClick={() => setModal({ kind: "job", job: j })}>Edit</button></td></tr>)}</tbody></table>
                  : <div className="empty">No pending work for anyone in this group.</div>}
              </div></div> : null}
            <ClientNotes key={c.id} clientId={c.id} meId={me.id} isManager={canManage} canDelete={canDelete} supabase={supabase} personName={personName} say={say} />
            <div><h2>Open jobs ({openJ.length})</h2><div className="tablebox solo">{openJ.length ? <Table list={openJ} /> : <div className="empty">No open jobs for this client.</div>}</div></div>
            {upcoming.length ? <div><h2>Upcoming jobs ({upcoming.length})</h2><div className="tablebox solo"><table><thead><tr><th>Service</th><th>Period</th><th>Created on</th><th>Due</th></tr></thead>
              <tbody>{upcoming.map((u) => <tr key={u.key}><td>{svcLabel(u.service)}</td><td className="mono">{u.period}</td><td><span className="pill">{fmtDate(u.appears)}</span></td><td>{u.due ? fmtDate(u.due) : <span className="muted">—</span>}</td></tr>)}</tbody></table>
              <div className="note" style={{ padding: "8px 12px" }}>Created automatically: BAS the day after the period ends, payroll on each pay day.</div></div></div> : null}
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
        <div className="tablebox solo"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th>{isMaster ? <th>Team leader</th> : null}<th title="Delete notes and comments. Only master admins can delete clients and jobs.">Can delete notes</th><th title="Can see Team workload and Working now on the Overview">Sees workload</th><th style={{ textAlign: "right" }}>Open jobs</th><th style={{ textAlign: "right" }}>Overdue</th><th></th></tr></thead>
          <tbody>{sorted.map((p) => { const oj = openJobs.filter((j) => j.assignee_id === p.id); const od = oj.filter((j) => j.due_date && daysFrom(j.due_date) < 0).length; return (
            <tr key={p.id}><td className="client">{p.full_name}{p.id === me.id ? " (you)" : ""}{p.title ? <div className="note">{p.title}</div> : null}</td>
              <td>{p.email}</td>
              <td><span className="role">{roleLabel(p.role)}</span>{!p.active ? <> <span className="pill danger">Access off</span></> : p.must_change_password ? <> <span className="pill warn">Hasn&apos;t signed in yet</span></> : null}</td>
              {isMaster ? <td>{p.role === "staff" ? personName(p.reports_to ?? null) || <span className="note">Not allocated</span> : null}</td> : null}
              <td>{p.role !== "staff" ? <span className="note">Always</span>
                : (isMaster || p.reports_to === me.id) && p.active
                  ? <button type="button" aria-pressed={!!p.can_delete} className={p.can_delete ? "primary" : undefined} title={p.can_delete ? "Click to take delete access away" : "Click to let them delete client notes and job comments"}
                      onClick={async () => { if (await adminCall(`/api/team/${p.id}/delete-access`, "PATCH", { allow: !p.can_delete })) say(p.can_delete ? `${p.full_name} can no longer delete notes` : `${p.full_name} can now delete notes and comments`); }}>{p.can_delete ? "Yes" : "No"}</button>
                  : p.can_delete ? "Yes" : "No"}</td>
              <td>{p.role === "master" ? <span className="note">Always</span>
                : isMaster && p.active
                  ? <button type="button" aria-pressed={!!p.can_see_workload} className={p.can_see_workload ? "primary" : undefined} title={p.can_see_workload ? "Click to hide Team workload and Working now from them" : "Click to let them see Team workload and Working now"}
                      onClick={async () => { if (await adminCall(`/api/team/${p.id}/workload-access`, "PATCH", { allow: !p.can_see_workload })) say(p.can_see_workload ? `${p.full_name} can no longer see the team workload` : `${p.full_name} can now see the team workload`); }}>{p.can_see_workload ? "Yes" : "No"}</button>
                  : p.can_see_workload ? "Yes" : "No"}</td>
              <td className="mono" style={{ textAlign: "right" }}>{oj.length}</td><td className="mono" style={{ textAlign: "right", color: od ? "var(--danger)" : undefined }}>{od}</td>
              <td style={{ textAlign: "right" }}>{isMaster && p.id !== me.id ? <button onClick={() => setModal({ kind: "member", member: p })}>Manage</button> : null}</td></tr>); })}</tbody></table></div>
        {!isMaster && sorted.length <= 1 ? <p className="note">No team members are allocated to you yet. Ask for team members to be allocated to you.</p> : null}
        <div className="panel" style={{ padding: 16, marginTop: 16 }}>
          <h2>What each role can do</h2>
          <p className="note" style={{ margin: 0 }}><strong>Staff</strong> work on the jobs assigned to them and add and update clients and jobs. <strong>Team leaders</strong> also see their own team members here, with their timesheets, what they&apos;re working on now and their workload, and can book meetings. The <strong>Master admin</strong> sees everyone, adds people, sets roles and permissions (Manage), and is the only one who can delete clients and jobs. Use the <strong>Sees workload</strong> and <strong>Can delete notes</strong> buttons, or Manage, to give extra permissions to one person.</p>
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
    if (n.job_id) {
      const j = jobs.find((x) => x.id === n.job_id);
      if (j) setModal({ kind: "job", job: j }); else say("That job has been deleted or is no longer visible to you.", true);
    } else if (n.meeting_id) {
      let m = meetings.find((x) => x.id === n.meeting_id);
      if (!m) { const { data } = await supabase.from("meetings").select("*").eq("id", n.meeting_id).maybeSingle(); m = (data as Meeting | null) ?? undefined; }
      if (m) setModal({ kind: "meeting", meeting: m }); else say("That meeting has been cancelled.", true);
    }
  }

  return (
    <Shell me={me} view={view} go={navGo} live={live} showTeam={canSeeTeam} badges={{ prospects: prospectsDue }} wide={view === "clients" && !clientId && ccols.length > 6} bell={<Bell supabase={supabase} meId={me.id} personName={personName} onOpen={openNotice} />}>
      {view === "overview" ? <Overview /> : null}
      {view === "jobs" ? JobsView() : null}
      {view === "payroll" ? <PayrollView key={navTick} jobs={jobs} clients={clients} meId={me.id} canSignOff={canManage} clientName={clientName} personName={personName} running={running} busy={timerBusy}
        onStart={startJob} onStop={stopJob} onSubmit={submitForReview} wasStarted={wasStarted} onStep={payrollStep} onOpen={(j) => setModal({ kind: "job", job: j })} onNew={() => setModal({ kind: "job", service: "payroll" })} /> : null}
      {view === "clients" ? (clientForDetail ? ClientDetail({ c: clientForDetail }) : ClientsView()) : null}
      {view === "prospects" && canSeeTeam ? <ProspectsView key={navTick} supabase={supabase} meId={me.id} team={team} clients={clients} canDelete={canDelete} personName={personName} say={say} onOpenClient={openClient} onChanged={load} /> : null}
      {view === "timesheet" ? <Timesheet key={navTick} me={me} supabase={supabase} people={people} visible={profiles.filter((p) => p.active)} clients={clients} jobs={jobs} canSeeTeam={canSeeTeam} say={say} /> : null}
      {view === "team" && canSeeTeam ? <TeamView /> : null}
      {view === "meetings" && canSeeTeam ? <MeetingsView key={navTick} meetings={meetings} meId={me.id} isMaster={isMaster} personName={personName} clientName={clientName}
        onBook={(date) => setModal({ kind: "meeting", date })} onOpen={(m) => setModal({ kind: "meeting", meeting: m })}
        quick={{ clients, team, supabase, say, onSaved: load, onEdit: (d) => setModal({ kind: "meeting", draft: d }) }} /> : null}

      {modal?.kind === "job" ? <JobModal job={modal.job} presetClient={modal.clientId} presetService={modal.service} isStaff={me.role === "staff"} leaderId={me.reports_to ?? null} statusLocked={!!modal.job && (staffNotStarted(modal.job) || staffSubmitted(modal.job))} statusLockMsg={modal.job && staffSubmitted(modal.job) ? SUBMITTED_LOCK_MSG : undefined} onOpenClient={(id) => { close(); openClient(id); }} clients={clients} team={team} canDelete={canDelete} canDeleteJob={isMaster} locked={!!modal.job && !canManage} readOnly={!!modal.job && !isOpen(modal.job.status) && !isMaster} meId={me.id} meName={me.full_name} onQuery={(j) => setModal({ kind: "query", job: j, mode: "send" })} onHandSign={(j) => setModal({ kind: "handsign", job: j })} canHandSign={(j) => canManage || (j.sign_owner ?? j.reviewer_id ?? j.assignee_id) === me.id} supabase={supabase} save={save} onClose={close} confirm={(m) => setModal({ kind: "confirm", ...m })} personName={personName} say={say} /> : null}
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

function JobModal({ job, presetClient, presetService, isStaff, leaderId, statusLocked, statusLockMsg, onOpenClient, clients, team, canDelete, canDeleteJob, locked: staffLock, readOnly, meId, meName, onQuery, onHandSign, canHandSign, supabase, save, onClose, confirm, personName, say }: {
  job?: Job; presetClient?: string; presetService?: string; isStaff: boolean; leaderId: string | null; statusLocked: boolean; statusLockMsg?: string; onOpenClient?: (id: string) => void; clients: Client[]; team: Person[]; canDelete: boolean; canDeleteJob: boolean; locked: boolean; readOnly: boolean; meId: string; meName: string; onQuery: (j: Job) => void; onHandSign: (j: Job) => void; canHandSign: (j: Job) => boolean; supabase: SB; save: SaveFn; onClose: () => void;
  confirm: (m: ConfirmArgs) => void; personName: (id: string | null) => string; say: (m: string, e?: boolean) => void;
}) {
  const locked = staffLock || readOnly;
  const preset = presetClient ? clients.find((c) => c.id === presetClient) : undefined;
  const [v, setV] = useState({
    client_id: job?.client_id ?? presetClient ?? "", service: job?.service ?? presetService ?? "bas", period: job?.period ?? "", due_date: job?.due_date ?? "",
    priority: job?.priority ?? "normal", assignee_id: job?.assignee_id ?? preset?.manager_id ?? "", reviewer_id: job?.reviewer_id ?? "",
    status: job?.status ?? "not_started", lodged_on: job?.lodged_on ?? "", notes: job?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"details" | "history" | "files" | "email">("details");
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
    const row: Partial<Job> = locked ? { status: v.status, notes: v.notes, ...(v.status === "lodged" && !job?.lodged_on ? { lodged_on: todayISO() } : {}) } : { ...v, period: v.period.trim(), due_date: v.due_date || null, assignee_id: v.assignee_id || null, reviewer_id: v.reviewer_id || null,
      lodged_on: v.lodged_on || (v.status === "lodged" ? todayISO() : null) };
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
  const pick = isStaff ? team.filter((p) => p.id === meId || p.id === v.assignee_id || p.id === v.reviewer_id || p.id === leaderId) : team;
  const opts = (blank: string) => <><option value="">{blank}</option>{pick.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</>;
  return (
    <Overlay onClose={onClose}><form className={`modal ${job ? "wide" : ""}`} onSubmit={submit}>
      <header><h2>{readOnly ? "Job (read-only)" : job ? "Edit job" : "New job"}</h2><button type="button" onClick={onClose}>Close</button></header>
      {job ? <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "details"} className={tab === "details" ? "on" : ""} onClick={() => setTab("details")}>Details</button>
        <button type="button" role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History &amp; time{sum ? ` · ${sum.hours ? fmtHours(sum.hours) : "0h"}${sum.comments ? ` · ${sum.comments} comment${sum.comments === 1 ? "" : "s"}` : ""}` : ""}</button>
        <button type="button" role="tab" aria-selected={tab === "files"} className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>Files{fileCount ? ` · ${fileCount}` : ""}</button>
        <button type="button" role="tab" aria-selected={tab === "email"} className={tab === "email" ? "on" : ""} onClick={() => setTab("email")}>Email client</button>
      </div> : null}
      {job && tab === "email" ? <div className="jobemailwrap"><JobEmail job={job} client={client} meName={meName} readOnly={readOnly} supabase={supabase} personName={personName} say={say} onSent={onClose} /></div> : null}
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
        <label className="f">Service<select id="m-service" disabled={locked} value={v.service} onChange={set("service")}>{SERVICES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
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
        <label className="f">Priority<select id="m-priority" disabled={locked} value={v.priority} onChange={set("priority")}><option value="normal">Normal</option><option value="high">High</option></select></label>
        <label className="f">Assigned to<select id="m-assignee" disabled={locked} value={v.assignee_id} onChange={set("assignee_id")}>{opts("Unassigned")}</select></label>
        <label className="f">Reviewer<select id="m-reviewer" disabled={locked} value={v.reviewer_id} onChange={set("reviewer_id")}>{opts("No reviewer")}</select></label>
        <label className="f">Status<select id="m-status" disabled={readOnly || statusLocked} title={statusLocked ? statusLockMsg ?? "Press Start on this job in My jobs first" : undefined} value={v.status} onChange={set("status")}>{STATUSES.map((s) => <option key={s.id} value={s.id} disabled={isStaff && STAFF_CANT_PICK.has(s.id) && s.id !== job?.status}>{s.label}</option>)}</select></label>
        {job && (job.status === "to_lodge" || job.status === "sent_for_sign") ? <div className="full hint">Signing handled by <strong>{personName(job.sign_owner ?? job.reviewer_id ?? job.assignee_id) || "nobody yet"}</strong>
          {canHandSign(job) ? <> · <button type="button" className="link" onClick={() => onHandSign(job)}>Hand to a team member</button></> : null}</div> : null}
        <label className="f">Lodged on<input id="m-lodged" type="date" disabled={locked} value={v.lodged_on} onChange={set("lodged_on")} /></label>
        <label className="f full">Notes<textarea id="m-notes" readOnly={readOnly} placeholder="Records outstanding, queries for the client, lodgment receipt number…" value={v.notes} onChange={set("notes")} /></label>
        {job ? <div className="full hint">Last changed {fmtDate(job.updated_at)}{job.updated_by ? ` by ${personName(job.updated_by)}` : ""}{logged ? <> · <button type="button" className="link" onClick={() => setTab("history")}>{fmtHours(logged)} logged, see history</button></> : null}</div> : null}
      </div>
      <footer style={{ display: tab === "email" ? "none" : undefined }}>
        {job && canDeleteJob ? <button type="button" className="danger" onClick={() => confirm({ title: "Delete this job?", text: "The job and its notes are removed for everyone. This cannot be undone.", yes: "Delete job", run: () => save(() => supabase.from("jobs").delete().eq("id", job.id), "Job deleted") })}>Delete job</button> : <span />}
        <div className="row">{job && staffLock && !job.assignee_id && !readOnly ? <button type="button" disabled={busy} onClick={async () => { if (await save(() => supabase.from("jobs").update({ assignee_id: meId }).eq("id", job.id), "The job is yours. It's in My jobs now")) onClose(); }}>Take this job</button> : null}
          <button type="button" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</button>{readOnly ? null : <button type="submit" className="primary" disabled={busy}>{job ? "Save changes" : "Create job"}</button>}</div>
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
  const [perm, setPerm] = useState({ canDelete: !!member?.can_delete, canSeeWorkload: !!member?.can_see_workload });
  const [teamIds, setTeamIds] = useState<string[]>(() => (member ? staff.filter((s) => s.reports_to === member.id).map((s) => s.id) : []));
  const extra = () => ({ canDelete: v.role === "staff" ? perm.canDelete : false, canSeeWorkload: v.role === "master" ? false : perm.canSeeWorkload, ...(v.role === "manager" ? { team: teamIds } : {}) });
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
          <span className="note">Only master admins can delete clients and jobs.</span>
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
  const others = team.filter((p) => p.id !== me.id);
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
