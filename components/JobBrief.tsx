"use client";
import type { MouseEvent as RMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Job, Person } from "@/lib/types";
import { svcLabel, ST, fmtDate, daysFrom } from "@/lib/domain";
import { checklistFor, STEPS } from "@/lib/checklists";
import ReviewNotes from "./ReviewNotes";
import type { JobFile } from "./JobFiles";

type SB = ReturnType<typeof createClient>;
interface Query { id: string; job_id: string; parent_id: string | null; author_id: string | null; to_id: string | null; body: string; file_id: string | null; answered_at: string | null; created_at: string }
interface Check { item: string; done_by: string | null; done_at: string }
interface Act { id: string; kind: string; body: string; from_value: string | null; to_value: string | null; actor_id: string | null; created_at: string }
/** First task on every job: look over what the client sent and get the data into the software. */
export const IR_ITEMS = [
  "All documents from the client received and checked",
  "Bank statements uploaded into the accounting software",
  "Bank transactions processed and coded",
  "Anything missing listed (raise a query for it)",
];
const IR_KEY = (i: string) => `IR: ${i}`;
const IR_DONE = "STEP: Initial review complete";
/** A step in preparation, in the order it happened. */
export interface PrepRow { kind: "ir" | "proc"; n: number; afterQuery: boolean; current: boolean; done: boolean; hours: number; marked: number; total: number; complete?: () => void }
const when = (s: string) => (s && !isNaN(Date.parse(s)) ? new Date(s) : new Date()).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const MAX = 25 * 1024 * 1024;
const safe = (name: string) => name.normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-120) || "file";

/** The job at a glance (for team members, instead of the edit form), its checklist,
 *  and internal queries: question on the left, the manager's reply beside it. */
