"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Client, Person } from "@/lib/types";
import { DEFAULT_PRACTICE, ENTITIES, PRACTICES, SERVICES, daysFrom, fmtDate, svcLabel, todayISO } from "@/lib/domain";
import { similarClients } from "@/lib/dupes";

type SB = ReturnType<typeof createClient>;

export interface Prospect {
  id: string; practice: string; name: string; entity: string; contact: string; email: string; phone: string;
  services: string[]; fee: number | null; source: string; stage: string; follow_up: string | null; owner_id: string | null;
  notes: string; lost_reason: string; client_id: string | null; created_by: string | null; created_at: string; updated_at: string;
}

export const STAGES = [
  { id: "new", label: "New enquiry", cls: "none" },
  { id: "contacted", label: "Contacted", cls: "info" },
  { id: "meeting", label: "Meeting booked", cls: "accent" },
  { id: "proposal", label: "Proposal sent", cls: "warn" },
  { id: "won", label: "Won (now a client)", cls: "ok" },
  { id: "lost", label: "Lost", cls: "danger" },
];
const OPEN = new Set(["new", "contacted", "meeting", "proposal"]);
const stageLabel = (s: string) => STAGES.find((x) => x.id === s)?.label ?? s;
const SOURCES = ["Referral from a client", "Website", "Google", "Social media", "Walk-in or phone call", "Existing client's family or business", "Other"];
const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

function Overlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>{children}</div>;
}

