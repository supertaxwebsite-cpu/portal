"use client";
import { Fragment, useEffect, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Job } from "@/lib/types";
import { svcLabel, todayISO } from "@/lib/domain";

type SB = ReturnType<typeof createClient>;
interface Q { id: string; job_id: string; parent_id: string | null; author_id: string | null; to_id: string | null; body: string; answered_at: string | null; created_at: string }
interface Pr { id: string; name: string; follow_up: string | null; fee: number | null; stage: string; owner_id: string | null }
const ago = (ts: string) => { const d = Math.floor((Date.now() - Date.parse(ts)) / 864e5); return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; };

/** Internal queries raised to me that nobody has answered yet. */
export function useMyQueries(supabase: SB, meId: string, jobs: Job[], on: boolean) {
  const [qs, setQs] = useState<Q[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    supabase.from("job_queries").select("id,job_id,parent_id,author_id,to_id,body,answered_at,created_at").gte("created_at", new Date(Date.now() - 120 * 864e5).toISOString()).limit(2000)
      .then(({ data }) => { if (live) setQs((data as Q[] | null) ?? []); });
    return () => { live = false; };
  }, [supabase, meId, jobs, on]);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const replied = new Set(qs.filter((x) => x.parent_id).map((x) => x.parent_id));
  return qs.filter((x) => !x.parent_id && !x.answered_at && !replied.has(x.id) && x.to_id === meId && byId.has(x.job_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at)).map((q) => ({ q, j: byId.get(q.job_id)! }));
}

/** The "Internal queries" view on the overview: every open query raised to me, oldest first. */
export function MyQueries({ list, clientName, personName, onOpen }: {
  list: { q: Q; j: Job }[]; clientName: (id: string) => string; personName: (id: string | null) => string; onOpen: (j: Job) => void;
}) {
  return (
    <div className="panel attention">
      <div className="ph"><h2>Internal queries raised to you</h2><span className="note">Oldest first</span></div>
      {!list.length ? <div className="empty"><strong>No queries waiting on you.</strong>When someone in the team raises an internal query to you, it shows here.</div> : (
        <ul className="list">{list.map(({ q, j }) => (
          <li key={q.id}><span className="pill danger">Query</span><div className="grow"><div className="t">{clientName(j.client_id)} · {svcLabel(j.service)} {j.period}</div>
            <div className="s">{personName(q.author_id) || "Someone"} asked {ago(q.created_at)}: &ldquo;{q.body.length > 160 ? `${q.body.slice(0, 160)}…` : q.body}&rdquo;</div></div>
            <button type="button" className="primary" onClick={() => onOpen(j)}>Answer</button></li>))}</ul>)}
    </div>
  );
}

