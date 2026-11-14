"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Client, Job, Person } from "@/lib/types";
import { ST, svcLabel } from "@/lib/domain";

type SB = ReturnType<typeof createClient>;
interface Act { id: string; job_id: string; actor_id: string | null; kind: string; from_value: string | null; to_value: string | null; body: string; created_at: string }
interface Login { id: string; user_id: string; clock_in: string; clock_out: string | null }
interface Row { id: string; at: string; who: string | null; type: "status" | "assign" | "comment" | "created" | "login"; text: string; job?: Job }

const TYPES: { id: "" | Row["type"]; label: string }[] = [
  { id: "", label: "All" }, { id: "status", label: "Status changes" }, { id: "assign", label: "Assigned" },
  { id: "comment", label: "Comments and queries" }, { id: "created", label: "Jobs created" }, { id: "login", label: "Log-ins" },
];
const TAG: Record<Row["type"], string> = { status: "info", assign: "accent", comment: "warn", created: "ok", login: "" };
const TAG_LABEL: Record<Row["type"], string> = { status: "Status", assign: "Assigned", comment: "Comment", created: "New job", login: "Log-in" };
const when = (s: string) => new Date(s).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const stLabel = (s: string | null) => (s ? ST[s]?.label ?? s : "—");
const DAYS = [{ v: 1, l: "Today" }, { v: 7, l: "Last 7 days" }, { v: 30, l: "Last 30 days" }];

/** Practice-wide log: who did what across all jobs, plus log-ins. For master admins and team leaders. */
export default function ActivityLog({ supabase, jobs, clients, people, onOpenJob }: {
  supabase: SB; jobs: Job[]; clients: Client[]; people: Person[]; onOpenJob: (j: Job) => void;
}) {
  const [acts, setActs] = useState<Act[]>([]);
  const [logins, setLogins] = useState<Login[]>([]);
  const [type, setType] = useState<"" | Row["type"]>("");
  const [who, setWho] = useState("");
  const [days, setDays] = useState(7);
  const [q, setQ] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - days * 864e5);
    if (days === 1) since.setHours(0, 0, 0, 0);
    const [a, l] = await Promise.all([
      supabase.from("job_activity").select("*").gte("created_at", since.toISOString()).order("created_at", { ascending: false }).limit(1000),
      supabase.from("attendance").select("id,user_id,clock_in,clock_out").gte("clock_in", since.toISOString()).order("clock_in", { ascending: false }).limit(500),
    ]);
    setActs((a.data as Act[] | null) ?? []);
    setLogins((l.data as Login[] | null) ?? []);
    setLoaded(true);
  }, [supabase, days]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`activity-log-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "job_activity" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, load]);

  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const clientName = useMemo(() => { const m = new Map(clients.map((c) => [c.id, c.name])); return (id: string) => m.get(id) ?? "Client"; }, [clients]);
  const name = useCallback((id: string | null) => (id ? people.find((p) => p.id === id)?.full_name ?? "Former staff" : "Portal"), [people]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const a of acts) {
      const job = jobById.get(a.job_id);
      const t: Row["type"] = a.kind === "status" ? "status" : a.kind === "assignee" || a.kind === "reviewer" ? "assign" : a.kind === "created" ? "created" : a.kind === "comment" ? "comment" : "status";
      let text = a.body || "";
      if (a.kind === "status") text = `Status ${stLabel(a.from_value)} → ${stLabel(a.to_value)}`;
      else if (a.kind === "assignee") text = `Assigned to ${a.to_value ? name(a.to_value) : "nobody"}`;
      else if (a.kind === "reviewer") text = `Reviewer set to ${a.to_value ? name(a.to_value) : "nobody"}`;
      else if (a.kind === "due") text = `Due date changed to ${a.to_value ?? "none"}`;
      else if (a.kind === "super") text = a.body || "Super confirmed";
      else if (a.kind === "stp") text = a.body || "STP lodged";
      else if (a.kind === "created") text = text || "Job created";
      out.push({ id: a.id, at: a.created_at, who: a.actor_id, type: t, text, job });
    }
    for (const l of logins) {
      out.push({ id: `in-${l.id}`, at: l.clock_in, who: l.user_id, type: "login", text: "Logged in" });
      if (l.clock_out) out.push({ id: `out-${l.id}`, at: l.clock_out, who: l.user_id, type: "login", text: "Logged out" });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [acts, logins, jobById, name]);

  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!type || r.type === type) && (!who || r.who === who)
    && (!needle || `${r.text} ${r.job ? clientName(r.job.client_id) : ""} ${name(r.who)}`.toLowerCase().includes(needle)));
  const count = (t: "" | Row["type"]) => rows.filter((r) => (!t || r.type === t) && (!who || r.who === who)).length;

  return (
    <div className="section" id="activity-log" style={{ marginTop: 24 }}>
      <div className="pagehead"><div><h2 style={{ fontSize: 20, margin: 0 }}>🕘 Activity log</h2><p>Who did what across the practice: status changes, assignments, comments, queries and log-ins.</p></div></div>
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <div className="row" style={{ width: "100%" }}>{TYPES.map((t) => <button key={t.id || "all"} type="button" className={type === t.id ? "primary" : undefined} onClick={() => setType(t.id)}>{t.label} <span className="note">{count(t.id)}</span></button>)}</div>
        <input type="search" aria-label="Search the log" placeholder="Search client, person or text…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
        <select aria-label="Person" value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{people.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
        <select aria-label="When" value={days} onChange={(e) => setDays(Number(e.target.value))}>{DAYS.map((d) => <option key={d.v} value={d.v}>{d.l}</option>)}</select>
      </div>
      <div className="tablebox solo">
        {!loaded ? <div className="empty">Loading…</div> : !shown.length ? <div className="empty"><strong>Nothing here for these filters.</strong>Changes to jobs and log-ins show here as they happen.</div> : (
          <table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Client and job</th></tr></thead>
            <tbody>{shown.slice(0, 300).map((r) => (
              <tr key={r.id}><td style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td><td>{name(r.who)}</td>
                <td><span className={`pill ${TAG[r.type]}`}>{TAG_LABEL[r.type]}</span> <span style={{ whiteSpace: "pre-wrap" }}>{r.text.length > 220 ? `${r.text.slice(0, 220)}…` : r.text}</span></td>
                <td>{r.job ? <button type="button" className="link" onClick={() => onOpenJob(r.job!)}>{clientName(r.job.client_id)} · {svcLabel(r.job.service)} {r.job.period}</button> : <span className="note">—</span>}</td></tr>))}</tbody></table>
        )}
        {shown.length > 300 ? <div className="count">Showing the latest 300 of {shown.length}. Narrow the filters to see more.</div> : null}
      </div>
    </div>
  );
}