/** Possible new clients still in discussion. Kept apart from the client list and job counts. */
export default function ProspectsView({ supabase, meId, team, clients, canDelete, personName, say, onOpenClient, onChanged }: {
  supabase: SB; meId: string; team: Person[]; clients: Client[]; canDelete: boolean;
  personName: (id: string | null) => string; say: (m: string, err?: boolean) => void;
  onOpenClient: (id: string) => void; onChanged: () => void;
}) {
  const [list, setList] = useState<Prospect[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("open");
  const [owner, setOwner] = useState("");
  const [edit, setEdit] = useState<Prospect | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("prospects").select("*").order("created_at", { ascending: false });
    if (error) { setMissing(true); setList([]); return; }
    setMissing(false); setList(data as Prospect[]);
  }, [supabase]);
  useEffect(() => {
    load();
    const ch = supabase.channel("prospects").on("postgres_changes", { event: "*", schema: "public", table: "prospects" }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, load]);

  const all = list ?? [];
  const open = all.filter((p) => OPEN.has(p.stage));
  const due = open.filter((p) => p.follow_up && daysFrom(p.follow_up) <= 0);
  const pipeline = open.reduce((s, p) => s + (p.fee ?? 0), 0);
  const month = todayISO().slice(0, 7);
  const wonMonth = all.filter((p) => p.stage === "won" && p.updated_at.slice(0, 7) === month);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return all.filter((p) => {
      if (stage === "open" && !OPEN.has(p.stage)) return false;
      if (stage === "due" && !(OPEN.has(p.stage) && p.follow_up && daysFrom(p.follow_up) <= 0)) return false;
      if (stage !== "open" && stage !== "due" && stage !== "" && p.stage !== stage) return false;
      if (owner === "__me" && p.owner_id !== meId) return false;
      if (owner && owner !== "__me" && p.owner_id !== owner) return false;
      if (t && ![p.name, p.contact, p.email, p.phone, p.notes, p.source].join(" ").toLowerCase().includes(t)) return false;
      return true;
    }).sort((a, b) => (OPEN.has(a.stage) ? 0 : 1) - (OPEN.has(b.stage) ? 0 : 1) || (a.follow_up ?? "9999").localeCompare(b.follow_up ?? "9999") || a.name.localeCompare(b.name));
  }, [all, q, stage, owner, meId]);

  async function run(p: PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true);
    const { error } = await p;
    setBusy(false);
    if (error) { say(/row-level security|permission/i.test(error.message) ? "You don't have permission to do that." : `Not saved: ${error.message}`, true); return false; }
    say(ok); await load(); onChanged(); return true;
  }
  const setStageOf = (p: Prospect, s: string) => run(supabase.from("prospects").update({ stage: s }).eq("id", p.id), `${p.name}: ${stageLabel(s).toLowerCase()}`);

  async function convert(p: Prospect) {
    const sim = similarClients(p.name, "", clients);
    const warn = sim.length ? `\n\nCareful: ${sim.slice(0, 3).map((s) => `${s.client.name} (${s.why})`).join(", ")} already exist${sim.length === 1 ? "s" : ""} as a client.` : "";
    if (!window.confirm(`Make ${p.name} a client? They'll be added to the Clients list with their contact details and services, and this prospect is marked Won.${warn}`)) return;
    setBusy(true);
    const { data, error } = await supabase.from("clients").insert({
      practice: p.practice || DEFAULT_PRACTICE, name: p.name.trim(), entity: p.entity, contact: p.contact, email: p.email, phone: p.phone,
      services: p.services, manager_id: p.owner_id, notes: p.notes,
    }).select().single();
    if (error || !data) { setBusy(false); say(`Not converted: ${error?.message ?? "unknown error"}`, true); return; }
    await supabase.from("prospects").update({ stage: "won", client_id: (data as Client).id, follow_up: null }).eq("id", p.id);
    setBusy(false);
    say(`${p.name} is now a client. Add their ABN and address on the client page.`);
    await load(); onChanged();
    onOpenClient((data as Client).id);
  }

  return (
    <>
      <div className="pagehead">
        <div><h1>Prospects</h1><p>Possible new clients you&apos;re still talking to. They stay off the client list until you convert them.</p></div>
        <div className="row"><button className="primary" disabled={missing} onClick={() => setEdit("new")}>Add prospect</button></div>
      </div>
      {missing ? <div className="panel" style={{ padding: 16, marginBottom: 16 }}><strong>One step to switch this on.</strong> Run the database update for prospects in Supabase, then refresh this page.</div> : null}
      <div className="tiles" style={{ marginBottom: 16 }}>
        <button type="button" className="tile" onClick={() => setStage("open")}><span className="lbl">Open prospects</span><span className="val">{open.length}</span></button>
        <button type="button" className={`tile${due.length ? " danger" : ""}`} onClick={() => setStage("due")}><span className="lbl">Follow-ups due</span><span className="val">{due.length}</span></button>
        <button type="button" className="tile" onClick={() => setStage("proposal")}><span className="lbl">Proposals out</span><span className="val">{open.filter((p) => p.stage === "proposal").length}</span></button>
        <div className="tile"><span className="lbl">Fees in discussion</span><span className="val" style={{ fontSize: 22 }}>{money(pipeline)}</span></div>
        <button type="button" className="tile" onClick={() => setStage("won")}><span className="lbl">Won this month</span><span className="val">{wonMonth.length}</span></button>
      </div>
      <div className="toolbar">
        <input type="search" id="pq" placeholder="Search name, contact, email, phone or notes" aria-label="Search prospects" value={q} onChange={(e) => setQ(e.target.value)} />
        <select id="pstage" aria-label="Stage" value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="open">All open prospects</option><option value="due">Follow-up due</option>
          {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}<option value="">Everything, including won and lost</option>
        </select>
        <select id="powner" aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Anyone</option><option value="__me">Mine</option>{team.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
        </select>
        <span className="clientcount"><strong>{shown.length}</strong> prospect{shown.length === 1 ? "" : "s"}</span>
      </div>
      <div className="tablebox">
        {!list ? <div className="empty">Loading…</div> : !shown.length ? <div className="empty"><strong>{all.length ? "No prospects match." : "No prospects yet."}</strong>{all.length ? "Try another filter." : "Click Add prospect when someone enquires about becoming a client."}</div> : (
          <table className="prospects"><thead><tr><th>Prospect</th><th>Services discussed</th><th style={{ textAlign: "right" }}>Fee quoted</th><th>Stage</th><th>Follow up</th><th>Owner</th><th></th></tr></thead>
            <tbody>{shown.map((p) => {
              const d = p.follow_up ? daysFrom(p.follow_up) : null, isOpen = OPEN.has(p.stage);
              return <tr key={p.id} className={isOpen ? "" : "muted"}>
                <td><button className="link" onClick={() => setEdit(p)}><strong>{p.name}</strong></button>
                  <div className="note">{[p.entity, p.practice !== DEFAULT_PRACTICE ? p.practice : "", p.contact, p.phone || p.email].filter(Boolean).join(" · ")}</div></td>
                <td>{p.services.length ? p.services.map((s) => <span key={s} className="tag">{svcLabel(s)}</span>) : <span className="muted">—</span>}</td>
                <td className="mono" style={{ textAlign: "right" }}>{p.fee != null ? money(Number(p.fee)) : <span className="muted">—</span>}</td>
                <td><select className={`status ${STAGES.find((s) => s.id === p.stage)?.cls ?? ""}`} aria-label={`Stage for ${p.name}`} value={p.stage} disabled={busy || p.stage === "won"} onChange={(e) => setStageOf(p, e.target.value)}>
                  {STAGES.map((s) => <option key={s.id} value={s.id} disabled={s.id === "won" && !p.client_id}>{s.label}</option>)}</select></td>
                <td>{isOpen && p.follow_up ? <span className={`pill${d !== null && d < 0 ? " danger" : d === 0 ? " warn" : ""}`}>{d === 0 ? "Today" : fmtDate(p.follow_up)}{d !== null && d < 0 ? ` · ${-d} day${d === -1 ? "" : "s"} late` : ""}</span> : <span className="muted">—</span>}</td>
                <td>{personName(p.owner_id) || <span className="muted">—</span>}</td>
                <td className="nowrap">{p.client_id ? <button onClick={() => onOpenClient(p.client_id!)}>Open client</button>
                  : isOpen ? <button className="primary" disabled={busy} onClick={() => convert(p)}>Convert to client</button> : null}</td>
              </tr>;
            })}</tbody></table>)}
      </div>
      <p className="note" style={{ marginTop: 10 }}>Prospects are not counted in your client totals, jobs or workload. Don&apos;t store TFNs, passwords or bank details here.</p>
      {edit ? <ProspectModal p={edit === "new" ? null : edit} meId={meId} team={team} canDelete={canDelete} busy={busy} onClose={() => setEdit(null)}
        onConvert={edit !== "new" && OPEN.has(edit.stage) ? () => { const p = edit; setEdit(null); convert(p); } : undefined}
        onSave={async (row) => { const ok = edit === "new" ? await run(supabase.from("prospects").insert(row), "Prospect added") : await run(supabase.from("prospects").update(row).eq("id", edit.id), "Prospect saved"); if (ok) setEdit(null); }}
        onDelete={edit !== "new" ? async () => { if (!window.confirm(`Delete ${edit.name}? This can't be undone. To keep a record, set the stage to Lost instead.`)) return; if (await run(supabase.from("prospects").delete().eq("id", edit.id), "Prospect deleted")) setEdit(null); } : undefined} />
        : null}
    </>
  );
}

