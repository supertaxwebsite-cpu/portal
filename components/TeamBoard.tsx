"use client";
import { useEffect, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Job, JobTimer } from "@/lib/types";
import { daysFrom, svcLabel, todayISO } from "@/lib/domain";

type SB = ReturnType<typeof createClient>;
export interface BoardRow { id: string; name: string; title: string; js: Job[] }
interface Hours { today: Record<string, number>; week: Record<string, number>; inNow: Set<string>; notes: { to_id: string | null; status: string; category: string; created_at: string }[] | null }

/** 6-day week (Mon to Sat) at 8h 15m a day. */
const WEEK_TARGET = 6 * 8.25;
const fmt = (h: number) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
const monday = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const elapsed = (s: string, now: number) => { const m = Math.max(0, Math.floor((now - Date.parse(s)) / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };

// Kept outside the component so the board doesn't re-fetch every time the overview redraws.
let cache: { at: number; key: string; data: Hours } | null = null;

/** Who is working on what right now, open and overdue jobs, and hours today / this week per person. */
export default function TeamBoard({ supabase, rows, timers, jobById, clientName, meId, title, onOpen, onViewTasks }: {
  supabase: SB; rows: BoardRow[]; timers: JobTimer[]; jobById: (id: string) => Job | undefined; clientName: (id: string) => string;
  meId: string; title: string; onOpen: (j: Job) => void; onViewTasks: (id: string) => void;
}) {
  const ids = rows.map((r) => r.id).filter((x) => x !== "__none");
  const key = `${todayISO()}|${ids.join(",")}`;
  const [hours, setHours] = useState<Hours | null>(cache?.key === key ? cache.data : null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (cache?.key === key && Date.now() - cache.at < 60000) { setHours(cache.data); return; }
    let live = true;
    (async () => {
      const from = monday(), today = todayISO();
      const [e, a, rn] = await Promise.all([
        supabase.from("timesheet_entries").select("user_id,work_date,hours").gte("work_date", from).lte("work_date", today),
        supabase.from("attendance").select("user_id").is("clock_out", null),
        supabase.from("review_notes").select("to_id,status,category,created_at").gte("created_at", `${today.slice(0, 4)}-01-01`),
      ]);
      const data: Hours = { notes: rn.error ? null : (rn.data as Hours["notes"]), today: {}, week: {}, inNow: new Set(((a.data as { user_id: string }[] | null) ?? []).map((x) => x.user_id)) };
      for (const r of (e.data as { user_id: string; work_date: string; hours: number }[] | null) ?? []) {
        const h = Number(r.hours) || 0;
        data.week[r.user_id] = (data.week[r.user_id] ?? 0) + h;
        if (r.work_date === today) data.today[r.user_id] = (data.today[r.user_id] ?? 0) + h;
      }
      cache = { at: Date.now(), key, data };
      if (live) setHours(data);
    })();
    return () => { live = false; };
  }, [supabase, key, now]);

  return (
    <div className="panel teamboard" style={{ marginBottom: 16 }}>
      <div className="ph"><h2>{title}</h2><span className="note">Live: who is working on what right now</span></div>
      <div style={{ overflowX: "auto" }}>
        <table><thead><tr><th>Team member</th><th>Working now</th><th style={{ textAlign: "right" }}>Open jobs</th><th style={{ textAlign: "right" }}>Overdue</th><th style={{ textAlign: "right" }}>Hours today</th><th>Hours this week</th>{hours?.notes ? <th>Review notes</th> : null}<th></th></tr></thead>
          <tbody>{rows.map((r) => {
            const t = timers.find((x) => x.user_id === r.id);
            const j = t?.job_id ? jobById(t.job_id) : undefined;
            const od = r.js.filter((x) => x.due_date && daysFrom(x.due_date) < 0).length;
            const wk = hours?.week[r.id] ?? 0;
            const none = r.id === "__none";
            return (
              <tr key={r.id}>
                <td className="client">{r.name}{r.id === meId ? <span className="note"> (you)</span> : null}{r.title ? <div className="note">{r.title}</div> : null}</td>
                <td>{none ? <span className="note">Jobs with nobody on them</span>
                  : t ? <span><span className="livedot on" /> {j ? <button type="button" className="link" style={{ color: "var(--fg)" }} onClick={() => onOpen(j)}><strong>{clientName(j.client_id)}</strong></button> : "A job"}{j ? <span className="note"> · {svcLabel(j.service)} {j.period}</span> : null} <span className="mono note">· {elapsed(t.started_at, now)}</span></span>
                  : <span className="note"><span className="livedot" /> {hours?.inNow.has(r.id) ? "Logged in · no job running" : "Not logged in"}</span>}</td>
                <td className="mono" style={{ textAlign: "right" }}>{r.js.length}</td>
                <td className="mono" style={{ textAlign: "right", color: od ? "var(--danger)" : "var(--ok)" }}>{od}</td>
                <td className="mono" style={{ textAlign: "right" }}>{none ? "" : hours ? `${(hours.today[r.id] ?? 0).toFixed(1)}h` : "…"}</td>
                <td>{none ? null : <div className="wkbar" title={`${fmt(wk)} of ${fmt(WEEK_TARGET)} (Mon to Sat, 8h 15m a day)`}><span className="mono">{fmt(wk)} / {fmt(WEEK_TARGET)}</span><i><b style={{ width: `${Math.min(100, (wk / WEEK_TARGET) * 100)}%` }} /></i></div>}</td>
                {hours?.notes ? <td>{none ? null : (() => { const mine = hours.notes!.filter((x) => x.to_id === r.id); const op = mine.filter((x) => x.status !== "cleared").length; return mine.length ? <span><span className={`pill ${op ? "danger" : "ok"}`}>{op} open</span> <span className="note">{mine.length} this year</span></span> : <span className="note">—</span>; })()}</td> : null}
                <td style={{ textAlign: "right" }}><button type="button" onClick={() => onViewTasks(r.id)}>View jobs</button></td>
              </tr>);
          })}</tbody></table>
      </div>
      {hours?.notes?.length ? (() => {
        const month = todayISO().slice(0, 7);
        const m = hours.notes!.filter((x) => x.created_at.slice(0, 7) === month);
        const types = [...new Set(m.map((x) => x.category))].map((c) => ({ c, n: m.filter((x) => x.category === c).length })).sort((a, b) => b.n - a.n);
        return types.length ? <div className="rntypes"><span className="note">Review notes this month by type:</span>{types.map((t) => <span key={t.c} className="pill warn">{t.c} {t.n}</span>)}</div> : null;
      })() : null}
    </div>
  );
}
