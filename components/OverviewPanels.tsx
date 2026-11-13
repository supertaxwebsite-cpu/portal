"use client";
import { useEffect, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Job } from "@/lib/types";
import { svcLabel, todayISO } from "@/lib/domain";

type SB = ReturnType<typeof createClient>;
interface Q { id: string; job_id: string; parent_id: string | null; author_id: string | null; to_id: string | null; body: string; answered_at: string | null; created_at: string }
interface Pr { id: string; name: string; follow_up: string | null; fee: number | null; stage: string; owner_id: string | null }
const ago = (ts: string) => { const d = Math.floor((Date.now() - Date.parse(ts)) / 864e5); return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; };

/** The manager's to-do across the practice: queries to answer, reviews, client signatures to chase, prospects to follow up. */
export function NeedsAttention({ supabase, meId, canManage, jobs, clientName, personName, onOpen, onFollowedUp, onProspects }: {
  supabase: SB; meId: string; canManage: boolean; jobs: Job[]; clientName: (id: string) => string; personName: (id: string | null) => string;
  onOpen: (j: Job) => void; onFollowedUp: (j: Job) => void; onProspects: () => void;
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
  const twoDays = (ts: string | null | undefined) => !!ts && Date.now() - Date.parse(ts) >= 2 * 864e5;
  const mineToChase = (j: Job) => canManage || (j.sign_owner ?? j.reviewer_id ?? j.assignee_id) === meId;
  const chase = jobs.filter((j) => (j.status === "sent_for_sign" || j.status === "client_query") && twoDays(j.sign_sent_at) && mineToChase(j));
  const n = toAnswer.length + reviews.length + chase.length + pr.length;
  return (
    <div className="panel attention">
      <div className="ph"><h2>Needs your attention</h2><span className="note">Most urgent first</span></div>
      {!n ? <div className="empty"><strong>Nothing waiting on you.</strong>Queries to answer, reviews, client signatures to chase and prospect follow-ups show here.</div> : (
        <ul className="list">
          {toAnswer.map((q) => { const j = byId.get(q.job_id)!; return (
            <li key={q.id}><span className="pill danger">Query</span><div className="grow"><div className="t">{clientName(j.client_id)} · {svcLabel(j.service)} {j.period}</div>
              <div className="s">{personName(q.author_id) || "Someone"} asks: &ldquo;{q.body.length > 110 ? `${q.body.slice(0, 110)}…` : q.body}&rdquo;</div></div>
              <button type="button" className="primary" onClick={() => onOpen(j)}>Answer</button></li>); })}
          {reviews.map((j) => (
            <li key={j.id}><span className="pill info">Review</span><div className="grow"><div className="t">{clientName(j.client_id)} · {svcLabel(j.service)} {j.period}</div>
              <div className="s">Prepared by {personName(j.assignee_id) || "someone"}</div></div>
              <button type="button" className="primary" onClick={() => onOpen(j)}>Start review</button></li>))}
          {chase.map((j) => (
            <li key={j.id}><span className="pill warn">{j.status === "client_query" ? "Client query" : "Signing"}</span><div className="grow"><div className="t">{clientName(j.client_id)} · {svcLabel(j.service)} {j.period}</div>
              <div className="s">{j.status === "client_query" ? "Query sent" : "Sent for signing"} {ago(j.sign_sent_at!)}, no {j.status === "client_query" ? "reply" : "signature"} yet</div></div>
              <div className="row"><button type="button" onClick={() => onFollowedUp(j)}>Still waiting</button><button type="button" onClick={() => onOpen(j)}>Open</button></div></li>))}
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

/** Review notes raised this month for each person: who needs training on what. */
export function ReviewByPerson({ supabase, people }: { supabase: SB; people: { id: string; full_name: string }[] }) {
  const [rows, setRows] = useState<{ to_id: string | null; severity: string; category: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    supabase.from("review_notes").select("to_id,severity,category").gte("created_at", `${todayISO().slice(0, 7)}-01`).then(({ data, error }) => { if (live) setRows(error ? null : (data as { to_id: string | null; severity: string; category: string }[])); });
    return () => { live = false; };
  }, [supabase]);
  if (!rows) return null;
  const list = people.map((p) => { const mine = rows.filter((r) => r.to_id === p.id); return { p, n: mine.length, major: mine.filter((r) => r.severity === "major").length, top: [...new Set(mine.map((r) => r.category))].slice(0, 2) }; }).sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...list.map((x) => x.n));
  return (
    <div className="panel">
      <div className="ph"><h2>Review notes this month</h2></div>
      <div className="leaveleft">{list.map(({ p, n, major, top }) => (
        <div key={p.id} className="row" title={top.join(", ")}><span className="nm" style={{ fontWeight: 600 }}>{p.full_name.split(" ")[0]}</span><i><b style={{ width: `${(n / max) * 100}%`, background: "#b26a00" }} /></i><span className="note" style={{ width: 120 }}>{n ? `${n} note${n === 1 ? "" : "s"}${major ? ` · ${major} major` : ""}` : "none"}</span></div>))}</div>
      <p className="note" style={{ margin: "0 16px 14px" }}>Helps spot who needs training on what. Hover a name to see the types of mistakes.</p>
    </div>
  );
}