function ProspectModal({ p, meId, team, canDelete, busy, onClose, onSave, onDelete, onConvert }: {
  p: Prospect | null; meId: string; team: Person[]; canDelete: boolean; busy: boolean; onClose: () => void;
  onSave: (row: Partial<Prospect>) => Promise<void>; onDelete?: () => Promise<void>; onConvert?: () => void;
}) {
  const [v, setV] = useState({
    practice: p?.practice ?? DEFAULT_PRACTICE, name: p?.name ?? "", entity: p?.entity ?? "Individual", contact: p?.contact ?? "", email: p?.email ?? "", phone: p?.phone ?? "",
    services: p?.services ?? [], fee: p?.fee != null ? String(p.fee) : "", source: p?.source ?? "", stage: p?.stage ?? "new",
    follow_up: p?.follow_up ?? "", owner_id: p?.owner_id ?? meId, notes: p?.notes ?? "", lost_reason: p?.lost_reason ?? "",
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  return (
    <Overlay onClose={onClose}><form className="modal wide" onSubmit={(e) => { e.preventDefault();
      onSave({ ...v, name: v.name.trim(), fee: v.fee.trim() === "" ? null : Number(v.fee), follow_up: v.follow_up || null, owner_id: v.owner_id || null, lost_reason: v.stage === "lost" ? v.lost_reason : "" }); }}>
      <header><h2>{p ? "Edit prospect" : "Add prospect"}</h2><button type="button" onClick={onClose}>Close</button></header>
      <div className="body">
        <label className="f">Practice<select id="p-practice" value={v.practice} onChange={set("practice")}>{PRACTICES.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
        <label className="f">Entity type<select id="p-entity" value={v.entity} onChange={set("entity")}>{ENTITIES.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
        <label className="f full">Name (person or business)<input id="p-name" required maxLength={200} value={v.name} onChange={set("name")} placeholder="e.g. Sharma Holdings Pty Ltd" /></label>
        <label className="f">Contact person<input id="p-contact" value={v.contact} onChange={set("contact")} /></label>
        <label className="f">Phone<input id="p-phone" value={v.phone} onChange={set("phone")} /></label>
        <label className="f full">Email<input id="p-email" type="email" value={v.email} onChange={set("email")} /></label>
        <div className="f full"><span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Services discussed</span>
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 4 }}>{SERVICES.map((s) => { const on = v.services.includes(s.id); return (
            <label key={s.id} className={`chip${on ? " on" : ""}`}><input type="checkbox" checked={on} onChange={() => setV({ ...v, services: on ? v.services.filter((x) => x !== s.id) : [...v.services, s.id] })} /> {s.label}</label>); })}</div></div>
        <label className="f">Fee quoted (per year, $)<input id="p-fee" type="number" min="0" step="1" inputMode="numeric" value={v.fee} onChange={set("fee")} placeholder="e.g. 2500" /></label>
        <label className="f">How they found us<input id="p-source" list="p-sources" value={v.source} onChange={set("source")} placeholder="Pick or type" /><datalist id="p-sources">{SOURCES.map((s) => <option key={s} value={s} />)}</datalist></label>
        <label className="f">Stage<select id="p-stage" value={v.stage} onChange={set("stage")}>{STAGES.map((s) => <option key={s.id} value={s.id} disabled={s.id === "won" && !p?.client_id}>{s.label}</option>)}</select></label>
        <label className="f">Owner (who follows up)<select id="p-owner" value={v.owner_id} onChange={set("owner_id")}><option value="">Nobody</option>{team.map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}</select></label>
        <label className="f">Next follow-up<input id="p-follow" type="date" value={v.follow_up} onChange={set("follow_up")} />
          <span className="row" style={{ gap: 8, fontWeight: 400 }}>{[["Tomorrow", 1], ["In 3 days", 3], ["In a week", 7], ["In 2 weeks", 14]].map(([l, n]) => <button key={l} type="button" className="link" onClick={() => setV({ ...v, follow_up: inDays(n as number) })}>{l}</button>)}</span></label>
        {v.stage === "lost" ? <label className="f">Why we lost them<input id="p-lost" value={v.lost_reason} onChange={set("lost_reason")} placeholder="e.g. Price, stayed with their accountant" /></label> : <span />}
        <label className="f full">Notes<textarea id="p-notes" maxLength={8000} value={v.notes} onChange={set("notes")} placeholder="What they need, what was discussed, documents promised, next step…" /></label>
        <div className="full hint">Every open prospect with a follow-up date due today or earlier is counted in Follow-ups due, and the Prospects menu shows how many of yours are due.</div>
      </div>
      <footer>
        <div className="row">{p && onDelete && canDelete ? <button type="button" className="danger" onClick={onDelete}>Delete</button> : null}
          {onConvert ? <button type="button" onClick={onConvert}>Convert to client</button> : null}</div>
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy}>{p ? "Save changes" : "Add prospect"}</button></div>
      </footer>
    </form></Overlay>
  );
}