const fmtHm = (h: number) => { const m = Math.round(h * 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`; };

export default function JobBrief({ job, clientName, showInfo, meId, canAnswerAll, team, defaultTo, readOnly, supabase, personName, say, onQueries, onNewClient, onRaised, onAnswered, timer, queryHours, onProgress, tasks }: {
  /** Task list mode: the job page draws each preparation row's header and the rows after preparation. */
  tasks?: { head: (r: PrepRow) => ReactNode; after: ReactNode; active: boolean; prepTime: (from: string | null, to: string | null) => number; onClientReplied?: () => void };
  job: Job; clientName: string; showInfo: boolean; meId: string; canAnswerAll: boolean; team: Person[]; defaultTo: string | null; readOnly?: boolean;
  supabase: SB; personName: (id: string | null) => string; say: (m: string, err?: boolean) => void; onQueries?: (open: number) => void; onNewClient?: () => void;
  /** A query was raised on this job: stop the timer and move the job to Internal query or Query with client. */
  onRaised?: (j: Job, kind: "internal" | "client") => void;
  /** A response was sent; stillOpen is how many internal queries on the job are still unanswered. */
  onAnswered?: (j: Job, stillOpen: number) => void;
  /** Job timer, so the person a query was raised to can time their answer onto their own timesheet. */
  /** Checklist progress: items marked Checked or N/A, out of the total. */
  onProgress?: (marked: number, total: number) => void;
  queryHours?: (q: { to_id: string | null; created_at: string; answered_at: string | null }) => number;
  timer?: { runningHere: boolean; busy: boolean; start: (j: Job) => void; stop: () => void };
}) {
  const [qs, setQs] = useState<Query[] | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [acts, setActs] = useState<Act[]>([]);
  const [files, setFiles] = useState<Record<string, JobFile>>({});
  const [missing, setMissing] = useState(false);
  const [ask, setAsk] = useState({ to: defaultTo ?? "", body: "" });
  const [askFile, setAskFile] = useState<File | null>(null);
  const [reply, setReply] = useState<Record<string, string>>({});
  const [replyFile, setReplyFile] = useState<Record<string, File | null>>({});
  const [busy, setBusy] = useState(false);
  const [askKind, setAskKind] = useState<"internal" | "client">("internal");
  // Task rows fold up when you click their header. Finished ones start folded.
  const tasksRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    tasksRef.current?.querySelectorAll<HTMLLIElement>(":scope > li.task").forEach((li) => {
      if (li.dataset.init || li.children.length < 2) return;
      li.dataset.init = "1";
      if (li.matches(".done, .answered, .rn.closed, .rn.cleared") || li.querySelector(":scope > .taskhead.done")) li.dataset.min = "1";
    });
  });
  const foldTask = (e: RMouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, select, input, textarea, a, label")) return;
    const head = t.closest(".taskhead"); const li = head?.parentElement;
    if (!head || !li || !li.matches("li.task") || li.children.length < 2) return;
    if (li.dataset.min) delete li.dataset.min; else li.dataset.min = "1";
  };
  const [askOpen, setAskOpen] = useState(false);

  const load = useCallback(async () => {
    const [q, c, f, a] = await Promise.all([
      supabase.from("job_queries").select("*").eq("job_id", job.id).order("created_at"),
      supabase.from("job_checks").select("item, done_by, done_at").eq("job_id", job.id),
      supabase.from("job_files").select("*").eq("job_id", job.id),
      supabase.from("job_activity").select("id,kind,body,from_value,to_value,actor_id,created_at").eq("job_id", job.id).in("kind", ["comment", "status"]).order("created_at"),
    ]);
    setActs((a.data as Act[] | null) ?? []);
    if (q.error) { setMissing(true); setQs([]); return; }
    const list = q.data as Query[];
    setQs(list); setChecks((c.data as Check[] | null) ?? []);
    setFiles(Object.fromEntries(((f.data as JobFile[] | null) ?? []).map((x) => [x.id, x])));
    onQueries?.(list.filter((x) => !x.parent_id && !x.answered_at && !list.some((r) => r.parent_id === x.id)).length);
  }, [supabase, job.id, onQueries]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`job-brief-${job.id}-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "job_queries", filter: `job_id=eq.${job.id}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "job_checks", filter: `job_id=eq.${job.id}` }, () => load())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "job_activity", filter: `job_id=eq.${job.id}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, job.id, load]);
  useEffect(() => { load(); }, [job.status, load]);

  async function upload(f: File): Promise<string | null | false> {
    if (f.size > MAX) { say(`${f.name} is over 25 MB`, true); return false; }
    const path = `${job.id}/${crypto.randomUUID()}-${safe(f.name)}`;
    const up = await supabase.storage.from("job-files").upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
    if (up.error) { say(`${f.name} wasn't uploaded: ${up.error.message}`, true); return false; }
    const { data, error } = await supabase.from("job_files").insert({ job_id: job.id, path, name: f.name.slice(0, 255), size: f.size, mime: f.type, kind: "query_sheet", uploaded_by: meId }).select("id").single();
    if (error) { await supabase.storage.from("job-files").remove([path]); say(`${f.name} wasn't saved: ${error.message}`, true); return false; }
    return (data as { id: string }).id;
  }
  async function post(row: { body: string; to_id?: string | null; parent_id?: string }, file: File | null) {
    if (!row.body.trim()) { say("Type your message first.", true); return false; }
    setBusy(true);
    const fileId = file ? await upload(file) : null;
    if (fileId === false) { setBusy(false); return false; }
    const { error } = await supabase.from("job_queries").insert({ job_id: job.id, author_id: meId, ...row, body: row.body.trim(), file_id: fileId });
    setBusy(false);
    if (error) { say(`Not sent: ${error.message}`, true); return false; }
    if (row.parent_id) {
      const stillOpen = questions.filter((q) => q.id !== row.parent_id && !q.answered_at && !replies.some((r) => r.parent_id === q.id)).length;
      onAnswered?.(job, stillOpen);
    } else onRaised?.(job, "internal");
    await load(); return true;
  }
  async function postClientQuery(body: string) {
    if (!body.trim()) { say("Type the query first.", true); return false; }
    setBusy(true);
    const { error } = await supabase.from("job_activity").insert({ job_id: job.id, actor_id: meId, kind: "comment", body: `Client query: ${body.trim()}` });
    setBusy(false);
    if (error) { say(`Not saved: ${error.message}`, true); return false; }
    await load();
    onRaised?.(job, "client");
    return true;
  }
  async function mark(item: string, to: "done" | "na" | null) {
    const del = await supabase.from("job_checks").delete().eq("job_id", job.id).in("item", [item, `N/A: ${item}`]);
    if (del.error) { say(`Not saved: ${del.error.message}`, true); return; }
    if (to) {
      const { error } = await supabase.from("job_checks").insert({ job_id: job.id, item: to === "na" ? `N/A: ${item}` : item, done_by: meId, done_at: new Date().toISOString() });
      if (error) { say(`Not saved: ${error.message}`, true); return; }
    }
    load();
  }
  async function openFile(id: string | null) {
    const f = id ? files[id] : undefined;
    if (!f) { say("That file has been deleted.", true); return; }
    const { data } = await supabase.storage.from("job-files").createSignedUrl(f.path, 120);
    if (data) window.open(data.signedUrl, "_blank", "noopener");
  }
  const fileChip = (id: string | null) => id ? <button type="button" className="link qfile" onClick={() => openFile(id)}>📎 {files[id]?.name ?? "Attachment"}</button> : null;
  const pickFile = (onPick: (f: File | null) => void, f: File | null, id: string) => <>
    <input id={id} type="file" hidden onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
    <button type="button" onClick={() => (document.getElementById(id) as HTMLInputElement | null)?.click()}>{f ? `📎 ${f.name}` : "Attach query sheet"}</button>
    {f ? <button type="button" className="link" onClick={() => onPick(null)}>Remove</button> : null}</>;

  const items = checklistFor(job.service);
  const done = new Map(checks.map((c) => [c.item, c]));
  // Each checklist item is marked Checked or N/A (N/A is saved as "N/A: <item>").
  const NA = (i: string) => `N/A: ${i}`;
  const markOf = (i: string) => { const c = done.get(i); if (c) return { c, na: false }; const n = done.get(NA(i)); return n ? { c: n, na: true } : null; };
  const isMarked = (i: string) => !!markOf(i);
  const markedN = items.filter(isMarked).length;
  useEffect(() => { onProgress?.(markedN, items.length); }, [markedN, items.length, onProgress]);
  const itemEl = (i: string, label = i) => { const m = markOf(i); return (
    <li key={i} className={m ? (m.na ? "na" : "done") : undefined}><span className="ci">{label}</span>
      <span className="row cmark">{m ? <span className="note">{m.na ? "N/A · " : ""}{personName(m.c.done_by) || "someone"} · {when(m.c.done_at)}</span> : null}
        <button type="button" className={m && !m.na ? "on ok2" : undefined} disabled={readOnly || missing} aria-pressed={!!m && !m.na} onClick={() => mark(i, m && !m.na ? null : "done")}>✓ Checked</button>
        <button type="button" className={m?.na ? "on na2" : undefined} disabled={readOnly || missing} aria-pressed={!!m?.na} onClick={() => mark(i, m?.na ? null : "na")}>N/A</button></span></li>); };
  const questions = (qs ?? []).filter((q) => !q.parent_id);
  const replies = (qs ?? []).filter((q) => q.parent_id);
  const d = job.due_date ? daysFrom(job.due_date) : null;

  const checklistEl = (<>
        {STEPS[job.service] ? (() => {
        const steps = STEPS[job.service];
        const nowIdx = steps.findIndex((s) => s.items.some((i) => !isMarked(i)));
        const allDone = markedN;
        return <section className="briefsec">
          <h3>Steps <span className="note">{allDone} of {items.length} done</span></h3>
          <div className="stepbar"><i style={{ width: `${(allDone / Math.max(1, items.length)) * 100}%` }} /></div>
          <ol className="steps">{steps.map((s, n) => { const d = s.items.filter(isMarked).length; const state = d === s.items.length ? "done" : n === nowIdx ? "now" : "";
            return (
              <li key={s.title} className={state}>
                <div className="stephead"><span className="dot">{state === "done" ? "✓" : n + 1}</span><strong>{s.title}</strong><span className="note">{d} of {s.items.length}</span></div>
                {state !== "done" || n === steps.length - 1 ? <ul className="checklist">{s.items.map((i) => itemEl(i))}</ul> : null}
                {n === steps.length - 1 && job.service === "company_formation" && onNewClient && !readOnly ? <button type="button" className="primary" style={{ marginTop: 8 }} onClick={onNewClient}>Create the new company as a client</button> : null}
              </li>); })}</ol>
        </section>;
      })() : items.length ? <section className="briefsec">
        <h3>Checklist <span className="note">{markedN} of {items.length} done</span></h3>
        <ul className="checklist">{items.map((i) => itemEl(i))}</ul>
      </section> : null}

  </>);
  const askForm = (<div className="qnew">
            <div className="qkind" role="radiogroup" aria-label="Type of query">
              <button type="button" role="radio" aria-checked={askKind === "internal"} className={askKind === "internal" ? "on" : undefined} onClick={() => setAskKind("internal")}>Internal query<span>to a team member</span></button>
              <button type="button" role="radio" aria-checked={askKind === "client"} className={askKind === "client" ? "on" : undefined} onClick={() => setAskKind("client")}>Client query<span>to the client</span></button>
            </div>
            {askKind === "internal" ? <>
            <div className="row" style={{ gap: 8 }}><label className="f" style={{ minWidth: 220 }}>Ask<select id="q-ask-to" value={ask.to} onChange={(e) => setAsk({ ...ask, to: e.target.value })}>
              <option value="">Choose who answers…</option>{team.filter((p) => p.id !== meId).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label></div>
            <textarea id="q-ask-body" placeholder="What's the query? e.g. Client has fuel receipts without tax invoices, can we claim the GST?" value={ask.body} onChange={(e) => setAsk({ ...ask, body: e.target.value })} />
            <div className="row">{pickFile(setAskFile, askFile, "q-ask-file")}<span style={{ flex: 1 }} />
              <button type="button" className="primary" disabled={busy || !ask.body.trim() || !ask.to} onClick={async () => { if (await post({ body: ask.body, to_id: ask.to }, askFile)) { setAsk({ ...ask, body: "" }); setAskFile(null); setAskOpen(false); say(`Query sent to ${personName(ask.to)}. Your timer stopped and the job is now Internal query`); } }}>Send internal query</button></div>
            <span className="note">{ask.to ? `Only ${personName(ask.to)} can respond. ` : "Only the person you pick can respond. "}Your timer stops and the job moves to Internal query until they answer.</span>
            </> : <>
            <textarea id="q-ask-client" placeholder="What did you ask the client? e.g. Please send the bank statements for September and October." value={ask.body} onChange={(e) => setAsk({ ...ask, body: e.target.value })} />
            <div className="row"><span style={{ flex: 1 }} />
              <button type="button" className="primary" disabled={busy || !ask.body.trim()} onClick={async () => { if (await postClientQuery(ask.body)) { setAsk({ ...ask, body: "" }); setAskOpen(false); say("Client query noted. Your timer stopped and the job is now Query with client"); } }}>Mark query sent to client</button></div>
            <span className="note">Send the query to the client by email as usual. This notes it on the job history, stops your timer and moves the job to Query with client. You get a bell reminder if there&apos;s no reply in 2 days.</span>
            </>}
          </div>);
  const ansCol = (q: Query, rs: Query[], mine: boolean) => (<div className="qcol ans">{rs.length ? rs.map((r) => (
                  <div key={r.id}><div className="qhead"><span className="pill ok">Response</span> {personName(r.author_id) || "Someone"} · {when(r.created_at)}</div>
                    <div className="qbody">{r.body}</div>{fileChip(r.file_id)}</div>))
                  : mine && !readOnly ? <div className="qreply">
                    {timer && q.to_id === meId ? <div className="row qtimer">{timer.runningHere
                      ? <><span className="runtxt">● Timing your answer</span><span style={{ flex: 1 }} /><button type="button" disabled={timer.busy} onClick={timer.stop}>Stop</button></>
                      : <><span className="note">Start the timer so the time you spend on this goes on your timesheet.</span><span style={{ flex: 1 }} /><button type="button" className="primary" disabled={timer.busy} onClick={() => timer.start(job)}>Start</button></>}</div> : null}
                    <textarea aria-label="Your response" placeholder="Type the response…" value={reply[q.id] ?? ""} onChange={(e) => setReply({ ...reply, [q.id]: e.target.value })} />
                    <div className="row">{pickFile((f) => setReplyFile({ ...replyFile, [q.id]: f }), replyFile[q.id] ?? null, `qr-file-${q.id}`)}<span style={{ flex: 1 }} />
                      <button type="button" className="primary" disabled={busy || !(reply[q.id] ?? "").trim()} onClick={async () => { if (await post({ body: reply[q.id] ?? "", parent_id: q.id }, replyFile[q.id] ?? null)) { setReply({ ...reply, [q.id]: "" }); setReplyFile({ ...replyFile, [q.id]: null }); say("Response sent"); } }}>Send response</button></div>
                  </div> : <div className="note qwait">Waiting for {personName(q.to_id) || "a manager"} to respond.</div>}</div>);

  if (tasks) {
    // Preparation in the order it happened: Initial review, then each query, then a Processing step after each answer.
    const irDoneAt = done.get(IR_DONE)?.done_at ?? null;
    const irMarked = IR_ITEMS.filter((i) => isMarked(IR_KEY(i))).length;
    const cqs = acts.filter((x) => x.kind === "comment" && x.body.startsWith("Client query: ")).map((x) => ({
      a: x, replied: acts.find((y) => y.kind === "status" && y.from_value === "client_query" && y.created_at > x.created_at)?.created_at ?? null }));
    const ansAt = (q: Query) => replies.find((r) => r.parent_id === q.id)?.created_at ?? q.answered_at;
    const raised = [...questions.map((q) => q.created_at), ...cqs.map((c) => c.a.created_at)].sort();
    type Ev = { t: string; kind: "iq"; q: Query } | { t: string; kind: "cq"; c: (typeof cqs)[number] } | { t: string; kind: "proc"; afterQuery: boolean };
    const evs: Ev[] = [
      ...questions.map((q) => ({ t: q.created_at, kind: "iq" as const, q })),
      ...cqs.map((c) => ({ t: c.a.created_at, kind: "cq" as const, c })),
      ...(irDoneAt && (!raised[0] || irDoneAt <= raised[0]) ? [{ t: irDoneAt, kind: "proc" as const, afterQuery: false }] : []),
      ...questions.map(ansAt).filter((t): t is string => !!t).map((t) => ({ t, kind: "proc" as const, afterQuery: true })),
      ...cqs.map((c) => c.replied).filter((t): t is string => !!t).map((t) => ({ t, kind: "proc" as const, afterQuery: true })),
    ].sort((x, y) => x.t.localeCompare(y.t));
    const procIdx = evs.map((e, k) => (e.kind === "proc" ? k : -1)).filter((k) => k >= 0);
    const lastProc = procIdx[procIdx.length - 1];
    const lastIsIr = !evs.length;
    const irRow: PrepRow = { kind: "ir", n: 1, afterQuery: false, current: tasks.active && lastIsIr, done: !lastIsIr || !tasks.active, hours: tasks.prepTime(null, evs[0]?.t ?? null),
      marked: irMarked, total: IR_ITEMS.length,
      complete: async () => { if (timer?.runningHere) await timer.stop(); await supabase.from("job_checks").delete().eq("job_id", job.id).eq("item", IR_DONE);
        const { error } = await supabase.from("job_checks").insert({ job_id: job.id, item: IR_DONE, done_by: meId, done_at: new Date().toISOString() }); if (error) { say(`Not saved: ${error.message}`, true); return; } say("Initial review complete. Processing is next: press Start when you begin"); load(); } };
    let pn = 1;
    const iqEl = (q: Query) => {
          const rs = replies.filter((r) => r.parent_id === q.id);
          // Only the person the query was raised to can respond. A query to "a manager" (nobody named) can be answered by any manager.
          const mine = q.to_id ? q.to_id === meId : canAnswerAll || q.author_id !== meId;
          const answered = rs.length > 0 || !!q.answered_at;
          return (
            <li key={q.id} className={`task iq${answered ? " answered" : ""}`}>
              <div className="taskhead"><span className="tdot">{answered ? "✓" : "?"}</span>
                <div style={{ minWidth: 0, flex: 1 }}><div className="tkt">Internal query · {personName(q.author_id) || "Someone"} → {personName(q.to_id) || "a manager"}</div>
                  <div className="tks">Raised {when(q.created_at)}{rs[0] ? ` · answered ${when(rs[0].created_at)}` : ""}</div></div>
                {queryHours?.(q) ? <span className="tasktime mono" title="Time logged answering this query">{fmtHm(queryHours(q))}</span> : null}
                <span className={`pill ${answered ? "ok" : "danger"}`}>{answered ? "Answered" : "Open"}</span></div>
              <div className="qpair">
                <div className="qcol ask"><div className="qhead"><span className="pill danger">Query</span> {personName(q.author_id) || "Someone"}</div><div className="qbody">{q.body}</div>{fileChip(q.file_id)}</div>
                {ansCol(q, rs, mine)}
              </div>
            </li>);
    };
    const cqEl = ({ a: x, replied }: (typeof cqs)[number]) => (
      <li key={x.id} className={`task iq cq${replied ? " answered" : ""}`}>
        <div className="taskhead"><span className="tdot">{replied ? "✓" : "?"}</span>
          <div style={{ minWidth: 0, flex: 1 }}><div className="tkt">Client query · {personName(x.actor_id) || "Someone"} → client</div>
            <div className="tks">Raised {when(x.created_at)}{replied ? ` · client replied ${when(replied)}` : ""}</div></div>
          <span className={`pill ${replied ? "ok" : "warn"}`}>{replied ? "Replied" : "Waiting on client"}</span></div>
        <div className="qpair">
          <div className="qcol ask"><div className="qhead"><span className="pill warn">Client query</span> {personName(x.actor_id) || "Someone"}</div><div className="qbody">{x.body.replace(/^Client query: /, "")}</div></div>
          <div className="qcol ans">{replied ? <div className="note">The client replied {when(replied)}. Processing continues below.</div>
            : !readOnly && tasks.onClientReplied && job.status === "client_query" ? <div className="qreply"><p className="note" style={{ margin: "0 0 8px" }}>When the client answers, press Client replied. A new Processing task opens for the preparer.</p><button type="button" className="primary" onClick={tasks.onClientReplied}>Client replied</button></div>
            : <div className="note qwait">Waiting for the client to reply.</div>}</div>
        </div>
      </li>);
    return (
    <div className="jobbrief" onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault(); }}>
      <ol className="tasks" ref={tasksRef} onClick={foldTask}>
        <li className={`task prep${irRow.current ? " now" : ""}`}>{tasks.head(irRow)}<div className="taskbody"><section className="briefsec">
          <h3>Checklist <span className="note">{irMarked} of {IR_ITEMS.length} done</span></h3>
          <ul className="checklist">{IR_ITEMS.map((i) => itemEl(IR_KEY(i), i))}</ul></section></div></li>
        {evs.map((e, k) => {
          if (e.kind === "iq") return iqEl(e.q);
          if (e.kind === "cq") return cqEl(e.c);
          const isLast = k === lastProc && k === evs.length - 1;
          const row: PrepRow = { kind: "proc", n: ++pn, afterQuery: e.afterQuery, current: tasks.active && isLast, done: !isLast || !tasks.active,
            hours: tasks.prepTime(e.t, evs[k + 1]?.t ?? null), marked: markedN, total: items.length };
          return <li key={`p${e.t}`} className={`task prep${row.current ? " now" : ""}`}>{tasks.head(row)}{k === lastProc ? <div className="taskbody">{checklistEl}</div> : null}</li>;
        })}
        <ReviewNotes asTasks job={job} meId={meId} canAnswerAll={canAnswerAll} readOnly={readOnly} supabase={supabase} personName={personName} say={say} />
        {!readOnly && !missing ? <li className="task add">{askOpen ? askForm : <button type="button" onClick={() => setAskOpen(true)}>? Raise a query (internal or client)</button>}</li> : null}
        {tasks.after}
      </ol>
    </div>
  ); }

  return (
    <div className="jobbrief" onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault(); }}>
      {showInfo ? <div className="briefline">
        <strong>{clientName}</strong><span>{svcLabel(job.service)} {job.period}</span>
        <span className={d !== null && d < 0 ? "danger" : ""}>Due {job.due_date ? fmtDate(job.due_date) : "not set"}{d !== null && d < 0 ? ` (${-d} days overdue)` : ""}</span>
        {job.priority === "high" ? <span className="pill danger">High priority</span> : null}
        <span className={`pill ${ST[job.status]?.cls ?? ""}`}>{ST[job.status]?.label ?? job.status}</span>
        <span className="note">Assigned {personName(job.assignee_id) || "nobody"} · Reviewer {personName(job.reviewer_id ?? null) || "none"}{job.needs_signature === false ? " · No client signature needed" : ""}</span>
      </div> : null}
      {showInfo && job.notes?.trim() ? <div className="briefnotes"><span className="lbl2">Notes from your manager</span><div>{job.notes}</div></div> : null}

      {checklistEl}

      <ReviewNotes job={job} meId={meId} canAnswerAll={canAnswerAll} readOnly={readOnly} supabase={supabase} personName={personName} say={say} />

      <section className="briefsec">
        <h3>Internal queries{questions.length ? ` (${questions.length})` : ""}</h3>
        {missing ? <p className="note">Run the database update for job queries in Supabase to switch these on.</p> : <>
          {questions.length ? <ul className="qthread">{questions.map((q) => {
            const rs = replies.filter((r) => r.parent_id === q.id);
            // Only the person the query was raised to can respond. A query to "a manager" (nobody named) can be answered by any manager.
          const mine = q.to_id ? q.to_id === meId : canAnswerAll || q.author_id !== meId;
            return (
              <li key={q.id}>
                <div className="qcol ask"><div className="qhead"><span className="pill danger">Query</span> {personName(q.author_id) || "Someone"}{q.to_id ? ` → ${personName(q.to_id)}` : ""} · {when(q.created_at)}</div>
                  <div className="qbody">{q.body}</div>{fileChip(q.file_id)}</div>
                {ansCol(q, rs, mine)}
              </li>); })}</ul> : <p className="note" style={{ margin: "0 0 10px" }}>No queries on this job yet.</p>}
          {!readOnly ? askForm : null}
        </>}
      </section>
    </div>
  );
}