/** The manager's to-do across the practice: queries to answer, reviews, prospects to follow up. Signing reminders stay in the bell. */
export function NeedsAttention({ supabase, meId, jobs, clientName, personName, onOpen, onProspects }: {
  supabase: SB; meId: string; jobs: Job[]; clientName: (id: string) => string; personName: (id: string | null) => string;
  onOpen: (j: Job) => void; onProspects: () => void;
}) {
  const [qs, setQs] = useState<Q[]>([]);
  const [pr, setPr] = useState<Pr[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const [q, p] = await Promise.all([
        supabase.from("job_queries").select("id,job_id,parent_id,author_id,to_id,body,answered_at,created_at").gte("created_at", new Date(Date.now() - 120 * 864e5).toISOString()).limit(2000),
        supabase.from("prospects").select("id,name,follow_up,fee,stage,owner_id").lte("follow_up", todayISO()),
      ]);
      if (!live) return;
      setQs((q.data as Q[] | null) ?? []);
      setPr(((p.data as Pr[] | null) ?? []).filter((x) => x.owner_id === meId && x.stage !== "won" && x.stage !== "lost"));
    })();
    return () => { live = false; };
  }, [supabase, meId, jobs]);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const replied = new Set(qs.filter((x) => x.parent_id).map((x) => x.parent_id));
  const toAnswer = qs.filter((x) => !x.parent_id && !x.answered_at && !replied.has(x.id) && x.to_id === meId && byId.has(x.job_id));
  const reviews = jobs.filter((j) => j.status === "review" && j.reviewer_id === meId);
  const n = toAnswer.length + reviews.length + pr.length;
  return (
    <div className="panel attention">
      <div className="ph"><h2>Needs your attention</h2><span className="note">Most urgent first</span></div>
      {!n ? <div className="empty"><strong>Nothing waiting on you.</strong>Queries to answer, reviews and prospect follow-ups show here.</div> : (
        <ul className="list">
          {toAnswer.map((q) => { const j = byId.get(q.job_id)!; return (
            <li key={q.id}><span className="pill danger">Query</span><div className="grow"><div className="t">{clientName(j.client_id)} · {svcLabel(j.service)} {j.period}</div>
              <div className="s">{personName(q.author_id) || "Someone"} asks: &ldquo;{q.body.length > 110 ? `${q.body.slice(0, 110)}…` : q.body}&rdquo;</div></div>
              <button type="button" className="primary" onClick={() => onOpen(j)}>Answer</button></li>); })}
          {reviews.map((j) => (
            <li key={j.id}><span className="pill info">Review</span><div className="grow"><div className="t">{clientName(j.client_id)} · {svcLabel(j.service)} {j.period}</div>
              <div className="s">Prepared by {personName(j.assignee_id) || "someone"}</div></div>
              <button type="button" className="primary" onClick={() => onOpen(j)}>Start review</button></li>))}
          {pr.map((p) => (
            <li key={p.id}><span className="pill accent">Prospect</span><div className="grow"><div className="t">{p.name}</div>
              <div className="s">Follow-up {p.follow_up === todayISO() ? "due today" : "overdue"}{p.fee ? ` · quoted $${p.fee.toLocaleString()} + GST` : ""}</div></div>
              <button type="button" onClick={onProspects}>Open</button></li>))}
        </ul>)}
    </div>
  );
}

/** Review notes raised this month, grouped by type, with who they went to. */
export function ReviewTypes({ supabase, personName, visible }: { supabase: SB; personName: (id: string | null) => string; visible: Set<string> }) {
  const [rows, setRows] = useState<{ to_id: string | null; category: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    supabase.from("review_notes").select("to_id,category").gte("created_at", `${todayISO().slice(0, 7)}-01`).then(({ data, error }) => { if (live) setRows(error ? null : (data as { to_id: string | null; category: string }[])); });
    return () => { live = false; };
  }, [supabase]);
  if (!rows) return null;
  const mine = rows.filter((r) => !r.to_id || visible.has(r.to_id));
  const types = [...new Set(mine.map((r) => r.category))].map((c) => ({ c, list: mine.filter((r) => r.category === c) })).sort((a, b) => b.list.length - a.list.length);
  return (
    <div className="panel rtypes">
      <div className="ph"><h2>Review notes by type</h2><span className="note">This month</span></div>
      {!types.length ? <div className="empty"><strong>No review notes this month.</strong>Mistakes found in review are counted here by type.</div> : (
        <ul className="list">{types.map(({ c, list }) => {
          const who = [...new Set(list.map((r) => r.to_id))].map((id) => ({ id, n: list.filter((r) => r.to_id === id).length })).sort((a, b) => b.n - a.n);
          return <li key={c}><span className={`pill ${list.length >= 5 ? "danger" : "warn"}`}>{list.length}</span><div className="grow"><div className="t">{c}</div>
            <div className="s">{who.map((w) => `${(personName(w.id) || "Someone").split(" ")[0]} ${w.n}`).join(" · ")}</div></div></li>; })}</ul>)}
    </div>
  );
}

