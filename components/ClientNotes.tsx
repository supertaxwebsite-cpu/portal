"use client";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type SB = ReturnType<typeof createClient>;
interface Note { id: string; client_id: string; author_id: string | null; category: string; body: string; pinned: boolean; created_at: string; updated_at: string }

export const NOTE_KINDS = [
  { id: "general", label: "General" },
  { id: "instruction", label: "Special instruction" },
  { id: "contact", label: "Contact & communication" },
  { id: "software", label: "Software & access" },
  { id: "tax", label: "Tax & ATO" },
  { id: "payroll", label: "Payroll" },
];
export const MGMT_KINDS = [
  { id: "general", label: "General" },
  { id: "quote", label: "Quote" },
  { id: "fees", label: "Fees & billing" },
  { id: "relationship", label: "Relationship" },
  { id: "risk", label: "Risk & concerns" },
];
const when = (s: string) => new Date(s).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** A running, dated log of notes on one client. Key notes can be pinned to the top. */
export default function ClientNotes({ clientId, meId, isManager, canDelete, supabase, personName, say, mgmt }: {
  clientId: string; meId: string; isManager: boolean; canDelete: boolean; supabase: SB; mgmt?: boolean;
  personName: (id: string | null) => string; say: (m: string, err?: boolean) => void;
}) {
  const table = mgmt ? "client_mgmt_notes" : "client_notes";
  const KINDS = mgmt ? MGMT_KINDS : NOTE_KINDS;
  const kindLabel = (id: string) => KINDS.find((k) => k.id === id)?.label ?? id;
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [kind, setKind] = useState("general");
  const [body, setBody] = useState("");
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string; category: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from(table).select("*").eq("client_id", clientId).order("created_at", { ascending: false });
    if (error) { setMissing(true); setNotes([]); return; }
    setNotes(data as Note[]);
  }, [supabase, clientId, table]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`${table}-${clientId}`)
      .on("postgres_changes", { event: "*", schema: "public", table, filter: `client_id=eq.${clientId}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, clientId, load, table]);

  async function run(p: PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true);
    const { error } = await p;
    setBusy(false);
    if (error) { say(/row-level security|permission/i.test(error.message) ? "You don't have permission to do that. Ask your manager." : `Not saved: ${error.message}`, true); return false; }
    say(ok); await load(); return true;
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    if (await run(supabase.from(table).insert({ client_id: clientId, author_id: meId, category: kind, body: body.trim(), pinned: pin }), "Note added")) { setBody(""); setPin(false); }
  }
  const canEdit = (n: Note) => isManager || n.author_id === meId;
  const canDel = (n: Note) => (mgmt ? canEdit(n) : canDelete);

  const list = (notes ?? []).filter((n) => !filter || n.category === filter);
  const pinned = list.filter((n) => n.pinned), rest = list.filter((n) => !n.pinned);
  const used = KINDS.filter((k) => (notes ?? []).some((n) => n.category === k.id));

  // A plain function (not a component) so the edit box keeps focus while typing.
  const item = (n: Note) => (
    <li key={n.id} className={n.pinned ? "pinned" : ""}>
      {editing?.id === n.id ? (
        <form onSubmit={async (e) => { e.preventDefault(); if (editing.body.trim() && await run(supabase.from(table).update({ body: editing.body.trim(), category: editing.category }).eq("id", n.id), "Note updated")) setEditing(null); }}>
          <select aria-label="Type of note" value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} style={{ marginBottom: 6 }}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
          <textarea aria-label="Note" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          <div className="row" style={{ marginTop: 6 }}><button type="submit" className="primary" disabled={busy}>Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div>
        </form>
      ) : <>
        <div className="nhead"><span className="tag">{kindLabel(n.category)}</span>{n.pinned ? <span className="tag pin">Pinned</span> : null}
          <span className="note">{personName(n.author_id) || "Former staff"} · {when(n.created_at)}{n.updated_at.slice(0, 16) !== n.created_at.slice(0, 16) ? " · edited" : ""}</span></div>
        <div className="nbody">{n.body}</div>
        {canEdit(n) || canDel(n) ? <div className="nact">
          {canEdit(n) ? <><button className="link" disabled={busy} onClick={() => run(supabase.from(table).update({ pinned: !n.pinned }).eq("id", n.id), n.pinned ? "Unpinned" : "Pinned to the top")}>{n.pinned ? "Unpin" : "Pin"}</button>
            <button className="link" onClick={() => setEditing({ id: n.id, body: n.body, category: n.category })}>Edit</button></> : null}
          {canDel(n) ? <button className="link danger" disabled={busy} onClick={() => { if (window.confirm("Delete this note for everyone?")) run(supabase.from(table).delete().eq("id", n.id), "Note deleted"); }}>Delete</button> : null}
        </div> : null}
      </>}
    </li>
  );

  return (
    <div className={`panel clientnotes${mgmt ? " mgmtnotes" : ""}`}>
      <div className="ph"><h2>{mgmt ? "🔒 Management notes" : "Client notes"}{notes?.length ? ` (${notes.length})` : ""}</h2>
        {mgmt ? <span className="note">Confidential. Only master admins, managers and people you give access to can see these.</span> : null}</div>
      {missing ? <div className="empty">{mgmt ? "Run the database update for management notes in Supabase to switch these on." : "Client notes aren\u2019t set up in the database yet."}</div> : <>
        <form className="addnote" onSubmit={add}>
          <textarea id={mgmt ? "mn-body" : "cn-body"} placeholder={mgmt ? "A confidential note, e.g. Quoted $1,650 + GST for FY26 tax return and BAS · Slow payer, ask for payment before lodging" : "Add a note about this client, e.g. Uses Xero, login in the shared vault · Prefers WhatsApp after 5pm · Director signs BAS, not the bookkeeper"} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
          <div className="row">
            <select id={mgmt ? "mn-kind" : "cn-kind"} aria-label="Type of note" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
            <label className="row" style={{ gap: 6, fontSize: 14 }}><input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> Pin to top</label>
            <span style={{ flex: 1 }} />
            <button type="submit" className="primary" disabled={busy || !body.trim()}>Add note</button>
          </div>
        </form>
        {used.length > 1 ? <div className="row" style={{ padding: "0 14px 8px" }}>
          <button className={`chip ${!filter ? "on" : ""}`} onClick={() => setFilter("")}>All</button>
          {used.map((k) => <button key={k.id} className={`chip ${filter === k.id ? "on" : ""}`} onClick={() => setFilter(filter === k.id ? "" : k.id)}>{k.label}</button>)}
        </div> : null}
        {notes === null ? <div className="empty">Loading…</div> : !list.length ? <div className="empty"><strong>No notes yet.</strong>{mgmt ? "Quotes, fees and anything confidential about this client. Your team can't see these." : "Software, contact preferences, special instructions and anything the team should know about this client."}</div> : (
          <ul className="notelist">{pinned.map(item)}{rest.map(item)}</ul>)}
      </>}
    </div>
  );
}
