"use client";
import { useEffect, useState } from "react";
import type { createClient } from "@/lib/supabase/client";

type SB = ReturnType<typeof createClient>;
export type NotesKind = "review" | "client" | "mgmt";
interface Note { id: string; author_id: string | null; to_id?: string | null; category: string; body: string; pinned?: boolean; severity?: string; status?: string; fix_body?: string; created_at: string }

const TITLE: Record<NotesKind, string> = { review: "Review notes", client: "Client notes", mgmt: "Management notes" };
const when = (t: string) => new Date(t).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Pop-up from the job page's Summary panel: reads the job's review notes, or the client's notes or management notes. */
export default function NotesPopup({ kind, jobId, clientId, clientName, supabase, personName, onClose, onOpenClient }: {
  kind: NotesKind; jobId: string; clientId: string; clientName: string; supabase: SB; personName: (id: string | null) => string;
  onClose: () => void; onOpenClient?: () => void;
}) {
  const [rows, setRows] = useState<Note[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    const q = kind === "review"
      ? supabase.from("review_notes").select("*").eq("job_id", jobId).order("created_at", { ascending: false })
      : supabase.from(kind === "client" ? "client_notes" : "client_mgmt_notes").select("*").eq("client_id", clientId).order("pinned", { ascending: false }).order("created_at", { ascending: false });
    q.then(({ data, error }) => { if (!live) return; if (error) setErr(error.message); else setRows((data as Note[] | null) ?? []); });
    return () => { live = false; };
  }, [kind, jobId, clientId, supabase]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal notespop" role="dialog" aria-label={TITLE[kind]}>
        <header><h2>{TITLE[kind]} <span className="note">· {clientName}</span></h2><button type="button" onClick={onClose}>Close</button></header>
        <div className="body">
          {err ? <p className="note danger">Couldn&apos;t load the notes: {err}</p>
            : !rows ? <p className="note">Loading…</p>
            : !rows.length ? <div className="empty"><strong>No {TITLE[kind].toLowerCase()} yet.</strong>{kind === "review" ? "The reviewer's notes on this job show here." : "Add them on the client page."}</div>
            : <ul className="noteslist">{rows.map((n) => (
              <li key={n.id} className={n.status === "open" ? "open" : undefined}>
                <div className="nhead">
                  {n.pinned ? <span className="pill info">📌 Pinned</span> : null}
                  {kind === "review" && n.severity ? <span className={`pill ${n.severity === "major" ? "danger" : "warn"}`}>{n.severity === "major" ? "Major" : "Minor"}</span> : null}
                  <span className="pill">{n.category.charAt(0).toUpperCase() + n.category.slice(1)}</span>
                  {kind === "review" && n.status ? <span className={`pill ${n.status === "open" ? "danger" : "ok"}`}>{n.status === "open" ? "Open" : n.status === "fixed" ? "Fixed" : "Cleared"}</span> : null}
                  <span className="note">{personName(n.author_id) || "Someone"}{kind === "review" && n.to_id ? ` → ${personName(n.to_id)}` : ""} · {when(n.created_at)}</span>
                </div>
                <div className="nbody">{n.body}</div>
                {kind === "review" && n.fix_body ? <div className="nfix"><b>Fix:</b> {n.fix_body}</div> : null}
              </li>))}</ul>}
        </div>
        {kind !== "review" && onOpenClient ? <footer><span className="note">To add or change notes, open the client page.</span><button type="button" onClick={() => { onClose(); onOpenClient(); }}>Open client page</button></footer> : null}
      </div>
    </div>
  );
}