/** Every review note counts, open or cleared: how many mistakes each person made, by period, severity and type. */
type RN = { id: string; job_id: string; to_id: string | null; author_id: string | null; severity: string; category: string; status: string; body: string; created_at: string };
const PERIODS: [string, string][] = [["month", "This month"], ["last", "Last month"], ["fy", "This financial year"], ["year", "This calendar year"], ["all", "All time"]];
function periodRange(p: string): [string | null, string | null] {
  const t = todayISO(); const y = +t.slice(0, 4), m = +t.slice(5, 7);
  const ym = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  if (p === "month") return [ym(y, m), null];
  if (p === "last") return m === 1 ? [ym(y - 1, 12), ym(y, 1)] : [ym(y, m - 1), ym(y, m)];
  if (p === "fy") return [m >= 7 ? ym(y, 7) : ym(y - 1, 7), null];
  if (p === "year") return [ym(y, 1), null];
  return [null, null];
}
export function ReviewByPerson({ supabase, people, personName, jobLabel, onOpenJob }: {
  supabase: SB; people: { id: string; full_name: string }[]; personName: (id: string | null) => string; jobLabel?: (id: string) => string; onOpenJob?: (id: string) => void;
}) {
  const [period, setPeriod] = useState("month");
  const [rows, setRows] = useState<RN[] | null>(null);
  const [openP, setOpenP] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const [from, to] = periodRange(period);
    let q = supabase.from("review_notes").select("id,job_id,to_id,author_id,severity,category,status,body,created_at").order("created_at", { ascending: false }).limit(5000);
    if (from) q = q.gte("created_at", from);
    if (to) q = q.lt("created_at", to);
    q.then(({ data, error }) => { if (live) setRows(error ? null : (data as RN[])); });
    return () => { live = false; };
  }, [supabase, period]);
  if (!rows) return null;
  const ids = [...new Set([...people.map((p) => p.id), ...rows.map((r) => r.to_id).filter((x): x is string => !!x)])];
  const list = ids.map((id) => { const mine = rows.filter((r) => r.to_id === id);
    const types = [...new Set(mine.map((r) => r.category))].map((c) => ({ c, n: mine.filter((r) => r.category === c).length })).sort((a, b) => b.n - a.n);
    return { id, name: people.find((p) => p.id === id)?.full_name ?? personName(id) ?? "Someone", mine, n: mine.length, major: mine.filter((r) => r.severity === "major").length, open: mine.filter((r) => r.status !== "cleared").length, types };
  }).filter((x) => x.n || people.some((p) => p.id === x.id)).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const total = rows.length;
  const when = (s: string) => new Date(s).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit" });
  return (
    <div className="panel rtally" id="review-tally">
      <div className="ph"><h2>Review notes by person</h2>
        <select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      <p className="note" style={{ margin: "0 16px 8px" }}>Every review note counts, including ones that were fixed and cleared. {total} in this period. Click a name to see each note.</p>
      <table className="rttable"><thead><tr><th>Person</th><th>Total</th><th>Major</th><th>Minor</th><th>Still open</th><th>Cleared</th><th>Most common</th></tr></thead>
        <tbody>{list.map((x) => <Fragment key={x.id}>
          <tr className={x.n ? "click" : undefined} onClick={() => x.n && setOpenP(openP === x.id ? null : x.id)}>
            <td><strong>{x.name}</strong>{x.n ? <span className="note"> {openP === x.id ? "▾" : "▸"}</span> : null}</td><td><strong>{x.n}</strong></td>
            <td>{x.major ? <span className="pill danger">{x.major}</span> : "0"}</td><td>{x.n - x.major}</td>
            <td>{x.open ? <span className="pill warn">{x.open}</span> : "0"}</td><td>{x.n - x.open}</td>
            <td className="note">{x.types.slice(0, 3).map((t) => `${t.c} ${t.n}`).join(" · ") || "—"}</td></tr>
          {openP === x.id ? <tr className="rtdetail"><td colSpan={7}><ul className="rtnotes">{x.mine.map((r) => (
            <li key={r.id}><span className={`pill ${r.severity === "major" ? "danger" : "warn"}`}>{r.severity === "major" ? "Major" : "Minor"}</span>
              <div className="grow"><div className="t">{r.category} · {r.status === "cleared" ? "Cleared" : r.status === "fixed" ? "Fixed, to check" : "Open"}{jobLabel ? ` · ${jobLabel(r.job_id)}` : ""}</div>
                <div className="s">{when(r.created_at)} · by {personName(r.author_id) || "reviewer"} · {r.body.length > 140 ? `${r.body.slice(0, 140)}…` : r.body}</div></div>
              {onOpenJob ? <button type="button" className="link" onClick={() => onOpenJob(r.job_id)}>Open job</button> : null}</li>))}</ul></td></tr> : null}
        </Fragment>)}</tbody></table>
    </div>
  );
}
