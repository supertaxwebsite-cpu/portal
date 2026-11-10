"use client";
import { useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Client, ClientLink } from "@/lib/types";
import { RELATIONS, relationText } from "@/lib/domain";
import ClientPicker from "./ClientPicker";

type SB = ReturnType<typeof createClient>;

/** Related clients on a client's page: company and its directors, husband and wife, trust and trustee, and so on. */
export default function RelatedClients({ client, clients, links, supabase, say, onOpen, onChanged, missing }: {
  client: Client; clients: Client[]; links: ClientLink[]; supabase: SB; missing: boolean;
  say: (m: string, err?: boolean) => void; onOpen: (id: string) => void; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [other, setOther] = useState("");
  const [relation, setRelation] = useState("director");
  // true: "<other> is the <relation> of <this client>"; false: "<this client> is the <relation> of <other>"
  const [otherIsFrom, setOtherIsFrom] = useState(true);
  const [busy, setBusy] = useState(false);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const mine = links.filter((l) => l.client_id === client.id || l.related_id === client.id);
  const linked = new Set(mine.flatMap((l) => [l.client_id, l.related_id]));
  const choices = clients.filter((c) => c.id !== client.id && !linked.has(c.id));
  const otherName = byId.get(other)?.name ?? "the other client";

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!other) { say("Pick the client to link first", true); return; }
    setBusy(true);
    const row = otherIsFrom ? { client_id: other, related_id: client.id, relation } : { client_id: client.id, related_id: other, relation };
    const { error } = await supabase.from("client_links").insert(row);
    setBusy(false);
    if (error) { say(/duplicate|unique/i.test(error.message) ? "These two clients are already linked" : /row-level|permission/i.test(error.message) ? "You don't have permission to do that." : `Not saved: ${error.message}`, true); return; }
    say(`Linked ${otherName}`); setOther(""); setAdding(false); onChanged();
  }
  async function remove(l: ClientLink) {
    const name = byId.get(l.client_id === client.id ? l.related_id : l.client_id)?.name ?? "this client";
    if (!window.confirm(`Remove the link to ${name}? Both clients and their jobs stay as they are.`)) return;
    const { error } = await supabase.from("client_links").delete().eq("id", l.id);
    if (error) { say(`Not removed: ${error.message}`, true); return; }
    say("Link removed"); onChanged();
  }

  return (
    <div className="panel related">
      <div className="ph" style={{ padding: 0, marginBottom: 8 }}><h2>Related clients ({mine.length})</h2>
        {!missing && !adding ? <button type="button" onClick={() => setAdding(true)}>Link a client</button> : null}</div>
      {missing ? <p className="note" style={{ margin: 0 }}>Run the database update for related clients to switch this on.</p> : null}
      {!missing && !mine.length && !adding ? <p className="note" style={{ margin: 0 }}>Link this client to its directors, spouse, trust or other related clients so you can see and finish all their work together.</p> : null}
      {mine.length ? <ul className="rellist">{mine.map((l) => {
        const fromHere = l.client_id === client.id, otherId = fromHere ? l.related_id : l.client_id, o = byId.get(otherId);
        return <li key={l.id}><span className="tag">{relationText(l.relation, fromHere)}</span>
          <button type="button" className="link" onClick={() => onOpen(otherId)}>{o?.name ?? "Unknown client"}</button>
          {o ? <span className="note">{o.entity}</span> : null}
          <button type="button" className="link danger" aria-label={`Remove link to ${o?.name ?? "client"}`} title="Remove link" onClick={() => remove(l)}>✕</button></li>;
      })}</ul> : null}
      {adding ? <form className="reladd" onSubmit={add}>
        <div className="relsentence">
          {otherIsFrom ? <ClientPicker id="rel-other" clients={choices} value={other} onChange={setOther} placeholder="Search client to link…" style={{ minWidth: 220 }} /> : <strong>{client.name}</strong>}
          <span>is the</span>
          <select id="rel-type" aria-label="Relationship" value={relation} onChange={(e) => setRelation(e.target.value)}>
            {RELATIONS.map((r) => <option key={r.id} value={r.id}>{r.of.replace(/ of$| to$/, "").toLowerCase()}</option>)}
          </select>
          <span>of</span>
          {otherIsFrom ? <strong>{client.name}</strong> : <ClientPicker id="rel-other" clients={choices} value={other} onChange={setOther} placeholder="Search client to link…" style={{ minWidth: 220 }} />}
          <button type="button" className="link" title="Swap the two sides" onClick={() => setOtherIsFrom(!otherIsFrom)}>⇄ Swap</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}><button type="submit" className="primary" disabled={busy}>Save link</button><button type="button" onClick={() => { setAdding(false); setOther(""); }}>Cancel</button></div>
      </form> : null}
    </div>
  );
}
