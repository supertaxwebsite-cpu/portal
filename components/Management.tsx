"use client";
import { useCallback, useEffect, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Client } from "@/lib/types";
import { fmtDate, daysFrom } from "@/lib/domain";
import ClientPicker from "./ClientPicker";

type SB = ReturnType<typeof createClient>;
interface Task { id: string; title: string; client_id: string | null; due_date: string | null; details: string; status: "open" | "done"; created_by: string | null; created_at: string; done_by: string | null; done_at: string | null }
interface Comment { id: string; task_id: string; author_id: string | null; body: string; created_at: string }
const when = (s: string) => new Date(s).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Management jobs: only master admins see them. No stages or checklist, just comments and Complete.
 *  compact = the panel on My tasks (open jobs only); otherwise the full Management page. */
export default function Management({ supabase, meId, clients, personName, say, compact }: {
  supabase: SB; meId: string; clients: Client[]; personName: (id: string | null) => string; say: (m: string, e?: boolean) => void; compact?: boolean;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [missing, setMissing] = useState(false);
  const [show, setShow] = useState<"open" | "done">("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [nv, setNv] = useState({ title: "", client_id: "", due_date: "", details: "" });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [t, c] = await Promise.all([
      supabase.from("mgmt_tasks").select("*").order("created_at", { ascending: false }).limit(500),
      supabase.from("mgmt_comments").select("*").order("created_at").limit(5000),
    ]);
    if (t.error) { setMissing(/does not exist|schema cache|mgmt_tasks/i.test(t.error.message)); setTasks([]); return; }
    setTasks(t.data as Task[]); setComments((c.data as Comment[] | null) ?? []);
  }, [supabase]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`mgmt-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "mgmt_tasks" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "mgmt_comments" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, load]);

  async function run(p: PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true); const { error } = await p; setBusy(false);
    if (error) { say(`Not saved: ${error.message}`, true); return false; }
    say(ok); load(); return true;
  }
  async function create() {
    if (!nv.title.trim()) return;
    const id = crypto.randomUUID();
    if (await run(supabase.from("mgmt_tasks").insert({ id, title: nv.title.trim(), client_id: nv.client_id || null, due_date: nv.due_date || null, details: nv.details.trim(), status: "open", created_by: meId }), "Management job added")) {
      setNv({ title: "", client_id: "", due_date: "", details: "" }); setAdding(false); setOpenId(id); setShow("open");
    }
  }
  const clientName = (id: string | null) => (id ? clients.find((c) => c.id === id)?.name ?? "Deleted client" : "");

  if (missing) return compact ? null : <div className="panel" style={{ padding: 16 }}><h2>Management</h2><p className="note">Run database-update-management-jobs.sql in Supabase to switch on management jobs.</p></div>;
  if (!tasks) return null;
  const list = tasks.filter((t) => t.status === (compact ? "open" : show));
  const openN = tasks.filter((t) => t.status === "open").length;
  if (compact && !openN && !adding) return (
    <div className="panel mgmt" style={{ marginTop: 16 }}><div className="ph"><h2>Management jobs</h2><button type="button" onClick={() => setAdding(true)}>+ New management job</button></div>
      <p className="note" style={{ margin: "0 16px 14px" }}>Nothing open. Only master admins see these.</p></div>);

  const form = <div className="qnew mgmtform">
    <label className="f">What needs doing<input id="mg-title" autoFocus value={nv.title} onChange={(e) => setNv({ ...nv, title: e.target.value })} placeholder="e.g. Review fee increase for 2027" /></label>
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <label className="f" style={{ flex: 2, minWidth: 220 }}>Client (optional)<ClientPicker id="mg-client" clients={clients} value={nv.client_id} emptyLabel="No client" onChange={(id) => setNv({ ...nv, client_id: id })} /></label>
      <label className="f" style={{ flex: 1, minWidth: 150 }}>Due date (optional)<input id="mg-due" type="date" value={nv.due_date} onChange={(e) => setNv({ ...nv, due_date: e.target.value })} /></label>
    </div>
    <label className="f">Details (optional)<textarea id="mg-details" value={nv.details} onChange={(e) => setNv({ ...nv, details: e.target.value })} /></label>
    <div className="row"><span className="note">Only master admins can see this job.</span><span style={{ flex: 1 }} />
      <button type="button" className="link" onClick={() => setAdding(false)}>Cancel</button>
      <button type="button" className="primary" disabled={busy || !nv.title.trim()} onClick={create}>Add management job</button></div>
  </div>;

  return (
    <div className={`panel mgmt${compact ? "" : " page"}`} style={compact ? { marginTop: 16 } : undefined}>
      <div className="ph"><h2>{compact ? `Management jobs (${openN} open)` : "Management jobs"}</h2>
        <div className="row">
          {!compact ? <div className="seg" role="tablist"><button type="button" className={show === "open" ? "on" : undefined} onClick={() => setShow("open")}>Open {openN}</button><button type="button" className={show === "done" ? "on" : undefined} onClick={() => setShow("done")}>Completed {tasks.length - openN}</button></div> : null}
          {!adding ? <button type="button" className="primary" onClick={() => setAdding(true)}>+ New management job</button> : null}</div></div>
      {!compact ? <p className="note" style={{ margin: "0 16px 8px" }}>Only Hardeep, Harshad and any other master admin can see these. Open jobs also show on each master admin&apos;s My tasks until someone completes them.</p> : null}
      {adding ? <div style={{ padding: "0 16px 12px" }}>{form}</div> : null}
      {!list.length ? <p className="note" style={{ margin: "0 16px 14px" }}>{show === "done" ? "Nothing completed yet." : "Nothing open."}</p> : (
        <ul className="mgmtlist">{list.map((t) => {
          const cs = comments.filter((c) => c.task_id === t.id);
          const on = openId === t.id;
          const d = t.due_date ? daysFrom(t.due_date) : null;
          return (
            <li key={t.id} className={`${t.status}${on ? " on" : ""}`}>
              <button type="button" className="mghead" onClick={() => setOpenId(on ? null : t.id)} aria-expanded={on}>
                <span className="tdot">{t.status === "done" ? "✓" : "M"}</span>
                <span className="grow"><strong>{t.title}</strong>
                  <span className="note">{[clientName(t.client_id), `Added by ${personName(t.created_by) || "someone"} ${when(t.created_at)}`, t.status === "done" && t.done_at ? `Completed by ${personName(t.done_by)} ${when(t.done_at)}` : ""].filter(Boolean).join(" · ")}</span></span>
                {t.due_date && t.status === "open" ? <span className={`pill ${d !== null && d < 0 ? "danger" : d !== null && d <= 7 ? "warn" : ""}`}>Due {fmtDate(t.due_date)}</span> : null}
                <span className="pill">{cs.length} comment{cs.length === 1 ? "" : "s"}</span><span className="note">{on ? "▾" : "▸"}</span>
              </button>
              {on ? <div className="mgbody">
                {t.details ? <p className="mgdetails">{t.details}</p> : null}
                <ul className="mgcomments">{cs.map((c) => <li key={c.id}><div className="qhead"><strong>{personName(c.author_id) || "Someone"}</strong> <span className="note">{when(c.created_at)}</span>
                  {c.author_id === meId ? <button type="button" className="link" style={{ marginLeft: 8 }} onClick={() => run(supabase.from("mgmt_comments").delete().eq("id", c.id), "Comment removed")}>Remove</button> : null}</div><div className="qbody">{c.body}</div></li>)}</ul>
                <textarea aria-label="Add a comment" placeholder="Add a comment…" value={draft[t.id] ?? ""} onChange={(e) => setDraft({ ...draft, [t.id]: e.target.value })} />
                <div className="row" style={{ marginTop: 6 }}>
                  <button type="button" disabled={busy || !(draft[t.id] ?? "").trim()} onClick={async () => { if (await run(supabase.from("mgmt_comments").insert({ task_id: t.id, author_id: meId, body: (draft[t.id] ?? "").trim() }), "Comment added")) setDraft({ ...draft, [t.id]: "" }); }}>Add comment</button>
                  <span style={{ flex: 1 }} />
                  {t.created_by === meId ? <button type="button" className="link" style={{ color: "var(--danger)" }} disabled={busy} onClick={() => { if (window.confirm(`Delete "${t.title}" and its comments?`)) run(supabase.from("mgmt_tasks").delete().eq("id", t.id), "Management job deleted"); }}>Delete</button> : null}
                  {t.status === "open"
                    ? <button type="button" className="primary" disabled={busy} onClick={() => run(supabase.from("mgmt_tasks").update({ status: "done", done_by: meId, done_at: new Date().toISOString() }).eq("id", t.id), "Management job completed")}>✓ Complete</button>
                    : <button type="button" disabled={busy} onClick={() => run(supabase.from("mgmt_tasks").update({ status: "open", done_by: null, done_at: null }).eq("id", t.id), "Reopened")}>Reopen</button>}
                </div>
              </div> : null}
            </li>); })}</ul>)}
    </div>
  );
}
