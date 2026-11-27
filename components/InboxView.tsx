"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client, Job } from "@/lib/types";
import { svcLabel, SIGNED_MARK, fmtDate } from "@/lib/domain";

type SB = SupabaseClient;
interface Head { box: number; folder: "inbox" | "sent"; uid: number; from: { name: string; address: string }; to: string[]; subject: string; date: string; seen: boolean; att: boolean }
interface Msg { box: number; folder: "inbox" | "sent"; uid: number; subject: string; date: string; from: { name: string; address: string }; replyTo: string; to: { name: string; address: string }[]; cc: { name: string; address: string }[];
  messageId: string; references: string[]; html: string; text: string; attachments: { i: number; name: string; size: number; type: string }[] }
interface SignRow { id: string; box: string; uid: number; subject: string; doc_name: string; received_at: string | null; result: "moved" | "needs" | "none" | "skipped" | "undone"; note: string; job_id: string | null; candidates: string[]; created_at: string }
interface Compose { box: number; to: string; cc: string; subject: string; body: string; quote: string; inReplyTo: string; references: string; files: File[] }

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (t: string) => {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};
const short = (a: string) => `${a.split("@")[0]}@`;

/** All the practice mailboxes in one place, and what the Zoho Sign automation did. Master admins only. */
export default function InboxView({ supabase, jobs, clients, say, onOpenJob }: {
  supabase: SB; jobs: Job[]; clients: Client[]; say: (m: string, e?: boolean) => void; onOpenJob: (j: Job) => void;
}) {
  const [boxes, setBoxes] = useState<{ i: number; address: string }[] | null>(null);
  const [box, setBox] = useState<"all" | number>("all");
  const [show, setShow] = useState<"inbox" | "sent" | "signing" | "unread">("inbox");
  const [q, setQ] = useState(""); const [qIn, setQIn] = useState("");
  const [list, setList] = useState<Head[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [log, setLog] = useState<SignRow[] | null>(null);
  const [logMissing, setLogMissing] = useState(false);
  const [sel, setSel] = useState<{ box: number; folder: "inbox" | "sent"; uid: number } | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [busy, setBusy] = useState(false);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [pick, setPick] = useState("");

  const clientName = useCallback((id: string) => clients.find((c) => c.id === id)?.name ?? "", [clients]);
  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const jobLabel = (id: string | null) => { const j = id ? jobById.get(id) : null; return j ? `${clientName(j.client_id)} · ${svcLabel(j.service)} ${j.period}` : "a job"; };
  const outForSign = useMemo(() => jobs.filter((j) => j.status === "sent_for_sign" && j.sign_reminded_at !== SIGNED_MARK)
    .sort((a, b) => clientName(a.client_id).localeCompare(clientName(b.client_id))), [jobs, clientName]);
  const addrOf = (i: number) => boxes?.find((b) => b.i === i)?.address ?? "";
  const idxOf = (address: string) => boxes?.find((b) => b.address === address)?.i ?? -1;

  const loadBoxes = useCallback(async () => {
    const r = await fetch("/api/mail?a=boxes"); const d = await r.json().catch(() => ({}));
    if (!r.ok) { say(d.error ?? "Couldn't open the mailboxes", true); setBoxes([]); return; }
    setBoxes(d.boxes ?? []);
  }, [say]);
  const loadLog = useCallback(async () => {
    const { data, error } = await supabase.from("sign_log").select("*").gte("created_at", new Date(Date.now() - 60 * 864e5).toISOString()).order("created_at", { ascending: false }).limit(300);
    if (error) { setLogMissing(true); setLog([]); return; }
    setLogMissing(false); setLog((data as SignRow[]) ?? []);
  }, [supabase]);
  const loadList = useCallback(async () => {
    if (show === "signing") return;
    setList(null);
    const p = new URLSearchParams({ a: "list", box: String(box), folder: show === "sent" ? "sent" : "inbox", q });
    const r = await fetch(`/api/mail?${p}`); const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErrors([d.error ?? "Couldn't read the mailbox"]); setList([]); return; }
    setErrors(d.errors ?? []); setList(d.messages ?? []);
  }, [box, show, q]);
  useEffect(() => { loadBoxes(); loadLog(); }, [loadBoxes, loadLog]);
  useEffect(() => { if (boxes?.length) loadList(); }, [boxes, loadList]);

  useEffect(() => {
    if (!sel) { setMsg(null); return; }
    let live = true; setLoadingMsg(true); setMsg(null); setPick("");
    (async () => {
      const r = await fetch(`/api/mail?a=msg&box=${sel.box}&folder=${sel.folder}&uid=${sel.uid}`); const d = await r.json().catch(() => ({}));
      if (!live) return;
      setLoadingMsg(false);
      if (!r.ok) { say(d.error ?? "Couldn't open that email", true); return; }
      setMsg(d as Msg);
      if (sel.folder === "inbox") setList((l) => l?.map((m) => (m.box === sel.box && m.uid === sel.uid && m.folder === "inbox" ? { ...m, seen: true } : m)) ?? l);
    })();
    return () => { live = false; };
  }, [sel, say]);

  const signFor = (b: number, uid: number) => log?.find((s) => s.box === addrOf(b) && Number(s.uid) === uid) ?? null;
  const today = new Date().toDateString();
  const movedToday = (log ?? []).filter((s) => s.result === "moved" && new Date(s.created_at).toDateString() === today).length;
  const needs = (log ?? []).filter((s) => s.result === "needs" || s.result === "none").length;

  async function checkNow() {
    setBusy(true);
    const r = await fetch("/api/mail/sync?now=1", { method: "POST" }); const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (d.off) { say(d.why ?? "No mailbox is set up yet", true); return; }
    if (d.errors?.length) say(d.errors[0], true); else say(d.handled ? `${d.handled} signing email${d.handled === 1 ? "" : "s"} handled` : "Checked. No new Zoho Sign emails");
    await loadLog(); if (show !== "signing") loadList();
  }
  async function signAct(a: "move" | "undo" | "ignore", row: SignRow, job?: string) {
    if (a === "undo" && !window.confirm(`Undo? ${jobLabel(row.job_id)} goes back to Sent for signing.`)) return;
    setBusy(true);
    const r = await fetch("/api/mail/sign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a, id: row.id, job }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { say(d.error ?? "That didn't work", true); return; }
    say(a === "move" ? `${jobLabel(job ?? null)} moved to Ready to lodge` : a === "undo" ? "Undone: back to Sent for signing" : "Ignored");
    await loadLog();
  }
  function startCompose(kind: "new" | "reply" | "all" | "fwd") {
    const fromBox = msg ? msg.box : typeof box === "number" ? box : boxes?.[0]?.i ?? 0;
    if (kind === "new" || !msg) { setCompose({ box: fromBox, to: "", cc: "", subject: "", body: "", quote: "", inReplyTo: "", references: "", files: [] }); return; }
    const me = addrOf(msg.box);
    const re = (s: string) => (/^re:/i.test(s) ? s : `Re: ${s}`);
    const quote = `On ${new Date(msg.date).toLocaleString("en-AU")}, ${msg.from.name || msg.from.address} wrote:\n${msg.text}`.slice(0, 20000);
    if (kind === "fwd") { setCompose({ box: msg.box, to: "", cc: "", subject: /^fwd?:/i.test(msg.subject) ? msg.subject : `Fwd: ${msg.subject}`, body: "", quote, inReplyTo: "", references: "", files: [] }); return; }
    const to = msg.folder === "sent" ? msg.to.map((x) => x.address).join(", ") : msg.replyTo || msg.from.address;
    const cc = kind === "all" ? [...msg.to, ...msg.cc].map((x) => x.address).filter((a) => a && a !== me && !to.includes(a)).join(", ") : "";
    setCompose({ box: msg.box, to, cc, subject: re(msg.subject), body: "", quote, inReplyTo: msg.messageId, references: [...msg.references, msg.messageId].filter(Boolean).join(" "), files: [] });
  }
  async function send() {
    if (!compose) return;
    const fd = new FormData();
    fd.set("a", "send"); fd.set("box", String(compose.box)); fd.set("to", compose.to); fd.set("cc", compose.cc); fd.set("subject", compose.subject);
    fd.set("body", compose.body); fd.set("quote", compose.quote); fd.set("inReplyTo", compose.inReplyTo); fd.set("references", compose.references);
    for (const f of compose.files) fd.append("file", f);
    setBusy(true);
    const r = await fetch("/api/mail", { method: "POST", body: fd }); const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { say(d.error ?? "Email not sent", true); return; }
    say(`Sent from ${addrOf(compose.box)}`); setCompose(null);
  }
  async function markUnread() {
    if (!msg || msg.folder !== "inbox") return;
    const fd = new FormData(); fd.set("a", "unseen"); fd.set("box", String(msg.box)); fd.set("uid", String(msg.uid));
    await fetch("/api/mail", { method: "POST", body: fd });
    setList((l) => l?.map((m) => (m.box === msg.box && m.uid === msg.uid && m.folder === "inbox" ? { ...m, seen: false } : m)) ?? l);
    setSel(null);
  }

  if (boxes && !boxes.length) return (<>
    <div className="pagehead"><div><h1>Inbox</h1><p>Your practice mailboxes in one place, and Zoho Sign emails that move jobs to Ready to lodge on their own.</p></div></div>
    <div className="panel empty" style={{ padding: 24 }}><strong>No mailbox is connected yet.</strong>
      Add the mailbox in Vercel (Settings → Environment Variables): <code>MAILBOX_1_USER</code> = the email address and <code>MAILBOX_1_PASS</code> = its app password, then redeploy.</div></>);

  const signRowEl = (s: SignRow) => {
    const j = s.job_id ? jobById.get(s.job_id) : null;
    const choices = s.result === "needs" && s.candidates.length > 1 ? s.candidates.map((id) => jobById.get(id)).filter(Boolean) as Job[] : outForSign;
    return <div className={`signbox ${s.result}`}>
      {s.result === "moved" ? <><b>✅ Done automatically:</b> {jobLabel(s.job_id)} moved from Sent for signing to <b>Ready to lodge</b>.{s.note ? ` ${s.note}.` : ""}
        <div className="row" style={{ marginTop: 6 }}>{j ? <button type="button" className="link" onClick={() => onOpenJob(j)}>Open job</button> : null}<button type="button" className="link" disabled={busy} onClick={() => signAct("undo", s)}>Undo</button></div></>
      : s.result === "skipped" ? <><b>↷ Nothing to do:</b> {s.note}{j ? <> · <button type="button" className="link" onClick={() => onOpenJob(j)}>{jobLabel(s.job_id)}</button></> : null}</>
      : <><b>⚠ Needs you:</b> {s.result === "undone" ? "you undid this move." : s.note || "no job matched."} Choose the job this signed document is for:
        <div className="row" style={{ marginTop: 6 }}>
          <select aria-label="Job" value={pick} onChange={(e) => setPick(e.target.value)} style={{ maxWidth: 360 }}>
            <option value="">Choose the job…</option>{choices.map((x) => <option key={x.id} value={x.id}>{clientName(x.client_id)} · {svcLabel(x.service)} {x.period}</option>)}</select>
          <button type="button" className="primary" disabled={busy || !pick} onClick={() => signAct("move", s, pick)}>Move to Ready to lodge</button>
          {s.result !== "undone" ? <button type="button" disabled={busy} onClick={() => signAct("ignore", s)}>Not a job (ignore)</button> : null}</div></>}
    </div>;
  };
  const tagFor = (s: SignRow | null) => !s ? null : <span className={`mtag ${s.result === "moved" ? "ok" : s.result === "skipped" ? "grey" : "warn"}`}>
    {s.result === "moved" ? "✅ Moved to Ready to lodge" : s.result === "skipped" ? `↷ ${s.note}` : s.result === "undone" ? "↺ Undone: choose the job" : s.result === "needs" ? "⚠ Choose the job" : "⚠ No job found"}</span>;

  const rows: { key: string; b: number; folder: "inbox" | "sent"; uid: number; who: string; subject: string; date: string; unread: boolean; att: boolean; sign: SignRow | null }[] =
    show === "signing"
      ? (log ?? []).filter((s) => box === "all" || s.box === addrOf(box)).map((s) => ({ key: s.id, b: idxOf(s.box), folder: "inbox" as const, uid: Number(s.uid), who: "Zoho Sign", subject: s.subject || s.doc_name, date: s.received_at ?? s.created_at, unread: false, att: false, sign: s }))
      : (list ?? []).filter((m) => show !== "unread" || !m.seen).map((m) => ({ key: `${m.box}-${m.folder}-${m.uid}`, b: m.box, folder: m.folder, uid: m.uid, who: m.folder === "sent" ? `To ${m.to.join(", ")}` : m.from.name || m.from.address,
        subject: m.subject, date: m.date, unread: !m.seen && m.folder === "inbox", att: m.att, sign: m.folder === "inbox" ? signFor(m.box, m.uid) : null }));
  const current = sel ? (show === "signing" ? log?.find((s) => s.box === addrOf(sel.box) && Number(s.uid) === sel.uid) ?? null : signFor(sel.box, sel.uid)) : null;

  return (<>
    <div className="pagehead"><div><h1>Inbox</h1><p>{boxes ? `${boxes.length} mailbox${boxes.length === 1 ? "" : "es"}` : "Loading…"}. Zoho Sign &ldquo;has been completed&rdquo; emails move the job to Ready to lodge on their own.</p></div>
      <div className="row" style={{ gap: 8 }}><button type="button" disabled={busy} onClick={checkNow}>⟳ Check Zoho emails now</button><button type="button" className="primary" onClick={() => startCompose("new")}>✉ New email</button></div></div>
    <div className="panel signbar">
      <b>🤖 Signing automation</b>
      {logMissing ? <span className="mtag warn">Run database-update-inbox-signing.sql in Supabase to switch it on</span> : <>
        <span className="mtag ok">✅ {movedToday} job{movedToday === 1 ? "" : "s"} moved to Ready to lodge today</span>
        {needs ? <button type="button" className="mtag warn" onClick={() => { setShow("signing"); setSel(null); }}>⚠ {needs} email{needs === 1 ? "" : "s"} need{needs === 1 ? "s" : ""} you</button> : null}</>}
      <span className="note">Reads Zoho Sign emails in {boxes?.length === 1 ? boxes[0].address : "all mailboxes"} · matches the document name (e.g. ITR_SUKHDEVSINGHCHAHAL) to a job in Sent for signing</span>
    </div>
    {errors.length ? <div className="panel" style={{ padding: "10px 14px", marginBottom: 12, color: "var(--danger)" }}>{errors.join(" · ")}</div> : null}
    <div className="panel inbox">
      <div className="mbx">
        <h4>Mailboxes</h4>
        {(boxes?.length ?? 0) > 1 ? <button type="button" className={box === "all" ? "on" : ""} onClick={() => { setBox("all"); setSel(null); }}><span>All inboxes<small>{boxes!.length} mailboxes</small></span></button> : null}
        {boxes?.map((b) => <button key={b.i} type="button" className={box === b.i || (boxes.length === 1) ? "on" : ""} onClick={() => { setBox(b.i); setSel(null); }}><span>{short(b.address)}<small>{b.address}</small></span></button>)}
        <h4 style={{ marginTop: 14 }}>Show</h4>
        {([["inbox", "Inbox"], ["unread", "Unread"], ["signing", "✍ Signing (Zoho)"], ["sent", "Sent"]] as const).map(([k, l]) => <button key={k} type="button" className={show === k ? "on" : ""} onClick={() => { setShow(k); setSel(null); }}>
          <span>{l}</span>{k === "signing" && needs ? <i className="warn">{needs}</i> : k === "unread" && list ? <i>{list.filter((m) => !m.seen && m.folder === "inbox").length || ""}</i> : null}</button>)}
      </div>
      <div className="mlist">
        {show !== "signing" ? <form className="mhead" onSubmit={(e) => { e.preventDefault(); setQ(qIn.trim()); }}><input type="search" placeholder="Search sender, recipient or subject" value={qIn} onChange={(e) => setQIn(e.target.value)} /><button type="submit">Search</button><button type="button" title="Refresh" onClick={() => loadList()}>⟳</button></form> : null}
        {show !== "signing" && !list ? <div className="empty">Loading emails…</div> : !rows.length ? <div className="empty">{show === "signing" ? "No Zoho Sign emails handled yet." : "No emails here."}</div>
          : rows.map((m) => <button type="button" key={m.key} className={`mitem${m.unread ? " unread" : ""}${sel && sel.box === m.b && sel.uid === m.uid && sel.folder === m.folder ? " on" : ""}${m.sign && (m.sign.result === "needs" || m.sign.result === "none") ? " needs" : ""}`}
            onClick={() => { if (m.b < 0) { say("That mailbox isn't connected any more", true); return; } setCompose(null); setSel({ box: m.b, folder: m.folder, uid: m.uid }); }}>
            <span className="t"><b>{m.who}</b><span>{when(m.date)}</span></span>
            <span className="s">{m.att ? "📎 " : ""}{m.subject}</span>
            <span className="tags">{tagFor(m.sign)}{(boxes?.length ?? 0) > 1 && m.b >= 0 ? <span className="mtag box">{short(addrOf(m.b))}</span> : null}</span>
          </button>)}
      </div>
      <div className="mread">
        {compose ? <div className="mcompose">
          <h3>{compose.inReplyTo ? "Reply" : compose.quote ? "Forward" : "New email"}</h3>
          <label className="f">From<select value={compose.box} onChange={(e) => setCompose({ ...compose, box: Number(e.target.value) })}>{boxes?.map((b) => <option key={b.i} value={b.i}>{b.address}</option>)}</select></label>
          <label className="f">To<input id="mc-to" value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} placeholder="name@example.com, another@example.com" /></label>
          <label className="f">CC<input id="mc-cc" value={compose.cc} onChange={(e) => setCompose({ ...compose, cc: e.target.value })} /></label>
          <label className="f">Subject<input id="mc-subject" value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} /></label>
          <label className="f">Message<textarea id="mc-body" rows={8} value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} /></label>
          {compose.quote ? <details className="note"><summary>Earlier message (included below yours)</summary><pre style={{ whiteSpace: "pre-wrap" }}>{compose.quote.slice(0, 3000)}</pre></details> : null}
          <div className="row"><label className="btn">📎 Attach<input type="file" multiple hidden onChange={(e) => setCompose({ ...compose, files: [...compose.files, ...Array.from(e.target.files ?? [])] })} /></label>
            {compose.files.map((f, i) => <span key={i} className="mtag box">{f.name} <button type="button" className="link" onClick={() => setCompose({ ...compose, files: compose.files.filter((_, k) => k !== i) })}>✕</button></span>)}
            <span style={{ flex: 1 }} /><button type="button" onClick={() => setCompose(null)}>Cancel</button><button type="button" className="primary" disabled={busy || !compose.to.trim()} onClick={send}>Send</button></div>
          <span className="note">Up to 4 MB of attachments. Sent emails go to the mailbox&apos;s Sent folder as usual.</span>
        </div>
        : !sel ? <div className="empty">Choose an email to read it.</div>
        : loadingMsg || !msg ? <div className="empty">Opening…{current ? signRowEl(current) : null}</div>
        : <>
          <div className="row actbar"><button type="button" onClick={() => startCompose("reply")}>↩ Reply</button><button type="button" onClick={() => startCompose("all")}>↩ Reply all</button><button type="button" onClick={() => startCompose("fwd")}>↪ Forward</button>
            {msg.folder === "inbox" ? <button type="button" onClick={markUnread}>Mark unread</button> : null}</div>
          <h2 className="msubj">{msg.subject}</h2>
          <div className="note"><b style={{ color: "var(--fg)" }}>{msg.from.name || msg.from.address}</b> &lt;{msg.from.address}&gt; → {msg.to.map((x) => x.address).join(", ")}{msg.cc.length ? ` · CC ${msg.cc.map((x) => x.address).join(", ")}` : ""} · {fmtDate(msg.date.slice(0, 10))} {new Date(msg.date).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}</div>
          {current ? signRowEl(current) : null}
          {msg.attachments.length ? <div className="row">{msg.attachments.map((a) => <a key={a.i} className="mtag box" href={`/api/mail?a=att&box=${msg.box}&folder=${msg.folder}&uid=${msg.uid}&i=${a.i}`}>📄 {a.name} · {kb(a.size)}</a>)}</div> : null}
          {msg.html ? <iframe className="mbody" title="Email" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={`<base target="_blank"><style>body{font-family:Arial,sans-serif;font-size:14px;color:#0b1a2c;margin:0;word-wrap:break-word}img{max-width:100%;height:auto}</style>${msg.html}`} />
            : <pre className="mbody text">{msg.text || "(no text)"}</pre>}
        </>}
      </div>
    </div>
  </>);
}
